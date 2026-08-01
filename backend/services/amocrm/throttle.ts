/**
 * Per-organisation token bucket for amoCRM.
 *
 * -----------------------------------------------------------------------------
 * WHY A BUCKET AND NOT A SLEEP
 * -----------------------------------------------------------------------------
 * amoCRM enforces **7 requests/second per integration** (the account-wide ceiling
 * is 50/s). Exceeding it does not merely fail the request: repeated 429s get an
 * integration blocked, and a blocked integration is a support ticket, not a
 * retry. An import walks tens of thousands of entities, so the limiter has to be
 * a real queue rather than a `await sleep(150)` sprinkled through the callers —
 * otherwise two concurrent workers (import + sync) each sleep politely and
 * together still emit 14 r/s.
 *
 * The bucket therefore lives here, is keyed by `organization_id`, and EVERY
 * outbound call — including the OAuth token endpoint, which shares the same host
 * — passes through it. Rate is 5/s by default, deliberately under the 7 ceiling:
 * the limit is measured on amoCRM's side with their clock and their idea of a
 * second, so the headroom absorbs the disagreement.
 *
 * -----------------------------------------------------------------------------
 * TIME
 * -----------------------------------------------------------------------------
 * Only `Date.now()` and `setTimeout` are used, both of which vitest's fake timers
 * replace, so the tests exercise the real scheduling arithmetic rather than a
 * test-only branch. There is no injected clock.
 */

export interface TokenBucketOptions {
  /** Sustained requests per second. Default 5 (headroom under amoCRM's 7). */
  ratePerSecond?: number;
  /** Bucket capacity — how large an instantaneous burst may be. Default = rate. */
  burst?: number;
  /**
   * Reject rather than queue past this many waiters. Guards against an unbounded
   * queue when a caller loops without awaiting. Default 10_000.
   */
  maxQueueDepth?: number;
}

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

export class ThrottleQueueOverflowError extends Error {
  readonly code = 'AMO_THROTTLE_QUEUE_FULL';

  constructor(depth: number) {
    super(`amoCRM throttle queue is full (${depth} waiting)`);
    this.name = 'ThrottleQueueOverflowError';
  }
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxQueueDepth: number;

  private tokens: number;
  private lastRefillAt: number;
  private backoffUntil = 0;

  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerFiresAt = 0;

  constructor(options: TokenBucketOptions = {}) {
    const rate = options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
    if (!(rate > 0)) {
      throw new Error('ratePerSecond must be greater than 0');
    }

    this.capacity = Math.max(1, options.burst ?? rate);
    this.refillPerMs = rate / 1000;
    this.maxQueueDepth = options.maxQueueDepth ?? 10_000;
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
  }

  /** Tokens currently available. Exposed for tests and diagnostics only. */
  get available(): number {
    this.refill(Date.now());
    return this.tokens;
  }

