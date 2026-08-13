// Data layer for the AI assistant chat screen.
//
// Backend: GET  /api/v1/assistant/status
//          POST /api/v1/assistant/messages          { message, conversation_id? }
//          POST /api/v1/assistant/transcribe        multipart { file }
//          GET  /api/v1/assistant/conversations
//          GET  /api/v1/assistant/conversations/:id
//
// Two things make this more than a thin fetch wrapper:
//
// 1. Error CODES, not messages. The provider faults come back operator-facing
//    and in English (`AI_UNAUTHORIZED: the service account is missing
//    ai.languageModels.user`). The screen needs the code to pick a Russian
//    sentence, so every failure is thrown as an AssistantRequestError carrying
//    it. SERVICE_NOT_CONFIGURED in particular is the realistic case: the role
//    may simply not be granted yet.
//
// 2. Rebuilding the tool calls from history — see utils/assistantTranscript.ts,
//    re-exported here so the screen has one import for its data.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';
import type { AssistantToolCall } from '../utils/assistantTools';
import type { AssistantApiMessage } from '../utils/assistantTranscript';

export { buildTranscript } from '../utils/assistantTranscript';
export type { AssistantApiMessage, AssistantBubble } from '../utils/assistantTranscript';

/** Mirrors MAX_USER_MESSAGE_CHARS in backend/services/assistant.ts. */
export const ASSISTANT_MAX_MESSAGE_CHARS = 4000;

export const ASSISTANT_HISTORY_PAGE_SIZE = 50;

// ─── Wire types (backend/api/controllers/assistant.ts) ────────────────────────

export type AssistantStatus = {
  configured: boolean;
  provider: string;
  max_message_length: number;
  /** Optional: absent on servers older than the voice-input release. */
  voice_input?: boolean;
};

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
};

export type AssistantConversationDetail = AssistantConversationSummary & {
  messages: AssistantApiMessage[];
};

export type AssistantSendResult = {
  conversation_id: string;
  conversation_title: string | null;
  message: AssistantApiMessage;
  tool_calls: AssistantToolCall[];
};

// ─── Errors ───────────────────────────────────────────────────────────────────

export type AssistantErrorCode =
  | 'SERVICE_NOT_CONFIGURED'
  | 'AI_UNAUTHORIZED'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_BAD_RESPONSE'
  | 'AI_REQUEST_FAILED'
  | 'VALIDATION_ERROR'
  | 'CONVERSATION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class AssistantRequestError extends Error {
  readonly code: AssistantErrorCode;
  readonly status: number;

  constructor(code: AssistantErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AssistantRequestError';
    this.code = code;
    this.status = status;
  }
}

export function assistantErrorCode(error: unknown): AssistantErrorCode {
  return error instanceof AssistantRequestError ? error.code : 'UNKNOWN';
}

type Envelope<T> = { data: T; error?: { code: string; message: string } };

async function requestAssistant<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/assistant${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        // FormData must set its own multipart boundary — forcing JSON here
        // would make the server reject the voice upload as malformed.
        ...(init.body === undefined || init.body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // No response at all — offline, DNS, TLS. Never a provider fault.
    throw new AssistantRequestError('NETWORK_ERROR', 'network request failed', 0);
  }

  let body: Envelope<T> | null = null;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    body = null;
  }

  if (!response.ok || body === null || body.data === undefined) {
    const code = (body?.error?.code ?? 'UNKNOWN') as AssistantErrorCode;
    // Message is a developer-facing fallback: the screen maps the code to a
    // localised sentence and only falls back to this when the code is new.
    throw new AssistantRequestError(
      code,
      body?.error?.message ?? `assistant request failed with status ${response.status}`,
      response.status,
    );
  }

  return body.data;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const ASSISTANT_QUERY_KEY = 'assistant';

/**
 * Config probe. It only reports that the env vars exist — a service account
 * without the ai.languageModels.user role still answers `configured: true` and
 * fails at send time with AI_UNAUTHORIZED, which the screen renders with the
 * same "not connected" copy.
 */
