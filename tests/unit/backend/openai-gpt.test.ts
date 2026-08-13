import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCompletion,
  getOpenAiGptConfig,
  isOpenAiGptConfigured,
  toWireMessages,
} from '../../../backend/services/openai-gpt';
import {
  createCompletion as routedCompletion,
  isModelProviderConfigured,
} from '../../../backend/services/model-provider';
import type { AiMessage } from '../../../backend/services/yandex-gpt';

// ---------------------------------------------------------------------------
// Env fixture
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_PROXY_TOKEN',
  'OPENAI_CHAT_MODEL',
  'OPENAI_CHAT_TIMEOUT_MS',
  'MODEL_PROVIDER',
  'YANDEX_API_KEY',
  'YANDEX_FOLDER_ID',
] as const;

let savedEnv: Record<string, string | undefined>;

function configureEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    OPENAI_BASE_URL: 'https://proxy.example.workers.dev/v1',
    OPENAI_PROXY_TOKEN: 'proxy-token-for-tests',
    OPENAI_CHAT_MODEL: undefined,
    OPENAI_CHAT_TIMEOUT_MS: undefined,
    MODEL_PROVIDER: undefined,
    YANDEX_API_KEY: undefined,
    YANDEX_FOLDER_ID: undefined,
    ...overrides,
  };
  for (const key of ENV_KEYS) {
    const value = base[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function chatResponse(content: string): unknown {
  return {
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  };
}

function sentPayload(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('getOpenAiGptConfig', () => {
  it('needs both the base URL and the proxy token', () => {
    configureEnv();
    expect(isOpenAiGptConfigured()).toBe(true);
    configureEnv({ OPENAI_BASE_URL: undefined });
    expect(isOpenAiGptConfigured()).toBe(false);
    configureEnv({ OPENAI_PROXY_TOKEN: undefined });
    expect(isOpenAiGptConfigured()).toBe(false);
  });

  it('defaults the model and strips a trailing slash', () => {
    configureEnv({ OPENAI_BASE_URL: 'https://proxy.example.workers.dev/v1/' });
    const config = getOpenAiGptConfig();
    expect(config?.baseUrl).toBe('https://proxy.example.workers.dev/v1');
    expect(config?.model).toBe('gpt-4o-mini');
    expect(config?.timeoutMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------

describe('toWireMessages', () => {
  it('maps system/user/assistant text messages onto content', () => {
    const messages: AiMessage[] = [
      { role: 'system', text: 'Ты ассистент CRM' },
      { role: 'user', text: 'Сколько сделок?' },
      { role: 'assistant', text: 'Три' },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'system', content: 'Ты ассистент CRM' },
      { role: 'user', content: 'Сколько сделок?' },
      { role: 'assistant', content: 'Три' },
    ]);
  });

  it('serialises tool calls with their ids and pairs results back by id', () => {
    const messages: AiMessage[] = [
      { role: 'user', text: 'Найди контакт' },
      {
        role: 'assistant',
        text: '',
        tool_calls: [
          { id: 'call-a', name: 'get_contacts', arguments: { q: 'K7F3' } },
          { id: 'call-b', name: 'get_deals', arguments: {} },
        ],
      },
      {
        role: 'tool',
        tool_results: [
          { name: 'get_contacts', content: '{"items":[]}' },
          { name: 'get_deals', content: '{"items":[1]}' },
        ],
      },
    ];

    const wire = toWireMessages(messages);
    expect(wire[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'get_contacts', arguments: '{"q":"K7F3"}' },
        },
        { id: 'call-b', type: 'function', function: { name: 'get_deals', arguments: '{}' } },
      ],
    });
    expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'call-a', content: '{"items":[]}' });
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: 'call-b', content: '{"items":[1]}' });
  });

  it('pairs same-named duplicate calls by position and synthesizes missing ids', () => {
    const messages: AiMessage[] = [
      {
        role: 'assistant',
        text: '',
        // Pre-id history rows deserialize with an empty id.
        tool_calls: [
          { id: '', name: 'get_contacts', arguments: { q: 'а' } },
          { id: '', name: 'get_contacts', arguments: { q: 'б' } },
        ],
      },
      {
        role: 'tool',
        tool_results: [
          { name: 'get_contacts', content: 'первый' },
          { name: 'get_contacts', content: 'второй' },
        ],
      },
    ];

    const wire = toWireMessages(messages);
    const callIds = (wire[0].tool_calls ?? []).map((call) => call.id);
    expect(callIds).toEqual(['call_0', 'call_1']);
    expect(wire[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_0', content: 'первый' });
    expect(wire[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'второй' });
  });
});

// ---------------------------------------------------------------------------
// createCompletion
// ---------------------------------------------------------------------------

describe('createCompletion (openai)', () => {
  it('refuses to run unconfigured without touching the network', async () => {
    configureEnv({ OPENAI_BASE_URL: undefined });
    const calls = stubFetch(() => jsonResponse(chatResponse('нет')));
    const result = await createCompletion({ messages: [{ role: 'user', text: 'привет' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'SERVICE_NOT_CONFIGURED' } });
    expect(calls).toHaveLength(0);
  });

  it('posts to the proxy with the token and the normalized payload', async () => {
    configureEnv();
    const calls = stubFetch(() => jsonResponse(chatResponse('Здравствуйте!')));

    const result = await createCompletion({
      messages: [{ role: 'user', text: 'привет' }],
      tools: [{ name: 'get_contacts', description: 'список', parameters: { type: 'object' } }],
      max_tokens: 2000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proxy.example.workers.dev/v1/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer proxy-token-for-tests');

    const payload = sentPayload(calls[0]);
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.stream).toBe(false);
    expect(payload.max_completion_tokens).toBe(2000);
    expect(payload.tools).toEqual([
      {
        type: 'function',
        function: { name: 'get_contacts', description: 'список', parameters: { type: 'object' } },
      },
    ]);

    expect(result).toEqual({
      ok: true,
      message: { role: 'assistant', text: 'Здравствуйте!', tool_calls: [] },
      usage: { input_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      model_version: 'gpt-4o-mini-2024-07-18',
      tools_offered: true,
    });
  });

  it('decodes tool calls and survives malformed argument JSON', async () => {
    configureEnv();
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'get_contacts', arguments: '{"q":"Ромашка"}' },
                },
                { id: 'call-2', type: 'function', function: { name: 'get_deals', arguments: 'не json' } },
                { id: 'call-3', type: 'function', function: { name: '  ', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    );

    const result = await createCompletion({ messages: [{ role: 'user', text: 'найди' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.tool_calls).toEqual([
      { id: 'call-1', name: 'get_contacts', arguments: { q: 'Ромашка' } },
      { id: 'call-2', name: 'get_deals', arguments: {} },
    ]);
  });

  it('maps statuses onto the shared error vocabulary', async () => {
    configureEnv();
    const cases: Array<[number, string, string | undefined]> = [
      [401, 'AI_UNAUTHORIZED', undefined],
      [403, 'AI_UNAUTHORIZED', undefined],
      [429, 'AI_RATE_LIMITED', 'daily_limit_exceeded'],
      [504, 'AI_TIMEOUT', 'upstream_timeout'],
      [500, 'AI_UNAVAILABLE', undefined],
      [400, 'AI_REQUEST_FAILED', 'model_not_allowed'],
      [503, 'SERVICE_NOT_CONFIGURED', 'proxy_not_configured'],
    ];
    for (const [status, code, proxyCode] of cases) {
      stubFetch(() =>
        jsonResponse({ error: { message: 'нет', type: 'proxy_error', code: proxyCode } }, status),
      );
      const result = await createCompletion({ messages: [{ role: 'user', text: 'x' }] });
      expect(result, `status ${status}`).toMatchObject({ ok: false, error: { code } });
    }
  });

  it('times out via its own timer and reports AI_TIMEOUT', async () => {
    configureEnv();
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await createCompletion({
      messages: [{ role: 'user', text: 'x' }],
      timeout_ms: 10,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'AI_TIMEOUT' } });
  });

  it('a network failure is AI_UNAVAILABLE and a non-JSON 200 is AI_BAD_RESPONSE', async () => {
    configureEnv();
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await createCompletion({ messages: [{ role: 'user', text: 'x' }] })).toMatchObject({
      ok: false,
      error: { code: 'AI_UNAVAILABLE' },
    });

    stubFetch(() => new Response('<html>', { status: 200 }));
    expect(await createCompletion({ messages: [{ role: 'user', text: 'x' }] })).toMatchObject({
      ok: false,
      error: { code: 'AI_BAD_RESPONSE' },
    });
  });
});

// ---------------------------------------------------------------------------
// Provider router
// ---------------------------------------------------------------------------

describe('model-provider router', () => {
  it('routes to OpenAI when MODEL_PROVIDER=openai', async () => {
    configureEnv({ MODEL_PROVIDER: 'openai' });
    const calls = stubFetch(() => jsonResponse(chatResponse('ok')));
    const result = await routedCompletion({ messages: [{ role: 'user', text: 'привет' }] });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe('https://proxy.example.workers.dev/v1/chat/completions');
    expect(isModelProviderConfigured()).toBe(true);
  });

  it('defaults to Yandex Foundation Models when MODEL_PROVIDER is unset', async () => {
    configureEnv({
      MODEL_PROVIDER: undefined,
      YANDEX_API_KEY: 'yandex-key',
      YANDEX_FOLDER_ID: 'folder-1',
    });
    const calls = stubFetch(() =>
      jsonResponse({
        result: {
          alternatives: [
            { message: { role: 'assistant', text: 'ок' }, status: 'ALTERNATIVE_STATUS_FINAL' },
          ],
          usage: { inputTextTokens: '1', completionTokens: '1', totalTokens: '2' },
        },
      }),
    );
    const result = await routedCompletion({ messages: [{ role: 'user', text: 'привет' }] });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toContain('llm.api.cloud.yandex.net');
  });

  it('an unknown provider fails closed without a network call', async () => {
    configureEnv({ MODEL_PROVIDER: 'mystery-llm' });
    const calls = stubFetch(() => jsonResponse(chatResponse('нет')));
    expect(isModelProviderConfigured()).toBe(false);
    const result = await routedCompletion({ messages: [{ role: 'user', text: 'x' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'SERVICE_NOT_CONFIGURED' } });
    expect(calls).toHaveLength(0);
  });

  it('openai selected but unconfigured reports not-configured, not a Yandex error', () => {
    configureEnv({ MODEL_PROVIDER: 'openai', OPENAI_BASE_URL: undefined });
    expect(isModelProviderConfigured()).toBe(false);
  });
});
