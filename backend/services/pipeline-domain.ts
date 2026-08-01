/**
 * pipeline-domain.ts
 *
 * Everything that decides whether a change to a funnel is ALLOWED lives here,
 * not in the controller. The controller's only job is to translate a
 * `PipelineDomainError` into an HTTP status.
 *
 * Why the guards are worth this much code: `Pipeline` / `PipelineStage` were
 * always dynamic in the database but had no write surface, so every stage in
 * production was created by the registration transaction and never touched
 * again. Opening them to users means an admin can now, with one tap, delete the
 * stage 400 deals are sitting on, leave a funnel with zero stages, or hand the
 * org two "won" stages — each of which silently breaks the funnel report rather
 * than failing loudly.
 *
 * The single most important rule in this file: **nothing here may write
 * `Deal.stage_entered_at` unless a deal actually changed stage by a human
 * moving it.** That column is the sole input to the stalled-deal report
 * (`DealsController.evaluateStale`), so touching it while merely reordering or
 * reorganising stages would reset every stall clock in the org at once and make
 * the report read "nothing is stuck" for the following two weeks. Reordering
 * writes ONLY `PipelineStage.position`; deleting a stage carries the deals'
 * existing `stage_entered_at` across unchanged.
 */

import { db } from './db';
import { DealStatus } from '@prisma/client';
import { stageBelongsToPipeline, type DomainError } from './deal-domain';
import {
  DEFAULT_PIPELINE_STAGE_NAMES,
  OPTIONAL_STAGE_LIBRARY,
  findStageTemplate,
  type StageTemplate,
} from '../config/market';
import { fireAmoOutbound } from './amocrm/sync-worker';

// ─── Errors ───────────────────────────────────────────────────────────────────

export type PipelineErrorPayload = DomainError & {
  /** Extra machine-readable context (deal counts, the blocking stage's name). */
  details?: Record<string, unknown>;
};

export class PipelineDomainError extends Error {
  constructor(public readonly domainError: PipelineErrorPayload) {
    super(domainError.message);
    this.name = 'PipelineDomainError';
  }
}

function fail(
  httpStatus: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new PipelineDomainError({ httpStatus, code, message, details });
}

/**
 * The two partial unique indexes added by 20260801170000 are invisible to the
 * Prisma schema, so a duplicate won/lost stage arrives as a bare P2002 and,
 * uncaught, reaches the client as a 500 — an internal error for what is a
 * perfectly ordinary user mistake. Every write below that can set a flag runs
 * through here.
 *
 * The pre-flight checks in `createStage` / `updateStage` catch this first and
 * produce a better message (they can name the stage already holding the flag);
 * this is the backstop for two admins racing each other.
 */
const WON_INDEX = 'pipeline_stage_one_won_per_pipeline';
const LOST_INDEX = 'pipeline_stage_one_lost_per_pipeline';

export function stageUniqueViolation(error: unknown): PipelineErrorPayload | null {
  if (typeof error !== 'object' || error === null) return null;
  if ((error as { code?: unknown }).code !== 'P2002') return null;

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const targets = Array.isArray(target)
    ? target.map((t) => String(t))
    : typeof target === 'string'
      ? [target]
      : [];
  const joined = targets.join(',').toLowerCase();

  if (joined.includes(LOST_INDEX) || joined.includes('lost')) {
    return {
      httpStatus: 409,
      code: 'STAGE_LOST_ALREADY_EXISTS',
      message:
        'В этой воронке уже есть этап проигранных сделок. Снимите флаг с текущего этапа, прежде чем назначать новый.',
    };
  }

  if (joined.includes(WON_INDEX) || joined.includes('won')) {
    return {
      httpStatus: 409,
      code: 'STAGE_WON_ALREADY_EXISTS',
      message:
        'В этой воронке уже есть этап успешных сделок. Снимите флаг с текущего этапа, прежде чем назначать новый.',
    };
  }

  return {
    httpStatus: 409,
    code: 'STAGE_CONFLICT',
    message: 'Такой этап уже есть в этой воронке.',
  };
}

