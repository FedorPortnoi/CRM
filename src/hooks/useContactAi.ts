// Data layer for the AI helpers on the contacts resource.
//
// Backend: POST /api/v1/ai/contacts/:id/summary          -> ContactSummary
//          POST /api/v1/ai/contacts/autofill   { text }  -> ContactAutofillResult
//          (routes in backend/api/routes/contact-ai.ts, logic in backend/services/contact-ai.ts)
//
// Both are mutations and neither is a query, for two reasons beyond the HTTP verb:
//   1. Every call spends YandexGPT quota. A query would refetch on mount, on focus and
//      on reconnect, billing the org for summaries nobody asked to read.
//   2. A summary names the contact and retells their history. Query results are
//      dehydrated into the PLAINTEXT AsyncStorage cache (see shouldDehydrateQuery in
//      utils/queryClient.ts); mutation results are not persisted unless the mutation
//      was paused offline, and a paused mutation here carries only the contact id.
//
// Errors surface as a ContactAiError carrying the server's `code`. The screen maps the
// code to a Russian sentence — the server's own message is operator-facing English
// ("the service account is missing ai.languageModels.user") and is never rendered.
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

/**
 * The availability probe for these endpoints is the assistant's own status query,
 * re-exported so a screen has a single data import.
 *
 * There is ONE provider client in the backend — backend/services/yandex-gpt.ts, called
 * by both assistant.ts and contact-ai.ts — so `configured` answers for the contact
 * helpers too, and sharing the query key means opening a contact right after the
 * assistant screen costs no second request.
 */
export { useAssistantStatus, type AssistantStatus } from './useAssistant';

/** Mirrors AUTOFILL_MAX_INPUT_CHARS in backend/services/contact-ai.ts. */
export const CONTACT_AUTOFILL_MAX_INPUT_CHARS = 4_000;

// ─── Who may call these at all ────────────────────────────────────────────────

/**
 * Roles that hold at least one write capability in backend/services/capabilities.ts.
 *
 * Both endpoints are POST, and backend/api/authenticate.ts refuses every non-GET from a
 * role with no write capability (`hasAnyWriteCapability`) — so for those roles the
 * request is a guaranteed 403 that never reaches the model. The button must not be drawn.
 *
 * Stated as an ALLOW-list on purpose. `role !== 'viewer'` is the deny-list-of-one that
 * capabilities.ts exists to kill: it silently admits `accountant`, which holds no write
 * capability either and would get the same 403. A role added later and forgotten here
 * loses a button, which is recoverable; the other direction ships a dead one.
 *
 * The backend is authoritative. This list only decides what to render.
 */
const ROLES_WITH_WRITE_CAPABILITY = new Set<string>([
  'owner',
  'admin',
  'head',
  'member',
  'marketer',
  'support',
]);

export function roleCanUseContactAi(role: string | null | undefined): boolean {
  return typeof role === 'string' && ROLES_WITH_WRITE_CAPABILITY.has(role);
}

// ─── Wire types (backend/services/contact-ai.ts) ──────────────────────────────

export type ContactSummary = {
  contact_id: string;
  /** 2–4 Russian sentences on the state of the relationship. */
  summary: string;
  next_action: string | null;
  provider: string;
  generated_at: string;
  /** What the model was actually given — the basis for the prose above. */
  context_counts: { deals: number; tasks: number; activities: number };
  last_activity_at: string | null;
};

export type ContactFieldSuggestion = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  position: string | null;
};

export type ContactAutofillResult = {
  suggestion: ContactFieldSuggestion;
  /** Always false — the endpoint never writes. The user confirms, then a contact write follows. */
  applied: false;
  provider: string;
  generated_at: string;
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Codes backend/services/contact-ai.ts and the global error handler can produce.
 * Deliberately a superset of the assistant's union rather than a reuse of it: only this
 * path can answer NOT_FOUND (contact absent, other org, or outside the visibility cone,
 * all collapsed into one status so the endpoint cannot be used to probe) or
 * AI_INVALID_RESPONSE (autofill needs parsable JSON where a summary can fall back to
 * prose).
 */
export type ContactAiErrorCode =
  | 'SERVICE_NOT_CONFIGURED'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_EMPTY_RESPONSE'
  | 'AI_INVALID_RESPONSE'
  | 'AI_REQUEST_FAILED'
  | 'NOT_FOUND'
  | 'TEXT_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'INVALID_ID'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class ContactAiError extends Error {
  readonly code: ContactAiErrorCode;
  readonly status: number;

  constructor(status: number, code: ContactAiErrorCode) {
    // The retry policy in utils/queryClient keys off "status 401" in the message.
    super(`Contact AI request failed with status ${status} (${code})`);
    this.name = 'ContactAiError';
    this.code = code;
    this.status = status;
  }
}

export function contactAiErrorCode(error: unknown): ContactAiErrorCode {
  return error instanceof ContactAiError ? error.code : 'UNKNOWN';
}

/** Codes that mean "this deployment has no model", not "this attempt failed". */
export function isContactAiOffCode(code: ContactAiErrorCode | null): boolean {
  return code === 'SERVICE_NOT_CONFIGURED';
}

type ErrorEnvelope = { error?: { code?: string } };

async function contactAiRequest<T>(path: string, token: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_URL}/ai${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // No response at all — offline, DNS, TLS. Never a provider fault, so it must not
    // be reported as one.
    throw new ContactAiError(0, 'NETWORK_ERROR');
  }

  const parsed = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const code = ((parsed as ErrorEnvelope | null)?.error?.code ?? 'UNKNOWN') as ContactAiErrorCode;
    throw new ContactAiError(res.status, code);
  }

  return (parsed as { data: T }).data;
}

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Summarize the relationship with one contact and suggest a next step.
 *
 * Nothing is invalidated on success because nothing was written — the endpoint reads the
 * contact, its deals, tasks and activity, and returns prose. Not even an audit row, so
 * no cached query can be stale afterwards.
 */
export function useContactSummary(
  contactId: string | null,
): UseMutationResult<ContactSummary, Error, void> {
  const token = useUserStore((s) => s.token);

  return useMutation<ContactSummary, Error, void>({
    mutationFn: () =>
      contactAiRequest<ContactSummary>(`/contacts/${contactId ?? ''}/summary`, token ?? ''),
  });
}

/**
 * Infer first name, last name, company and position from free text — a note, an email
 * signature block.
 *
 * A SUGGESTION only: `applied` is always false and the server writes nothing, so the
 * caller has to show the fields for confirmation and then go through the normal contact
 * create/update endpoints. Email and phone are NOT among the fields — the server masks
 * them out of the text before the model sees it (ФЗ-152 ст. 5 ч. 5), and
 * backend/services/contact-recognition.ts already extracts those two locally and
 * deterministically, without a language model.
 */
export function useContactAutofill(): UseMutationResult<ContactAutofillResult, Error, string> {
  const token = useUserStore((s) => s.token);

  return useMutation<ContactAutofillResult, Error, string>({
    mutationFn: (text) =>
      contactAiRequest<ContactAutofillResult>('/contacts/autofill', token ?? '', {
        // The route schema trims and then requires at least one character, so a
        // whitespace-only draft is a 400 rather than a wasted model call.
        text: text.trim().slice(0, CONTACT_AUTOFILL_MAX_INPUT_CHARS),
      }),
  });
}
