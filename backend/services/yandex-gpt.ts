import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Thin client over the Yandex Foundation Models completion API.
//
// This file is the ONLY place that knows Yandex's wire format. Everything else
// speaks the normalized `AiMessage` / `AiCompletion` shapes below. It never
// throws: every failure — missing config, a service account without the
// ai.languageModels.user role, a timeout, a malformed body — comes back as a
// structured `{ ok: false, error }` so a Fastify worker can neither hang nor
// crash on it.
// ---------------------------------------------------------------------------

// The real Yandex Cloud Foundation Models host. `llm.foundationmodels.yandex.net`
// was used here first and does not exist — DNS returns NXDOMAIN, so every call
// failed with a bare "fetch failed" that looked exactly like an outage or a
// missing ai.languageModels.user role.
export const YANDEX_GPT_ENDPOINT =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

export const DEFAULT_YANDEX_GPT_MODEL = 'yandexgpt/latest';
export const DEFAULT_YANDEX_GPT_TIMEOUT_MS = 30_000;
export const DEFAULT_YANDEX_GPT_MAX_TOKENS = 2000;
export const DEFAULT_YANDEX_GPT_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Normalized (provider-agnostic) types
// ---------------------------------------------------------------------------

export type AiToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AiToolResult = {
  name: string;
  content: string;
};

export type AiMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; tool_calls?: AiToolCall[] }
  | { role: 'tool'; tool_results: AiToolResult[] };