/** Runs a write, turning a P2002 from the partial indexes into a 409. */
async function guardUniqueWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    const conflict = stageUniqueViolation(err);
    if (conflict) throw new PipelineDomainError(conflict);
    throw err;
  }
}

// ─── Shapes ───────────────────────────────────────────────────────────────────

export const stageSelect = {
  id: true,
  pipeline_id: true,
  name: true,
  position: true,
  color: true,
  probability: true,
  stale_after_days: true,
  is_won_stage: true,
  is_lost_stage: true,
  is_archived: true,
  created_at: true,
  updated_at: true,
} as const;

type StageRow = {
  id: string;
  name: string;
  position: number;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  is_archived: boolean;
};

export type CreateStageInput = {
  pipeline_id: string;
  /** Either this or `name`. Pulls defaults out of OPTIONAL_STAGE_LIBRARY. */
  template_key?: string;
  name?: string;
  position?: number;
  color?: string;
  probability?: number;
  stale_after_days?: number;
  is_won_stage?: boolean;
  is_lost_stage?: boolean;
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

export type CreatePipelineInput = {
  name: string;
  description?: string;
  is_default?: boolean;
  /** Defaults to DEFAULT_PIPELINE_STAGE_NAMES — a pipeline with no stages is unusable. */
  stage_names?: string[];
};

export type UpdatePipelineInput = {
  name?: string;
  description?: string | null;
  is_default?: boolean;
};

// ─── Pure helpers (no database — unit-testable on their own) ──────────────────

/** Stage names are compared case- and whitespace-insensitively, and «ё» folds to «е». */
export function normalizeStageName(name: string): string {
  return name.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * `ordered_ids` has to be a PERMUTATION of the pipeline's stages — not a subset,
 * not a superset, no repeats. A subset would silently leave the omitted stages
 * sharing a position with a listed one; a superset would be an attempt to drag a
 * stage in from another pipeline (or another org).
 */
export function orderedIdsMatchStageSet(
  orderedIds: readonly string[],
  currentIds: readonly string[],
): boolean {
  if (orderedIds.length !== currentIds.length) return false;
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return currentIds.every((id) => seen.has(id));
}

/** Where a new stage lands: an explicit position is clamped, otherwise append. */
export function resolveInsertPosition(
  requested: number | undefined,
  siblings: readonly { position: number }[],
): number {
  if (requested === undefined) {
    return siblings.reduce((max, s) => Math.max(max, s.position + 1), 0);
  }
  return Math.max(0, Math.min(requested, siblings.length));
}

// ─── Lookups that also enforce org scope ──────────────────────────────────────

/**
 * Guard 1. Every lookup filters on the ORGANISATION, and a miss is a 404 with
 * the same body whether the row belongs to somebody else or does not exist at
 * all — a 403 here would confirm the id is real to a caller in another tenant.
 */
async function requirePipeline(pipelineId: string, orgId: string) {
  const pipeline = await db.pipeline.findFirst({
    where: { id: pipelineId, organization_id: orgId },
    select: { id: true, name: true, is_default: true, organization_id: true },
  });
  if (!pipeline) {
    fail(404, 'PIPELINE_NOT_FOUND', 'Воронка не найдена.');
  }
  return pipeline;
}

async function requireStage(stageId: string, orgId: string) {
  const stage = await db.pipelineStage.findFirst({
    where: { id: stageId, pipeline: { organization_id: orgId } },
    select: stageSelect,
  });
  if (!stage) {
    fail(404, 'STAGE_NOT_FOUND', 'Этап не найден.');
  }
  return stage;
}

async function siblingStages(pipelineId: string, exceptStageId?: string): Promise<StageRow[]> {
  return db.pipelineStage.findMany({
    where: {
      pipeline_id: pipelineId,
      ...(exceptStageId ? { id: { not: exceptStageId } } : {}),
    },
    select: {
      id: true,
      name: true,
      position: true,
      is_won_stage: true,
      is_lost_stage: true,
      is_archived: true,
    },
    orderBy: { position: 'asc' },
  }) as unknown as Promise<StageRow[]>;
}

function assertNameFree(siblings: readonly StageRow[], name: string): void {
  const normalized = normalizeStageName(name);
  const clash = siblings.find((s) => normalizeStageName(s.name) === normalized);
  if (clash) {
    fail(409, 'STAGE_NAME_TAKEN', `Этап «${clash.name}» уже есть в этой воронке.`, {
      stage_id: clash.id,
    });
  }
}

/**
 * Guard 5, the readable half. The partial unique index is the one that cannot be
 * raced past, but it can only say "duplicate key"; this can say which stage is
 * already holding the flag, which is the difference between an error a user can
 * act on and one they file a support ticket about.
 */
function assertFlagsFree(
  siblings: readonly StageRow[],
  wantsWon: boolean,
  wantsLost: boolean,
): void {
  if (wantsWon) {
    const holder = siblings.find((s) => s.is_won_stage);
    if (holder) {
      fail(
        409,
        'STAGE_WON_ALREADY_EXISTS',
        `В этой воронке уже есть этап успешных сделок — «${holder.name}». Снимите флаг с него, прежде чем назначать новый.`,
        { stage_id: holder.id },
      );
    }
  }

  if (wantsLost) {
    const holder = siblings.find((s) => s.is_lost_stage);
    if (holder) {
      fail(
        409,
        'STAGE_LOST_ALREADY_EXISTS',
        `В этой воронке уже есть этап проигранных сделок — «${holder.name}». Снимите флаг с него, прежде чем назначать новый.`,
        { stage_id: holder.id },
      );
    }
  }
}

// ─── Stages: read ─────────────────────────────────────────────────────────────

export async function listStages(pipelineId: string, orgId: string) {
  await requirePipeline(pipelineId, orgId);
  return db.pipelineStage.findMany({
    where: { pipeline_id: pipelineId },
    select: { ...stageSelect, _count: { select: { deals: true } } },
    orderBy: { position: 'asc' },
  });
}

export type StageLibraryEntry = StageTemplate & { already_added: boolean };

/**
 * The suggestion menu, annotated for ONE pipeline. `already_added` is matched on
 * the normalized name rather than the key because PipelineStage has no
 * template_key column — a stage created from a template and one typed by hand
 * with the same name are the same stage as far as the user is concerned.
 */
export async function stageLibraryForPipeline(
  orgId: string,
  pipelineId?: string,
): Promise<{ pipeline_id: string | null; entries: StageLibraryEntry[] }> {
  const pipeline = pipelineId
    ? await requirePipeline(pipelineId, orgId)
    : await db.pipeline.findFirst({
        where: { organization_id: orgId },
        select: { id: true, name: true, is_default: true, organization_id: true },
        orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
      });

  const existing = pipeline
    ? await db.pipelineStage.findMany({
        where: { pipeline_id: pipeline.id },
        select: { name: true },
      })
    : [];

  const taken = new Set(existing.map((s) => normalizeStageName(s.name)));

  return {
    pipeline_id: pipeline?.id ?? null,
    entries: OPTIONAL_STAGE_LIBRARY.map((template) => ({
      ...template,
      already_added: taken.has(normalizeStageName(template.name)),
    })),
  };
}

// ─── Stages: create ───────────────────────────────────────────────────────────

export async function createStage(orgId: string, input: CreateStageInput) {
  const template = input.template_key ? findStageTemplate(input.template_key) : undefined;
  if (input.template_key && !template) {
    fail(400, 'STAGE_TEMPLATE_NOT_FOUND', 'Неизвестный шаблон этапа.', {
      template_key: input.template_key,
    });
  }

  await requirePipeline(input.pipeline_id, orgId);

  const name = (input.name ?? template?.name ?? '').trim();
  if (!name) {
    fail(400, 'STAGE_NAME_REQUIRED', 'Укажите название этапа.');
  }

  const isWon = input.is_won_stage ?? template?.is_won_stage ?? false;
  const isLost = input.is_lost_stage ?? template?.is_lost_stage ?? false;
  if (isWon && isLost) {
    fail(
      400,
      'STAGE_FLAGS_CONFLICT',
      'Этап не может быть одновременно успешным и проигранным.',
    );
  }

  const siblings = await siblingStages(input.pipeline_id);
  assertNameFree(siblings, name);
  assertFlagsFree(siblings, isWon, isLost);

  const position = resolveInsertPosition(input.position, siblings);
  const needsShift = siblings.some((s) => s.position >= position);

  return guardUniqueWrite(() =>
    db.$transaction(async (tx) => {
      if (needsShift) {
        await tx.pipelineStage.updateMany({
          where: { pipeline_id: input.pipeline_id, position: { gte: position } },
          data: { position: { increment: 1 } },
        });
      }

      return tx.pipelineStage.create({
        data: {
          pipeline_id: input.pipeline_id,
          name,
          position,
          color: input.color ?? template?.color ?? null,
          probability: input.probability ?? template?.probability ?? null,
          stale_after_days: input.stale_after_days ?? null,
          is_won_stage: isWon,
          is_lost_stage: isLost,
        },
        select: stageSelect,
      });
    }),
  );
}

// ─── Stages: update ───────────────────────────────────────────────────────────

export async function updateStage(stageId: string, orgId: string, patch: UpdateStageInput) {
  const stage = await requireStage(stageId, orgId);

  const nextWon = patch.is_won_stage ?? stage.is_won_stage;
  const nextLost = patch.is_lost_stage ?? stage.is_lost_stage;
  if (nextWon && nextLost) {
    fail(
      400,
      'STAGE_FLAGS_CONFLICT',
      'Этап не может быть одновременно успешным и проигранным.',
    );
  }

  // Reports and forecasting resolve the successful outcome by finding THE won
  // stage. The partial index prevents two, but it cannot prevent zero. Keep
  // that other half of the invariant at every stage mutation boundary.
  if (stage.is_won_stage && patch.is_won_stage === false) {
    fail(
      409,
      'STAGE_WON_REQUIRED',
      'В воронке должен остаться один этап успешной сделки. Сначала назначьте другой.',
      { stage_id: stage.id },
    );
  }

  const siblings = await siblingStages(stage.pipeline_id, stage.id);

  if (patch.name !== undefined && normalizeStageName(patch.name) !== normalizeStageName(stage.name)) {
    assertNameFree(siblings, patch.name);
  }

  // A won-stage change is an atomic hand-over: the old flag is cleared in the
  // same transaction that sets this one. Requiring two separate PATCHes would
  // either leave a transient funnel with no won stage or make the exact-one
  // invariant impossible to preserve. Lost is optional, so it keeps the
  // explicit clear-then-set behaviour.
  assertFlagsFree(siblings, false, nextLost && !stage.is_lost_stage);

  // Archiving is the soft alternative to deleting, so it inherits the same
  // floor: a pipeline whose every stage is archived shows an empty kanban and
  // cannot accept a new deal.
  if (patch.is_archived === true && !stage.is_archived) {
    const otherActive = siblings.filter((s) => !s.is_archived).length;
    if (otherActive === 0) {
      fail(
        409,
        'STAGE_LAST_ACTIVE',
        'Нельзя архивировать последний активный этап воронки.',
      );
    }
    if (stage.is_won_stage) {
      fail(
        409,
        'STAGE_WON_REQUIRED',
        'Этап успешной сделки нельзя архивировать. Сначала назначьте другой.',
        { stage_id: stage.id },
      );
    }
    const openDealCount = await db.deal.count({
      where: { stage_id: stage.id, organization_id: orgId, status: DealStatus.open },
    });
    if (openDealCount > 0) {
      fail(
        409,
        'STAGE_HAS_OPEN_DEALS',
        'На этапе есть открытые сделки. Сначала перенесите их на активный этап.',
        { deal_count: openDealCount },
      );
    }
  }

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.color !== undefined) data.color = patch.color;
  if (patch.probability !== undefined) data.probability = patch.probability;
  if (patch.stale_after_days !== undefined) data.stale_after_days = patch.stale_after_days;
  if (patch.is_archived !== undefined) data.is_archived = patch.is_archived;
  if (patch.is_won_stage !== undefined) data.is_won_stage = patch.is_won_stage;
  if (patch.is_lost_stage !== undefined) data.is_lost_stage = patch.is_lost_stage;

  return guardUniqueWrite(() =>
    db.$transaction(async (tx) => {
      if (nextWon && !stage.is_won_stage) {
        await tx.pipelineStage.updateMany({
          where: { pipeline_id: stage.pipeline_id, is_won_stage: true, id: { not: stageId } },
          data: { is_won_stage: false },
        });
      }

      return tx.pipelineStage.update({
        where: { id: stageId },
        data,
        select: stageSelect,
      });
    }),
  );
}

// ─── Stages: delete ───────────────────────────────────────────────────────────

export type DeleteStageResult = {
  deleted_stage_id: string;
  moved_deals: number;
  moved_to: string | null;
};

export async function deleteStage(
  stageId: string,
  orgId: string,
  moveTo?: string,
): Promise<DeleteStageResult> {
  const stage = await requireStage(stageId, orgId);

  // Guard 2. A pipeline with zero stages cannot be drawn, cannot accept a deal,
  // and cannot be repaired from the kanban — the "add stage" control lives in
  // the stage list itself.
  const stageCount = await db.pipelineStage.count({ where: { pipeline_id: stage.pipeline_id } });
  if (stageCount <= 1) {
    fail(409, 'STAGE_LAST_IN_PIPELINE', 'Нельзя удалить единственный этап воронки.');
  }

  if (stage.is_won_stage) {
    fail(
      409,
      'STAGE_WON_REQUIRED',
      'Этап успешной сделки нельзя удалить. Сначала назначьте другой.',
      { stage_id: stage.id },
    );
  }

  // Guard 3. Deals reference the stage by foreign key, so this is also what
  // stops Postgres from raising a raw constraint violation at the client.
  const dealCount = await db.deal.count({
    where: { stage_id: stageId, organization_id: orgId },
  });

  if (dealCount > 0) {
    if (!moveTo) {
      fail(
        409,
        'STAGE_HAS_DEALS',
        `На этапе ${dealCount} ${pluralDeals(dealCount)}. Укажите этап, в который их перенести.`,
        { deal_count: dealCount },
      );
    }

    if (moveTo === stageId) {
      fail(
        400,
        'STAGE_MOVE_TARGET_SAME',
        'Нельзя перенести сделки в удаляемый этап.',
      );
    }

    const targetOk = await stageBelongsToPipeline(moveTo, stage.pipeline_id, orgId);
    if (!targetOk) {
      fail(
        400,
        'STAGE_MOVE_TARGET_INVALID',
        'Этап для переноса должен принадлежать той же воронке.',
      );
    }
  }

  const movedDealIds = dealCount > 0 && moveTo
    ? (await db.deal.findMany({
        where: { stage_id: stageId, organization_id: orgId },
        select: { id: true },
      })).map((deal) => deal.id)
    : [];

  await db.$transaction(async (tx) => {
    if (dealCount > 0 && moveTo) {
      // `stage_entered_at` is deliberately absent from this update. The deal did
      // not progress — an administrator reorganised the funnel underneath it —
      // so its stall clock keeps running. Writing it here would clear the
      // stalled-deal report for every deal on the deleted stage at once, which
      // is the loudest possible way to hide the deals that most need attention.
      await tx.deal.updateMany({
        where: { stage_id: stageId, organization_id: orgId },
        data: { stage_id: moveTo },
      });
    }

    await tx.pipelineStage.delete({ where: { id: stageId } });
  });

  // Moving deals as part of stage retirement is still a real stage change for
  // amoCRM, even though it deliberately preserves 4KUB's stall clock. Enqueue
  // only after the transaction commits so an outbound worker can never observe
  // a move that was rolled back locally.
  if (movedDealIds.length > 0) {
    const movedDeals = await db.deal.findMany({
      where: { id: { in: movedDealIds }, organization_id: orgId },
    });
    for (const deal of movedDeals) {
      fireAmoOutbound({
        organizationId: orgId,
        entityType: 'lead',
        operation: 'stage_change',
        localId: deal.id,
        record: deal as unknown as Record<string, unknown>,
      });
    }
  }

  return {
    deleted_stage_id: stageId,
    moved_deals: dealCount > 0 && moveTo ? dealCount : 0,
    moved_to: dealCount > 0 && moveTo ? moveTo : null,
  };
}

function pluralDeals(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'сделок';
  if (mod10 === 1) return 'сделка';
  if (mod10 >= 2 && mod10 <= 4) return 'сделки';
  return 'сделок';
}

// ─── Stages: reorder ──────────────────────────────────────────────────────────

/**
 * Guard 4 + guard 7.
 *
 * Writes `position` on the pipeline's stages and NOTHING else — in particular
 * not one column on `Deal`. Dragging a column in the kanban must not register
 * as "every deal in the org just moved".
 */
export async function reorderStages(
  pipelineId: string,
  orgId: string,
  orderedIds: readonly string[],
) {
  await requirePipeline(pipelineId, orgId);

  const current = await db.pipelineStage.findMany({
    where: { pipeline_id: pipelineId },
    select: { id: true },
    orderBy: { position: 'asc' },
  });

  if (!orderedIdsMatchStageSet(orderedIds, current.map((s) => s.id))) {
    fail(
      400,
      'STAGE_ORDER_MISMATCH',
      'Список этапов не совпадает с текущими этапами воронки.',
      { expected: current.length, received: orderedIds.length },
    );
  }

  // One transaction: a half-applied reorder leaves two stages on the same
  // position, and the kanban then renders them in an arbitrary order that
  // differs per request.
  await db.$transaction(
    orderedIds.map((id, index) =>
      db.pipelineStage.update({
        where: { id },
        data: { position: index },
      }),
    ),
  );

  return db.pipelineStage.findMany({
    where: { pipeline_id: pipelineId },
    select: stageSelect,
    orderBy: { position: 'asc' },
  });
}

// ─── Pipelines ────────────────────────────────────────────────────────────────

export async function getPipeline(pipelineId: string, orgId: string) {
  await requirePipeline(pipelineId, orgId);
  return db.pipeline.findFirst({
    where: { id: pipelineId, organization_id: orgId },
    include: {
      stages: { orderBy: { position: 'asc' } },
      _count: { select: { deals: true } },
    },
  });
}

export async function createPipeline(
  orgId: string,
  userId: string | null,
  input: CreatePipelineInput,
) {
  const name = input.name.trim();
  if (!name) {
    fail(400, 'PIPELINE_NAME_REQUIRED', 'Укажите название воронки.');
  }

  const existing = await db.pipeline.findFirst({
    where: { organization_id: orgId, name },
    select: { id: true },
  });
  if (existing) {
    fail(409, 'PIPELINE_NAME_TAKEN', `Воронка «${name}» уже существует.`, {
      pipeline_id: existing.id,
    });
  }

  // A pipeline with no stages cannot be used and — because of guard 2 — cannot
  // be fixed by deleting anything, so one is never created empty. The last of
  // the four defaults carries is_won_stage, matching what registration builds.
  const stageNames =
    input.stage_names && input.stage_names.length > 0
      ? input.stage_names.map((s) => s.trim()).filter(Boolean)
      : [...DEFAULT_PIPELINE_STAGE_NAMES];

  if (stageNames.length === 0) {
    fail(400, 'PIPELINE_STAGES_REQUIRED', 'В воронке должен быть хотя бы один этап.');
  }

  return guardUniqueWrite(() =>
    db.$transaction(async (tx) => {
      if (input.is_default) {
        await tx.pipeline.updateMany({
          where: { organization_id: orgId, is_default: true },
          data: { is_default: false },
        });
      }

      const pipeline = await tx.pipeline.create({
        data: {
          organization_id: orgId,
          name,
          description: input.description ?? null,
          is_default: input.is_default ?? false,
          created_by: userId ?? undefined,
        },
      });

      await tx.pipelineStage.createMany({
        data: stageNames.map((stageName, index) => ({
          pipeline_id: pipeline.id,
          name: stageName,
          position: index,
          // Every funnel needs exactly one successful outcome for reports and
          // forecasts. For custom names we cannot infer semantics, so the final
          // supplied stage is the least-surprising initial choice.
          is_won_stage: index === stageNames.length - 1,
          is_lost_stage: false,
        })),
      });

      return tx.pipeline.findFirst({
        where: { id: pipeline.id },
        include: { stages: { orderBy: { position: 'asc' } } },
      });
    }),
  );
}

export async function updatePipeline(
  pipelineId: string,
  orgId: string,
  patch: UpdatePipelineInput,
) {
  await requirePipeline(pipelineId, orgId);

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) {
      fail(400, 'PIPELINE_NAME_REQUIRED', 'Укажите название воронки.');
    }
    const clash = await db.pipeline.findFirst({
      where: { organization_id: orgId, name, id: { not: pipelineId } },
      select: { id: true },
    });
    if (clash) {
      fail(409, 'PIPELINE_NAME_TAKEN', `Воронка «${name}» уже существует.`, {
        pipeline_id: clash.id,
      });
    }
  }

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.is_default !== undefined) data.is_default = patch.is_default;

  return db.$transaction(async (tx) => {
    if (patch.is_default === true) {
      await tx.pipeline.updateMany({
        where: { organization_id: orgId, is_default: true, id: { not: pipelineId } },
        data: { is_default: false },
      });
    }

    return tx.pipeline.update({
      where: { id: pipelineId },
      data,
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  });
}

export type DeletePipelineResult = { deleted_pipeline_id: string; deleted_stages: number };

export async function deletePipeline(
  pipelineId: string,
  orgId: string,
): Promise<DeletePipelineResult> {
  const pipeline = await requirePipeline(pipelineId, orgId);

  const pipelineCount = await db.pipeline.count({ where: { organization_id: orgId } });
  if (pipelineCount <= 1) {
    fail(409, 'PIPELINE_LAST', 'Нельзя удалить единственную воронку организации.');
  }

  if (pipeline.is_default) {
    fail(
      409,
      'PIPELINE_IS_DEFAULT',
      'Сначала назначьте основной другую воронку, затем удалите эту.',
    );
  }

  const stages = await db.pipelineStage.findMany({
    where: { pipeline_id: pipelineId },
    select: { id: true },
  });
  const stageIds = stages.map((s) => s.id);

  // Guard 6. Both columns are checked because `Deal.pipeline_id` is nullable: a
  // deal can sit on one of these stages while its pipeline_id is null, and
  // deleting the stage under it would fail on the foreign key — as a 500.
  const dealCount = await db.deal.count({
    where: {
      organization_id: orgId,
      OR: [
        { pipeline_id: pipelineId },
        ...(stageIds.length > 0 ? [{ stage_id: { in: stageIds } }] : []),
      ],
    },
  });

  if (dealCount > 0) {
    fail(
      409,
      'PIPELINE_HAS_DEALS',
      `В воронке ${dealCount} ${pluralDeals(dealCount)}. Перенесите их в другую воронку, прежде чем удалять эту.`,
      { deal_count: dealCount },
    );
  }

  await db.$transaction(async (tx) => {
    await tx.pipelineStage.deleteMany({ where: { pipeline_id: pipelineId } });
    await tx.pipeline.delete({ where: { id: pipelineId } });
  });

  return { deleted_pipeline_id: pipelineId, deleted_stages: stageIds.length };
}
