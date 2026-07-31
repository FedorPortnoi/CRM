/**
 * Public REST API (`/public/v1`) — credential handling, tenant isolation and
 * idempotency.
 *
 * The Prisma singleton is replaced with a small in-memory store that honours
 * `where.organization_id` and the `(organization_id, key)` unique constraint on
 * IdempotencyKey.  Everything above it — api-keys, public-api-auth, idempotency,
 * contact-domain, the route plugin — is the real code, so a regression that
 * dropped org scoping or leaked a plaintext key would actually fail here.
 */

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// Vitest already sets NODE_ENV=test. contact-domain encrypts PII through
// config/security, which falls back to JWT_SECRET outside production.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'j'.repeat(32);

// ─── In-memory Prisma double ──────────────────────────────────────────────────

type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {
    apiKey: [],
    user: [],
    contact: [],
    idempotencyKey: [],
    activityLog: [],
  };

  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

  function matches(row: Row, where: any): boolean {
    if (!where) return true;

    for (const [field, condition] of Object.entries(where)) {
      if (field === 'AND') {
        if (!(condition as any[]).every((clause) => matches(row, clause))) return false;
        continue;
      }

      if (field === 'OR') {
        if (!(condition as any[]).some((clause) => matches(row, clause))) return false;
        continue;
      }

      const value = row[field];

      if (
        condition !== null &&
        typeof condition === 'object' &&
        !Array.isArray(condition) &&
        !(condition instanceof Date)
      ) {
        const operators = condition as Record<string, unknown>;
        if ('not' in operators && value === operators.not) return false;
        if ('in' in operators && !(operators.in as unknown[]).includes(value)) return false;
        if ('lte' in operators && !(value instanceof Date && value <= (operators.lte as Date))) return false;
        if ('lt' in operators && !(value instanceof Date && value < (operators.lt as Date))) return false;
        if ('contains' in operators) {
          const needle = String(operators.contains).toLowerCase();
          if (typeof value !== 'string' || !value.toLowerCase().includes(needle)) return false;
        }
        continue;
      }

      if (value !== condition) return false;
    }

    return true;
  }

  function makeTable(name: string, defaults: (data: Row) => Row) {
    const rows = () => tables[name];

    return {
      findFirst: vi.fn(async ({ where }: any = {}) => rows().find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where, skip = 0, take }: any = {}) => {
        const found = rows().filter((row) => matches(row, where));
        const page = take === undefined ? found.slice(skip) : found.slice(skip, skip + take);
        return page.map((row) => ({ ...row, _count: { deals: 0 } }));
      }),
      count: vi.fn(async ({ where }: any = {}) => rows().filter((row) => matches(row, where)).length),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: nextId(name), created_at: new Date(), updated_at: new Date(), ...defaults(data), ...data };
        rows().push(row);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const targets = rows().filter((row) => matches(row, where));
        for (const row of targets) Object.assign(row, data, { updated_at: new Date() });
        return { count: targets.length };
      }),
      deleteMany: vi.fn(async ({ where }: any = {}) => {
        const survivors = rows().filter((row) => !matches(row, where));
        const removed = rows().length - survivors.length;
        tables[name] = survivors;
        return { count: removed };
      }),
    };
  }

  const apiKey = makeTable('apiKey', () => ({
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    created_by: null,
  }));

  const contact = makeTable('contact', () => ({
    status: 'active',
    assigned_to: null,
    created_by: null,
    email: null,
    phone: null,
    mobile: null,
  }));

  const idempotencyKey = makeTable('idempotencyKey', () => ({
    status_code: null,
    response_body: null,
  }));

  // The real uniqueness guarantee the replay/conflict logic depends on.
  const baseCreate = idempotencyKey.create;
  idempotencyKey.create = vi.fn(async (args: any) => {
    const clash = tables.idempotencyKey.some(
      (row) => row.organization_id === args.data.organization_id && row.key === args.data.key,
    );
    if (clash) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    return baseCreate(args);
  }) as typeof baseCreate;

  return {
    tables,
    reset() {
      for (const name of Object.keys(tables)) tables[name] = [];
      sequence = 0;
    },
    db: {
      apiKey: {
        ...apiKey,
        findUnique: vi.fn(async ({ where }: any) => tables.apiKey.find((row) => matches(row, where)) ?? null),
      },
      user: makeTable('user', () => ({ is_active: true, role: 'admin' })),
      contact,
      idempotencyKey,
      activityLog: makeTable('activityLog', () => ({})),
    },
  };
});

