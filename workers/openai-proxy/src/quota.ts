// ---------------------------------------------------------------------------
// Daily request ceiling — Durable Object.
//
// Why a Durable Object and not KV (the README repeats this, but the reasoning
// belongs next to the code):
//
//   The threat being defended against is a runaway agent loop hammering the
//   proxy as fast as it can. KV is the wrong tool for exactly that case:
//     * reads are served from a cache with a 60s minimum TTL, so a burst reads
//       a stale count for up to a minute;
//     * writes to a single key are throttled to roughly one per second and are
//       eventually consistent, so concurrent increments overwrite each other.
//   A loop firing 50 req/s would therefore keep seeing "count: 12" and blow
//   through the ceiling by thousands of requests before KV caught up — the
//   counter would be decorative precisely when it matters.
//
//   A Durable Object is a single addressable instance with strongly consistent
//   storage. Cloudflare serialises event delivery to it (input gates hold new
//   requests while a storage op is in flight), and `blockConcurrencyWhile`
//   makes the read-modify-write explicitly atomic. Increments cannot be lost,
//   so the ceiling is a real ceiling.
//
//   Cost of the choice: all quota checks funnel through one object in one
//   location, adding a round trip (tens of ms) to each request. Against a
//   multi-second LLM call that is noise, and one object handles far more
//   throughput than this CRM will ever produce.
// ---------------------------------------------------------------------------

const COUNTER_KEY = 'counter';

type CounterRecord = {
  day: string;
  count: number;
};

export type QuotaDecision = {
  allowed: boolean;
  used: number;
  limit: number;
  day: string;
};

/**
 * Minimal surface of `DurableObjectState` this class needs. Declaring it
 * locally keeps the object unit-testable with a plain in-memory fake and
 * avoids a hard dependency on the ambient Workers types at runtime.
 */
export type QuotaState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

export class DailyQuota {
  private readonly state: QuotaState;

  constructor(state: QuotaState) {
    this.state = state;
  }

  /**
   * `POST /reserve?day=YYYY-MM-DD&limit=N`
   *
   * Reserves one request against today's budget. The reservation is taken
   * BEFORE the upstream call and is never refunded if OpenAI then errors:
   * a loop that keeps failing upstream still costs connections and can still
   * cost money (OpenAI bills a request that fails after generation started),
   * so the ceiling counts attempts, not successes.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const day = url.searchParams.get('day') ?? '';
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);

    if (!day || !Number.isFinite(limit) || limit < 0) {
      return jsonResponse({ allowed: false, used: 0, limit: 0, day }, 400);
    }

    const decision = await this.state.blockConcurrencyWhile<QuotaDecision>(async () => {
      const stored = await this.state.storage.get<CounterRecord>(COUNTER_KEY);
      // A different day (or no record at all) starts from zero — that is the
      // whole reset mechanism, no alarms or cleanup jobs required.
      const used = stored && stored.day === day ? stored.count : 0;

      if (used >= limit) {
        return { allowed: false, used, limit, day };
      }

      const next = used + 1;
      await this.state.storage.put<CounterRecord>(COUNTER_KEY, { day, count: next });
      return { allowed: true, used: next, limit, day };
    });

    return jsonResponse(decision, 200);
  }
}

function jsonResponse(body: QuotaDecision, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
