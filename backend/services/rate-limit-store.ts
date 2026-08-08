/**
 * rate-limit-store.ts
 *
 * A rate-limit bucket that survives a restart, and the per-IP floor that always
 * runs underneath the per-account limits.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * @fastify/rate-limit keeps its buckets in a `toad-cache` LruMap on the plugin
 * instance (node_modules/@fastify/rate-limit/store/LocalStore.js). That is fine
 * for smoothing traffic and useless as a security control, for two reasons:
 *
 *   • The process owns them. A pm2 restart, a crash, a deploy, or the
 *     `max_memory_restart: '600M'` in deploy/local/ecosystem.config.js hands
 *     every key a brand-new budget. "5 attempts per 15 minutes" was really
 *     "5 attempts per 15 minutes, or per restart, whichever comes first".
 *   • The LRU is capped at 5000 entries PER ROUTE and evicts. A blocked key can
 *     be flushed out by 5000 throwaway keys without any restart at all.
 *
 * The one place in this product where a rate limit is load-bearing for a secret
 * is the 6-character invite claim code: services/invites.ts states outright that
 * "the defence was never the window — it is the call budget". That budget was
 * the least durable thing in the process. Now it is a row.
 *
 * ─── WHY POSTGRES AND NOT REDIS ─────────────────────────────────────────────
 *
 * There is no Redis in this repo and adding one is the wrong trade here: the
 * deployment is a single pm2 fork on one laptop, so Redis would be a second
 * daemon to keep alive, a second thing to back up, and one more component whose
 * silent death changes the security posture. Postgres is already the datastore,
 * already reached through the same Prisma client the auth controller opens with,
 * and already in deploy/local/backup.js.
 *
 * ─── SCOPE: THE EIGHT UNAUTHENTICATED AUTH ROUTES, AND NOTHING ELSE ─────────
 *
 * This store is deliberately NOT wired into the global limiter in backend/
 * index.ts, nor into the high-volume route limiters (tracking pixel 120/min, OTA
 * manifest 120/min, OTA assets 1200/min, amoCRM webhook 1200/min, imports,
 * export). Those would become one INSERT per request — real write amplification,
 * on the same disk as the customer data — and none of them guards a secret worth
 * counting durably. The eight auth routes see a few hundred calls a day.
 *
 * ─── FAIL CLOSED ────────────────────────────────────────────────────────────
 *
 * `incr` calls back with a RateLimitStoreError when the database refuses, and
 * the plugin's `skipOnError` is left at its default `false`, so the error is
 * rethrown and the controller never runs. NEVER set skipOnError on these routes:
 * measured, `skipOnError: true` turns a store failure into HTTP 200 — an
 * unlimited-attempts switch wired to "Postgres hiccuped".
 *
 * Failing closed costs nothing here. AuthController.login opens with a
 * `db.user.findUnique`; if Postgres is unreachable nobody could log in anyway.
 * backend/index.ts maps RateLimitStoreError to 503 so the outage reads as an
 * outage instead of as an opaque 500.
 *
 * ─── WHAT IS STORED ─────────────────────────────────────────────────────────
 *
 * The row id is a SHA-256 digest of "<scope>|<key>", never the key itself. Two
 * reasons, both load-bearing:
 *
 *   • The key for POST /auth/login is `<ip>:<email>`, and LoginSchema puts no
 *     length cap on the address. Storing it raw would let a 16 MB body mint
 *     multi-kilobyte primary keys — a table-bloat vector on an unauthenticated
 *     endpoint.
 *   • An email address and an IP are personal data under ФЗ-152. A digest of a
 *     failed login attempt is not, and a rate limiter has no business creating a
 *     new register of who tried to sign in from where.
 *
 * *** THE MIGRATION IS PENDING. *** backend/prisma/migrations/
 * 20260807120000_durable_rate_limit_buckets/migration.sql creates
 * "RateLimitBucket" and has NOT been applied to any database. It must be applied
 * to crm_prod (with .env.localprod — .env points at crm_dev).
 * The migration is additive and idempotent, so applying it early is harmless.
 *
 * ─── ONE EXCEPTION TO FAIL-CLOSED: THE TABLE ISN'T THERE YET ────────────────
 *
 * "Fail closed" is right for a database that is DOWN and wrong for a schema that
 * has not caught up. The two are different failures with different blast radii:
 * if Postgres is unreachable nobody could log in anyway, but if only this ONE
 * TABLE is absent every other query still works — so refusing would take
 * authentication down for a fully healthy product, on the single pm2 fork that
 * is production, the moment someone runs `npm run build && pm2 restart` without
 * having applied the migration first. That is a self-inflicted total auth outage
 * for every installed 1.1.6 client, triggered by deploying a security fix.
 *
 * So `undefined_table` (SQLSTATE 42P01) — and ONLY that — degrades to the
 * in-process buckets this store was written to replace, loudly: an error line
 * per transition, and a re-probe every DEGRADED_RETRY_MS so applying the
 * migration heals the process without a restart. Degraded is strictly no worse
 * than the behaviour that shipped for two years; refusing would be far worse
 * than either. Every other error still fails closed, unchanged.
 *
 * Nothing here touches the generated Prisma client, on purpose: every statement
 * is raw SQL, so `npx prisma generate` is not a deploy-order dependency and this
 * file type-checks before the model has ever been generated.
 */