vi.mock('../../../backend/services/db', () => ({ db: store.db }));
vi.mock('../../../backend/services/workflows', () => ({
  evaluateWorkflows: vi.fn(async () => undefined),
  invalidateWorkflowCache: vi.fn(),
}));
vi.mock('../../../backend/services/notificationEngine', () => ({
  dispatchNotification: vi.fn(async () => undefined),
  contactCtx: vi.fn(async () => null),
  dealCtx: vi.fn(async () => null),
  taskCtx: vi.fn(async () => null),
}));
vi.mock('../../../backend/services/lastContacted', () => ({
  getLastContactedMap: vi.fn(async () => new Map()),
  getContactIdsLastContactedBefore: vi.fn(async () => []),
}));

import publicApiRoutes from '../../../backend/api/routes/public-api';
import {
  API_KEY_DISPLAY_PREFIX_LENGTH,
  API_KEY_TOKEN_PREFIX,
  apiKeyDisplayPrefix,
  createApiKey,
  generateApiKey,
  hashApiKey,
  listApiKeys,
  parseApiKeyScopes,
  revokeApiKey,
} from '../../../backend/services/api-keys';
import {
  consumePublicApiRateLimit,
  getPublicApiRateLimitMax,
  getPublicApiRateLimitWindowMs,
  resetPublicApiRateLimits,
} from '../../../backend/services/public-api-auth';
import { sha256 } from '../../../backend/services/crypto';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_A = '00000000-0000-4000-a000-00000000000a';
const ORG_B = '00000000-0000-4000-a000-00000000000b';
const ADMIN_A = '00000000-0000-4000-a000-0000000000a1';
const ADMIN_B = '00000000-0000-4000-a000-0000000000b1';

const ALL_SCOPES = ['contacts:read', 'contacts:write', 'deals:read', 'deals:write', 'tasks:read', 'tasks:write'];

function seedOrgs(): void {
  store.tables.user.push(
    { id: ADMIN_A, organization_id: ORG_A, role: 'owner', is_active: true, created_at: new Date() },
    { id: ADMIN_B, organization_id: ORG_B, role: 'owner', is_active: true, created_at: new Date() },
  );
}

