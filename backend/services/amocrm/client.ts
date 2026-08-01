/**
 * The amoCRM HTTP client: one door, and every rule about talking to amoCRM
 * enforced behind it.
 *
 * Nothing outside this file should call `fetch` against an amoCRM host. The
 * import, the sync worker and the webhook receiver all go through `amoRequest`
 * or `paginate`, which is what makes these guarantees hold for the whole
 * integration rather than for whichever caller remembered:
 *
 *   • Every request carries a token that `getAccessToken` has already renewed if
 *     it was close to expiry, under the advisory lock.
 *   • Every request passes the per-organisation token bucket, so two workers
 *     running at once still add up to under amoCRM's 7 r/s.
 *   • A 429 backs the WHOLE bucket off by the server's own `retry_after`.
 *   • A 5xx or a network fault is retried with exponential backoff and jitter.
 *   • A 401 refreshes ONCE and retries once. A second 401 means the integration
 *     was revoked, not expired: it is marked needs_reauth and never retried.
 *   • 402 (account unpaid) and 403 (no rights, or rate-blocked) are terminal.
 *     amoCRM answers 403 to EVERY request once an account is blocked for
 *     repeated limit violations, so retrying is exactly the wrong move.
 *
 * `paginate` is the generator the import walks. It follows `_links.next.href`
 * and re-validates that href's origin — a server-supplied absolute URL that the
 * client follows blindly is an SSRF primitive even when the server is one we
 * chose to trust.
 */

import {
  AmoOAuthError,
  AmoReauthRequiredError,
  amoUrl,
  getAccessToken,
  markNeedsReauth,
  type AmoAccess,
} from './auth';
import { acquireAmoSlot, backOffOrg, parseRetryAfterMs } from './throttle';
import { AMO_EMBEDDED_KEYS, AMO_MAX_BATCH, AMO_PAGE_LIMIT, type AmoCollection } from './types';

export type AmoMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type AmoQuery = Record<string, string | number | boolean | undefined | null>;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * A non-2xx from the amoCRM API.
 *
 * `terminal` is the field callers must branch on. It answers "is another attempt
 * capable of succeeding?" — not "was this an error?". A queue that retries a
 * terminal error burns quota and, for 403, keeps an already-blocked account
 * blocked.
 */
export class AmoApiError extends Error {
  readonly code = 'AMO_API_ERROR';

  constructor(
    message: string,
    readonly status: number,
    readonly terminal: boolean,
    readonly method: string,
    readonly path: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'AmoApiError';
  }
}

export class AmoRateLimitError extends AmoApiError {
  constructor(method: string, path: string, readonly retryAfterMs: number, body?: unknown) {
    super(
      `amoCRM rate limit hit on ${method} ${path}; backing off ${Math.round(retryAfterMs / 1000)}s`,
      429,
      false,
      method,
      path,
      body,
    );
    this.name = 'AmoRateLimitError';
  }
}

/** The request never got an answer: DNS, TCP, TLS, or our own timeout. */
export class AmoNetworkError extends Error {
  readonly code = 'AMO_NETWORK_ERROR';
  readonly terminal = false;

  constructor(message: string, readonly method: string, readonly path: string) {
    super(message);
    this.name = 'AmoNetworkError';
  }
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
/** Attempts at the transport level (a 5xx or network fault). Not the 401 retry. */
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Absolute cap on a 429 stall, so one bad header cannot park a worker for hours. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const handle = timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  });
}

/**
 * Exponential backoff with full jitter. The jitter is not decoration: without
 * it, a hundred jobs that failed on the same 502 all wake at the same
 * millisecond and reproduce the overload they were backing off from.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.floor(Math.random() * ceiling) + Math.floor(ceiling / 4);
}

// ─── Request ──────────────────────────────────────────────────────────────────

export interface AmoRequestOptions {
  /** Query parameters appended to `path`. Undefined/null entries are dropped. */
  query?: AmoQuery;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Transport-level attempts for 5xx/network faults. Default 4. */
  maxAttempts?: number;
  /** Caller cancellation, e.g. a shutting-down worker. */
  signal?: AbortSignal;
  /** Treat a 404 as an empty result instead of an error. */
  notFoundAsNull?: boolean;
}

