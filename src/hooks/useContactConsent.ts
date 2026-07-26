// Marketing-consent state for one contact (ФЗ-38 «О рекламе», ст. 18).
//
// Backend: GET    /api/v1/consent/contacts/:contactId
//          POST   /api/v1/consent/contacts/:contactId   { source, consented_at? }
//          DELETE /api/v1/consent/contacts/:contactId
//
// The consent record IS the legal evidence, so the screen reads it back from the server after
// every write rather than patching local state — what is on screen is what an operator could
// be asked to produce.
//
// The bearer token is part of the query key, which keeps this out of the plaintext
// AsyncStorage cache (see shouldDehydrateQuery in utils/queryClient.ts): a consent record is
// personal data.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

/** Mirrors CONSENT_SOURCES in backend/services/consent.ts. */
export const CONSENT_SOURCES = [
  'form',
  'website',
  'import',
  'verbal',
  'contract',
  'event',
  'other',
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export type ConsentState = {
  contact_id: string;
  marketing_consent: boolean;
  marketing_consent_at: string | null;
  marketing_consent_source: string | null;
  unsubscribed_at: string | null;
  can_send_marketing: boolean;
  /** Only present on the withdrawal response — how many sequences the opt-out stopped. */
  stopped_enrollments?: number;
};

export class ConsentApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    // The retry policy in utils/queryClient keys off "status 401" in the message.
    super(`Consent request failed with status ${status} (${code})`);
    this.name = 'ConsentApiError';
    this.code = code;
    this.status = status;
  }
}

type ErrorEnvelope = { error?: { code?: string } };

async function consentRequest(
  contactId: string,
  token: string,
  init?: { method?: 'POST' | 'DELETE'; body?: unknown },
): Promise<ConsentState> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}/consent/contacts/${contactId}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const parsed = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const code = (parsed as ErrorEnvelope | null)?.error?.code ?? 'REQUEST_FAILED';
    throw new ConsentApiError(res.status, code);
  }

  return (parsed as { data: ConsentState }).data;
}

export function useContactConsent(contactId: string | null): UseQueryResult<ConsentState, Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<ConsentState, Error>({
    queryKey: ['contact-consent', contactId, token],
    queryFn: () => consentRequest(contactId ?? '', token ?? ''),
    enabled: Boolean(token) && Boolean(contactId),
  });
}

export function useRecordConsent(
  contactId: string | null,
): UseMutationResult<ConsentState, Error, ConsentSource> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<ConsentState, Error, ConsentSource>({
    mutationFn: (source) =>
      consentRequest(contactId ?? '', token ?? '', { method: 'POST', body: { source } }),
    onSuccess: (state) => {
      queryClient.setQueryData(['contact-consent', contactId, token], state);
      // The activity/audit log on the contact card gains a consent.recorded row.
      void queryClient.invalidateQueries({ queryKey: ['audit-log'] });
    },
  });
}

export function useWithdrawConsent(
  contactId: string | null,
): UseMutationResult<ConsentState, Error, void> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<ConsentState, Error, void>({
    mutationFn: () => consentRequest(contactId ?? '', token ?? '', { method: 'DELETE' }),
    onSuccess: (state) => {
      queryClient.setQueryData(['contact-consent', contactId, token], state);
      void queryClient.invalidateQueries({ queryKey: ['audit-log'] });
      // Withdrawal stops every active enrollment org-wide.
      void queryClient.invalidateQueries({ queryKey: ['sequences'] });
    },
  });
}
