// ---------------------------------------------------------------------------
// 4КУБ → OpenAI proxy.
//
// api.openai.com is not reachable from Russia, so the CRM backend talks to this
// Worker instead. The Worker holds the OpenAI key; the CRM only ever holds
// PROXY_TOKEN, a separate shared secret that grants nothing but these two
// rate-limited endpoints.
//
// PRIVACY — READ BEFORE ADDING ANY console.log:
// Request and response bodies carry customer contact names, deal titles,
// free-text notes — and, on the transcription route, recordings of a real
// person's voice. They are NEVER logged, never stored, and never buffered any
// longer than it takes to forward them. The only observability this Worker
// emits is the single structured line built by `emitLog` below: outcome, HTTP
// status, duration, model name and quota counters. If you need to debug a
// payload, reproduce it locally against `wrangler dev` — do not add body
// logging here.
// ---------------------------------------------------------------------------

import {
  dayKey,
  loadConfig,
  isModelAllowed,
  secondsUntilNextDay,
  type ConfigVars,
  type ProxyConfig,
} from './config.ts';
import { extractBearerToken, isAuthorized } from './auth.ts';
import { DailyQuota, type QuotaDecision } from './quota.ts';

export { DailyQuota };

const ROUTE_METHOD = 'POST';
const CHAT_PATH = '/v1/chat/completions';
const CHAT_UPSTREAM_URL = 'https://api.openai.com/v1/chat/completions';
const TRANSCRIBE_PATH = '/v1/audio/transcriptions';
const TRANSCRIBE_UPSTREAM_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** The single Durable Object instance that owns the daily counter. */
const QUOTA_OBJECT_NAME = 'daily-quota-v1';

/**
 * Response headers copied back to the CRM. An allowlist, not a blocklist:
 * anything OpenAI adds in the future (cookies, tracing ids, account hints) is
 * dropped by default rather than relayed into the CRM by accident.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
];

type QuotaId = unknown;
type QuotaStub = { fetch(request: Request): Promise<Response> };
export type QuotaNamespace = {
  idFromName(name: string): QuotaId;
  get(id: QuotaId): QuotaStub;
};

export type Env = ConfigVars & {
  /** Secret — `wrangler secret put OPENAI_API_KEY`. Never in wrangler.toml. */
  OPENAI_API_KEY?: string;
  /** Secret — `wrangler secret put PROXY_TOKEN`. Never in wrangler.toml. */
  PROXY_TOKEN?: string;
  /** Optional secret, only set during a token rotation. See README. */
  PROXY_TOKEN_PREVIOUS?: string;
  /** Optional secrets for accounts that scope keys to an org/project. */
  OPENAI_ORG_ID?: string;
  OPENAI_PROJECT_ID?: string;
  DAILY_QUOTA: QuotaNamespace;
};

type LogFields = {
  outcome: string;
  status: number;
  model?: string;
  upstream_status?: number;
  quota_used?: number;
  quota_limit?: number;
};

