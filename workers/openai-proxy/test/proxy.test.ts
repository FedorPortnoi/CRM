// Runs on plain Node 22.6+/24 — `node --test test/` strips the TypeScript
// types, and Request/Response/crypto.subtle/AbortSignal.timeout are all
// globals there, so the Worker's logic is exercised without wrangler,
// miniflare, or a network. `npm test`.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker, { type Env, readBodyWithLimit, readRawBodyWithLimit } from '../src/index.ts';
import { DailyQuota, type QuotaState } from '../src/quota.ts';
import {
  dayKey,
  isModelAllowed,
  loadConfig,
  parseBoundedInt,
  parseList,
  secondsUntilNextDay,
} from '../src/config.ts';
import { extractBearerToken, isAuthorized, timingSafeEqualString } from '../src/auth.ts';

const REAL_KEY = 'test-openai-key-not-a-real-one';
const GOOD_TOKEN = 'test-proxy-token-0123456789abcdef';

// --- test doubles ----------------------------------------------------------

function makeQuotaNamespace(): Env['DAILY_QUOTA'] {
  const storage = new Map<string, unknown>();
  const state: QuotaState = {
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        storage.set(key, value);
      },
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  };
  const instance = new DailyQuota(state);
  return { idFromName: (name: string) => name, get: () => instance };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: REAL_KEY,
    PROXY_TOKEN: GOOD_TOKEN,
    ALLOWED_MODELS: 'gpt-4o-mini,gpt-4o',
    ALLOWED_TRANSCRIBE_MODELS: 'whisper-1,gpt-4o-mini-transcribe',
    DAILY_REQUEST_LIMIT: '500',
    MAX_BODY_BYTES: '262144',
    MAX_AUDIO_BODY_BYTES: '26214400',
    UPSTREAM_TIMEOUT_MS: '60000',
    ALLOW_STREAMING: 'false',
    DAY_BOUNDARY_OFFSET_MINUTES: '180',
    MAX_OUTPUT_TOKENS: '4096',
    DAILY_QUOTA: makeQuotaNamespace(),
    ...overrides,
  };
}

const SENSITIVE_BODY = JSON.stringify({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Сделка «Ромашка» — Иванов Пётр, 500000 руб.' }],
});

function makeRequest(
  body: string | null = SENSITIVE_BODY,
  init: { headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers({
    authorization: `Bearer ${GOOD_TOKEN}`,
    'content-type': 'application/json',
  });
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }
  return new Request('https://proxy.example.com/v1/chat/completions', {
    method: 'POST',
    headers,
    ...(body === null ? {} : { body }),
  });
}

// A recognisable ASCII marker inside the "audio" bytes plus a Cyrillic
// filename — the privacy tests assert neither ever reaches a log line.
const AUDIO_MARKER = 'VOICE-SECRET-MARKER-bytes';

function makeAudioForm(model: string | null = 'whisper-1'): FormData {
  const form = new FormData();
  form.append('file', new File([`RIFF${AUDIO_MARKER}`], 'голос-иванова.m4a', { type: 'audio/mp4' }));
  if (model !== null) form.append('model', model);
  form.append('language', 'ru');
  return form;
}

function makeTranscribeRequest(form: FormData = makeAudioForm()): Request {
  // No explicit content-type: Request serialises the form and sets the
  // multipart boundary itself, exactly as the CRM backend's fetch will.
  return new Request('https://proxy.example.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    body: form,
  });
}

type UpstreamCall = { url: string; init: RequestInit };

let upstreamCalls: UpstreamCall[] = [];
let logLines: string[] = [];
let originalFetch: typeof globalThis.fetch;
let originalLog: typeof console.log;