export function useAssistantStatus(): UseQueryResult<AssistantStatus, Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<AssistantStatus, Error>({
    queryKey: [ASSISTANT_QUERY_KEY, 'status', token],
    queryFn: () => requestAssistant<AssistantStatus>('/status', token ?? ''),
    enabled: Boolean(token),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

/** Only fetched while the history sheet is open. */
export function useAssistantConversations(
  enabled: boolean,
): UseQueryResult<AssistantConversationSummary[], Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<AssistantConversationSummary[], Error>({
    queryKey: [ASSISTANT_QUERY_KEY, 'conversations', token],
    queryFn: () =>
      requestAssistant<AssistantConversationSummary[]>(
        `/conversations?per_page=${ASSISTANT_HISTORY_PAGE_SIZE}`,
        token ?? '',
      ),
    enabled: Boolean(token) && enabled,
  });
}

export function useAssistantConversation(
  conversationId: string | null,
): UseQueryResult<AssistantConversationDetail, Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<AssistantConversationDetail, Error>({
    queryKey: [ASSISTANT_QUERY_KEY, 'conversation', conversationId, token],
    queryFn: () =>
      requestAssistant<AssistantConversationDetail>(
        `/conversations/${conversationId ?? ''}`,
        token ?? '',
      ),
    enabled: Boolean(token) && conversationId !== null,
    // A finished turn never changes, and a refetch would cost nothing but would
    // also overwrite the bubbles the screen is holding.
    staleTime: Infinity,
    retry: 0,
  });
}

export type SendAssistantMessageInput = {
  message: string;
  conversation_id?: string;
};

/**
 * One turn. The server writes nothing when a turn fails, so a retry with the
 * same text cannot duplicate the user message.
 */
export function useSendAssistantMessage(): UseMutationResult<
  AssistantSendResult,
  Error,
  SendAssistantMessageInput
> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<AssistantSendResult, Error, SendAssistantMessageInput>({
    mutationFn: (input) =>
      requestAssistant<AssistantSendResult>('/messages', token ?? '', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // The conversation list gains a row (or moves one to the top) after every
      // turn; the open sheet should not show a stale order.
      void queryClient.invalidateQueries({ queryKey: [ASSISTANT_QUERY_KEY, 'conversations'] });
      // A stored conversation is immutable right up to the moment it gains a
      // turn — without this, reopening the one just written from history would
      // replay the cached transcript and silently drop the newest answer.
      void queryClient.invalidateQueries({ queryKey: [ASSISTANT_QUERY_KEY, 'conversation'] });
    },
  });
}

// ─── Voice input ──────────────────────────────────────────────────────────────

export type TranscribeVoiceInput = {
  /** file:// URI of the finished recording (AAC in an m4a container). */
  uri: string;
};

export type TranscribeVoiceResult = { text: string };

/**
 * One recording → one transcript. The server holds the audio only for the
 * lifetime of the request and stores nothing; the transcript is placed in the
 * composer for review rather than sent, because the assistant acts on CRM
 * data and a mis-heard command should die in the text box, not in a tool call.
 */
export function useTranscribeVoice(): UseMutationResult<
  TranscribeVoiceResult,
  Error,
  TranscribeVoiceInput
> {
  const token = useUserStore((s) => s.token);

  return useMutation<TranscribeVoiceResult, Error, TranscribeVoiceInput>({
    mutationFn: ({ uri }) => {
      const form = new FormData();
      // React Native's FormData takes a file descriptor, not a Blob; the cast
      // bridges the DOM lib type that fetch's types insist on.
      form.append('file', {
        uri,
        name: 'voice-message.m4a',
        type: 'audio/m4a',
      } as unknown as Blob);
      return requestAssistant<TranscribeVoiceResult>('/transcribe', token ?? '', {
        method: 'POST',
        body: form,
      });
    },
  });
}