  /** Requests currently waiting for a token. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Milliseconds remaining on an active back-off, or 0. */
  get backoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - Date.now());
  }

  /**
   * Resolves when the caller may send one request.
   *
   * FIFO: a request that queued first is released first, so a long import cannot
   * starve an interactive sync behind it indefinitely.
   */
  acquire(): Promise<void> {
    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new ThrottleQueueOverflowError(this.queue.length));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.pump();
    });
  }

  /**
   * Back the WHOLE bucket off — every queued and future request — for `delayMs`.
   *
   * Called on a 429 with its `Retry-After`. It is deliberately bucket-wide rather
   * than per-request: amoCRM counted our aggregate rate, so slowing only the one
   * request that happened to lose is no answer. The bucket is also drained to
   * zero, because a 429 is proof we already overspent, and accrual restarts from
   * empty when the back-off lapses rather than releasing a full burst the instant
   * the penalty ends.
   */
  backOff(delayMs: number): void {
    const now = Date.now();
    const until = now + Math.max(0, delayMs);
    if (until > this.backoffUntil) {
      this.backoffUntil = until;
    }
    this.tokens = 0;
    this.lastRefillAt = this.backoffUntil;
    this.pump();
  }

  /**
   * Fail every waiter and drop any pending timer. Used when an integration is
   * disconnected or moves to needs_reauth: keeping requests queued against an
   * account we can no longer authenticate to is pointless work.
   */
  drain(reason: Error): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.timerFiresAt = 0;
    }
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(reason);
    }
  }

  private refill(now: number): void {
    if (now <= this.lastRefillAt) {
      // Also the back-off case: lastRefillAt is parked in the future, so nothing
      // accrues until the penalty has actually elapsed.
      return;
    }
    const elapsed = now - this.lastRefillAt;
    this.lastRefillAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
  }

  private pump(): void {
    const now = Date.now();

    if (now < this.backoffUntil) {
      this.schedule(this.backoffUntil - now);
      return;
    }

    this.refill(now);

    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!.resolve();
    }

    if (this.queue.length > 0) {
      // Time until the bucket holds one whole token again.
      this.schedule((1 - this.tokens) / this.refillPerMs);
    }
  }

  private schedule(delayMs: number): void {
    const delay = Math.max(1, Math.ceil(delayMs));
    const firesAt = Date.now() + delay;

    if (this.timer !== null) {
      if (this.timerFiresAt <= firesAt) {
        return; // An earlier wake-up is already pending; it will re-pump.
      }
      clearTimeout(this.timer);
    }

    this.timerFiresAt = firesAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerFiresAt = 0;
      this.pump();
    }, delay);

    // A queued request must never be the reason the process refuses to exit.
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * 5 r/s sustained against amoCRM's documented 7 r/s per-integration limit.
 * Override per deployment with AMOCRM_RATE_LIMIT_PER_SECOND if an account is
 * known to be on a different ceiling; the value is clamped so a typo cannot
 * configure the integration into a ban.
 */
export const DEFAULT_RATE_PER_SECOND = 5;
const MAX_CONFIGURABLE_RATE_PER_SECOND = 7;

function configuredRate(): number {
  const raw = Number.parseFloat(process.env.AMOCRM_RATE_LIMIT_PER_SECOND ?? '');
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_RATE_PER_SECOND;
  }
  return Math.min(raw, MAX_CONFIGURABLE_RATE_PER_SECOND);
}

const buckets = new Map<string, TokenBucket>();

/** The bucket for one organisation, created on first use. */
export function getThrottle(orgId: string): TokenBucket {
  let bucket = buckets.get(orgId);
  if (!bucket) {
    const rate = configuredRate();
    bucket = new TokenBucket({ ratePerSecond: rate, burst: rate });
    buckets.set(orgId, bucket);
  }
  return bucket;
}

/** Wait for this organisation's turn to call amoCRM. */
export function acquireAmoSlot(orgId: string): Promise<void> {
  return getThrottle(orgId).acquire();
}

/** Apply a 429's penalty to the whole organisation's bucket. */
export function backOffOrg(orgId: string, delayMs: number): void {
  getThrottle(orgId).backOff(delayMs);
}

/** Forget an organisation's bucket — called on disconnect. */
export function releaseThrottle(orgId: string, reason?: Error): void {
  const bucket = buckets.get(orgId);
  if (!bucket) return;
  bucket.drain(reason ?? new Error('amoCRM integration disconnected'));
  buckets.delete(orgId);
}

/** Test helper: drop every bucket so suites do not leak state into each other. */
export function resetThrottles(): void {
  for (const bucket of buckets.values()) {
    bucket.drain(new Error('throttle reset'));
  }
  buckets.clear();
}

/**
 * `Retry-After` in milliseconds, or null when the header is absent/unparseable.
 *
 * RFC 9110 allows both a delay in seconds and an HTTP-date; amoCRM has been seen
 * to send the numeric form, but a proxy in front of it may rewrite it, so both
 * are handled. The result is clamped to `maxMs` (default 5 min) so a hostile or
 * broken header cannot park a worker for a day.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  maxMs = 5 * 60_000,
): number | null {
  if (!header) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, maxMs);
  }

  // The only other legal form is an HTTP-date, which always carries a month or
  // weekday name. Requiring a letter stops Date.parse from cheerfully reading
  // '-5' as a year and turning a malformed header into a 2000-year wait.
  if (!/[a-z]/i.test(trimmed)) return null;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), maxMs);
}