import { createHash } from 'crypto';
import { db } from './db';

/**
 * Thrown when the bucket could not be written. Marked with its own class purely
 * so backend/index.ts can answer 503 instead of 500 — see the error handler
 * there. Everything else about it is an ordinary Error.
 */
export class RateLimitStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitStoreError';
  }
}

/** Shape @fastify/rate-limit expects back from `incr`. */
export type RateLimitIncrResult = { current: number; ttl: number };

type RateLimitIncrCallback = (error: Error | null, result?: RateLimitIncrResult) => void;

/**
 * What the plugin hands to `child()`. Its own .d.ts types this as
 * `RouteOptions & { path, prefix }`, which is not what the JS passes: index.js
 * builds `mergeParams(globalParams, config.rateLimit, { routeInfo: routeOptions })`
 * and it is `routeInfo` that carries the method and url. `fastify.rateLimit()`
 * passes `{ routeInfo: {} }`, hence every field being optional.
 */
type RateLimitChildParams = {
  routeInfo?: { method?: string | string[]; url?: string };
  /**
   * The class named by a route's `config.rateLimit.store`, which HybridRateLimitStore
   * reads in child(). Typed as unknown and narrowed there rather than as a
   * constructor, because the plugin passes whatever the route wrote.
   */
  store?: unknown;
};

/**
 * The constructor and child() take `unknown` and narrow here.
 *
 * The plugin's own `.d.ts` types them as the full FastifyRateLimitOptions /
 * RouteOptions, and every field of RateLimitChildParams is optional — so a
 * narrower declared parameter trips TypeScript's weak-type check and `store:`
 * stops type-checking on every route config that uses it. Accepting `unknown`
 * is honest about what the plugin actually passes (mergeParams hands over the
 * whole merged options object) and satisfies the contract in both directions.
 */
function asChildParams(params: unknown): RateLimitChildParams {
  return (params && typeof params === 'object' ? params : {}) as RateLimitChildParams;
}

/** Bucket scope used by the per-IP floor. Kept distinct from any route scope. */
export const AUTH_IP_BUCKET_SCOPE = 'auth-ip';

/** Fallback window, only reachable if the plugin ever stops passing one. */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The per-IP floor's window. Not configurable: the ceiling is the knob, and two
 * knobs on one budget is how a "tuning" change silently removes the limit.
 */
export const AUTH_IP_WINDOW_MS = 15 * 60 * 1000;

function readPositiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * How many requests one IP may make across ALL eight sensitive auth routes
 * combined, per 15 minutes.
 *
 * WHY 60 AND NOT 5. This bucket is shared by everyone behind one address, and
 * routes/updates.ts already records why that matters here: Russian mobile
 * carriers put very large numbers of subscribers behind a handful of CGNAT
 * addresses, and an office NAT does the same. A ceiling sized for one device
 * throttles a whole office at 09:00, and a legitimate user who gets a 429 on
 * login reads it as "the CRM is down". 60 tolerates a 20-person office logging
 * in, retrying, and verifying, while cutting a spray from unlimited to 4
 * attempts a minute. The tight per-(ip,email) budget of 5/15min is untouched —
 * this is a floor under it, not a replacement for it.
 *
 * AUTH_IP_RATE_LIMIT_MAX exists so the number can be raised on a live box
 * without a redeploy, which is the only mitigation available if this does lock
 * an office out.
 *
 * `env` is a PARAMETER, not a read of the ambient process, so a test can
 * exercise the PRODUCTION branch. Same shape as openTrackingRateLimit() in
 * routes/tracking.ts and for the same recorded reason: a test that asserts
 * against the NODE_ENV==='test' substitute passes with the real ceiling deleted.
 */
