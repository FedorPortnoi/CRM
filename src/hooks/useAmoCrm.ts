import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';
import {
  type AmoImportPreview,
  type AmoImportRequest,
  type AmoImportResult,
  type AmoReconcileResult,
  type AmoStatus,
  roleCanImportAmo,
  roleCanManageAmo,
} from './amocrmTypes';

export * from './amocrmTypes';

type Envelope<T> = {
  data?: T;
  error?: { code?: string; message?: string };
};

export class AmoApiError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(code: string | null, message: string, status: number) {
    super(message);
    this.name = 'AmoApiError';
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
    throw new AmoApiError(
      body?.error?.code ?? null,
      body?.error?.message ?? fallback,
      response.status,
    );
  }
  if (body?.data === undefined) {
    throw new AmoApiError(null, fallback, response.status);
  }
  return body.data;
}

export function useAmoCrm() {
  const token = useUserStore((state) => state.token);
  const role = useUserStore((state) => state.user?.role);
  const queryClient = useQueryClient();
  const canManage = roleCanManageAmo(role);
  const canImport = roleCanImportAmo(role);
  const [awaitingOAuth, setAwaitingOAuth] = useState(false);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit, fallback = 'amoCRM request failed'): Promise<T> => {
      const response = await fetch(`${API_URL}${path}`, {
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

  const statusQuery = useQuery<AmoStatus, Error>({
    queryKey: ['amocrm', 'status', token],
    queryFn: () => request<AmoStatus>('/amocrm/status', undefined, 'Could not load amoCRM status'),
    enabled: !!token && canManage,
    retry: false,
  });

  const previewQuery = useQuery<AmoImportPreview, Error>({
    queryKey: ['amocrm', 'import-preview', token],
    queryFn: () =>
      request<AmoImportPreview>(
        '/import/amocrm/preview',
        undefined,
        'Could not preview the amoCRM import',
      ),
    enabled:
      !!token &&
      canManage &&
      statusQuery.data?.connected === true &&
      statusQuery.data.status === 'active',
    retry: false,
  });

  const refreshAfterOAuth = useCallback(() => {
    if (!awaitingOAuth) return;
    setAwaitingOAuth(false);
    void queryClient.invalidateQueries({ queryKey: ['amocrm'] });
  }, [awaitingOAuth, queryClient]);

  useEffect(() => {
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshAfterOAuth();
    });
    const link = Linking.addEventListener('url', refreshAfterOAuth);
    return () => {
      appState.remove();
      link.remove();
    };
  }, [refreshAfterOAuth]);

  const connectMutation = useMutation<{ auth_url: string }, Error>({
    mutationFn: async () => {
      const result = await request<{ auth_url: string }>(
        '/amocrm/connect?redirect=false',
        undefined,
        'Could not start amoCRM authorization',
      );
      setAwaitingOAuth(true);
      await Linking.openURL(result.auth_url);
      return result;
    },
    onError: () => setAwaitingOAuth(false),
  });

  const importMutation = useMutation<AmoImportResult, Error, AmoImportRequest>({
    mutationFn: (body) =>
      request<AmoImportResult>(
        '/import/amocrm',
        { method: 'POST', body: JSON.stringify(body) },
        'Could not import from amoCRM',
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['amocrm', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['amocrm', 'import-preview'] });
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
    },
  });

  const reconcileMutation = useMutation<AmoReconcileResult, Error>({
    mutationFn: () =>
      request<AmoReconcileResult>(
        '/amocrm/reconcile',
        { method: 'POST' },
        'Could not reconcile amoCRM',
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['amocrm', 'status'] }),
  });

  const subscribeMutation = useMutation<{ subscribed: boolean; webhook_count: number }, Error>({
    mutationFn: () =>
      request<{ subscribed: boolean; webhook_count: number }>(
        '/amocrm/webhooks/subscribe',
        { method: 'POST' },
        'Could not subscribe to amoCRM changes',
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['amocrm', 'status'] }),
  });

  return {
    canManage,
    canImport,
    awaitingOAuth,
    statusQuery,
    previewQuery,
    connectMutation,
    importMutation,
    reconcileMutation,
    subscribeMutation,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['amocrm'] }),
  };
}