/** Insert a usable key straight into the store and hand back the plaintext. */
function seedKey(options: {
  organizationId: string;
  createdBy?: string | null;
  scopes?: string[];
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}): string {
  const key = generateApiKey();

  store.tables.apiKey.push({
    id: `key-${store.tables.apiKey.length + 1}`,
    organization_id: options.organizationId,
    name: 'test key',
    key_prefix: apiKeyDisplayPrefix(key),
    key_hash: hashApiKey(key),
    scopes: options.scopes ?? ALL_SCOPES,
    created_by: options.createdBy ?? null,
    last_used_at: null,
    revoked_at: options.revokedAt ?? null,
    expires_at: options.expiresAt ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  return key;
}

let contactSeq = 0;

/** Route params are validated as UUIDs, so fixtures must look like real ids. */
function nextContactId(): string {
  contactSeq += 1;
  return `00000000-0000-4000-a000-${String(contactSeq).padStart(12, '0')}`;
}

function seedContact(organizationId: string, firstName: string): Row {
  const contact = {
    id: nextContactId(),
    organization_id: organizationId,
    first_name: firstName,
    last_name: null,
    company: null,
    email: null,
    phone: null,
    mobile: null,
    status: 'active',
    type: null,
    assigned_to: null,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  store.tables.contact.push(contact);
  return contact;
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(publicApiRoutes, { prefix: '/public/v1' });
  await app.ready();
  return app;
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

beforeEach(() => {
  store.reset();
  contactSeq = 0;
  resetPublicApiRateLimits();
  vi.clearAllMocks();
  seedOrgs();
});

// ─── 1. Key material never lands in the database ──────────────────────────────

describe('API key hashing', () => {
  it('stores only a hash and a short prefix, never the plaintext key', async () => {
    const created = await createApiKey({
      organizationId: ORG_A,
      createdBy: ADMIN_A,
      name: '  Integration  ',
      scopes: ['contacts:read'],
    });

    expect(created.key.startsWith(API_KEY_TOKEN_PREFIX)).toBe(true);

    const stored = store.tables.apiKey.at(-1) as Row;

    expect(stored.key_hash).toBe(sha256(created.key));
    expect(stored.key_hash).not.toBe(created.key);
    // Nothing anywhere on the row reproduces the secret.
    expect(JSON.stringify(stored)).not.toContain(created.key);

    // The prefix is a display aid, not a credential: it reveals 8 of 43 secret
    // characters and cannot be lengthened by accident.
    expect(stored.key_prefix).toBe(created.key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH));
    expect(stored.key_prefix.length).toBeLessThan(created.key.length);
    expect(created.key.startsWith(stored.key_prefix)).toBe(true);

    expect(created.name).toBe('Integration');
    expect(created.scopes).toEqual(['contacts:read']);
  });

  it('never returns key material from the listing endpoint', async () => {
    const created = await createApiKey({
      organizationId: ORG_A,
      createdBy: ADMIN_A,
      name: 'Integration',
      scopes: ['contacts:read'],
    });

    const listed = await listApiKeys(ORG_A);
    const serialized = JSON.stringify(listed);

    expect(listed).toHaveLength(1);
    expect(serialized).not.toContain(created.key);
    expect(serialized).not.toContain(sha256(created.key));
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]).not.toHaveProperty('key_hash');
  });

  it('drops unrecognised scope strings instead of honouring them', () => {
    expect(parseApiKeyScopes(['contacts:read', 'org:admin', 42])).toEqual(['contacts:read']);
    expect(parseApiKeyScopes(null)).toEqual([]);
  });

  it('scopes listing and revocation to the calling organization', async () => {
    const created = await createApiKey({
      organizationId: ORG_A,
      createdBy: ADMIN_A,
      name: 'A key',
      scopes: ['contacts:read'],
    });

    await expect(listApiKeys(ORG_B)).resolves.toEqual([]);
    await expect(revokeApiKey(created.id, ORG_B)).rejects.toThrow('API key not found');
    expect(store.tables.apiKey[0].revoked_at).toBeNull();

    const revoked = await revokeApiKey(created.id, ORG_A);
    expect(revoked.revoked_at).toBeInstanceOf(Date);
  });
});

// ─── 2. Credential rejection ──────────────────────────────────────────────────

describe('public API authentication', () => {
  it('accepts a live key', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    seedContact(ORG_A, 'Anna');
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(key) });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    // Successful use is recorded so an idle or leaked key is visible in the UI.
    expect(store.tables.apiKey[0].last_used_at).toBeInstanceOf(Date);

    await app.close();
  });

  it('rejects a revoked key', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A, revokedAt: new Date('2026-01-01') });
    seedContact(ORG_A, 'Anna');
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(key) });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid, revoked, or expired API key' },
    });
    // A rejected request must not even stamp last_used_at.
    expect(store.tables.apiKey[0].last_used_at).toBeNull();

    await app.close();
  });

  it('rejects an expired key, an unknown key and a missing header', async () => {
    seedKey({
      organizationId: ORG_A,
      createdBy: ADMIN_A,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expired = store.tables.apiKey[0];
    const app = await buildApp();

    const expiredResponse = await app.inject({
      method: 'GET',
      url: '/public/v1/contacts',
      headers: { authorization: `Bearer ${generateApiKey()}` },
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(expired.last_used_at).toBeNull();

    const noHeader = await app.inject({ method: 'GET', url: '/public/v1/contacts' });
    expect(noHeader.statusCode).toBe(401);

    const garbage = await app.inject({
      method: 'GET',
      url: '/public/v1/contacts',
      headers: { authorization: 'Bearer not-a-key' },
    });
    expect(garbage.statusCode).toBe(401);

    await app.close();
  });

  it('returns the standard error envelope for validation and unknown routes', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const app = await buildApp();

    const badParam = await app.inject({
      method: 'GET',
      url: '/public/v1/contacts/not-a-uuid',
      headers: auth(key),
    });
    expect(badParam.statusCode).toBe(400);
    expect(badParam.json().error.code).toBe('VALIDATION_ERROR');

    const badBody = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers: { ...auth(key), 'content-type': 'application/json' },
      payload: JSON.stringify({ last_name: 'Missing first name' }),
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe('VALIDATION_ERROR');

    const unknown = await app.inject({ method: 'GET', url: '/public/v1/nope', headers: auth(key) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });

    await app.close();
  });

  it('refuses a write when the key lacks the write scope', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A, scopes: ['contacts:read'] });
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers: { ...auth(key), 'content-type': 'application/json' },
      payload: JSON.stringify({ first_name: 'Boris' }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('INSUFFICIENT_SCOPE');
    expect(store.tables.contact).toHaveLength(0);

    await app.close();
  });
});