export function getAuthIpBudget(env: NodeJS.ProcessEnv = process.env): {
  max: number;
  windowMs: number;
} {
  return {
    max: env.NODE_ENV === 'test' ? 10_000 : readPositiveIntEnv('AUTH_IP_RATE_LIMIT_MAX', 60, env),
    windowMs: AUTH_IP_WINDOW_MS,
  };
}

/**
 * The primary key of a bucket: SHA-256 over "<scope>|<key>".
 *
 * Exported because "two different routes can never share a bucket" is a property
 * worth asserting directly rather than inferring from behaviour.
 */
export function bucketId(scope: string, key: string): string {
  return createHash('sha256').update(`${scope}|${key}`).digest('hex');
}

// ─── The in-process fallback ────────────────────────────────────────────────

type MemoryBucket = { count: number; startedAtMs: number; windowMs: number };

/**
 * Fixed-window counters held in this process, used ONLY while the durable table
 * is missing and by HybridRateLimitStore for the routes that were never meant to
 * be durable (the global 100/min limiter, the tracking pixel, OTA assets, the
 * amoCRM webhook — see the scope note in the file header).
 *
 * Semantics are LocalStore.js's, deliberately, so swapping between them changes
 * durability and nothing else: an expired entry is recycled in place, and `ttl`
 * counts down within the window rather than being reset by a further request.
 * `continueExceeding`, `exponentialBackoff` and `ban` are not implemented
 * because this codebase does not use them and each one lets a single abusive
 * client extend a penalty on a key that CGNAT users share.
 */
const memoryBuckets = new Map<string, MemoryBucket>();

/**
 * Bounded so an unauthenticated flood cannot turn the fallback into a memory
 * leak. Insertion-ordered Map, so deleting the first key evicts the oldest
 * *written* entry — the same eviction property toad-cache's LruMap gives at its
 * own 5000 default, with more headroom because this Map is shared by every scope
 * rather than being one per route.
 */
const MEMORY_BUCKET_LIMIT = 20_000;

function bumpMemoryBucket(id: string, windowMs: number): RateLimitIncrResult {
  const now = Date.now();
  const existing = memoryBuckets.get(id);

  if (!existing || existing.startedAtMs + existing.windowMs <= now) {
    if (!existing && memoryBuckets.size >= MEMORY_BUCKET_LIMIT) {
      const oldest = memoryBuckets.keys().next();
      if (!oldest.done) memoryBuckets.delete(oldest.value);
    }
    memoryBuckets.set(id, { count: 1, startedAtMs: now, windowMs });
    return { current: 1, ttl: windowMs };
  }

  existing.count += 1;
  return {
    current: existing.count,
    ttl: Math.max(0, existing.startedAtMs + existing.windowMs - now),
  };
}

/** Test seam. Nothing in production calls this. */
export function resetMemoryRateLimitBuckets(): void {
  memoryBuckets.clear();
  degradedSinceMs = null;
}

// ─── Degradation ────────────────────────────────────────────────────────────

/** How long to stay on the fallback before probing Postgres again. */
const DEGRADED_RETRY_MS = 60_000;

let degradedSinceMs: number | null = null;

/** True while the durable table is known-absent. Exported for tests and health. */
export function isRateLimitStoreDegraded(): boolean {
  return degradedSinceMs !== null;
}

/**
 * Is this the specific "relation does not exist" failure, and nothing else?
 *
 * Prisma wraps a raw-query failure as P2010 and carries the driver's SQLSTATE in
 * `meta.code`, so 42P01 is the reliable signal. The message check is a fallback
 * for driver/Prisma versions that only surface the text, and it is deliberately
 * narrowed to this table's name so a missing table ANYWHERE ELSE — which would
 * be a genuine, alarming schema problem — is not quietly waved through here.
 */
