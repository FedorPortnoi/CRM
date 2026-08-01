/**
 * The amoCRM limiter, under fake timers.
 *
 * These assertions are about a number that is not ours to negotiate: amoCRM
 * allows 7 requests/second per integration, and an integration that keeps
 * exceeding it gets blocked rather than merely throttled. So the tests pin the
 * three behaviours that decide whether an import of 40 000 contacts finishes or
 * gets the account cut off:
 *
 *   1. A burst is allowed up to the bucket's capacity and no further.
 *   2. The sustained rate really is the configured rate — the (n+1)-th request
 *      lands one refill interval later, not immediately and not a whole second.
 *   3. A 429 backs off the WHOLE bucket, including requests already queued.
 *      Backing off only the request that lost the race answers the wrong
 *      question: amoCRM measured our aggregate rate, not that one call.
 *
 * Timers are faked, so "waited 200 ms" is asserted by advancing the clock rather
 * than by wall-clock tolerance. `settled` records the fake-clock instant each
 * promise resolved at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TokenBucket,
  ThrottleQueueOverflowError,
  acquireAmoSlot,
  backOffOrg,
  getThrottle,
  parseRetryAfterMs,
  releaseThrottle,
  resetThrottles,
} from '../../../backend/services/amocrm/throttle';

/**
 * Resolve microtasks without moving the fake clock. `advanceTimersByTimeAsync`
 * already does this, but a plain `await Promise.resolve()` is not enough when a
 * promise chain is more than one tick deep.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

/** Track when (on the fake clock) each acquire resolved. */
function track(bucket: TokenBucket, count: number): { at: (number | null)[]; done: Promise<void>[] } {
  const at: (number | null)[] = new Array(count).fill(null);
  const done = Array.from({ length: count }, (_, i) =>
    bucket
      .acquire()
      .then(() => {
        at[i] = Date.now();
      })
      // A test may end with waiters still queued; afterEach drains them, and an
      // unhandled rejection there would fail an unrelated test.
      .catch(() => undefined),
  );
  return { at, done };
}

