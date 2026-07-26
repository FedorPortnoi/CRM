// Data layer for the email-sequence screens.
//
// Backend (backend/api/routes/sequences.ts) — every route is authenticated AND owner/admin:
//   GET    /sequences                        list, optional ?status=
//   POST   /sequences                        create, optionally with the first steps
//   GET    /sequences/:id                    sequence + ordered steps + active_enrollments
//   PATCH  /sequences/:id                    rename / launch / pause / resume
//   DELETE /sequences/:id                    ARCHIVE — never a delete, the send ledger is
//                                            consent evidence and has to survive
//   POST   /sequences/:id/steps              add a step (appended last)
//   POST   /sequences/:id/steps/reorder      { step_ids } in the new order
//   DELETE /sequences/:id/steps/:stepId      remove a step, positions close the gap
//   GET    /sequences/:id/enrollments        enrollments + contact (email decrypted)
//   POST   /sequences/:id/enrollments        enroll ONE contact — REFUSED without consent
//   DELETE /sequences/:id/enrollments/:eid   stop an in-flight enrollment
//
// The refusal codes are the whole point of the feature, so the error `code` is carried to
// the UI in SequenceApiError.code rather than flattened into a message. The server's
// messages are English operator text; the screens translate the code themselves.
//
// Every query key ends with the bearer token. utils/queryClient.ts refuses to persist any
// key carrying a JWT, which keeps enrollment rows — they contain a decrypted contact email
// — out of the plaintext AsyncStorage cache.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

export const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export const ENROLLMENT_STATUSES = [
  'active',
  'completed',
  'unsubscribed',
  'failed',
  'cancelled',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** Delay and position limits mirror the Zod schemas in backend/api/routes/sequences.ts. */
export const MAX_STEP_DELAY_DAYS = 365;
export const MAX_SUBJECT_LENGTH = 500;
export const MAX_BODY_LENGTH = 50_000;

export type Sequence = {
  id: string;
  name: string;
  description: string | null;
  status: SequenceStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** `position` is 0-based on the server — every screen renders `position + 1`. */
export type SequenceStep = {
  id: string;
  sequence_id: string;
  position: number;
  delay_days: number;
  template_id: string | null;
  subject: string | null;
  body: string | null;
  created_at: string;
  updated_at: string;
};

export type SequenceDetail = Sequence & {
  steps: SequenceStep[];
  active_enrollments: number;
};

export type EnrollmentContact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  email: string | null;
  marketing_consent: boolean;
  unsubscribed_at: string | null;
};

export type Enrollment = {
  id: string;
  sequence_id: string;
  contact_id: string;
  status: EnrollmentStatus;
  current_step: number;
  next_send_at: string | null;
  enrolled_at: string;
  completed_at: string | null;
  contact: EnrollmentContact | null;
};

/** A contact as the enrollment picker needs it — name plus the three consent facts. */
export type MarketingContact = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  email: string | null;
  marketing_consent: boolean;
  unsubscribed_at: string | null;
};

export type EmailTemplateOption = {
  id: string;
  name: string;
  subject: string;
};

export type StepInput = {
  delay_days: number;
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
};

export type CreateSequenceInput = {
  name: string;
  description?: string | null;
  status?: SequenceStatus;
  steps?: StepInput[];
};

/** Carries the server's `error.code` so the UI can explain the refusal instead of echoing it. */
export class SequenceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SequenceApiError';
    this.code = code;
    this.status = status;
  }
}

type Envelope<T> = { data: T; meta?: Record<string, unknown> };
type PagedEnvelope<T> = { data: T; meta: { total: number; page: number; per_page: number } };

async function apiRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });

  const body = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const envelope = body as { error?: { code?: string; message?: string } } | null;
    throw new SequenceApiError(
      envelope?.error?.code ?? 'REQUEST_FAILED',
      envelope?.error?.message ?? `Request failed with status ${res.status}`,
      res.status,
    );
  }

  return body as T;
}

/** 403/404/422 are answers, not outages — retrying them only delays the message. */
function retryServerFaultsOnly(failureCount: number, error: Error): boolean {
  if (error instanceof SequenceApiError && error.status < 500) return false;
  return failureCount < 2;
}

// ─── Query keys ───────────────────────────────────────────────────────────────

function listKey(status: SequenceStatus | 'all', token: string | null): unknown[] {
  return ['sequences', 'list', status, token];
}

function detailKey(id: string, token: string | null): unknown[] {
  return ['sequences', 'detail', id, token];
}

