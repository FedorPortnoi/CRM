/**
 * The tenant chokepoint's own tests.
 *
 * backend/services/tenant-scope.ts is the runtime half of tenant isolation: it
 * wraps the single shared PrismaClient in backend/services/db.ts and inspects
 * every `where` before the query is issued. Until this file existed the walker
 * had ZERO coverage — nothing in the repo imported `checkTenantScope`, and the
 * throw path had never run — which is how it shipped judging
 * `{ organization_id: { not: myOrg } }`, the literal definition of a
 * cross-tenant read, as correctly tenant-scoped.
 *
 * Two things are tested here and they are not the same thing:
 *
 *   1. THE VERDICT. `checkTenantScope` is pure, so every shape is a table row.
 *      The rows that matter are the ones that USED to return `{ ok: true }`.
 *   2. THE WRAPPER. `withTenantScope` decides what happens to the verdict. It is
 *      exercised against a real PrismaClient with a datasource that refuses
 *      connections: under TENANT_SCOPE_ENFORCE=1 the rejection must arrive
 *      BEFORE any connection is attempted, which is what proves the guard runs
 *      ahead of the query rather than alongside it. No database is involved.
 *
 * Note for anyone tempted to set TENANT_SCOPE_ENFORCE=1 in vitest.config.ts to
 * "turn the guard on for tests": it would change nothing. Every unit test that
 * touches `db` replaces the module with `vi.mock`, so the extension is never
 * installed and `enforcing()` is never called. That is why the throw path is
 * covered here, by installing the extension explicitly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkTenantScope,
  identityKeysFor,
  resetTenantScopeReports,
  withTenantScope,
  TenantScopeError,
  TENANT_KEY_BY_MODEL,
  TENANT_OWNED_VIA_RELATION,
  GLOBAL_MODELS,
} from '../../../backend/services/tenant-scope';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ROW = 'cccccccc-0000-4000-8000-000000000007';

function verdict(where: unknown, model = 'Contact', operation = 'findMany') {
  return checkTenantScope(model, operation, { where });
}

// --- 1. A negated or ranged filter is the OPPOSITE of a tenant scope ---------
//
// Every row here returned { ok: true } before the allow-list rewrite of
// constrains(). Each one reads across every tenant in the database.

describe('a filter that does not pin the column is not a tenant scope', () => {
  const crossTenant: Array<[string, unknown]> = [
    ['organization_id not', { organization_id: { not: ORG } }],
    ['organization_id notIn', { organization_id: { notIn: [ORG] } }],
    ['organization_id null', { organization_id: null }],
    ['organization_id not null', { organization_id: { not: null } }],
    ['organization_id gte', { organization_id: { gte: '' } }],
    ['organization_id contains', { organization_id: { contains: '' } }],
    ['organization_id startsWith', { organization_id: { startsWith: '' } }],
    ['id not', { id: { not: ROW } }],
    ['id gt (keyset pagination)', { id: { gt: '00000000-0000-4000-8000-000000000000' } }],
    ['id notIn', { id: { notIn: [ROW] } }],
    ['bearer token not null', { unsubscribe_token: { not: null } }],
    ['bearer token contains', { unsubscribe_token: { contains: '' } }],
  ];

  for (const [label, where] of crossTenant) {
    it(`flags Contact.findMany with ${label}`, () => {
      expect(verdict(where)).toMatchObject({ ok: false, tenantKey: 'organization_id' });
    });
  }

  it('flags a negated tenant column reached through a relation filter', () => {
    expect(verdict({ contact: { organization_id: { not: ORG } } }, 'Deal')).toMatchObject({ ok: false });
  });

  it('reports a range on the tenant key as unbound, not as missing', () => {
    expect(verdict({ organization_id: { not: ORG } })).toEqual({
      ok: false,
      reason: 'unbound',
      tenantKey: 'organization_id',
    });
  });
});

// --- 2. The undefined trap, including one operator level down ---------------

describe('a filter Prisma silently drops is not a tenant scope', () => {
  const dropped: Array<[string, unknown]> = [
    ['bare undefined', { organization_id: undefined }],
    ['equals undefined', { organization_id: { equals: undefined } }],
    ['in undefined', { organization_id: { in: undefined } }],
    ['empty operator object', { organization_id: {} }],
  ];

  for (const [label, where] of dropped) {
    it(`flags ${label} as 'undefined'`, () => {
      expect(verdict(where)).toEqual({ ok: false, reason: 'undefined', tenantKey: 'organization_id' });
    });
  }

  it('flags an undefined identity key too', () => {
    expect(verdict({ id: { equals: undefined } })).toMatchObject({ ok: false, reason: 'missing' });
  });

  it("flags a written-but-undefined tenant key even when an id is also present", () => {
    // The id makes the query safe by accident. The dropped filter is still a bug
    // and the next edit to this call site is the one that leaks.
    expect(verdict({ organization_id: undefined, id: ROW })).toMatchObject({ ok: false, reason: 'undefined' });
  });
});

// --- 3. Real scoping must still pass ----------------------------------------

describe('a filter that pins the column is a tenant scope', () => {
  const scoped: Array<[string, unknown]> = [
    ['scalar tenant key', { organization_id: ORG }],
    ['equals tenant key', { organization_id: { equals: ORG } }],
    ['in tenant key', { organization_id: { in: [ORG, OTHER] } }],
    ['in with an empty list (matches nothing)', { organization_id: { in: [] } }],
    ['id', { id: ROW }],
    ['id in', { id: { in: [ROW] } }],
    ['bearer token', { unsubscribe_token: 'unsub-token' }],
    ['tenant key alongside a negated non-tenant column', { organization_id: ORG, id: { not: ROW } }],
    ['AND with one scoped branch', { AND: [{ status: 'active' }, { organization_id: ORG }] }],
    ['OR with every branch scoped', { OR: [{ organization_id: ORG }, { organization_id: OTHER }] }],
  ];

  for (const [label, where] of scoped) {
    it(`accepts ${label}`, () => {
      expect(verdict(where)).toEqual({ ok: true });
    });
  }

  it('accepts a tenant column reached through a relation filter', () => {
    expect(verdict({ contact: { organization_id: ORG } }, 'Deal')).toEqual({ ok: true });
  });

  it('rejects an OR where one branch is unscoped', () => {
    expect(verdict({ OR: [{ organization_id: ORG }, { status: 'active' }] })).toMatchObject({ ok: false });
  });

  it('rejects a bare or absent where', () => {
    expect(verdict({})).toMatchObject({ ok: false, reason: 'missing' });
    expect(checkTenantScope('Contact', 'findMany', {})).toMatchObject({ ok: false, reason: 'missing' });
    expect(checkTenantScope('Contact', 'findMany', undefined)).toMatchObject({ ok: false, reason: 'missing' });
  });
});

// --- 4. Which models and operations the guard applies to --------------------

describe('the guard applies to exactly the tenant-owned models and scoped operations', () => {
  it('uses org_id for PendingCapture and nothing else', () => {
    expect(TENANT_KEY_BY_MODEL.PendingCapture).toBe('org_id');
    expect(checkTenantScope('PendingCapture', 'findMany', { where: { org_id: ORG } })).toEqual({ ok: true });
    // The literal string 'organization_id' does NOT scope this model.
    expect(checkTenantScope('PendingCapture', 'findMany', { where: { organization_id: ORG } })).toMatchObject({
      ok: false,
      tenantKey: 'org_id',
    });
  });

  it('exempts create and createMany, which carry no where', () => {
    expect(checkTenantScope('Contact', 'create', { data: {} })).toEqual({ ok: true });
    expect(checkTenantScope('Contact', 'createMany', { data: [] })).toEqual({ ok: true });
  });

  it('exempts models it cannot decide, which is why the static walk exists', () => {
    for (const model of Object.keys(TENANT_OWNED_VIA_RELATION)) {
      expect(checkTenantScope(model, 'findMany', { where: {} })).toEqual({ ok: true });
    }
    for (const model of Object.keys(GLOBAL_MODELS)) {
      expect(checkTenantScope(model, 'findMany', { where: {} })).toEqual({ ok: true });
    }
    expect(checkTenantScope('NoSuchModel', 'findMany', { where: {} })).toEqual({ ok: true });
  });

  it('lists id first among the identity keys of every tenant-owned model', () => {
    for (const model of Object.keys(TENANT_KEY_BY_MODEL)) {
      expect(identityKeysFor(model)[0]).toBe('id');
    }
  });
});

// --- 5. The wrapper: what actually happens to a verdict ---------------------
//
// A real PrismaClient pointed at a port nothing listens on. Under enforcement
// the rejection must be a TenantScopeError, which can only happen if the guard
// runs before the query is issued — a connection attempt would fail with a
// Prisma initialisation error instead.

async function withRealClient(fn: (client: import('@prisma/client').PrismaClient) => Promise<void>) {
  const { PrismaClient } = await import('@prisma/client');
  const base = new PrismaClient({
    datasources: { db: { url: 'postgresql://nobody:nobody@127.0.0.1:1/tenant-scope-test' } },
  });
  try {
    await fn(withTenantScope(base));
  } finally {
    await base.$disconnect().catch(() => undefined);
  }
}

describe('withTenantScope decides what happens to the verdict', () => {
  const previous = process.env.TENANT_SCOPE_ENFORCE;

  beforeEach(() => {
    resetTenantScopeReports();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.TENANT_SCOPE_ENFORCE;
    else process.env.TENANT_SCOPE_ENFORCE = previous;
    vi.restoreAllMocks();
  });

  it('throws before issuing the query when TENANT_SCOPE_ENFORCE=1', async () => {
    process.env.TENANT_SCOPE_ENFORCE = '1';
    await withRealClient(async (client) => {
      await expect(client.contact.findMany({})).rejects.toBeInstanceOf(TenantScopeError);
      await expect(client.contact.findMany({ where: { organization_id: { not: ORG } } })).rejects.toBeInstanceOf(
        TenantScopeError,
      );
    });
  }, 30_000);

  it('does not throw on a scoped query — it reaches the (absent) database instead', async () => {
    process.env.TENANT_SCOPE_ENFORCE = '1';
    await withRealClient(async (client) => {
      const error = await client.contact.findMany({ where: { organization_id: ORG } }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TenantScopeError);
    });
  }, 30_000);

  it('reports once per call site and lets the query through when enforcement is off', async () => {
    delete process.env.TENANT_SCOPE_ENFORCE;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await withRealClient(async (client) => {
      await client.contact.findMany({}).catch(() => undefined);
      await client.contact.findMany({}).catch(() => undefined);
    });

    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[tenant-scope]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Contact.findMany');
  }, 30_000);
});