export type AiToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AiUsage = {
  input_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type AiErrorCode =
  | 'SERVICE_NOT_CONFIGURED'
  | 'AI_UNAUTHORIZED'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_BAD_RESPONSE'
  | 'AI_REQUEST_FAILED';

export type AiError = {
  code: AiErrorCode;
  message: string;
  status?: number;
};

export type AiCompletion = {
  role: 'assistant';
  text: string;
  tool_calls: AiToolCall[];
};

export type AiResult =
  | {
      ok: true;
      message: AiCompletion;
      usage: AiUsage;
      model_version: string | null;
      /** false when the request had to be retried without tools (see toolsSupported) */
      tools_offered: boolean;
    }
  | { ok: false; error: AiError };

export type AiCompletionInput = {
  messages: AiMessage[];
  tools?: AiToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
};

// ---------------------------------------------------------------------------
// Yandex wire types — never leak outside this module
// ---------------------------------------------------------------------------

type YandexWireFunctionCall = {
  name?: string;
  arguments?: unknown;
};

type YandexWireToolCall = {
  functionCall?: YandexWireFunctionCall;
};

type YandexWireToolResult = {
  functionResult: { name: string; content: string };
};

type YandexWireMessage = {
  // Required, not optional. This field was optional and the tool-result branch of
  // toWireMessage simply left it out, so the compiler had nothing to say about a
  // payload the API rejects outright. Keeping it required is what makes that
  // class of mistake a build error rather than a runtime 400.
  role: string;
  text?: string;
  toolCallList?: { toolCalls?: YandexWireToolCall[] };
  toolResultList?: { toolResults?: YandexWireToolResult[] };
};

type YandexWireUsage = {
  inputTextTokens?: string | number;
  completionTokens?: string | number;
  totalTokens?: string | number;
};

type YandexCompletionResponse = {
  result?: {
    alternatives?: Array<{ message?: YandexWireMessage; status?: string }>;
    usage?: YandexWireUsage;
    modelVersion?: string;
  };
  // Foundation Models returns errors in two different envelopes depending on
  // whether the failure happened in the gateway or in the model service.
  error?: { message?: string; httpCode?: number; grpcCode?: number; httpStatus?: string };
  code?: number;
  message?: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type YandexGptConfig = {
  apiKey: string;
  folderId: string;
  modelUri: string;
  timeoutMs: number;
};

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getYandexGptConfig(): YandexGptConfig | null {
  const apiKey = process.env.YANDEX_API_KEY?.trim();
  const folderId = process.env.YANDEX_FOLDER_ID?.trim();
  if (!apiKey || !folderId) {
    return null;
  }

  const model = process.env.YANDEX_GPT_MODEL?.trim() || DEFAULT_YANDEX_GPT_MODEL;

  return {
    apiKey,
    folderId,
    modelUri: `gpt://${folderId}/${model}`,
    timeoutMs: positiveIntFromEnv('YANDEX_GPT_TIMEOUT_MS', DEFAULT_YANDEX_GPT_TIMEOUT_MS),
  };
}

export function isYandexGptConfigured(): boolean {
  return getYandexGptConfig() !== null;
}

export function serviceNotConfiguredError(): AiError {
  return {
    code: 'SERVICE_NOT_CONFIGURED',
    message:
      'AI assistant is not configured: YANDEX_API_KEY and YANDEX_FOLDER_ID must both be set',
  };
}

// The folder's service account may not hold ai.languageModels.user. The first
// request that finds out flips this flag so we stop paying for the round trip
// on a feature we know is unavailable; the assistant surfaces it as a clean
// SERVICE_NOT_CONFIGURED-class error instead of a 500.
let toolsSupported = true;

/** Test seam — resets memoised provider capability probing. */
export function resetYandexGptState(): void {
  toolsSupported = true;
}

export function areToolsSupported(): boolean {
  return toolsSupported;
}

// ---------------------------------------------------------------------------
// Wire encoding / decoding
// ---------------------------------------------------------------------------

function toWireMessage(message: AiMessage): YandexWireMessage {
  if (message.role === 'tool') {
    // The role is REQUIRED here even though the payload carries no text. Omitting
    // it makes Yandex reject the whole request with `invalid message role ''`,
    // which killed every assistant turn that reached a second round — i.e. every
    // question that actually touched CRM data, which is most of them.
    //
    // 'user' rather than 'assistant': the tool result is input being handed *to*
    // the model, and it keeps the assistant/user alternation intact across
    // multi-round tool use (assistant asks -> user answers -> assistant asks…).
    // Both are accepted by the API for a single round; only 'user' avoids
    // consecutive assistant turns once a second round happens.
    return {
      role: 'user',
      toolResultList: {
        toolResults: message.tool_results.map((r) => ({
          functionResult: { name: r.name, content: r.content },
        })),
      },
    };
  }

  if (message.role === 'assistant') {
    const wire: YandexWireMessage = { role: 'assistant', text: message.text ?? '' };
    if (message.tool_calls && message.tool_calls.length > 0) {
      wire.toolCallList = {
        toolCalls: message.tool_calls.map((call) => ({
          functionCall: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return wire;
  }

  return { role: message.role, text: message.text };
}

function toWireTools(tools: AiToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function decodeToolCalls(message: YandexWireMessage): AiToolCall[] {
  const calls = message.toolCallList?.toolCalls ?? [];
  const decoded: AiToolCall[] = [];

  for (const call of calls) {
    const name = call.functionCall?.name;
    if (typeof name !== 'string' || !name.trim()) {
      continue;
    }

    decoded.push({
      id: randomUUID(),
      name: name.trim(),
      arguments: parseToolArguments(call.functionCall?.arguments),
    });
  }

  return decoded;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const UNAUTHORIZED_MESSAGE =
  'Yandex Foundation Models rejected the credentials. Check YANDEX_API_KEY and make sure the service account holds the ai.languageModels.user role on the folder.';

function errorForStatus(status: number, detail: string | undefined): AiError {
  if (status === 401 || status === 403) {
    return { code: 'AI_UNAUTHORIZED', message: detail || UNAUTHORIZED_MESSAGE, status };
  }

  if (status === 429) {
    return {
      code: 'AI_RATE_LIMITED',
      message: detail || 'Yandex Foundation Models rate limit exceeded, try again shortly',
      status,
    };
  }

  if (status >= 500) {
    return {
      code: 'AI_UNAVAILABLE',
      message: detail || 'Yandex Foundation Models is temporarily unavailable',
      status,
    };
  }

  return {
    code: 'AI_REQUEST_FAILED',
    message: detail || `Yandex Foundation Models request failed with status ${status}`,
    status,
  };
}

// gRPC status codes leak through the body when the gateway does not set an
// httpCode: 7 = PERMISSION_DENIED, 16 = UNAUTHENTICATED, 8 = RESOURCE_EXHAUSTED.
function statusFromBody(body: YandexCompletionResponse, httpStatus: number): number {
  if (typeof body.error?.httpCode === 'number') return body.error.httpCode;
  const grpc = typeof body.error?.grpcCode === 'number' ? body.error.grpcCode : body.code;
  if (grpc === 7) return 403;
  if (grpc === 16) return 401;
  if (grpc === 8) return 429;
  return httpStatus;
}

function bodyErrorMessage(body: YandexCompletionResponse): string | undefined {
  const message = body.error?.message ?? body.message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function looksLikeUnsupportedTools(status: number, detail: string | undefined): boolean {
  if (status !== 400 && status !== 404 && status !== 501) return false;
  if (!detail) return false;
  return /tool|function|unknown field|unsupported/i.test(detail);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type RawCallOutcome =
  | { kind: 'body'; status: number; body: YandexCompletionResponse | null; text: string }
  | { kind: 'error'; error: AiError };

async function postCompletion(
  config: YandexGptConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<RawCallOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(YANDEX_GPT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${config.apiKey}`,
        'Content-Type': 'application/json',
        'x-folder-id': config.folderId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let body: YandexCompletionResponse | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as YandexCompletionResponse;
      } catch {
        body = null;
      }
    }

    return { kind: 'body', status: response.status, body, text };
  } catch (err) {
    if (timedOut) {
      return {
        kind: 'error',
        error: {
          code: 'AI_TIMEOUT',
          message: `Yandex Foundation Models did not respond within ${timeoutMs}ms`,
        },
      };
    }

    return {
      kind: 'error',
      error: {
        code: 'AI_UNAVAILABLE',
        message: err instanceof Error ? err.message : 'Failed to reach Yandex Foundation Models',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function createCompletion(input: AiCompletionInput): Promise<AiResult> {
  const config = getYandexGptConfig();
  if (!config) {
    return { ok: false, error: serviceNotConfiguredError() };
  }

  const timeoutMs = input.timeout_ms && input.timeout_ms > 0 ? input.timeout_ms : config.timeoutMs;
  const wantsTools = Array.isArray(input.tools) && input.tools.length > 0;
  let offerTools = wantsTools && toolsSupported;

  const basePayload: Record<string, unknown> = {
    modelUri: config.modelUri,
    completionOptions: {
      stream: false,
      temperature: input.temperature ?? DEFAULT_YANDEX_GPT_TEMPERATURE,
      maxTokens: String(input.max_tokens ?? DEFAULT_YANDEX_GPT_MAX_TOKENS),
    },
    messages: input.messages.map(toWireMessage),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = offerTools && input.tools
      ? { ...basePayload, tools: toWireTools(input.tools) }
      : basePayload;

    const outcome = await postCompletion(config, payload, timeoutMs);
    if (outcome.kind === 'error') {
      return { ok: false, error: outcome.error };
    }

    const { status, body, text } = outcome;
    const detail = body ? bodyErrorMessage(body) : text.slice(0, 500) || undefined;

    if (status < 200 || status >= 300 || (body && (body.error || typeof body.code === 'number'))) {
      const effectiveStatus = body ? statusFromBody(body, status) : status;

      // The API version in this folder may predate function calling. Retry once
      // without tools so the assistant degrades to plain chat instead of 502ing.
      if (offerTools && looksLikeUnsupportedTools(effectiveStatus, detail)) {
        toolsSupported = false;
        offerTools = false;
        continue;
      }

      return { ok: false, error: errorForStatus(effectiveStatus, detail) };
    }

    if (!body) {
      return {
        ok: false,
        error: { code: 'AI_BAD_RESPONSE', message: 'Yandex Foundation Models returned a non-JSON body' },
      };
    }

    const alternative = body.result?.alternatives?.[0];
    if (!alternative?.message) {
      return {
        ok: false,
        error: {
          code: 'AI_BAD_RESPONSE',
          message: 'Yandex Foundation Models returned no completion alternatives',
        },
      };
    }

    const usage = body.result?.usage;

    return {
      ok: true,
      message: {
        role: 'assistant',
        text: typeof alternative.message.text === 'string' ? alternative.message.text : '',
        tool_calls: decodeToolCalls(alternative.message),
      },
      usage: {
        input_tokens: toNumber(usage?.inputTextTokens),
        completion_tokens: toNumber(usage?.completionTokens),
        total_tokens: toNumber(usage?.totalTokens),
      },
      model_version: body.result?.modelVersion ?? null,
      tools_offered: offerTools,
    };
  }

  return {
    ok: false,
    error: {
      code: 'AI_REQUEST_FAILED',
      message: 'Yandex Foundation Models request failed after retrying without tools',
    },
  };
}