function enrollmentsKey(
  id: string,
  status: EnrollmentStatus | 'all',
  token: string | null,
): unknown[] {
  return ['sequences', 'enrollments', id, status, token];
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function useSequenceList(
  status: SequenceStatus | 'all',
  enabled: boolean,
): UseQueryResult<PagedEnvelope<Sequence[]>, Error> {
  const token = useUserStore((s) => s.token);
  const query = status === 'all' ? '' : `?status=${status}`;

  return useQuery<PagedEnvelope<Sequence[]>, Error>({
    queryKey: listKey(status, token),
    queryFn: () => apiRequest<PagedEnvelope<Sequence[]>>(`/sequences${query}`, token ?? ''),
    enabled: Boolean(token) && enabled,
    retry: retryServerFaultsOnly,
  });
}

export function useSequenceDetail(id: string | null): UseQueryResult<SequenceDetail, Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<SequenceDetail, Error>({
    queryKey: detailKey(id ?? '', token),
    queryFn: () =>
      apiRequest<Envelope<SequenceDetail>>(`/sequences/${id ?? ''}`, token ?? '').then(
        (body) => body.data,
      ),
    enabled: Boolean(token) && Boolean(id),
    retry: retryServerFaultsOnly,
  });
}

/**
 * Step and enrollment counts for the list rows.
 *
 * `GET /sequences` returns neither, so this reads each sequence's detail — under the exact
 * key useSequenceDetail uses, which means opening a row afterwards is served from cache.
 * A row whose count is still loading shows a placeholder rather than a wrong zero.
 */
export function useSequenceSummaries(ids: string[]): Record<string, SequenceDetail> {
  const token = useUserStore((s) => s.token);

  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: detailKey(id, token),
      queryFn: () =>
        apiRequest<Envelope<SequenceDetail>>(`/sequences/${id}`, token ?? '').then(
          (body) => body.data,
        ),
      enabled: Boolean(token),
      retry: retryServerFaultsOnly,
    })),
  });

  const summaries: Record<string, SequenceDetail> = {};
  results.forEach((result, index) => {
    const id = ids[index];
    if (id !== undefined && result.data) {
      summaries[id] = result.data;
    }
  });
  return summaries;
}

export function useSequenceEnrollments(
  id: string | null,
  status: EnrollmentStatus | 'all',
): UseQueryResult<PagedEnvelope<Enrollment[]>, Error> {
  const token = useUserStore((s) => s.token);
  const query = status === 'all' ? '' : `?status=${status}`;

  return useQuery<PagedEnvelope<Enrollment[]>, Error>({
    queryKey: enrollmentsKey(id ?? '', status, token),
    queryFn: () =>
      apiRequest<PagedEnvelope<Enrollment[]>>(
        `/sequences/${id ?? ''}/enrollments${query}`,
        token ?? '',
      ),
    enabled: Boolean(token) && Boolean(id),
    retry: retryServerFaultsOnly,
  });
}

/**
 * Contact lookup for the enrollment picker. `GET /contacts` returns the whole contact row,
 * so `marketing_consent` and `unsubscribed_at` come along — the picker can mark a contact
 * that cannot lawfully be mailed before the operator taps it.
 */
export function useMarketingContactSearch(
  term: string,
  enabled: boolean,
): UseQueryResult<MarketingContact[], Error> {
  const token = useUserStore((s) => s.token);
  const trimmed = term.trim();

  return useQuery<MarketingContact[], Error>({
    queryKey: ['sequences', 'contact-search', trimmed, token],
    queryFn: () =>
      apiRequest<PagedEnvelope<MarketingContact[]>>(
        `/contacts?q=${encodeURIComponent(trimmed)}&per_page=20`,
        token ?? '',
      ).then((body) => body.data),
    enabled: Boolean(token) && enabled && trimmed.length >= 2,
    retry: retryServerFaultsOnly,
  });
}

export function useEmailTemplateOptions(
  enabled: boolean,
): UseQueryResult<EmailTemplateOption[], Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<EmailTemplateOption[], Error>({
    queryKey: ['sequences', 'email-templates', token],
    queryFn: () =>
      apiRequest<PagedEnvelope<EmailTemplateOption[]>>(
        '/email-templates?per_page=100',
        token ?? '',
      ).then((body) => body.data),
    enabled: Boolean(token) && enabled,
    retry: retryServerFaultsOnly,
  });
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Every mutation invalidates the whole `sequences` tree. The dataset is small and the
 * relationships are dense — deleting a step renumbers the others, archiving cancels
 * enrollments — so surgical invalidation would mostly be a way to show stale numbers.
 */