function isMissingTableError(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta;
  if (meta && typeof meta.code === 'string' && meta.code === '42P01') {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes('42P01') || (
    message.includes('RateLimitBucket') && /does not exist|не существует/i.test(message)
  );
}

/**
 * One request against one bucket: a single statement, a single row, a single
 * primary-key lookup.
 *
 * ATOMICITY. There is no SELECT and no transaction. `INSERT … ON CONFLICT DO
 * UPDATE` makes the read-modify-write one operation under the row lock, so two
 * concurrent attempts cannot both observe "4" and both be allowed. A
 * read-then-write version of this is not a rate limit, it is a race.
 *
 * FIXED WINDOW, matching LocalStore.js:12-38 exactly, so replacing the store
 * changes durability and nothing else: an expired row is recycled in place
 * (count back to 1, new window) rather than being deleted and re-inserted, which
 * is also why a returning client never grows the table.
 *
 * ALL TIME COMES FROM POSTGRES, as `now() AT TIME ZONE 'UTC'`. The column is a
 * naive TIMESTAMP(3) holding UTC, exactly like every other timestamp in this
 * schema, and the explicit `AT TIME ZONE` is what stops a session TimeZone from
 * deciding what it means. This database ran three hours off once; it is not
 * going to be the thing that decides who is rate limited.
 *
 * The window arrives as a text parameter cast to `interval` rather than as a
 * number, because a bound numeric in `make_interval(secs => …)` has no inferable
 * type. Same shape as the `${id}::uuid` casts in controllers/auth.ts.
 */
async function bumpBucketInPostgres(id: string, windowMs: number): Promise<RateLimitIncrResult> {
  const window = `${Math.max(1, Math.trunc(windowMs))} milliseconds`;

  const rows = await db.$queryRaw<Array<{ current: number; ttl: number }>>`
    INSERT INTO "RateLimitBucket" ("id", "count", "window_start", "expires_at", "updated_at")
    VALUES (
      ${id},
      1,
      (now() AT TIME ZONE 'UTC'),
      (now() AT TIME ZONE 'UTC') + ${window}::interval,
      (now() AT TIME ZONE 'UTC')
    )
    ON CONFLICT ("id") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."expires_at" <= (now() AT TIME ZONE 'UTC') THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "window_start" = CASE
        WHEN "RateLimitBucket"."expires_at" <= (now() AT TIME ZONE 'UTC') THEN (now() AT TIME ZONE 'UTC')
        ELSE "RateLimitBucket"."window_start"
      END,
      "expires_at" = CASE
        WHEN "RateLimitBucket"."expires_at" <= (now() AT TIME ZONE 'UTC')
          THEN (now() AT TIME ZONE 'UTC') + ${window}::interval
        ELSE "RateLimitBucket"."expires_at"
      END,
      "updated_at" = (now() AT TIME ZONE 'UTC')
    RETURNING
      "count"::int AS "current",
      GREATEST(
        0,
        EXTRACT(EPOCH FROM ("expires_at" - (now() AT TIME ZONE 'UTC'))) * 1000
      )::int AS "ttl"
  `;

  const row = rows[0];
  if (!row) {
    // Unreachable with ON CONFLICT DO UPDATE — RETURNING always yields the row.
    // Treated as a store failure rather than as "0 attempts so far", because the
    // only safe reading of "I do not know the count" is "refuse".
    throw new RateLimitStoreError('rate-limit store returned no row');
  }

  return { current: row.current, ttl: row.ttl };
}

/**
 * bumpBucketInPostgres, plus the one degradation the file header argues for.
 *
 * Anything that is not `undefined_table` propagates and the caller fails closed,
 * exactly as before.
 */
async function bumpBucket(id: string, windowMs: number): Promise<RateLimitIncrResult> {
  if (degradedSinceMs !== null && Date.now() - degradedSinceMs < DEGRADED_RETRY_MS) {
    return bumpMemoryBucket(id, windowMs);
  }

  try {
    const result = await bumpBucketInPostgres(id, windowMs);
    if (degradedSinceMs !== null) {
      degradedSinceMs = null;
      memoryBuckets.clear();
      // eslint-disable-next-line no-console
      console.error(
        '[rate-limit] "RateLimitBucket" is reachable again — rate limits are durable once more.',
      );
    }
    return result;
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }

    if (degradedSinceMs === null) {
      // eslint-disable-next-line no-console
      console.error(
        '[rate-limit] "RateLimitBucket" DOES NOT EXIST. Falling back to in-process ' +
        'buckets, which do not survive a restart. Apply migration ' +
        '20260807120000_durable_rate_limit_buckets (crm_prod uses .env.localprod, ' +
        'not .env) — auth rate limits are weaker until you do.',
      );
    }
    degradedSinceMs = Date.now();
    return bumpMemoryBucket(id, windowMs);
  }
}