describe('amoCRM token bucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    resetThrottles();
  });

  afterEach(() => {
    resetThrottles();
    vi.useRealTimers();
    delete process.env.AMOCRM_RATE_LIMIT_PER_SECOND;
  });

  it('lets a full burst through immediately and makes the next request wait one refill interval', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 5, burst: 5 });
    const start = Date.now();

    const { at } = track(bucket, 6);
    await flush();

    // Five tokens were in the bucket at t=0, so five calls go out with no delay.
    expect(at.slice(0, 5)).toEqual([start, start, start, start, start]);
    // The sixth has to wait for a token to accrue: 1/5 s.
    expect(at[5]).toBeNull();

    await vi.advanceTimersByTimeAsync(199);
    expect(at[5]).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(at[5]).toBe(start + 200);
  });

  it('holds the sustained rate over a long queue', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 5, burst: 5 });
    const start = Date.now();

    const { at } = track(bucket, 15);
    await flush();

    // 5 immediately, then one every 200 ms.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(at.slice(0, 5)).toEqual([start, start, start, start, start]);
    expect(at[5]).toBe(start + 200);
    expect(at[9]).toBe(start + 1_000);
    expect(at[14]).toBe(start + 2_000);

    // Nothing left waiting, and the arithmetic never released more than
    // capacity + rate * elapsed requests.
    expect(bucket.waiting).toBe(0);
    const released = at.filter((t) => t !== null).length;
    expect(released).toBeLessThanOrEqual(5 + 5 * 2);
  });

  it('releases in FIFO order so a later caller cannot jump the queue', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 2, burst: 1 });
    const order: number[] = [];

    void bucket.acquire().then(() => order.push(1));
    void bucket.acquire().then(() => order.push(2));
    void bucket.acquire().then(() => order.push(3));

    await flush();
    expect(order).toEqual([1]);

    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual([1, 2, 3]);
  });

  describe('429 back-off', () => {
    it('stalls the whole bucket for Retry-After, including requests already queued', async () => {
      const bucket = new TokenBucket({ ratePerSecond: 5, burst: 5 });
      const start = Date.now();

      // Drain the burst, then queue two more.
      const { at } = track(bucket, 7);
      await flush();
      expect(at[5]).toBeNull();
      expect(at[6]).toBeNull();

      // amoCRM answers 429 Retry-After: 2 for one of the in-flight calls.
      bucket.backOff(2_000);

      // The two queued requests must NOT be released at their old 200 ms slots.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(at[5]).toBeNull();
      expect(at[6]).toBeNull();
      expect(bucket.waiting).toBe(2);

      // Back-off lapses. The bucket restarts EMPTY — a 429 is proof we already
      // overspent, so it must not hand out a fresh burst the instant the penalty
      // ends. First release is one refill interval after the back-off.
      await vi.advanceTimersByTimeAsync(1);
      expect(at[5]).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      expect(at[5]).toBe(start + 2_200);
      expect(at[6]).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      expect(at[6]).toBe(start + 2_400);
    });

    it('takes the longest of overlapping back-offs rather than the latest', async () => {
      const bucket = new TokenBucket({ ratePerSecond: 5, burst: 1 });
      await bucket.acquire();

      bucket.backOff(10_000);
      // A second, shorter 429 arrives from another in-flight request. Shortening
      // the penalty would walk straight back into the block.
      bucket.backOff(1_000);

      expect(bucket.backoffRemainingMs).toBe(10_000);

      let released = false;
      void bucket.acquire().then(() => {
        released = true;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(released).toBe(false);

      await vi.advanceTimersByTimeAsync(5_200);
      expect(released).toBe(true);
    });
  });

  it('keeps organisations independent — one tenant cannot throttle another', async () => {
    process.env.AMOCRM_RATE_LIMIT_PER_SECOND = '5';
    const orgA = '11111111-1111-1111-1111-111111111111';
    const orgB = '22222222-2222-2222-2222-222222222222';

    // Exhaust A and park it behind a long back-off.
    for (let i = 0; i < 5; i += 1) {
      await acquireAmoSlot(orgA);
    }
    backOffOrg(orgA, 30_000);

    let aReleased = false;
    void acquireAmoSlot(orgA)
      .then(() => {
        aReleased = true;
      })
      .catch(() => undefined);

    let bReleased = false;
    void acquireAmoSlot(orgB)
      .then(() => {
        bReleased = true;
      })
      .catch(() => undefined);

    await flush();
    expect(bReleased).toBe(true);
    expect(aReleased).toBe(false);
    expect(getThrottle(orgA).backoffRemainingMs).toBe(30_000);
    expect(getThrottle(orgB).backoffRemainingMs).toBe(0);
  });

  it('clamps a configured rate above amoCRM\'s documented ceiling', async () => {
    process.env.AMOCRM_RATE_LIMIT_PER_SECOND = '500';
    const bucket = getThrottle('33333333-3333-3333-3333-333333333333');

    // Capacity follows the clamped rate (7), not the configured 500.
    const { at } = track(bucket, 8);
    await flush();
    expect(at.filter((t) => t !== null)).toHaveLength(7);
    expect(at[7]).toBeNull();
  });

  it('rejects rather than queueing without bound', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 1, maxQueueDepth: 3 });
    void bucket.acquire();
    const queued = [bucket.acquire(), bucket.acquire(), bucket.acquire()];
    queued.forEach((p) => {
      void p.catch(() => undefined);
    });

    await expect(bucket.acquire()).rejects.toBeInstanceOf(ThrottleQueueOverflowError);

    bucket.drain(new Error('cleanup'));
    await Promise.allSettled(queued);
  });

  it('fails waiting callers when the integration goes away', async () => {
    const orgId = '44444444-4444-4444-4444-444444444444';
    const bucket = getThrottle(orgId);
    // Drain the burst so the next acquire has to queue.
    for (let i = 0; i < 16; i += 1) {
      void bucket.acquire().catch(() => undefined);
    }
    await flush();

    const pending = acquireAmoSlot(orgId);
    releaseThrottle(orgId, new Error('disconnected'));

    await expect(pending).rejects.toThrow('disconnected');
    // A fresh bucket is handed out afterwards rather than the drained one.
    expect(getThrottle(orgId).waiting).toBe(0);
  });
});

describe('parseRetryAfterMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the delay-seconds form', () => {
    expect(parseRetryAfterMs('2')).toBe(2_000);
    expect(parseRetryAfterMs(' 30 ')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('reads the HTTP-date form', () => {
    expect(parseRetryAfterMs('Sat, 01 Aug 2026 00:00:45 GMT')).toBe(45_000);
  });

  it('never returns a negative wait for a date already in the past', () => {
    expect(parseRetryAfterMs('Fri, 31 Jul 2026 00:00:00 GMT')).toBe(0);
  });

  it('clamps a hostile header so a worker cannot be parked for a day', () => {
    expect(parseRetryAfterMs('86400')).toBe(5 * 60_000);
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs('-5')).toBeNull();
  });
});