type Finish = (response: Response, fields: LogFields) => Response;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    const ray = request.headers.get('cf-ray') ?? undefined;

    const emitLog = (fields: LogFields): void => {
      // Deliberately minimal. No bodies, no headers, no tokens, no client IP.
      console.log(
        JSON.stringify({
          evt: 'openai_proxy',
          ...fields,
          duration_ms: Date.now() - startedAt,
          ray,
        }),
      );
    };

    const finish: Finish = (response, fields) => {
      emitLog(fields);
      return response;
    };

    // --- 1. Routing ------------------------------------------------------
    // Exactly two method + path pairs. Everything else is 404, including the
    // right path with the wrong method: there is no wildcard passthrough,
    // because a general-purpose proxy in front of a funded OpenAI account is
    // an open relay for anyone who ever sees PROXY_TOKEN.
    const url = new URL(request.url);
    const isChat = request.method === ROUTE_METHOD && url.pathname === CHAT_PATH;
    const isTranscribe = request.method === ROUTE_METHOD && url.pathname === TRANSCRIBE_PATH;
    if (!isChat && !isTranscribe) {
      return finish(errorResponse(404, 'not_found', 'Not found.'), {
        outcome: 'not_found',
        status: 404,
      });
    }

    // --- 2. Configuration sanity ----------------------------------------
    // Fail closed: a Worker deployed without its secrets must reject traffic,
    // never wave it through.
    if (!env.PROXY_TOKEN || !env.OPENAI_API_KEY) {
      return finish(
        errorResponse(503, 'proxy_not_configured', 'Proxy is not fully configured.'),
        { outcome: 'not_configured', status: 503 },
      );
    }

    const config = loadConfig(env);

    // --- 3. Caller authentication ---------------------------------------
    // Before the body is read and before the quota is touched, so unauthorised
    // traffic can neither consume memory nor burn the CRM's daily budget.
    const presented = extractBearerToken(request.headers.get('authorization'));
    const authorized = await isAuthorized(presented, env.PROXY_TOKEN, env.PROXY_TOKEN_PREVIOUS);
    if (!authorized) {
      return finish(errorResponse(401, 'unauthorized', 'Invalid proxy credentials.'), {
        outcome: 'unauthorized',
        status: 401,
      });
    }

    return isTranscribe
      ? handleTranscribe(request, env, config, finish)
      : handleChat(request, env, config, finish);
  },
};

/** POST /v1/chat/completions — JSON in, JSON (or SSE) out. */
async function handleChat(
  request: Request,
  env: Env,
  config: ProxyConfig,
  finish: Finish,
): Promise<Response> {
  // --- 4. Body: content type, size cap, JSON ---------------------------
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return finish(
      errorResponse(415, 'unsupported_media_type', 'Content-Type must be application/json.'),
      { outcome: 'bad_content_type', status: 415 },
    );
  }

  const body = await readBodyWithLimit(request, config.maxBodyBytes);
  if (!body.ok) {
    return finish(
      errorResponse(
        413,
        'payload_too_large',
        `Request body exceeds the ${config.maxBodyBytes} byte limit.`,
      ),
      { outcome: 'body_too_large', status: 413 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    // The parse error message can quote body content — never include it.
    return finish(errorResponse(400, 'invalid_json', 'Body must be a JSON object.'), {
      outcome: 'invalid_json',
      status: 400,
    });
  }

  // --- 5. Model allowlist (before any upstream call) -------------------
  const model = payload.model;
  if (!isModelAllowed(model, config.allowedModels)) {
    const label = typeof model === 'string' ? model : undefined;
    return finish(
      errorResponse(
        400,
        'model_not_allowed',
        'Requested model is not permitted by this proxy.',
      ),
      { outcome: 'model_not_allowed', status: 400, model: label },
    );
  }

  // --- 6. Streaming gate ------------------------------------------------
  // The CRM's provider client is request/response (yandex-gpt.ts sends
  // `stream: false` and reads one JSON body), so streaming is off by
  // default. It is gated, not foreclosed: the response below is piped
  // through unbuffered, so flipping ALLOW_STREAMING to "true" is all that is
  // needed once the backend can consume SSE.
  if (payload.stream && !config.allowStreaming) {
    return finish(
      errorResponse(
        400,
        'streaming_disabled',
        'Streaming is disabled on this proxy. Set ALLOW_STREAMING=true to enable it.',
      ),
      { outcome: 'streaming_disabled', status: 400, model },
    );
  }

  // --- 7. Per-request output cap ---------------------------------------
  if (config.maxOutputTokens > 0) {
    const requested = payload.max_completion_tokens ?? payload.max_tokens;
    if (typeof requested === 'number' && requested > config.maxOutputTokens) {
      return finish(
        errorResponse(
          400,
          'max_tokens_too_large',
          `Requested output tokens exceed the proxy limit of ${config.maxOutputTokens}.`,
        ),
        { outcome: 'max_tokens_too_large', status: 400, model },
      );
    }
  }

  return reserveAndForward({
    upstreamUrl: CHAT_UPSTREAM_URL,
    // Forwarded verbatim: re-serialising could subtly change the request
    // (key order, number formatting) and we have no reason to rewrite it.
    body: body.text,
    contentType: 'application/json',
    accept: payload.stream ? 'text/event-stream' : 'application/json',
    model,
    env,
    config,
    finish,
  });
}

/**
 * POST /v1/audio/transcriptions — multipart audio in, JSON transcript out.
 *
 * The voice-message path of the CRM assistant. The multipart body is parsed
 * once, in memory, only to read the `model` and `stream` fields for the
 * allowlist and streaming gates — the ORIGINAL bytes are what get forwarded,
 * because re-serialising multipart would rewrite the boundary and byte layout
 * for no reason. Nothing from the form — filename, audio, prompt — is ever
 * logged; the static-error-strings rule applies here exactly as in handleChat.
 */
async function handleTranscribe(
  request: Request,
  env: Env,
  config: ProxyConfig,
  finish: Finish,
): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return finish(
      errorResponse(415, 'unsupported_media_type', 'Content-Type must be multipart/form-data.'),
      { outcome: 'bad_content_type', status: 415 },
    );
  }

  const body = await readRawBodyWithLimit(request, config.maxAudioBodyBytes);
  if (!body.ok) {
    return finish(
      errorResponse(
        413,
        'payload_too_large',
        `Request body exceeds the ${config.maxAudioBodyBytes} byte limit.`,
      ),
      { outcome: 'body_too_large', status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await new Request('https://parse.invalid/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: body.bytes,
    }).formData();
  } catch {
    // The parse error message can quote body content — never include it.
    return finish(
      errorResponse(400, 'invalid_multipart', 'Body must be valid multipart/form-data.'),
      { outcome: 'invalid_multipart', status: 400 },
    );
  }

  const model = form.get('model');
  if (!isModelAllowed(model, config.allowedTranscribeModels)) {
    const label = typeof model === 'string' ? model : undefined;
    return finish(
      errorResponse(
        400,
        'model_not_allowed',
        'Requested model is not permitted by this proxy.',
      ),
      { outcome: 'model_not_allowed', status: 400, model: label },
    );
  }

  // Transcription streaming (gpt-4o-transcribe models) rides the same gate as
  // chat streaming: refused rather than silently downgraded.
  const wantsStream = form.get('stream') === 'true';
  if (wantsStream && !config.allowStreaming) {
    return finish(
      errorResponse(
        400,
        'streaming_disabled',
        'Streaming is disabled on this proxy. Set ALLOW_STREAMING=true to enable it.',
      ),
      { outcome: 'streaming_disabled', status: 400, model },
    );
  }

  return reserveAndForward({
    upstreamUrl: TRANSCRIBE_UPSTREAM_URL,
    // The original bytes, verbatim — the content-type header carries the
    // boundary they were encoded with, so both must travel together.
    body: body.bytes,
    contentType,
    accept: wantsStream ? 'text/event-stream' : 'application/json',
    model,
    env,
    config,
    finish,
  });
}

