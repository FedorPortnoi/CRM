import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

/**
 * «Заявки с Яндекс Карт» — the lead-inbox integration.
 *
 * Same envelope/request shape as useAmoCrm: raw fetch against API_URL, the
 * bearer token in the query key so the persisted react-query cache drops
 * these rows (see the JWT_SHAPE guard in src/utils/queryClient.ts).
 */

export type LeadInboxRecentMessage = {
  id: string;
  subject: string | null;
  from_addr: string | null;
  status: 'claimed' | 'processed' | 'failed' | 'duplicate' | string;
  error: string | null;
  contact_id: string | null;
  deal_id: string | null;
  received_at: string | null;
  created_at: string;
};

export type LeadInboxStatusPayload = {
  configured: boolean;
  id?: string;
  mode?: 'collector' | 'custom';
  intake_token?: string | null;
  /** The one string a collector-mode user ever touches. */
  intake_address?: string | null;
  imap_host?: string;
  imap_port?: number;
  imap_user?: string | null;
  pipeline_id?: string | null;
  stage_id?: string | null;
  assigned_to?: string | null;
  source_label?: string;
  status?: 'active' | 'paused' | 'error';
  last_polled_at?: string | null;
  last_error?: string | null;
  messages_total?: number;
  recent_messages?: LeadInboxRecentMessage[];
};

export type LeadInboxTestResult = {
  ok: boolean;
  error?: string;
  scanned?: number;
  created?: number;
  duplicates?: number;
  failed?: number;
};

type Envelope<T> = {
  data?: T;
  error?: { code?: string; message?: string };
};

export class LeadInboxApiError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(code: string | null, message: string, status: number) {
    super(message);
    this.name = 'LeadInboxApiError';
    this.code = code;
    this.status = status;
  }
}

async function readEnvelope<T>(response: Response, fallback: string): Promise<T> {
  let body: Envelope<T> | null = null;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    // A proxy may answer HTML. Use the local fallback rather than rendering it.
  }

  if (!response.ok) {
    throw new LeadInboxApiError(
      body?.error?.code ?? null,
      body?.error?.message ?? fallback,
      response.status,
    );
  }
  if (body?.data === undefined) {
    throw new LeadInboxApiError(null, fallback, response.status);
  }
  return body.data;
}

export function useLeadInbox() {
  const token = useUserStore((state) => state.token);
  const role = useUserStore((state) => state.user?.role);
  const queryClient = useQueryClient();
  // Mirrors the backend's `integrations.manage` capability gate.
  const canManage = role === 'owner' || role === 'admin';

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit, fallback = 'Lead inbox request failed'): Promise<T> => {
      const response = await fetch(`${API_URL}/integrations/lead-inbox${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token ?? ''}`,
          ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
      return readEnvelope<T>(response, fallback);
    },
    [token],
  );

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['lead-inbox'] }),
    [queryClient],
  );

  const statusQuery = useQuery<LeadInboxStatusPayload, Error>({
    queryKey: ['lead-inbox', 'status', token],
    queryFn: () =>
      request<LeadInboxStatusPayload>('', undefined, 'Could not load the lead inbox status'),
    enabled: !!token && canManage,
    retry: false,
  });

  // The whole point of the feature: PUT with an empty body IS the setup. The
  // server mints the org's intake address and answers with it.
  const connectMutation = useMutation<LeadInboxStatusPayload, Error>({
    mutationFn: () =>
      request<LeadInboxStatusPayload>(
        '',
        { method: 'PUT', body: JSON.stringify({}) },
        'Could not enable the lead inbox',
      ),
    onSuccess: () => void invalidate(),
  });

  const testMutation = useMutation<LeadInboxTestResult, Error>({
    mutationFn: () =>
      request<LeadInboxTestResult>(
        '/test',
        { method: 'POST' },
        'Could not test the lead inbox connection',
      ),
    onSuccess: () => void invalidate(),
  });

  const disconnectMutation = useMutation<{ deleted: boolean }, Error>({
    mutationFn: () =>
      request<{ deleted: boolean }>('', { method: 'DELETE' }, 'Could not disable the lead inbox'),
    onSuccess: () => void invalidate(),
  });

  const refresh = useCallback(async () => {
    await invalidate();
  }, [invalidate]);

  return {
    canManage,
    statusQuery,
    connectMutation,
    testMutation,
    disconnectMutation,
    refresh,
  };
}