function stubUpstream(handler: (call: UpstreamCall) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    upstreamCalls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  upstreamCalls = [];
  logLines = [];
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  console.log = (line: string) => {
    logLines.push(String(line));
  };
  stubUpstream(
    () =>
      new Response(JSON.stringify({ id: 'chatcmpl-x', choices: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining-requests': '9999',
          'set-cookie': 'tracking=should-not-be-forwarded',
        },
      }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
});

// --- routing ---------------------------------------------------------------

describe('routing', () => {
  test('the happy path is POST /v1/chat/completions', async () => {
    const response = await worker.fetch(makeRequest(), makeEnv());
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, 'https://api.openai.com/v1/chat/completions');
  });

  test('other paths are 404 and never reach upstream', async () => {
    const paths = ['/', '/v1/embeddings', '/v1/chat/completions/', '/v1/models'];
    for (const path of paths) {
      const response = await worker.fetch(
        new Request(`https://proxy.example.com${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'content-type': 'application/json' },
          body: SENSITIVE_BODY,
        }),
        makeEnv(),
      );
      assert.equal(response.status, 404, `expected 404 for ${path}`);
    }
    assert.equal(upstreamCalls.length, 0);
  });

  test('GET on the proxied path is 404, not 405', async () => {
    const response = await worker.fetch(
      new Request('https://proxy.example.com/v1/chat/completions'),
      makeEnv(),
    );
    assert.equal(response.status, 404);
    assert.equal(upstreamCalls.length, 0);
  });
});

// --- authentication --------------------------------------------------------

describe('authentication', () => {
  test('missing, malformed and wrong tokens are all 401', async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: '' },
      { authorization: GOOD_TOKEN },
      { authorization: 'Bearer ' },
      { authorization: 'Bearer wrong-token' },
      { authorization: `Bearer ${GOOD_TOKEN}x` },
      { authorization: `Bearer ${GOOD_TOKEN.slice(0, -1)}` },
      { authorization: `Basic ${GOOD_TOKEN}` },
    ];
    for (const headers of cases) {
      const request = new Request('https://proxy.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: SENSITIVE_BODY,
      });
      const response = await worker.fetch(request, makeEnv());
      assert.equal(response.status, 401, `expected 401 for ${JSON.stringify(headers)}`);
    }
    assert.equal(upstreamCalls.length, 0);
  });

  test('the OpenAI key is not accepted as the proxy token', async () => {
    const response = await worker.fetch(
      makeRequest(SENSITIVE_BODY, { headers: { authorization: `Bearer ${REAL_KEY}` } }),
      makeEnv(),
    );
    assert.equal(response.status, 401);
  });

  test('unauthenticated traffic cannot consume the daily quota', async () => {
    const env = makeEnv({ DAILY_REQUEST_LIMIT: '1' });
    const bad = await worker.fetch(
      makeRequest(SENSITIVE_BODY, { headers: { authorization: 'Bearer nope' } }),
      env,
    );
    assert.equal(bad.status, 401);
    // The single request in the budget must still be available.
    const good = await worker.fetch(makeRequest(), env);
    assert.equal(good.status, 200);
  });

  test('a Worker missing its secrets fails closed', async () => {
    for (const overrides of [
      { PROXY_TOKEN: undefined },
      { OPENAI_API_KEY: undefined },
      { PROXY_TOKEN: '', OPENAI_API_KEY: '' },
    ]) {
      const response = await worker.fetch(makeRequest(), makeEnv(overrides));
      assert.equal(response.status, 503);
    }
    assert.equal(upstreamCalls.length, 0);
  });

  test('PROXY_TOKEN_PREVIOUS is accepted during rotation', async () => {
    const env = makeEnv({ PROXY_TOKEN: 'new-token-value', PROXY_TOKEN_PREVIOUS: GOOD_TOKEN });
    const withOld = await worker.fetch(makeRequest(), env);
    assert.equal(withOld.status, 200);
    const withNew = await worker.fetch(
      makeRequest(SENSITIVE_BODY, { headers: { authorization: 'Bearer new-token-value' } }),
      env,
    );
    assert.equal(withNew.status, 200);
    const withOther = await worker.fetch(
      makeRequest(SENSITIVE_BODY, { headers: { authorization: 'Bearer third-token' } }),
      env,
    );
    assert.equal(withOther.status, 401);
  });

  test('constant-time compare still gives the right answer', async () => {
    assert.equal(await timingSafeEqualString('abc', 'abc'), true);
    assert.equal(await timingSafeEqualString('abc', 'abd'), false);
    assert.equal(await timingSafeEqualString('abc', 'abcd'), false);
    assert.equal(await timingSafeEqualString('', ''), true);
    assert.equal(await timingSafeEqualString('', 'a'), false);
    assert.equal(await timingSafeEqualString('Ромашка', 'Ромашка'), true);
  });

  test('empty secrets never authorise', async () => {
    assert.equal(await isAuthorized('', '', undefined), false);
    assert.equal(await isAuthorized('x', undefined, undefined), false);
    assert.equal(await isAuthorized(null, 'x', undefined), false);
    assert.equal(await isAuthorized('x', 'x', undefined), true);
  });

  test('bearer extraction', () => {
    assert.equal(extractBearerToken('Bearer abc'), 'abc');
    assert.equal(extractBearerToken('bearer abc'), 'abc');
    assert.equal(extractBearerToken('  Bearer   abc  '), 'abc');
    assert.equal(extractBearerToken('abc'), null);
    assert.equal(extractBearerToken(null), null);
  });
});

// --- request validation ----------------------------------------------------

describe('request validation', () => {
  test('non-JSON content type is 415', async () => {
    const response = await worker.fetch(
      makeRequest(SENSITIVE_BODY, { headers: { 'content-type': 'text/plain' } }),
      makeEnv(),
    );
    assert.equal(response.status, 415);
    assert.equal(upstreamCalls.length, 0);
  });

  test('oversized bodies are 413', async () => {
    const big = JSON.stringify({ model: 'gpt-4o-mini', pad: 'x'.repeat(5000) });
    const response = await worker.fetch(makeRequest(big), makeEnv({ MAX_BODY_BYTES: '2048' }));
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls.length, 0);
  });

  test('the size cap counts the stream, not just Content-Length', async () => {
    // A chunked request has no Content-Length to check against, so the cap has
    // to be enforced while reading.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(1000));
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request('https://proxy.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error - Node requires duplex for streaming bodies
      duplex: 'half',
    });
    assert.equal(request.headers.get('content-length'), null);
    const response = await worker.fetch(request, makeEnv({ MAX_BODY_BYTES: '2048' }));
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls.length, 0);
  });

  test('a body exactly at the cap is accepted', async () => {
    const limit = 2048;
    const filler = 'x'.repeat(limit - JSON.stringify({ model: 'gpt-4o-mini', pad: '' }).length);
    const body = JSON.stringify({ model: 'gpt-4o-mini', pad: filler });
    assert.equal(new TextEncoder().encode(body).byteLength, limit);
    const response = await worker.fetch(
      makeRequest(body),
      makeEnv({ MAX_BODY_BYTES: String(limit) }),
    );
    assert.equal(response.status, 200);
  });

  test('malformed JSON is 400 and the error never echoes the body', async () => {
    for (const body of ['{ not json', '[]', '"a string"', 'null', '']) {
      const response = await worker.fetch(makeRequest(body), makeEnv());
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const text = await response.text();
      assert.ok(!text.includes('not json'));
    }
    assert.equal(upstreamCalls.length, 0);
  });
});

// --- model allowlist -------------------------------------------------------

describe('model allowlist', () => {
  test('unlisted models are rejected before the upstream call', async () => {
    const bodies = [
      { model: 'gpt-4-turbo' },
      { model: 'o3' },
      { model: 'gpt-4o-mini-2024-07-18' }, // prefix of an allowed model, still not allowed
      { model: 'GPT-4O-MINI' },
      { model: '' },
      { model: 123 },
      {},
    ];
    for (const payload of bodies) {
      const response = await worker.fetch(makeRequest(JSON.stringify(payload)), makeEnv());
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      const parsed = (await response.json()) as { error: { code: string } };
      assert.equal(parsed.error.code, 'model_not_allowed');
    }
    assert.equal(upstreamCalls.length, 0, 'no upstream call may be made for a rejected model');
  });

  test('an empty allowlist allows nothing', async () => {
    const response = await worker.fetch(makeRequest(), makeEnv({ ALLOWED_MODELS: '' }));
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls.length, 0);
  });

  test('a rejected model does not consume quota', async () => {
    const env = makeEnv({ DAILY_REQUEST_LIMIT: '1' });
    await worker.fetch(makeRequest(JSON.stringify({ model: 'o3' })), env);
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 200);
  });

  test('isModelAllowed is exact match only', () => {
    const allowed = ['gpt-4o-mini'];
    assert.equal(isModelAllowed('gpt-4o-mini', allowed), true);
    assert.equal(isModelAllowed('gpt-4o-mini-2024-07-18', allowed), false);
    assert.equal(isModelAllowed('gpt-4o', allowed), false);
    assert.equal(isModelAllowed(undefined, allowed), false);
  });
});

// --- streaming -------------------------------------------------------------

describe('streaming', () => {
  test('stream:true is refused while ALLOW_STREAMING is false', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [] });
    const response = await worker.fetch(makeRequest(body), makeEnv());
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as { error: { code: string } };
    assert.equal(parsed.error.code, 'streaming_disabled');
    assert.equal(upstreamCalls.length, 0);
  });

  test('stream:false is unaffected', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', stream: false, messages: [] });
    const response = await worker.fetch(makeRequest(body), makeEnv());
    assert.equal(response.status, 200);
  });

  test('flipping ALLOW_STREAMING is enough to enable SSE passthrough', async () => {
    stubUpstream(
      () =>
        new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const body = JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [] });
    const response = await worker.fetch(makeRequest(body), makeEnv({ ALLOW_STREAMING: 'true' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(upstreamCalls[0].init.headers instanceof Headers, true);
    assert.equal(
      (upstreamCalls[0].init.headers as Headers).get('accept'),
      'text/event-stream',
    );
    assert.ok((await response.text()).includes('[DONE]'));
  });
});

// --- transcription route ---------------------------------------------------

describe('transcription route', () => {
  test('the happy path forwards to /v1/audio/transcriptions', async () => {
    stubUpstream(
      () =>
        new Response(JSON.stringify({ text: 'привет' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const response = await worker.fetch(makeTranscribeRequest(), makeEnv());
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.deepEqual(await response.json(), { text: 'привет' });
  });

  test('the multipart body travels byte-for-byte with its boundary', async () => {
    const request = makeTranscribeRequest();
    const mirror = request.clone();
    const response = await worker.fetch(request, makeEnv());
    assert.equal(response.status, 200);
    const headers = upstreamCalls[0].init.headers as Headers;
    const sentType = String(headers.get('content-type'));
    assert.ok(sentType.startsWith('multipart/form-data; boundary='), sentType);
    assert.equal(sentType, mirror.headers.get('content-type'));
    assert.equal(headers.get('authorization'), `Bearer ${REAL_KEY}`);
    const expected = new Uint8Array(await mirror.arrayBuffer());
    assert.deepEqual(upstreamCalls[0].init.body, expected);
  });

  test('GET on the transcription path is 404', async () => {
    const response = await worker.fetch(
      new Request('https://proxy.example.com/v1/audio/transcriptions'),
      makeEnv(),
    );
    assert.equal(response.status, 404);
    assert.equal(upstreamCalls.length, 0);
  });

  test('the transcription route requires the proxy token', async () => {
    const request = new Request('https://proxy.example.com/v1/audio/transcriptions', {
      method: 'POST',
      body: makeAudioForm(),
    });
    const response = await worker.fetch(request, makeEnv());
    assert.equal(response.status, 401);
    assert.equal(upstreamCalls.length, 0);
  });

  test('JSON on the transcription route is 415', async () => {
    const request = new Request('https://proxy.example.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'whisper-1' }),
    });
    const response = await worker.fetch(request, makeEnv());
    assert.equal(response.status, 415);
    assert.equal(upstreamCalls.length, 0);
  });

  test('garbage with a multipart content-type is 400 and never echoed', async () => {
    const request = new Request('https://proxy.example.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        'content-type': 'multipart/form-data; boundary=xyz',
      },
      body: 'Иванов Пётр — это не multipart',
    });
    const response = await worker.fetch(request, makeEnv());
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes('Иванов'));
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'invalid_multipart');
    assert.equal(upstreamCalls.length, 0);
  });

  test('oversized audio is 413 before any upstream call', async () => {
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('file', new File([new Uint8Array(8192)], 'voice.m4a', { type: 'audio/mp4' }));
    const response = await worker.fetch(
      makeTranscribeRequest(form),
      makeEnv({ MAX_AUDIO_BODY_BYTES: '2048' }),
    );
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls.length, 0);
  });

  test('a chat model is not authorised for transcription', async () => {
    const response = await worker.fetch(
      makeTranscribeRequest(makeAudioForm('gpt-4o-mini')),
      makeEnv(),
    );
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as { error: { code: string } };
    assert.equal(parsed.error.code, 'model_not_allowed');
    assert.equal(upstreamCalls.length, 0);
  });

  test('a missing model field is refused', async () => {
    const response = await worker.fetch(makeTranscribeRequest(makeAudioForm(null)), makeEnv());
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls.length, 0);
  });

  test('stream=true is refused while ALLOW_STREAMING is false', async () => {
    const form = makeAudioForm('gpt-4o-mini-transcribe');
    form.append('stream', 'true');
    const response = await worker.fetch(makeTranscribeRequest(form), makeEnv());
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as { error: { code: string } };
    assert.equal(parsed.error.code, 'streaming_disabled');
    assert.equal(upstreamCalls.length, 0);
  });

  test('chat and transcription share one daily budget', async () => {
    const env = makeEnv({ DAILY_REQUEST_LIMIT: '1' });
    const chat = await worker.fetch(makeRequest(), env);
    assert.equal(chat.status, 200);
    const voice = await worker.fetch(makeTranscribeRequest(), env);
    assert.equal(voice.status, 429);
    assert.equal(upstreamCalls.length, 1, 'the voice request must not reach OpenAI');
  });

  test('no log line contains the filename, the form fields or the audio bytes', async () => {
    await worker.fetch(makeTranscribeRequest(), makeEnv());
    const joined = logLines.join('\n');
    for (const secret of [AUDIO_MARKER, 'голос', 'иванова', GOOD_TOKEN, REAL_KEY]) {
      assert.ok(!joined.includes(secret), `log leaked ${secret}: ${joined}`);
    }
    const entry = JSON.parse(logLines[0]) as Record<string, unknown>;
    assert.equal(entry.outcome, 'ok');
    assert.equal(entry.model, 'whisper-1');
  });
});

// --- output token cap ------------------------------------------------------

describe('output token cap', () => {
  test('max_tokens over the cap is refused', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 100000 });
    const response = await worker.fetch(makeRequest(body), makeEnv());
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls.length, 0);
  });

  test('max_completion_tokens is checked too', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', max_completion_tokens: 100000 });
    const response = await worker.fetch(makeRequest(body), makeEnv());
    assert.equal(response.status, 400);
  });

  test('the CRM assistant default of 2000 passes', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 2000 });
    const response = await worker.fetch(makeRequest(body), makeEnv());
    assert.equal(response.status, 200);
  });

  test('MAX_OUTPUT_TOKENS=0 disables the check', async () => {
    const body = JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 999999 });
    const response = await worker.fetch(makeRequest(body), makeEnv({ MAX_OUTPUT_TOKENS: '0' }));
    assert.equal(response.status, 200);
  });
});

// --- daily quota -----------------------------------------------------------

describe('daily quota', () => {
  test('refuses past the ceiling and reports when to retry', async () => {
    const env = makeEnv({ DAILY_REQUEST_LIMIT: '3' });
    for (let i = 0; i < 3; i += 1) {
      const ok = await worker.fetch(makeRequest(), env);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('x-proxy-quota-used'), String(i + 1));
      assert.equal(ok.headers.get('x-proxy-quota-limit'), '3');
    }
    const blocked = await worker.fetch(makeRequest(), env);
    assert.equal(blocked.status, 429);
    assert.equal(upstreamCalls.length, 3, 'the 4th request must not reach OpenAI');
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 86_400, `implausible retry-after ${retryAfter}`);
    const parsed = (await blocked.json()) as { error: { code: string } };
    assert.equal(parsed.error.code, 'daily_limit_exceeded');
  });

  test('a limit of 0 blocks everything', async () => {
    const response = await worker.fetch(makeRequest(), makeEnv({ DAILY_REQUEST_LIMIT: '0' }));
    assert.equal(response.status, 429);
    assert.equal(upstreamCalls.length, 0);
  });

  test('concurrent bursts cannot exceed the ceiling', async () => {
    const env = makeEnv({ DAILY_REQUEST_LIMIT: '10' });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => worker.fetch(makeRequest(), env)),
    );
    const allowed = responses.filter((r) => r.status === 200).length;
    assert.equal(allowed, 10);
    assert.equal(upstreamCalls.length, 10);
  });

  test('an unreachable counter fails closed, not open', async () => {
    const env = makeEnv({
      DAILY_QUOTA: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => {
            throw new Error('durable object unavailable');
          },
        }),
      },
    });
    const response = await worker.fetch(makeRequest(), env);
    assert.equal(response.status, 503);
    assert.equal(upstreamCalls.length, 0);
  });

  test('the counter resets when the day rolls over', async () => {
    const storage = new Map<string, unknown>();
    const state: QuotaState = {
      storage: {
        get: async <T>(key: string) => storage.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => {
          storage.set(key, value);
        },
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    };
    const quota = new DailyQuota(state);
    const reserve = async (day: string, limit: number) => {
      const response = await quota.fetch(
        new Request(`https://quota.invalid/reserve?day=${day}&limit=${limit}`, { method: 'POST' }),
      );
      return (await response.json()) as { allowed: boolean; used: number };
    };

    assert.deepEqual(await reserve('2026-07-27', 2), { allowed: true, used: 1, limit: 2, day: '2026-07-27' });
    assert.equal((await reserve('2026-07-27', 2)).used, 2);
    assert.equal((await reserve('2026-07-27', 2)).allowed, false);
    // New day, fresh budget.
    assert.deepEqual(await reserve('2026-07-28', 2), { allowed: true, used: 1, limit: 2, day: '2026-07-28' });
  });

  test('the day boundary can be shifted off UTC', () => {
    const nearMidnightUtc = new Date('2026-07-27T22:30:00Z');
    assert.equal(dayKey(nearMidnightUtc, 0), '2026-07-27');
    assert.equal(dayKey(nearMidnightUtc, 180), '2026-07-28'); // already the 28th in Moscow
    const seconds = secondsUntilNextDay(nearMidnightUtc, 180);
    assert.ok(seconds > 0 && seconds <= 86_400);
    // 20:59Z is 23:59 Moscow, so the quota resets in one minute.
    assert.equal(secondsUntilNextDay(new Date('2026-07-27T20:59:00Z'), 180), 60);
  });
});

// --- upstream handling -----------------------------------------------------

describe('upstream handling', () => {
  test('the real key is injected and the caller token never leaves', async () => {
    await worker.fetch(makeRequest(), makeEnv());
    const headers = upstreamCalls[0].init.headers as Headers;
    assert.equal(headers.get('authorization'), `Bearer ${REAL_KEY}`);
    assert.ok(!String(headers.get('authorization')).includes(GOOD_TOKEN));
  });

  test('caller headers are not forwarded upstream', async () => {
    await worker.fetch(
      makeRequest(SENSITIVE_BODY, {
        headers: {
          'openai-organization': 'org-attacker',
          'x-forwarded-host': 'evil.example.com',
          cookie: 'session=abc',
        },
      }),
      makeEnv(),
    );
    const headers = upstreamCalls[0].init.headers as Headers;
    assert.equal(headers.get('openai-organization'), null);
    assert.equal(headers.get('x-forwarded-host'), null);
    assert.equal(headers.get('cookie'), null);
  });

  test('optional org/project secrets are applied when configured', async () => {
    await worker.fetch(
      makeRequest(),
      makeEnv({ OPENAI_ORG_ID: 'org-configured', OPENAI_PROJECT_ID: 'proj-configured' }),
    );
    const headers = upstreamCalls[0].init.headers as Headers;
    assert.equal(headers.get('openai-organization'), 'org-configured');
    assert.equal(headers.get('openai-project'), 'proj-configured');
  });

  test('the body is forwarded byte-for-byte', async () => {
    await worker.fetch(makeRequest(), makeEnv());
    assert.equal(upstreamCalls[0].init.body, SENSITIVE_BODY);
  });

  test('upstream errors are relayed with their status', async () => {
    stubUpstream(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '20' },
        }),
    );
    const response = await worker.fetch(makeRequest(), makeEnv());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '20');
  });

  test('a timeout is 504 and a network failure is 502', async () => {
    stubUpstream(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    assert.equal((await worker.fetch(makeRequest(), makeEnv())).status, 504);

    stubUpstream(() => {
      throw new TypeError('fetch failed');
    });
    assert.equal((await worker.fetch(makeRequest(), makeEnv())).status, 502);
  });

  test('response headers are allowlisted, not relayed wholesale', async () => {
    const response = await worker.fetch(makeRequest(), makeEnv());
    assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '9999');
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

// --- privacy ---------------------------------------------------------------

describe('privacy', () => {
  test('no log line contains any part of the request or response body', async () => {
    stubUpstream(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'Иванов Пётр звонил' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const response = await worker.fetch(makeRequest(), makeEnv());
    await response.text();

    assert.ok(logLines.length > 0, 'the proxy should still log something');
    const joined = logLines.join('\n');
    for (const secret of ['Ромашка', 'Иванов', '500000', 'messages', 'choices', 'content']) {
      assert.ok(!joined.includes(secret), `log leaked ${secret}: ${joined}`);
    }
  });

  test('logs carry no credentials', async () => {
    await worker.fetch(makeRequest(), makeEnv());
    const joined = logLines.join('\n');
    assert.ok(!joined.includes(GOOD_TOKEN));
    assert.ok(!joined.includes(REAL_KEY));
  });

  test('logs do carry the operational fields', async () => {
    await worker.fetch(makeRequest(), makeEnv());
    const entry = JSON.parse(logLines[0]) as Record<string, unknown>;
    assert.equal(entry.evt, 'openai_proxy');
    assert.equal(entry.outcome, 'ok');
    assert.equal(entry.status, 200);
    assert.equal(entry.model, 'gpt-4o-mini');
    assert.equal(typeof entry.duration_ms, 'number');
    assert.equal(entry.quota_limit, 500);
  });

  test('a rejected model is logged by name without the body', async () => {
    const body = JSON.stringify({ model: 'o3', messages: [{ role: 'user', content: 'Ромашка' }] });
    await worker.fetch(makeRequest(body), makeEnv());
    const entry = JSON.parse(logLines[0]) as Record<string, unknown>;
    assert.equal(entry.model, 'o3');
    assert.ok(!logLines.join('\n').includes('Ромашка'));
  });
});

// --- pure helpers ----------------------------------------------------------

describe('config parsing', () => {
  test('lists are trimmed and de-duplicated', () => {
    assert.deepEqual(parseList(' a , b ,, a '), ['a', 'b']);
    assert.deepEqual(parseList(undefined), []);
    assert.deepEqual(parseList(''), []);
  });

  test('integers are clamped, and garbage falls back', () => {
    const bounds = { fallback: 10, min: 1, max: 100 };
    assert.equal(parseBoundedInt('50', bounds), 50);
    assert.equal(parseBoundedInt('0', bounds), 1);
    assert.equal(parseBoundedInt('9999', bounds), 100);
    assert.equal(parseBoundedInt('abc', bounds), 10);
    assert.equal(parseBoundedInt(undefined, bounds), 10);
    assert.equal(parseBoundedInt('-5', bounds), 1);
  });

  test('defaults are safe when every var is missing', () => {
    const config = loadConfig({});
    assert.deepEqual(config.allowedModels, [], 'no model is allowed by default');
    assert.equal(config.allowStreaming, false);
    assert.ok(config.dailyRequestLimit > 0);
    assert.ok(config.maxBodyBytes > 0);
  });
});

describe('body reader', () => {
  test('reads a body under the cap', async () => {
    const request = new Request('https://x/', { method: 'POST', body: 'hello' });
    assert.deepEqual(await readBodyWithLimit(request, 1024), { ok: true, text: 'hello' });
  });

  test('an empty body is fine', async () => {
    const request = new Request('https://x/', { method: 'POST' });
    assert.deepEqual(await readBodyWithLimit(request, 1024), { ok: true, text: '' });
  });

  test('multi-byte characters are counted as bytes, not characters', async () => {
    // 10 Cyrillic characters = 20 UTF-8 bytes.
    const request = new Request('https://x/', { method: 'POST', body: 'о'.repeat(10) });
    assert.deepEqual(await readBodyWithLimit(request, 15), { ok: false });
  });

  test('the raw reader returns binary bytes untouched', async () => {
    // Bytes that are not valid UTF-8 — a text decode would mangle them.
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x07, 0xfe]);
    const request = new Request('https://x/', { method: 'POST', body: bytes });
    const result = await readRawBodyWithLimit(request, 1024);
    assert.ok(result.ok);
    assert.deepEqual(result.bytes, bytes);
  });
});