/**
 * The @fastify/rate-limit store contract, backed by "RateLimitBucket".
 *
 * The plugin calls `new Store(globalParams)` once and then `.child(params)` per
 * route, which is where the route scope comes from. LocalStore gets isolation
 * for free by handing every route its own LRU; one shared table does not, so the
 * scope has to be part of the key or POST /auth/login and
 * POST /auth/invites/lookup would spend each other's budget.
 */
export class PostgresRateLimitStore {
  private readonly scope: string;

  constructor(params?: unknown) {
    const info = asChildParams(params).routeInfo;
    const method = Array.isArray(info?.method) ? info?.method.join(',') : info?.method;
    this.scope = method && info?.url ? `${method} ${info.url}` : 'default';
  }

  /**
   * `timeWindow` and `max` are optional only to satisfy the plugin's .d.ts,
   * which declares `incr(key, callback)` while its own JS calls
   * `incr(key, cb, timeWindow, max)` (index.js:250). The plugin always passes
   * the window.
   */
  incr(
    key: string,
    callback: RateLimitIncrCallback,
    timeWindow?: number,
    _max?: number,
  ): void {
    void bumpBucket(bucketId(this.scope, key), timeWindow ?? DEFAULT_WINDOW_MS)
      .then((result) => callback(null, result))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        callback(new RateLimitStoreError(`rate-limit store unavailable: ${reason}`));
      });
  }

  child(routeOptions: unknown): PostgresRateLimitStore {
    return new PostgresRateLimitStore(routeOptions);
  }
}

/**
 * The store the plugin is registered with — and the reason `store:` on a route
 * config does anything at all.
 *
 * @fastify/rate-limit reads `settings.store` EXACTLY ONCE, at plugin
 * registration (index.js:115-117). Per route it does
 * `pluginComponent.store.child(mergedRateLimitParams)` (index.js:147), and
 * LocalStore's own `child()` reads three fields and throws the rest away
 * (store/LocalStore.js:46-48) — so `store: PostgresRateLimitStore` written on a
 * route was inert. Every per-route budget on the eight auth routes was still an
 * in-process LruMap: "5 attempts per 15 minutes, or per restart, whichever comes
 * first", which is the thing this module exists to end.
 *
 * The fix is a `child()` that honours it. `mergeParams` is `Object.assign({},
 * globalParams, config.rateLimit, { routeInfo })` and globalParams never
 * acquires a `store` key (index.js:37-104, checked), so `params.store` is
 * precisely what the route declared and `undefined` everywhere else. That keeps
 * the declaration ON the route — one source of truth — instead of a second
 * hardcoded URL list here that a new route would silently fall out of.
 *
 * Everything else stays in this process on purpose. Wiring Postgres under the
 * global 100/min limiter, the tracking pixel, the OTA manifest and assets or the
 * amoCRM webhook would be one INSERT per request on the same disk as the
 * customer data — see the scope note in the file header.
 */
export class HybridRateLimitStore {
  private readonly scope: string;

  constructor(params?: unknown) {
    const info = asChildParams(params).routeInfo;
    const method = Array.isArray(info?.method) ? info?.method.join(',') : info?.method;
    this.scope = method && info?.url ? `${method} ${info.url}` : 'global';
  }

  incr(
    key: string,
    callback: RateLimitIncrCallback,
    timeWindow?: number,
    _max?: number,
  ): void {
    callback(null, bumpMemoryBucket(bucketId(this.scope, key), timeWindow ?? DEFAULT_WINDOW_MS));
  }

  child(routeOptions: unknown): PostgresRateLimitStore | HybridRateLimitStore {
    const Store = asChildParams(routeOptions).store;
    if (typeof Store === 'function' && Store !== HybridRateLimitStore) {
      return new (Store as new (params: unknown) => PostgresRateLimitStore)(routeOptions);
    }
    return new HybridRateLimitStore(routeOptions);
  }
}

