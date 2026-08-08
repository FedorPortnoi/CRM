/**
 * THE DURABLE RATE-LIMIT STORE, AND THE TWO THINGS THAT WERE WRONG WITH IT.
 *
 * 1. `store: PostgresRateLimitStore` on a route was INERT. @fastify/rate-limit
 *    reads `store` exactly once, from the PLUGIN registration (index.js:115-117),
 *    and per route calls `pluginComponent.store.child(mergedParams)` — LocalStore's
 *    own child() reads three fields and discards the rest (LocalStore.js:46-48).
 *    backend/index.ts registered the plugin with only `max` and `timeWindow`, so
 *    every per-route budget on the eight auth routes was still an in-process
 *    LruMap: "5 attempts per 15 minutes, or per restart, whichever comes first",
 *    which is precisely the audit finding the durable store was written to close.
 *    The line READ like the fix while the buckets stayed in memory.
 *
 * 2. The store fails closed and "RateLimitBucket" does not exist in crm_prod OR
 *    crm_dev. Wiring (1) correctly without (2) would have turned the next
 *    `npm run build && pm2 restart` into a 503 on login, register, join, OTP
 *    verify, OTP resend and all three invite-redemption routes at once — a total
 *    authentication outage for every installed 1.1.6 client, caused by deploying
 *    a security fix. So a MISSING TABLE, and only that, degrades loudly to the
 *    in-process behaviour instead of refusing.
 *
 * There was no test for any of this: grepping tests/ for `rate-limit-store`,
 * `PostgresRateLimitStore`, `consumeAuthIpBudget` or `RateLimitBucket` returned
 * nothing at all.
 */

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

/**
 * A Postgres stand-in with the SAME fixed-window semantics bumpBucket has, keyed
 * by the row id the store computes. Module-level so it can outlive an app — that
 * is how "a restart" is expressed below.
 */
const durableRows = new Map<string, { count: number; expiresAt: number }>();
let queryFailure: Error | null = null;

const dbMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

vi.mock('../../../backend/api/controllers/auth', () => ({
  AuthController: new Proxy({} as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop] = vi.fn(async (
          _request: unknown,
          reply: { send: (payload: unknown) => unknown },
        ) => {
          reply.send({ data: {}, meta: {} });
        });
      }
      return target[prop];
    },
  }),
}));

vi.mock('../../../backend/api/controllers/invites', () => ({
  InviteController: new Proxy({} as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop] = vi.fn(async (
          _request: unknown,
          reply: { send: (payload: unknown) => unknown },
        ) => {
          reply.send({ data: {}, meta: {} });
        });
      }
      return target[prop];
    },
  }),
}));

import authRoutes from '../../../backend/api/routes/auth';
import {
  AUTH_IP_BUCKET_SCOPE,
  HybridRateLimitStore,
  RateLimitStoreError,
  bucketId,
  consumeAuthIpBudget,
  consumeScopedBudget,
  isRateLimitStoreDegraded,
  resetMemoryRateLimitBuckets,
} from '../../../backend/services/rate-limit-store';

/** The SQLSTATE Postgres raises for a missing relation, as Prisma surfaces it. */
function undefinedTableError(): Error {
  const error = new Error(
    'Raw query failed. Code: `42P01`. Message: `relation "RateLimitBucket" does not exist`',
  ) as Error & { meta: { code: string } };
  error.meta = { code: '42P01' };
  return error;
}

/** The ids every bumpBucket call was made against, in order. */
const writtenIds: string[] = [];

function installDurableFake(): void {
  dbMock.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (queryFailure) return Promise.reject(queryFailure);

    void strings;
    const id = values[0] as string;
    const windowText = values[1] as string;
    const windowMs = Number.parseInt(windowText, 10);
    writtenIds.push(id);

    const now = Date.now();
    const existing = durableRows.get(id);
    if (!existing || existing.expiresAt <= now) {
      durableRows.set(id, { count: 1, expiresAt: now + windowMs });
      return Promise.resolve([{ current: 1, ttl: windowMs }]);
    }

    existing.count += 1;
    return Promise.resolve([
      { current: existing.count, ttl: Math.max(0, existing.expiresAt - now) },
    ]);
  });
}

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('jwtVerify', async function jwtVerify() {
    return undefined;
  });
  // EXACTLY how backend/index.ts registers it. If this line and that one drift,
  // the assertions below stop meaning anything about production.
  await app.register(rateLimit, {
    max: 10_000,
    timeWindow: 60_000,
    store: HybridRateLimitStore,
  });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

