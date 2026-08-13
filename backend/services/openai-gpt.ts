import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Thin client over the OpenAI Chat Completions API, reached exclusively
// through workers/openai-proxy — api.openai.com is not reachable from Russia,
// and the real OpenAI key lives only in Cloudflare. This backend holds
// OPENAI_PROXY_TOKEN, which buys nothing but the proxy's two model-restricted,
// daily-capped endpoints.
//
// This file is the ONLY place that knows OpenAI's wire format. Everything else
// speaks the normalized `AiMessage` / `AiCompletion` shapes from yandex-gpt.ts
// (the module that defined the provider-agnostic contract first). It never
// throws: every failure comes back as `{ ok: false, error }`.
//
// JURISDICTION: OpenAI is a FOREIGN provider and is deliberately absent from
// DOMESTIC_PROVIDERS in model-jurisdiction.ts. Selecting it via MODEL_PROVIDER
// is exactly the "Wave A repoint" that module was written to police: with
// personalNamesMayBeSent() false, model-projection.ts aliases contacts in tool
// results and contact-alias-resolver.ts aliases them in prompts, so what this
// client puts on the wire is «Клиент K7F3», never a real name.
// ---------------------------------------------------------------------------

import type {
  AiCompletionInput,
  AiError,
  AiMessage,
  AiResult,
  AiToolCall,
  AiToolDefinition,
  AiUsage,
} from './yandex-gpt';

export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o-mini';
export const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENAI_MAX_TOKENS = 2000;
export const DEFAULT_OPENAI_TEMPERATURE = 0.3;

// ---------------------------------------------------------------------------
// Wire types — never leak outside this module
// ---------------------------------------------------------------------------

type OpenAiWireToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiWireMessage = {
  role: string;
  content: string | null;
  tool_calls?: OpenAiWireToolCall[];
  tool_call_id?: string;
};

type OpenAiCompletionResponse = {
  choices?: Array<{ message?: OpenAiWireMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string; code?: string };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type OpenAiGptConfig = {
  /** The proxy Worker's /v1 base — never api.openai.com directly. */
  baseUrl: string;
  proxyToken: string;
  model: string;
  timeoutMs: number;
};

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getOpenAiGptConfig(): OpenAiGptConfig | null {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const proxyToken = process.env.OPENAI_PROXY_TOKEN?.trim();
  if (!baseUrl || !proxyToken) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    proxyToken,
    model: process.env.OPENAI_CHAT_MODEL?.trim() || DEFAULT_OPENAI_CHAT_MODEL,
    timeoutMs: positiveIntFromEnv('OPENAI_CHAT_TIMEOUT_MS', DEFAULT_OPENAI_TIMEOUT_MS),
  };
}

export function isOpenAiGptConfigured(): boolean {
  return getOpenAiGptConfig() !== null;
}

export function openAiNotConfiguredError(): AiError {
  return {
    code: 'SERVICE_NOT_CONFIGURED',
    message:
      'AI assistant is not configured: OPENAI_BASE_URL and OPENAI_PROXY_TOKEN must both be set',
  };
}

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------

/**
 * OpenAI links tool results to tool calls by id, one `tool` message per
 * result. The provider-agnostic AiToolResult carries no id (Yandex's wire has
 * none), so results are paired against the preceding assistant message's
 * calls: by name first, by position as a fallback, with a synthesized id as
 * the last resort for pre-id rows replayed out of history. The agent loop
 * appends results for exactly the calls it executed, in order, so the pairing
 * is deterministic in practice and the fallbacks are armour, not a path.
 */
export function toWireMessages(messages: AiMessage[]): OpenAiWireMessage[] {
  const wire: OpenAiWireMessage[] = [];
  let pendingCalls: Array<{ id: string; name: string; used: boolean }> = [];

  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.tool_calls ?? [];
      pendingCalls = calls.map((call, index) => ({
        id: call.id || `call_${String(index)}`,
        name: call.name,
        used: false,
      }));
      const entry: OpenAiWireMessage = {
        role: 'assistant',
        content: message.text ? message.text : calls.length > 0 ? null : '',
      };
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call, index) => ({
          id: pendingCalls[index].id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
      }
      wire.push(entry);
      continue;
    }

    if (message.role === 'tool') {
      for (const [index, result] of message.tool_results.entries()) {
        const byName = pendingCalls.find((call) => !call.used && call.name === result.name);
        const byPosition = pendingCalls[index] && !pendingCalls[index].used
          ? pendingCalls[index]
          : pendingCalls.find((call) => !call.used);
        const matched = byName ?? byPosition;
        if (matched) matched.used = true;
        wire.push({
          role: 'tool',
          tool_call_id: matched?.id ?? `call_${String(index)}`,
          content: result.content,
        });
      }
      continue;
    }

    wire.push({ role: message.role, content: message.text });
  }

  return wire;
}