interface Attempted {
  response: Response;
  raw: string;
}

async function sendOnce(
  access: AmoAccess,
  method: AmoMethod,
  path: string,
  body: unknown,
  options: AmoRequestOptions,
): Promise<Attempted> {
  const url = amoUrl(access.subdomain, path, options.query);

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const hasBody = body !== undefined && body !== null;
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${access.access_token}`,
        Accept: 'application/json',
        'User-Agent': process.env.AMOCRM_USER_AGENT?.trim() || '4KUB-CRM/1.0',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      // amoCRM's unsubscribe is a DELETE that carries a JSON body, so the body
      // is attached for every method that supplies one, not just POST/PATCH.
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      // Never follow a redirect: it would replay the Authorization header at
      // whatever host the response names.
      redirect: 'error',
      signal: controller.signal,
    });

    const raw = await response.text();
    return { response, raw };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function parseBody(raw: string): unknown {
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describeApiFailure(status: number, body: unknown, method: string, path: string): string {
  const envelope = (body ?? {}) as { title?: string; detail?: string; hint?: string; message?: string };
  const detail = envelope.detail ?? envelope.hint ?? envelope.title ?? envelope.message;
  return detail
    ? `amoCRM ${method} ${path} failed with ${status}: ${detail}`
    : `amoCRM ${method} ${path} failed with ${status}`;
}

/** The `retry_after` amoCRM actually sends — a BODY field, in seconds. */
function retryAfterFrom(response: Response, body: unknown): number {
  const fromBody = (body as { retry_after?: unknown } | null)?.retry_after;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
    return Math.min(fromBody * 1000, MAX_RETRY_AFTER_MS);
  }
  // Only Kommo documents the body field, and amocrm.ru documents neither, so the
  // RFC header is still read as a fallback before falling back to a flat minute.
  // VERIFY: whether amoCRM ever sends the `Retry-After` header is UNCONFIRMED.
  return parseRetryAfterMs(response.headers.get('retry-after'), MAX_RETRY_AFTER_MS) ?? 60_000;
}

/**
 * One authenticated call to the amoCRM API.
 *
 * Returns `null` for a 204 or an empty body — amoCRM answers 204 No Content for
 * a list that matched nothing, so `null` means "no data", not "failure".
 */
export async function amoRequest<T>(
  orgId: string,
  method: AmoMethod,
  path: string,
  body?: unknown,
  options: AmoRequestOptions = {},
): Promise<T | null> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  let refreshedOnce = false;
  let attempt = 0;

  // Not a `for` loop: a 401-driven refresh deliberately does NOT consume a
  // transport attempt, and a 429 consumes one only after the bucket has been
  // backed off. Making that explicit is worth the while(true).
  while (true) {
    attempt += 1;

    // Re-read every attempt rather than caching: a concurrent worker may have
    // rotated the token between our attempts, and the stale copy would 401.
    const access = await getAccessToken(orgId);

    await acquireAmoSlot(orgId);

    let attempted: Attempted;
    try {
      attempted = await sendOnce(access, method, path, body, options);
    } catch (err) {
      // A caller-driven abort is not a fault to retry.
      if (options.signal?.aborted) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        throw new AmoNetworkError(
          `amoCRM ${method} ${path} failed after ${attempt} attempts: ${message}`,
          method,
          path,
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    }

    const { response, raw } = attempted;

    if (response.status === 204 || raw.trim().length === 0) {
      if (response.ok) return null;
    }

    const parsed = parseBody(raw);

    if (response.ok) {
      return parsed as T | null;
    }

    // ── 401: the token is dead. Refresh once, retry once. ──────────────────
    if (response.status === 401) {
      if (refreshedOnce) {
        // A freshly minted token was refused. That is a revoked integration,
        // not an expiry — stop, and make sure nothing else tries either.
        await markNeedsReauth(
          orgId,
          `amoCRM refused a freshly refreshed token on ${method} ${path}`,
        );
        throw new AmoReauthRequiredError(orgId, 'amoCRM refused a freshly refreshed access token');
      }

      refreshedOnce = true;
      attempt -= 1; // The refresh is not a transport attempt.
      try {
        // staleAccessToken is what makes concurrent 401s collapse into ONE
        // refresh: whoever gets the lock second sees the token already moved.
        await getAccessToken(orgId, {
          forceRefresh: true,
          staleAccessToken: access.access_token,
        });
      } catch (err) {
        // A terminal refresh failure (AmoReauthRequiredError) propagates
        // untouched — it must never be retried.
        if (err instanceof AmoOAuthError && !err.terminal && attempt < maxAttempts) {
          await sleep(backoffDelay(Math.max(1, attempt)));
          continue;
        }
        throw err;
      }
      continue;
    }

    // ── 429: back the whole bucket off, then retry. ────────────────────────
    if (response.status === 429) {
      const delayMs = retryAfterFrom(response, parsed);
      backOffOrg(orgId, delayMs);
      if (attempt >= maxAttempts) {
        throw new AmoRateLimitError(method, path, delayMs, parsed);
      }
      // No explicit sleep: the bucket now refuses to release a slot until the
      // back-off lapses, so the next acquireAmoSlot IS the wait — and it stalls
      // every other worker for this org too, which a local sleep would not.
      continue;
    }

    // ── Terminal by contract. ──────────────────────────────────────────────
    if (response.status === 402 || response.status === 403) {
      throw new AmoApiError(
        describeApiFailure(response.status, parsed, method, path),
        response.status,
        true,
        method,
        path,
        parsed,
      );
    }

    if (response.status === 404 && options.notFoundAsNull) {
      return null;
    }

    // ── 5xx: transient. ────────────────────────────────────────────────────
    if (response.status >= 500) {
      if (attempt >= maxAttempts) {
        throw new AmoApiError(
          describeApiFailure(response.status, parsed, method, path),
          response.status,
          false,
          method,
          path,
          parsed,
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    }

    // Every other 4xx is our mistake — a malformed filter, a bad id, a field
    // this account does not have. Retrying cannot fix it.
    throw new AmoApiError(
      describeApiFailure(response.status, parsed, method, path),
      response.status,
      true,
      method,
      path,
      parsed,
    );
  }
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginateOptions {
  /** Page size. Clamped to amoCRM's maximum of 250. */
  limit?: number;
  /**
   * Which array inside `_embedded` holds the entities. Inferred from the path
   * for the standard collections; pass it for anything unusual.
   */
  embeddedKey?: string;
  /** Safety stop. Default 10 000 pages (2.5 M entities at limit=250). */
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * `_embedded` is keyed by the plural entity name, which is NOT derivable from
 * the response alone when several arrays are present. Preference order:
 *   1. what the caller said,
 *   2. the last non-numeric path segment, if it names a known collection,
 *   3. the single array-valued key, when the body has exactly one.
 * Returning null rather than guessing is deliberate: silently reading the wrong
 * array would make an import look successful while importing nothing.
 */
export function inferEmbeddedKey(path: string, body: AmoCollection<unknown>): string | null {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (/^\d+$/.test(segment)) continue;
    const known = AMO_EMBEDDED_KEYS[segment];
    if (known) return known;
  }

  const embedded = body._embedded ?? {};
  const arrayKeys = Object.keys(embedded).filter((key) => Array.isArray(embedded[key]));
  return arrayKeys.length === 1 ? arrayKeys[0] : null;
}

/**
 * Walk an amoCRM collection page by page, yielding one page of entities at a
 * time. The import consumes this directly:
 *
 *   for await (const batch of paginate<AmoContact>(orgId, '/api/v4/contacts')) { … }
 *
 * Pagination ends on ANY of: a 204/empty response, a page with no `_links.next`,
 * a `next` href identical to the one just fetched (amoCRM has been known to
 * repeat the last page rather than omit the link), or maxPages.
 *
 * // VERIFY: "absent `_links.next` terminates the walk" is implied by the
 * // documented example but never stated verbatim; the 204-on-empty behaviour is
 * // documented on the Kommo mirror only. Both terminators are honoured.
 */
export async function* paginate<T>(
  orgId: string,
  path: string,
  params: AmoQuery = {},
  options: PaginateOptions = {},
): AsyncGenerator<T[], void, undefined> {
  // `params` may already carry `limit` and `page` — the import passes a start
  // page to resume an interrupted run. Overriding them here would silently
  // restart every resumed import from page 1, which looks like success and
  // re-imports everything. The caller's values win; only the clamp is ours.
  const requestedLimit = Number(params.limit);
  const limit = Math.min(
    Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : options.limit ?? AMO_PAGE_LIMIT),
    AMO_PAGE_LIMIT,
  );
  const requestedPage = Number(params.page);
  const startPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const maxPages = options.maxPages ?? 10_000;

  // Resolved once so the `_links.next` href can be checked against the account's
  // own origin. Every page after the first is a URL amoCRM chose, not one we
  // built, and following such a URL unchecked is how a client becomes an SSRF
  // relay for whoever can influence that response.
  const { subdomain } = await getAccessToken(orgId);

  let target = path;
  let query: AmoQuery | undefined = { ...params, limit, page: startPage };
  let seen: string | null = null;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;

    const page = await amoRequest<AmoCollection<T>>(orgId, 'GET', target, undefined, {
      query,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    // 204 No Content: the filter matched nothing, or we walked past the end.
    if (!page) return;

    const key = options.embeddedKey ?? inferEmbeddedKey(target, page);
    const items = key ? ((page._embedded?.[key] ?? []) as T[]) : [];

    if (items.length > 0) {
      yield items;
    }

    const next = page._links?.next?.href;
    if (!next || next === seen) return;
    // Guard against an empty page that still advertises a next link, which would
    // otherwise spin to maxPages doing nothing.
    if (items.length === 0) return;

    seen = next;
    const nextUrl = amoUrl(subdomain, next);
    target = `${nextUrl.pathname}${nextUrl.search}`;
    query = undefined;
  }
}

/**
 * Every entity of a collection in one array. Convenience over `paginate` for
 * small collections (pipelines, users, custom-field definitions) — never for
 * contacts or leads, where the whole point of the generator is not holding the
 * account in memory. `cap` is a hard stop against that mistake.
 */
export async function amoFetchAll<T>(
  orgId: string,
  path: string,
  params: AmoQuery = {},
  options: PaginateOptions & { cap?: number } = {},
): Promise<T[]> {
  const cap = options.cap ?? 5_000;
  const all: T[] = [];
  for await (const batch of paginate<T>(orgId, path, params, options)) {
    all.push(...batch);
    if (all.length >= cap) return all.slice(0, cap);
  }
  return all;
}

/**
 * Split a write into batches amoCRM will accept. The hard ceiling is 500
 * entities per request; 250 is amoCRM's own recommendation and the default here,
 * so reads and writes use one page size.
 */
export function chunkForBatch<T>(items: readonly T[], size = AMO_PAGE_LIMIT): T[][] {
  const bounded = Math.min(Math.max(1, size), AMO_MAX_BATCH);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += bounded) {
    out.push(items.slice(i, i + bounded));
  }
  return out;
}

export { AMO_MAX_BATCH, AMO_PAGE_LIMIT };
