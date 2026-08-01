// Data layer for the funnel-stage settings screen (src/app/settings/pipelines.tsx).
//
// Backend — every route is authenticated AND owner/admin:
//   GET    /deals/pipelines                     pipelines + their stages (+ deal counts)
//   GET    /deals/stages/library                suggested stages for the current funnel
//   POST   /deals/stages                        { pipeline_id, name, ... } | { pipeline_id, template_key }
//   PATCH  /deals/stages/:id                    partial stage update
//   DELETE /deals/stages/:id?move_to=<uuid>     409 when the stage still holds deals
//   POST   /deals/stages/reorder                { pipeline_id, ordered_ids }
//
// Two things are deliberate here:
//   1. The bearer token is part of every query key. utils/queryClient.ts refuses to persist
//      any key carrying a JWT, which keeps the funnel — and the deal counts hanging off it —
//      out of the plaintext AsyncStorage cache.
//   2. Failures surface as a PipelineApiError carrying the HTTP status. The delete flow is
//      driven off `status === 409`, not off the server's prose: that message is operator
//      English and the screen renders its own Russian copy instead.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

/** Mirrors the Zod limits the stage routes validate against. */
export const MAX_STAGE_NAME_LENGTH = 100;
export const MAX_STALE_AFTER_DAYS = 365;

/**
 * The preset palette offered in the editor. A funnel read at a glance needs colours that
 * stay apart on both themes, so this is a fixed short list rather than a colour picker —
 * `color` is still a free string on the wire, so a stage coloured elsewhere survives edits.
 */
export const STAGE_COLOR_PRESETS = [
  '#CC785C',
  '#D4A27F',
  '#D9A441',
  '#7C9A6E',
  '#4F9D8C',
  '#3B82F6',
  '#8B7BC8',
  '#8FA3AD',
  '#CC5247',
] as const;

export type PipelineStage = {
  id: string;
  name: string;
  position: number;
  color: string | null;
  probability: number | null;
  stale_after_days: number | null;
  is_archived: boolean;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  /**
   * Deals sitting in this stage — `GET /deals/pipelines` returns it per stage. Still typed
   * optional so a cached response from before the field existed does not read as zero:
   * `stageDealCount` returns null in that case and the row omits the chip rather than
   * asserting a count it does not have.
   */
  _count?: { deals: number } | null;
};

export type Pipeline = {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStage[];
  _count: { deals: number };
};

/**
 * One suggested stage. `already_added` is computed by the server against the pipeline the
 * library was asked for, so the sheet can grey a template out rather than let it 409.
 */
export type StageLibraryItem = {
  key: string;
  name: string;
  suggested_position: number;
  color: string | null;
  probability: number | null;
  rationale: string;
  recommended: boolean;
  already_added: boolean;
};

export type CreateStageInput =
  | { pipeline_id: string; template_key: string }
  | {
      pipeline_id: string;
      name: string;
      color?: string | null;
      probability?: number | null;
      position?: number;
    };

export type UpdateStageInput = {
  name?: string;
  color?: string | null;
  probability?: number | null;
  stale_after_days?: number | null;
  is_archived?: boolean;
  is_won_stage?: boolean;
  is_lost_stage?: boolean;
};

export type DeleteStageInput = {
  id: string;
  /** Where the stage's deals go. Omitted on the first attempt — the 409 is what asks. */
  move_to?: string | null;
};

/**
 * Refusal codes the stage routes answer with. The delete flow dispatches on these and on
 * nothing else — the HTTP status alone cannot tell them apart:
 *
 *   STAGE_HAS_DEALS           409, and the ONLY code that means "ask where the deals go".
 *   STAGE_LAST_IN_PIPELINE    409 as well, but a flat refusal — a one-stage funnel has no
 *                             other stage to move anything into, and the server checks this
 *                             BEFORE it counts deals.
 *   STAGE_MOVE_TARGET_INVALID 400 — target is missing or belongs to another funnel.
 *   STAGE_MOVE_TARGET_SAME    400 — target is the stage being deleted.
 */