// ─── 2b. Per-key rate limiting ────────────────────────────────────────────────
//
// The file header of public-api-auth.ts calls the per-key bucket one of the
// three things that contain org-level API access ("one integration cannot
// exhaust the org's budget"), so it needs a test that goes red when the bucket
// is removed. getPublicApiRateLimitMax() takes an `env`, so the ceiling that
// actually ships can be read directly rather than inferred from the 10_000 the
// suite runs under.

describe('public API rate limiting', () => {
  const env = (values: Record<string, string>): NodeJS.ProcessEnv =>
    values as unknown as NodeJS.ProcessEnv;

  it('ships a 60-request minute, not the 10_000 the test suite runs under', () => {
    expect(getPublicApiRateLimitMax(env({ NODE_ENV: 'production' }))).toBe(60);
    expect(getPublicApiRateLimitMax(env({ NODE_ENV: 'development' }))).toBe(60);
    expect(getPublicApiRateLimitWindowMs(env({ NODE_ENV: 'production' }))).toBe(60_000);

    // Tunable, but only to a positive integer — a misconfigured value must fall
    // back to 60 rather than to "no limit".
    const overrides: Array<[string, number]> = [
      ['120', 120],
      ['1', 1],
      ['0', 60],
      ['-5', 60],
      ['', 60],
      ['unlimited', 60],
    ];
    for (const [raw, expected] of overrides) {
      expect(
        getPublicApiRateLimitMax(env({ NODE_ENV: 'production', PUBLIC_API_RATE_LIMIT_MAX_REQUESTS: raw })),
        `PUBLIC_API_RATE_LIMIT_MAX_REQUESTS=${raw}`,
      ).toBe(expected);
    }

    // The escape hatch is keyed on NODE_ENV and nothing else.
    expect(getPublicApiRateLimitMax(env({ NODE_ENV: 'test' }))).toBe(10_000);
  });

  it('spends a budget per key, refuses past it, and reopens on the next window', () => {
    const WINDOW = 60_000;
    const at = 1_000_000;

    expect(consumePublicApiRateLimit('key-a', at, 2, WINDOW)).toMatchObject({ allowed: true, remaining: 1 });
    expect(consumePublicApiRateLimit('key-a', at, 2, WINDOW)).toMatchObject({ allowed: true, remaining: 0 });

    const refused = consumePublicApiRateLimit('key-a', at, 2, WINDOW);
    expect(refused.allowed).toBe(false);
    expect(refused).toMatchObject({ retry_after_ms: WINDOW, reset_at: at + WINDOW });

    // A second key has its own budget — the bucket is keyed by key id, not shared.
    expect(consumePublicApiRateLimit('key-b', at, 2, WINDOW).allowed).toBe(true);

    // One millisecond before the window closes it is still refused; after, it reopens.
    expect(consumePublicApiRateLimit('key-a', at + WINDOW - 1, 2, WINDOW).allowed).toBe(false);
    expect(consumePublicApiRateLimit('key-a', at + WINDOW, 2, WINDOW).allowed).toBe(true);
  });

  it('answers 429 once a key has spent its budget, and refuses before the handler runs', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    seedContact(ORG_A, 'Anna');
    const app = await buildApp();
    const keyId = store.tables.apiKey[0].id;

    // Spend the whole bucket through the same limiter the preHandler consumes,
    // at whatever ceiling this environment carries — no env stubbing, no 10_000
    // HTTP round trips.
    const max = getPublicApiRateLimitMax();
    for (let i = 0; i < max; i += 1) consumePublicApiRateLimit(keyId);
    expect(consumePublicApiRateLimit(keyId).allowed).toBe(false);

    const response = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(key) });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Public API rate limit exceeded' },
    });
    // A caller has to be told when to come back, or it retries immediately.
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);

    // The refusal happens in the preHandler: no rows leave, and last_used_at is
    // not stamped by a request that was never served.
    expect(response.body).not.toContain('Anna');
    expect(store.tables.apiKey[0].last_used_at).toBeNull();
    expect(store.db.contact.findMany).not.toHaveBeenCalled();

    await app.close();
  });

  it('lets the same key straight through again once its buckets are dropped', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    seedContact(ORG_A, 'Anna');
    const app = await buildApp();
    const keyId = store.tables.apiKey[0].id;

    for (let i = 0; i < getPublicApiRateLimitMax(); i += 1) consumePublicApiRateLimit(keyId);
    expect((await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(key) })).statusCode).toBe(429);

    resetPublicApiRateLimits();
    const after = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(key) });

    expect(after.statusCode).toBe(200);
    expect(after.json().data).toHaveLength(1);

    await app.close();
  });

  it('rate-limits per key, so one integration cannot spend another key\'s budget', async () => {
    const noisy = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const quiet = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    seedContact(ORG_A, 'Anna');
    const app = await buildApp();

    for (let i = 0; i < getPublicApiRateLimitMax(); i += 1) {
      consumePublicApiRateLimit(store.tables.apiKey[0].id);
    }

    const blocked = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(noisy) });
    const allowed = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(quiet) });

    expect(blocked.statusCode).toBe(429);
    expect(allowed.statusCode).toBe(200);

    await app.close();
  });
});