function login(app: ReturnType<typeof Fastify>, email = 'victim@example.ru') {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: 'whatever' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  durableRows.clear();
  writtenIds.length = 0;
  queryFailure = null;
  resetMemoryRateLimitBuckets();
  installDurableFake();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the route-level store is actually honoured', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('writes BOTH the per-IP floor and the route bucket to the durable store', async () => {
    const response = await login(app);
    expect(response.statusCode).toBe(200);

    // Today (before HybridRateLimitStore) exactly ONE id is written — the floor's
    // — because the route bucket goes to LocalStore and never reaches Postgres.
    expect(writtenIds).toContain(bucketId(AUTH_IP_BUCKET_SCOPE, '127.0.0.1'));
    expect(writtenIds).toContain(
      bucketId('POST /auth/login', '127.0.0.1:victim@example.ru'),
    );
  });

  it('gives two different routes two different buckets', async () => {
    // One shared table, so scope isolation has to be in the key. LocalStore got
    // it for free by handing every route its own LRU.
    await login(app);
    await app.inject({
      method: 'POST',
      url: '/auth/verify/resend',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ user_id: '00000000-0000-4000-a000-0000000000aa' }),
    });

    expect(new Set(writtenIds).size).toBe(writtenIds.length > 0 ? new Set(writtenIds).size : 0);
    expect(writtenIds).toContain(bucketId('POST /auth/login', '127.0.0.1:victim@example.ru'));
    expect(writtenIds).toContain(bucketId('POST /auth/verify/resend', '127.0.0.1'));
  });
});

describe('a restart no longer hands out a fresh budget', () => {
  it('keeps refusing after the process is replaced', async () => {
    // The ceiling is raised to 10_000 under NODE_ENV=test so unrelated suites are
    // not throttled — a test that only ever sees that substitute would pass with
    // the real limit deleted. Stubbed BEFORE registration, because the plugin
    // reads `max` once, at onRoute.
    vi.stubEnv('NODE_ENV', 'production');

    const appA = await buildApp();
    for (let i = 0; i < 5; i++) {
      expect((await login(appA)).statusCode).toBe(200);
    }
    expect((await login(appA)).statusCode).toBe(429);
    await appA.close();

    // THE RESTART. Everything the process owned is gone — a brand-new Fastify
    // instance, a brand-new plugin instance, a brand-new store object, and the
    // in-process buckets cleared, which is what a pm2 restart / crash /
    // max_memory_restart bounce actually does. Only the durable rows survive.
    // Clearing the memory is what makes this test able to fail: without it the
    // module-level fallback Map would carry the count across and the assertion
    // would pass even with the route budget still in process.
    resetMemoryRateLimitBuckets();
    const appB = await buildApp();
    expect((await login(appB)).statusCode).toBe(429);
    await appB.close();
  });
});

describe('fail closed, except for a schema that has not caught up', () => {
  it('refuses rather than allowing when the database is genuinely broken', async () => {
    queryFailure = new Error('connection refused');

    await expect(consumeAuthIpBudget('1.2.3.4')).rejects.toBeInstanceOf(RateLimitStoreError);
    expect(isRateLimitStoreDegraded()).toBe(false);
  });

  it('degrades to in-process buckets when the table does not exist', async () => {
    // THE DEPLOY-SAFETY PROPERTY. "RateLimitBucket" is absent from crm_prod and
    // crm_dev right now, and the store is on the login path. If a missing table
    // threw, the first build-and-restart after this work lands would 503 every
    // auth route on the laptop that IS production. Degraded is no worse than the
    // behaviour that shipped for two years; refusing is far worse than either.
    queryFailure = undefinedTableError();

    const verdict = await consumeAuthIpBudget('1.2.3.4');

    expect(verdict.allowed).toBe(true);
    expect(isRateLimitStoreDegraded()).toBe(true);
  });

  it('still counts while degraded — it falls back, it does not give up', async () => {
    queryFailure = undefinedTableError();

    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      results.push((await consumeScopedBudget('probe', 'k', 2, 60_000, {} as NodeJS.ProcessEnv)).allowed);
    }

    // A fallback that always answers `allowed: true` would satisfy the previous
    // test and silently remove the limit. It has to keep counting.
    expect(results).toEqual([true, true, false, false]);
  });

  it('heals without a restart once the migration is applied', async () => {
    queryFailure = undefinedTableError();
    await consumeAuthIpBudget('1.2.3.4');
    expect(isRateLimitStoreDegraded()).toBe(true);

    queryFailure = null;
    // The re-probe is time-gated so a missing table does not cost a failed query
    // per request. Advancing past the window is what lets the next call retry.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    try {
      await consumeAuthIpBudget('1.2.3.4');
    } finally {
      vi.useRealTimers();
    }

    expect(isRateLimitStoreDegraded()).toBe(false);
  });
});

describe('the budget arithmetic', () => {
  it('allows exactly `max` requests and then refuses', async () => {
    const verdicts: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      // env passed as a PARAMETER so the PRODUCTION ceiling is what is exercised.
      verdicts.push(
        (await consumeScopedBudget('scope', 'key', 5, 60_000, {} as NodeJS.ProcessEnv)).allowed,
      );
    }

    expect(verdicts).toEqual([true, true, true, true, true, false, false]);
  });

  it('never returns a Retry-After of zero, which invites an instant retry', async () => {
    dbMock.$queryRaw.mockResolvedValue([{ current: 99, ttl: 0 }]);
    const verdict = await consumeScopedBudget('scope', 'key', 1, 60_000, {} as NodeJS.ProcessEnv);
    expect(verdict.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});