export const STAGE_ERROR_CODES = {
  hasDeals: 'STAGE_HAS_DEALS',
  lastInPipeline: 'STAGE_LAST_IN_PIPELINE',
  wonRequired: 'STAGE_WON_REQUIRED',
  hasOpenDeals: 'STAGE_HAS_OPEN_DEALS',
  moveTargetInvalid: 'STAGE_MOVE_TARGET_INVALID',
  moveTargetSame: 'STAGE_MOVE_TARGET_SAME',
} as const;

/**
 * Carries the server's `code` and `details` so callers can branch on the refusal itself
 * rather than on the status — two different 409s mean two different things here.
 */
export class PipelineApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The server's own prose. Russian, so it is safe to render when no key matches. */
  readonly serverMessage: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(
    status: number,
    code: string | null,
    serverMessage: string | null,
    details: Record<string, unknown> | null,
  ) {
    super(serverMessage ?? code ?? `Request failed with status ${status}`);
    this.name = 'PipelineApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
    this.details = details;
  }
}

/** `details.deal_count` off a STAGE_HAS_DEALS refusal, when the server sent one. */
export function dealCountFromError(error: unknown): number | null {
  if (!(error instanceof PipelineApiError)) return null;
  const raw = error.details?.deal_count;
  return typeof raw === 'number' ? raw : null;
}

type Envelope<T> = { data: T };
type ErrorEnvelope = {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
};

async function pipelineRequest<T>(
  path: string,
  token: string,
  init?: { method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const parsed = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const envelope = parsed as ErrorEnvelope | null;
    throw new PipelineApiError(
      res.status,
      envelope?.error?.code ?? null,
      envelope?.error?.message ?? null,
      envelope?.error?.details ?? null,
    );
  }

  return parsed as T;
}

/** 4xx are answers, not outages — retrying them only delays the explanation. */
function retryServerFaultsOnly(failureCount: number, error: Error): boolean {
  if (error instanceof PipelineApiError && error.status < 500) return false;
  return failureCount < 2;
}

function pipelinesKey(token: string | null): unknown[] {
  return ['pipelines', 'list', token];
}

function libraryKey(pipelineId: string | null, token: string | null): unknown[] {
  return ['pipelines', 'library', pipelineId, token];
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function usePipelineList(): UseQueryResult<Pipeline[], Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<Pipeline[], Error>({
    queryKey: pipelinesKey(token),
    queryFn: () =>
      pipelineRequest<Envelope<Pipeline[]>>('/deals/pipelines?include_archived=true', token ?? '').then((b) => b.data),
    enabled: Boolean(token),
    retry: retryServerFaultsOnly,
  });
}

/**
 * The suggested-stage catalogue. `already_added` is relative to a pipeline, so the id goes
 * on the querystring AND into the key — switching funnels must not reuse the other one's
 * answer. Servers that ignore the parameter simply return an org-wide list; nothing breaks.
 */
