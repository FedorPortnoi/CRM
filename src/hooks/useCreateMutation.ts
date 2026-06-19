import { useState } from 'react';
import { sendOrQueueMutation } from '../utils/offlineMutation';

interface CreateMutationOptions<TPayload, TData> {
  endpoint: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  token: string;
  validate: () => boolean;
  buildPayload: () => TPayload;
  onSuccess: (data: TData, queued: boolean) => void | Promise<void>;
  fallbackErrorMessage?: string;
}

interface CreateMutationResult {
  isSubmitting: boolean;
  apiError: string | null;
  clearError: () => void;
  submit: () => Promise<void>;
}

interface ErrorApiResponse {
  error?: { code?: string; message?: string };
  message?: string;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object') {
    const b = body as Record<string, unknown>;

    // Branch 1: custom envelope { error: { message: string } }
    if (
      'error' in b &&
      b.error !== null &&
      typeof b.error === 'object' &&
      'message' in (b.error as Record<string, unknown>) &&
      typeof (b.error as Record<string, unknown>).message === 'string'
    ) {
      return (b.error as Record<string, unknown>).message as string;
    }

    // Branch 2: Fastify/Zod top-level { message: string }
    if ('message' in b && typeof b.message === 'string') {
      return b.message;
    }
  }
  return `Request failed with status ${status}`;
}

export function useCreateMutation<TPayload, TData = { id: string }>(
  options: CreateMutationOptions<TPayload, TData>,
): CreateMutationResult {
  const { endpoint, method = 'POST', token, validate, buildPayload, onSuccess, fallbackErrorMessage } = options;

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!validate()) return;

    setIsSubmitting(true);
    setApiError(null);

    try {
      const payload = buildPayload();

      const result = await sendOrQueueMutation({
        url: endpoint,
        method,
        token,
        body: payload,
      });

      if (result.queued) {
        await onSuccess({} as TData, true);
        return;
      }

      const res = result.response;
      const body = (await res.json()) as unknown;

      if (res.ok) {
        const responseData = (body as { data: TData }).data;
        await onSuccess(responseData, false);
      } else {
        setApiError(
          extractErrorMessage(body, res.status) ?? fallbackErrorMessage ?? 'Request failed',
        );
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : (fallbackErrorMessage ?? 'Network error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const clearError = (): void => setApiError(null);

  return { isSubmitting, apiError, clearError, submit };
}