/**
 * Steps shared by both routes once a request is validated: reserve a slot in
 * the daily ceiling, call OpenAI with rebuilt headers, and relay the response
 * through the header allowlist. Headers are built from scratch rather than
 * forwarded: anything the caller sent — a second Authorization header,
 * OpenAI-Organization, an injected Host — is discarded, so the caller cannot
 * smuggle fields into the upstream request or bill a different account.
 */
async function reserveAndForward(options: {
  upstreamUrl: string;
  body: BodyInit;
  contentType: string;
  accept: string;
  model: string;
  env: Env;
  config: ProxyConfig;
  finish: Finish;
}): Promise<Response> {
  const { upstreamUrl, body, contentType, accept, model, env, config, finish } = options;

  // --- 8. Daily ceiling -------------------------------------------------
  const now = new Date();
  const today = dayKey(now, config.dayBoundaryOffsetMinutes);
  let decision: QuotaDecision;
  try {
    decision = await reserveQuota(env.DAILY_QUOTA, today, config.dailyRequestLimit);
  } catch {
    // The counter is a safety device. If it is unreachable we refuse rather
    // than fail open — an unmetered proxy is exactly the failure we are
    // trying to prevent.
    return finish(
      errorResponse(503, 'quota_unavailable', 'Request accounting is unavailable.'),
      { outcome: 'quota_unavailable', status: 503, model },
    );
  }

  if (!decision.allowed) {
    const retryAfter = secondsUntilNextDay(now, config.dayBoundaryOffsetMinutes);
    const response = errorResponse(
      429,
      'daily_limit_exceeded',
      `Daily request ceiling of ${decision.limit} reached.`,
    );
    response.headers.set('retry-after', String(retryAfter));
    response.headers.set('x-proxy-quota-used', String(decision.used));
    response.headers.set('x-proxy-quota-limit', String(decision.limit));
    return finish(response, {
      outcome: 'daily_limit_exceeded',
      status: 429,
      model,
      quota_used: decision.used,
      quota_limit: decision.limit,
    });
  }

  // --- 9. Upstream ------------------------------------------------------
  const upstreamHeaders = new Headers({
    authorization: `Bearer ${env.OPENAI_API_KEY}`,
    'content-type': contentType,
    accept,
  });
  if (env.OPENAI_ORG_ID) upstreamHeaders.set('openai-organization', env.OPENAI_ORG_ID);
  if (env.OPENAI_PROJECT_ID) upstreamHeaders.set('openai-project', env.OPENAI_PROJECT_ID);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return finish(
      errorResponse(
        timedOut ? 504 : 502,
        timedOut ? 'upstream_timeout' : 'upstream_unreachable',
        timedOut
          ? `OpenAI did not respond within ${config.upstreamTimeoutMs}ms.`
          : 'Could not reach OpenAI.',
      ),
      {
        outcome: timedOut ? 'upstream_timeout' : 'upstream_unreachable',
        status: timedOut ? 504 : 502,
        model,
        quota_used: decision.used,
        quota_limit: decision.limit,
      },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('x-proxy-quota-used', String(decision.used));
  responseHeaders.set('x-proxy-quota-limit', String(decision.limit));

  // `upstream.body` is piped straight through: the body is never read into
  // this Worker, which keeps memory flat, keeps SSE working when streaming
  // is enabled, and makes accidental body logging structurally harder.
  return finish(
    new Response(upstream.body, { status: upstream.status, headers: responseHeaders }),
    {
      outcome: upstream.ok ? 'ok' : 'upstream_error',
      status: upstream.status,
      upstream_status: upstream.status,
      model,
      quota_used: decision.used,
      quota_limit: decision.limit,
    },
  );
}

async function reserveQuota(
  namespace: QuotaNamespace,
  day: string,
  limit: number,
): Promise<QuotaDecision> {
  const stub = namespace.get(namespace.idFromName(QUOTA_OBJECT_NAME));
  const response = await stub.fetch(
    new Request(
      `https://quota.invalid/reserve?day=${encodeURIComponent(day)}&limit=${limit}`,
      { method: 'POST' },
    ),
  );
  if (!response.ok) {
    throw new Error(`quota object returned ${response.status}`);
  }
  return (await response.json()) as QuotaDecision;
}

/**
 * Reads the body while enforcing a hard byte cap, without decoding it.
 *
 * Content-Length is checked first as a cheap rejection, but it is not trusted:
 * it can be absent on a chunked request or simply be a lie. The stream is
 * therefore counted chunk by chunk and cancelled the moment it goes over, so
 * an oversized upload is dropped mid-flight instead of being buffered whole.
 */
export async function readRawBodyWithLimit(
  request: Request,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false };
  }

  if (!request.body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

/**
 * Text view of `readRawBodyWithLimit`, for the JSON route. Decoding is safe
 * there because a JSON body is UTF-8 text by definition; audio bodies must
 * never pass through this function.
 */
export async function readBodyWithLimit(
  request: Request,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const raw = await readRawBodyWithLimit(request, limit);
  if (!raw.ok) return { ok: false };
  return { ok: true, text: new TextDecoder().decode(raw.bytes) };
}

/**
 * Errors use OpenAI's envelope shape so the CRM can read `error.message` and
 * `error.code` on one code path whether the failure came from the proxy or
 * from OpenAI. Messages are static strings — they never echo body content.
 */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: 'proxy_error', code } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}