export function useStageLibrary(
  pipelineId: string | null,
  enabled: boolean,
): UseQueryResult<StageLibraryItem[], Error> {
  const token = useUserStore((s) => s.token);
  const query = pipelineId === null ? '' : `?pipeline_id=${encodeURIComponent(pipelineId)}`;

  return useQuery<StageLibraryItem[], Error>({
    queryKey: libraryKey(pipelineId, token),
    queryFn: () =>
      pipelineRequest<Envelope<StageLibraryItem[]>>(`/deals/stages/library${query}`, token ?? '')
        .then((b) => b.data),
    enabled: Boolean(token) && enabled,
    retry: retryServerFaultsOnly,
    // The catalogue is a compile-time constant on the server apart from `already_added`,
    // which every stage mutation invalidates anyway.
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Every stage mutation invalidates the whole `pipelines` tree. Positions renumber, deal
 * counts move between stages and `already_added` flips — surgical invalidation would mostly
 * be a way to keep showing numbers that just stopped being true.
 */
function useStageMutation<TVars, TData>(
  mutationFn: (token: string, vars: TVars) => Promise<TData>,
): UseMutationResult<TData, Error, TVars> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<TData, Error, TVars>({
    mutationFn: (vars: TVars) => mutationFn(token ?? '', vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
    },
  });
}

export function useCreateStage(): UseMutationResult<PipelineStage, Error, CreateStageInput> {
  return useStageMutation<CreateStageInput, PipelineStage>((token, input) =>
    pipelineRequest<Envelope<PipelineStage>>('/deals/stages', token, {
      method: 'POST',
      body: input,
    }).then((b) => b.data),
  );
}

export function useUpdateStage(): UseMutationResult<
  PipelineStage,
  Error,
  { id: string; patch: UpdateStageInput }
> {
  return useStageMutation<{ id: string; patch: UpdateStageInput }, PipelineStage>(
    (token, { id, patch }) =>
      pipelineRequest<Envelope<PipelineStage>>(`/deals/stages/${id}`, token, {
        method: 'PATCH',
        body: patch,
      }).then((b) => b.data),
  );
}

/**
 * Deleting without `move_to` is the question, not a mistake: a stage holding deals answers
 * 409, and that refusal is what tells the screen to ask where the deals should go.
 */
export function useDeleteStage(): UseMutationResult<{ id: string }, Error, DeleteStageInput> {
  return useStageMutation<DeleteStageInput, { id: string }>((token, { id, move_to }) => {
    const query = move_to ? `?move_to=${encodeURIComponent(move_to)}` : '';
    return pipelineRequest<Envelope<{ id: string }>>(`/deals/stages/${id}${query}`, token, {
      method: 'DELETE',
    }).then((b) => b.data);
  });
}

/**
 * Reorder takes the FULL ordered id list. Applied optimistically because a drag that snaps
 * back for the length of a round trip reads as a failed drag; the rollback in onError puts
 * the server's order back if the write is refused.
 */
export function useReorderStages(): UseMutationResult<
  PipelineStage[],
  Error,
  { pipeline_id: string; ordered_ids: string[] },
  { previous: Pipeline[] | undefined }
> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();
  const key = pipelinesKey(token);

  return useMutation<
    PipelineStage[],
    Error,
    { pipeline_id: string; ordered_ids: string[] },
    { previous: Pipeline[] | undefined }
  >({
    mutationFn: (input) =>
      pipelineRequest<Envelope<PipelineStage[]>>('/deals/stages/reorder', token ?? '', {
        method: 'POST',
        body: input,
      }).then((b) => b.data),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Pipeline[]>(key);

      queryClient.setQueryData<Pipeline[]>(key, (current) =>
        current?.map((pipeline) => {
          if (pipeline.id !== input.pipeline_id) return pipeline;
          const byId = new Map(pipeline.stages.map((s) => [s.id, s]));
          const reordered = input.ordered_ids
            .map((id, index) => {
              const stage = byId.get(id);
              return stage === undefined ? null : { ...stage, position: index };
            })
            .filter((s): s is PipelineStage => s !== null);
          // Anything the caller left out (an archived stage the screen hides) keeps its
          // row rather than vanishing from the cache.
          const missing = pipeline.stages.filter((s) => !input.ordered_ids.includes(s.id));
          return { ...pipeline, stages: [...reordered, ...missing] };
        }),
      );

      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
    },
  });
}

// ─── Derivations ──────────────────────────────────────────────────────────────

/** Null when the server sent no per-stage count, so the row can stay silent about it. */
export function stageDealCount(stage: PipelineStage): number | null {
  return typeof stage._count?.deals === 'number' ? stage._count.deals : null;
}

export function visibleStages(pipeline: Pipeline | null | undefined): PipelineStage[] {
  if (!pipeline) return [];
  return pipeline.stages
    .filter((s) => !s.is_archived)
    .slice()
    .sort((a, b) => a.position - b.position);
}

export function archivedStages(pipeline: Pipeline | null | undefined): PipelineStage[] {
  if (!pipeline) return [];
  return pipeline.stages
    .filter((s) => s.is_archived)
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * The client half of the "only one won stage" rule.
 *
 * The server answers 409, but by then the operator has already committed to a save and has
 * to guess which of their stages is in the way. This returns the stage that currently holds
 * the flag — the screen names it in the explanation and refuses the toggle up front.
 * `exceptId` is the stage being edited, which cannot conflict with itself.
 */
export function stageHoldingFlag(
  stages: PipelineStage[],
  flag: 'is_won_stage' | 'is_lost_stage',
  exceptId: string | null,
): PipelineStage | null {
  return stages.find((s) => s[flag] && s.id !== exceptId) ?? null;
}

/** Moves `from` to `to` in a copy. Shared by the drag handler and the up/down buttons. */
export function moveInArray<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