function useSequenceMutation<TVars, TData>(
  mutationFn: (token: string, vars: TVars) => Promise<TData>,
): UseMutationResult<TData, Error, TVars> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<TData, Error, TVars>({
    mutationFn: (vars: TVars) => mutationFn(token ?? '', vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sequences'] });
    },
  });
}

export function useCreateSequence(): UseMutationResult<SequenceDetail, Error, CreateSequenceInput> {
  return useSequenceMutation<CreateSequenceInput, SequenceDetail>((token, input) =>
    apiRequest<Envelope<SequenceDetail>>('/sequences', token, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((body) => body.data),
  );
}

export function useUpdateSequence(
  id: string,
): UseMutationResult<SequenceDetail, Error, { name?: string; description?: string | null; status?: SequenceStatus }> {
  return useSequenceMutation<
    { name?: string; description?: string | null; status?: SequenceStatus },
    SequenceDetail
  >((token, patch) =>
    apiRequest<Envelope<SequenceDetail>>(`/sequences/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((body) => body.data),
  );
}

export function useArchiveSequence(
  id: string,
): UseMutationResult<{ id: string; cancelled_enrollments: number }, Error, void> {
  return useSequenceMutation<void, { id: string; cancelled_enrollments: number }>((token) =>
    apiRequest<Envelope<{ id: string; cancelled_enrollments: number }>>(`/sequences/${id}`, token, {
      method: 'DELETE',
    }).then((body) => body.data),
  );
}

export function useAddStep(id: string): UseMutationResult<SequenceStep, Error, StepInput> {
  return useSequenceMutation<StepInput, SequenceStep>((token, input) =>
    apiRequest<Envelope<SequenceStep>>(`/sequences/${id}/steps`, token, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((body) => body.data),
  );
}

export function useRemoveStep(id: string): UseMutationResult<{ id: string }, Error, string> {
  return useSequenceMutation<string, { id: string }>((token, stepId) =>
    apiRequest<Envelope<{ id: string }>>(`/sequences/${id}/steps/${stepId}`, token, {
      method: 'DELETE',
    }).then((body) => body.data),
  );
}

/** Takes the full ordered id list — the server rejects a partial one with INVALID_STEP_ORDER. */
export function useReorderSteps(id: string): UseMutationResult<SequenceStep[], Error, string[]> {
  return useSequenceMutation<string[], SequenceStep[]>((token, stepIds) =>
    apiRequest<Envelope<SequenceStep[]>>(`/sequences/${id}/steps/reorder`, token, {
      method: 'POST',
      body: JSON.stringify({ step_ids: stepIds }),
    }).then((body) => body.data),
  );
}

/**
 * Enroll one contact. Rejects with SequenceApiError — MARKETING_CONSENT_REQUIRED,
 * CONTACT_UNSUBSCRIBED, CONTACT_NO_EMAIL, ALREADY_ENROLLED, SEQUENCE_HAS_NO_STEPS,
 * SEQUENCE_NOT_ENROLLABLE — which the screen turns into an explanation, not a red banner.
 */
export function useEnrollContact(id: string): UseMutationResult<Enrollment, Error, string> {
  return useSequenceMutation<string, Enrollment>((token, contactId) =>
    apiRequest<Envelope<Enrollment>>(`/sequences/${id}/enrollments`, token, {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId }),
    }).then((body) => body.data),
  );
}

export function useUnenroll(id: string): UseMutationResult<Enrollment, Error, string> {
  return useSequenceMutation<string, Enrollment>((token, enrollmentId) =>
    apiRequest<Envelope<Enrollment>>(`/sequences/${id}/enrollments/${enrollmentId}`, token, {
      method: 'DELETE',
    }).then((body) => body.data),
  );
}

// ─── Consent ──────────────────────────────────────────────────────────────────

/**
 * The client-side half of the ФЗ-38 gate. The server decides — this only lets the picker
 * mark a contact before the operator taps it, and lets the refusal panel open instantly
 * instead of after a round trip. Returns the same code the API would.
 */
export function marketingBlockFor(contact: {
  email: string | null;
  marketing_consent: boolean;
  unsubscribed_at: string | null;
}): 'CONTACT_UNSUBSCRIBED' | 'MARKETING_CONSENT_REQUIRED' | 'CONTACT_NO_EMAIL' | null {
  if (contact.unsubscribed_at !== null) return 'CONTACT_UNSUBSCRIBED';
  if (!contact.marketing_consent) return 'MARKETING_CONSENT_REQUIRED';
  if (!contact.email) return 'CONTACT_NO_EMAIL';
  return null;
}

export function contactDisplayName(contact: {
  first_name: string;
  last_name: string | null;
}): string {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
}