// ─── 3. Tenant isolation ──────────────────────────────────────────────────────

describe('public API org scoping', () => {
  it('blocks a cross-org read by id and by listing', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    seedContact(ORG_A, 'Anna');
    const foreign = seedContact(ORG_B, 'Boris');
    const app = await buildApp();

    const direct = await app.inject({
      method: 'GET',
      url: `/public/v1/contacts/${foreign.id}`,
      headers: auth(key),
    });

    expect(direct.statusCode).toBe(404);
    expect(direct.json().error.code).toBe('CONTACT_NOT_FOUND');

    const list = await app.inject({ method: 'GET', url: '/public/v1/contacts', headers: auth(key) });
    const names = list.json().data.map((row: Row) => row.first_name);

    expect(names).toEqual(['Anna']);
    expect(JSON.stringify(list.json())).not.toContain('Boris');

    await app.close();
  });

  it('blocks a cross-org write and creates records in the key\'s own org', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const foreign = seedContact(ORG_B, 'Boris');
    const app = await buildApp();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/public/v1/contacts/${foreign.id}`,
      headers: { ...auth(key), 'content-type': 'application/json' },
      payload: JSON.stringify({ company: 'Taken over' }),
    });

    expect(patch.statusCode).toBe(404);
    // The foreign row is untouched — the write never reached it.
    expect(store.tables.contact.find((row) => row.id === foreign.id)?.company).toBeNull();

    const created = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers: { ...auth(key), 'content-type': 'application/json' },
      payload: JSON.stringify({ first_name: 'Anna' }),
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().data.organization_id).toBe(ORG_A);

    await app.close();
  });
});

// ─── 4 & 5. Idempotency ───────────────────────────────────────────────────────

describe('public API idempotency', () => {
  const body = JSON.stringify({ first_name: 'Anna', company: 'Yandex' });

  it('replays the first response instead of acting twice', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const app = await buildApp();
    const headers = { ...auth(key), 'content-type': 'application/json', 'idempotency-key': 'order-4711' };

    const first = await app.inject({ method: 'POST', url: '/public/v1/contacts', headers, payload: body });
    const second = await app.inject({ method: 'POST', url: '/public/v1/contacts', headers, payload: body });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(first.headers['idempotency-replayed']).toBe('false');
    expect(second.headers['idempotency-replayed']).toBe('true');

    // The operation ran exactly once.
    expect(store.tables.contact).toHaveLength(1);

    await app.close();
  });

  it('treats the same key with a different body as a conflict, not a replay', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const app = await buildApp();
    const headers = { ...auth(key), 'content-type': 'application/json', 'idempotency-key': 'order-4711' };

    const first = await app.inject({ method: 'POST', url: '/public/v1/contacts', headers, payload: body });
    const second = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers,
      payload: JSON.stringify({ first_name: 'Boris', company: 'Ozon' }),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(store.tables.contact).toHaveLength(1);

    await app.close();
  });

  it('is insensitive to JSON key order but sensitive to the endpoint', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const contact = seedContact(ORG_A, 'Anna');
    const app = await buildApp();
    const headers = { ...auth(key), 'content-type': 'application/json', 'idempotency-key': 'order-4711' };

    const first = await app.inject({ method: 'POST', url: '/public/v1/contacts', headers, payload: body });
    const reordered = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers,
      payload: JSON.stringify({ company: 'Yandex', first_name: 'Anna' }),
    });

    expect(reordered.statusCode).toBe(201);
    expect(reordered.json()).toEqual(first.json());

    // Same key, same body, different endpoint — still a conflict.
    const elsewhere = await app.inject({
      method: 'PATCH',
      url: `/public/v1/contacts/${contact.id}`,
      headers,
      payload: body,
    });

    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    await app.close();
  });

  it('keys the replay record per organization', async () => {
    const keyA = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const keyB = seedKey({ organizationId: ORG_B, createdBy: ADMIN_B });
    const app = await buildApp();

    const shared = { 'content-type': 'application/json', 'idempotency-key': 'order-4711' };

    const inA = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers: { ...auth(keyA), ...shared },
      payload: body,
    });
    const inB = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers: { ...auth(keyB), ...shared },
      payload: body,
    });

    // Same key string, different tenants: both must actually run.
    expect(inA.statusCode).toBe(201);
    expect(inB.statusCode).toBe(201);
    expect(inA.json().data.organization_id).toBe(ORG_A);
    expect(inB.json().data.organization_id).toBe(ORG_B);
    expect(store.tables.contact).toHaveLength(2);

    await app.close();
  });

  it('rejects a malformed Idempotency-Key rather than ignoring it', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/public/v1/contacts',
      headers: { ...auth(key), 'content-type': 'application/json', 'idempotency-key': 'has spaces' },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_IDEMPOTENCY_KEY');
    expect(store.tables.contact).toHaveLength(0);

    await app.close();
  });

  it('does not cache a failed operation', async () => {
    const key = seedKey({ organizationId: ORG_A, createdBy: ADMIN_A });
    const app = await buildApp();
    const headers = { ...auth(key), 'content-type': 'application/json', 'idempotency-key': 'retry-me' };

    store.db.contact.create.mockRejectedValueOnce(new Error('transient database failure'));

    const failed = await app.inject({ method: 'POST', url: '/public/v1/contacts', headers, payload: body });
    expect(failed.statusCode).toBe(500);
    expect(store.tables.idempotencyKey).toHaveLength(0);

    const retried = await app.inject({ method: 'POST', url: '/public/v1/contacts', headers, payload: body });
    expect(retried.statusCode).toBe(201);
    expect(store.tables.contact).toHaveLength(1);

    await app.close();
  });
});