/**
 * A budget keyed on something other than the caller's address.
 *
 * Every limiter in routes/auth.ts keys on `request.ip`, alone or as
 * `<ip>:<email>`. That is blind by construction to the abuse shape where the
 * TARGET is fixed and the SOURCE varies — an IPv6 /64, a mobile carrier, a small
 * botnet — which is exactly how the unauthenticated /auth/verify/resend hole
 * works: one attacker, many addresses, one victim's mailbox and one victim's
 * pending OTP. A ceiling on the victim is the only control that sees it.
 *
 * Spent from inside a controller rather than as a second `config.rateLimit`,
 * because the key is a BODY field and because the plugin sets a `rateLimitRan`
 * flag on the request (index.js:281) that makes a second one silently never run.
 *
 * `env` is a parameter, not a read of the ambient process, for the same recorded
 * reason as getAuthIpBudget: a test that only ever exercises the
 * NODE_ENV==='test' substitute passes with the real ceiling deleted.
 */
export async function consumeScopedBudget(
  scope: string,
  key: string,
  max: number,
  windowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const effectiveMax = env.NODE_ENV === 'test' ? 10_000 : max;

  let result: RateLimitIncrResult;
  try {
    result = await bumpBucket(bucketId(scope, key), windowMs);
  } catch (error) {
    if (error instanceof RateLimitStoreError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new RateLimitStoreError(`rate-limit store unavailable: ${reason}`);
  }

  return {
    allowed: result.current <= effectiveMax,
    retryAfterSec: Math.max(1, Math.ceil(result.ttl / 1000)),
  };
}

/**
 * The per-IP floor, spent by hand rather than through the plugin.
 *
 * A second `config.rateLimit` on the same route CANNOT do this: index.js:281
 * sets a `rateLimitRan` flag on the request and every later hook from the plugin
 * returns immediately, so the second limiter silently never runs. Worse, the
 * plugin treats a route-level config as a REPLACEMENT for the global limiter
 * (index.js:144-155 — the `else if (globalParams.global)` branch is only reached
 * when a route has no config of its own), which is why the eight routes carrying
 * authRateLimit() were the only routes in the API with no per-IP ceiling at all.
 * On /auth/login the key is `<ip>:<email>`, so varying the email minted an
 * unlimited number of fresh buckets from one address.
 *
 * Throws RateLimitStoreError when the store is unreachable — never a silent
 * pass. See the fail-closed note in the file header.
 */
export async function consumeAuthIpBudget(
  ip: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const { max, windowMs } = getAuthIpBudget(env);

  let result: RateLimitIncrResult;
  try {
    result = await bumpBucket(bucketId(AUTH_IP_BUCKET_SCOPE, ip), windowMs);
  } catch (error) {
    if (error instanceof RateLimitStoreError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new RateLimitStoreError(`rate-limit store unavailable: ${reason}`);
  }

  return {
    allowed: result.current <= max,
    // Ceil, and never below 1: a Retry-After of 0 invites an immediate retry.
    retryAfterSec: Math.max(1, Math.ceil(result.ttl / 1000)),
  };
}

/**
 * Delete buckets whose window has closed. Wired into the hourly scheduler loop
 * next to the idempotency reaper, and backed by @@index([expires_at]).
 *
 * Belt and braces rather than the only defence: bumpBucket recycles an expired
 * row in place instead of inserting a second one, so if this job ever stops the
 * table grows with distinct keys rather than without bound, and the limiter
 * keeps working. Deliberately not org-scoped — every row here is written BEFORE
 * authentication, so there is no tenant to scope to. Same exception, and the
 * same reason, as reapIdempotencyKeys().
 */
export async function reapRateLimitBuckets(): Promise<number> {
  try {
    return await db.$executeRaw`
      DELETE FROM "RateLimitBucket"
      WHERE "expires_at" <= (now() AT TIME ZONE 'UTC')
    `;
  } catch (error) {
    // Same single exception as bumpBucket: an absent table is a pending
    // migration, not an outage, and it must not take the hourly loop down with
    // it — the idempotency reaper, join-code rotation and amoCRM reconciliation
    // all run beside it.
    if (!isMissingTableError(error)) {
      throw error;
    }
    return 0;
  }
}