function toWireTools(tools: AiToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Wire decoding
// ---------------------------------------------------------------------------

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function decodeToolCalls(message: OpenAiWireMessage): AiToolCall[] {
  const decoded: AiToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    decoded.push({
      id: call.id || randomUUID(),
      name: name.trim(),
      arguments: parseToolArguments(call.function?.arguments),
    });
  }
  return decoded;
}

function toUsage(body: OpenAiCompletionResponse): AiUsage {
  return {
    input_tokens: body.usage?.prompt_tokens ?? 0,
    completion_tokens: body.usage?.completion_tokens ?? 0,
    total_tokens: body.usage?.total_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function errorForStatus(status: number, detail: string | undefined, proxyCode?: string): AiError {
  // The proxy answers 503 proxy_not_configured when ITS secrets are missing —
  // from the CRM's point of view that is "the feature is not set up", not a
  // transient outage, and the app shows the right card for it.
  if (proxyCode === 'proxy_not_configured') {
    return {
      code: 'SERVICE_NOT_CONFIGURED',
      message: detail || 'The OpenAI proxy Worker is missing its secrets (see workers/openai-proxy)',
      status,
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: 'AI_UNAUTHORIZED',
      message:
        detail ||
        'The OpenAI proxy rejected the credentials. Check OPENAI_PROXY_TOKEN against the Worker secret.',
      status,
    };
  }

  if (status === 429) {
    return {
      code: 'AI_RATE_LIMITED',
      message: detail || 'OpenAI rate limit or the proxy daily ceiling reached, try again later',
      status,
    };
  }

  if (status === 504) {
    return { code: 'AI_TIMEOUT', message: detail || 'OpenAI did not respond in time', status };
  }

  if (status >= 500) {
    return {
      code: 'AI_UNAVAILABLE',
      message: detail || 'OpenAI is temporarily unavailable',
      status,
    };
  }

  return {
    code: 'AI_REQUEST_FAILED',
    message: detail || `OpenAI request failed with status ${status}`,
    status,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function createCompletion(input: AiCompletionInput): Promise<AiResult> {
  const config = getOpenAiGptConfig();
  if (!config) {
    return { ok: false, error: openAiNotConfiguredError() };
  }

  const timeoutMs = input.timeout_ms && input.timeout_ms > 0 ? input.timeout_ms : config.timeoutMs;
  const offerTools = Array.isArray(input.tools) && input.tools.length > 0;

  const payload: Record<string, unknown> = {
    model: config.model,
    stream: false,
    temperature: input.temperature ?? DEFAULT_OPENAI_TEMPERATURE,
    max_completion_tokens: input.max_tokens ?? DEFAULT_OPENAI_MAX_TOKENS,
    messages: toWireMessages(input.messages),
    ...(offerTools && input.tools ? { tools: toWireTools(input.tools) } : {}),
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.proxyToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        error: { code: 'AI_TIMEOUT', message: `OpenAI did not respond within ${timeoutMs}ms` },
      };
    }
    return {
      ok: false,
      error: {
        code: 'AI_UNAVAILABLE',
        message: err instanceof Error ? err.message : 'Failed to reach the OpenAI proxy',
      },
    };
  } finally {
    clearTimeout(timer);
  }

  let body: OpenAiCompletionResponse | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as OpenAiCompletionResponse;
    } catch {
      body = null;
    }
  }

  if (response.status < 200 || response.status >= 300) {
    const detail = body?.error?.message?.trim() || text.slice(0, 500) || undefined;
    return { ok: false, error: errorForStatus(response.status, detail, body?.error?.code) };
  }

  if (!body) {
    return {
      ok: false,
      error: { code: 'AI_BAD_RESPONSE', message: 'OpenAI returned a non-JSON body' },
    };
  }

  const message = body.choices?.[0]?.message;
  if (!message) {
    return {
      ok: false,
      error: { code: 'AI_BAD_RESPONSE', message: 'OpenAI returned no completion choices' },
    };
  }

  return {
    ok: true,
    message: {
      role: 'assistant',
      text: typeof message.content === 'string' ? message.content : '',
      tool_calls: decodeToolCalls(message),
    },
    usage: toUsage(body),
    model_version: typeof body.model === 'string' ? body.model : null,
    tools_offered: offerTools,
  };
}
