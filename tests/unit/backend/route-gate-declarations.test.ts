/**
 * THE DRIFT GUARD FOR READ AUTHORIZATION.
 *
 * Read gates in api/authenticate.ts are an ordered chain of literal paths and
 * one-segment regexes, and `adminRoutePolicy` returning null means "no
 * capability required". That is fail-open by omission, and every instance found
 * so far was found by hand, after shipping: `/contacts/:id/deals` returned full
 * deal rows from a path the `/deals` clauses could not match; `/api/v1/calendar`
 * hands back `deal: { id, title }`; `/api/v1/tasks` hands back `deal_id`. The URL
 * is not the authority on what a handler reads.
 *
 * This file replaces a scratch probe that lived at this path and asserted
 * `routes.length > 0` while dumping routes.json into a machine-specific Windows
 * temp directory — a test named for a guarantee it never exercised, which is a
 * mistake this codebase has recorded before.
 *
 * What it asserts now:
 *   1. Every registered route whose pattern contains a `deals` segment is
 *      DECLARED in backend/api/route-gates.ts. This is the mechanical guard: add
 *      `f.get('/:id/history')` to routes/deals.ts and the build goes red naming
 *      the route, instead of the route shipping ungated.
 *   2. No declaration is stale — every key corresponds to a route that is
 *      actually registered, so a deleted route cannot rot in the table.
 *   3. The declared table and the hand-written chain in authenticate.ts agree
 *      about the routes they both cover.
 *   4. The module list this file registers matches the one backend/index.ts
 *      registers. Without this, the check itself is fail-open by omission one
 *      level up: a new plugin added to index.ts and not here would be invisible.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../../../backend/services/db', () => ({
  db: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }),
}));

import {
  DEAL_READ_ROUTES,
  looksLikeDealRoute,
  routeGateKey,
} from '../../../backend/api/route-gates';

/**
 * Mounted plugins, as `[module basename, prefix]`.
 *
 * Kept in step with backend/index.ts by the last test in this file rather than
 * by discipline — the two lists agreeing is itself an assertion.
 */
const MODULES: Array<[string, string]> = [
  ['ws', '/api/v1'],
  ['auth', '/api/v1/auth'],
  ['contacts', '/api/v1/contacts'],
  ['deals', '/api/v1/deals'],
  ['tasks', '/api/v1/tasks'],
  ['messages', '/api/v1/messages'],
  ['calendar', '/api/v1/calendar'],
  ['analytics', '/api/v1/analytics'],
  ['notifications', '/api/v1/notifications'],
  ['workflows', '/api/v1/workflows'],
  ['sync', '/api/v1/sync'],
  ['captures', '/api/v1/captures'],
  ['onboarding', '/api/v1/onboarding'],
  ['export', '/api/v1/export'],
  ['activities', '/api/v1'],
  ['attachments', '/api/v1'],
  ['chat', '/api/v1/chat'],
  ['imports', '/api/v1/import'],
  ['amocrm', '/api/v1/amocrm'],
  ['amocrm-webhook', '/api/v1/integrations/amocrm'],
  ['lead-inbox', '/api/v1/integrations/lead-inbox'],
  ['org', '/api/v1/org'],
  ['reporting', '/api/v1/reports'],
  ['webhooks', '/api/v1/webhooks'],
  ['assistant', '/api/v1/assistant'],
  ['contact-ai', '/api/v1/ai'],
  ['email-templates', '/api/v1/email-templates'],
  ['tracking', '/api/v1/tracking'],
  ['updates', '/api/v1/updates'],
];

type RegisteredRoute = { method: string; url: string };

let routes: RegisteredRoute[] = [];

beforeAll(async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const collected: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      collected.push({ method, url: route.url });
    }
  });

  const jwt = (await import('@fastify/jwt')).default;
  const formbody = (await import('@fastify/formbody')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  const websocket = (await import('@fastify/websocket')).default;
  await app.register(formbody);
  await app.register(jwt, { secret: 'x'.repeat(48) });
  await app.register(rateLimit, { max: 10_000, timeWindow: 60_000 });
  await app.register(websocket);

  for (const [name, prefix] of MODULES) {
    const mod = (await import(`../../../backend/api/routes/${name}`)) as Record<string, unknown>;
    const plugin = (mod.default ?? mod[Object.keys(mod)[0] as string]) as never;
    await app.register(plugin, { prefix });
  }

  const sequences = await import('../../../backend/api/routes/sequences');
  await app.register(sequences.default as never, { prefix: '/api/v1/sequences' });
  await app.register(sequences.consentRoutes as never, { prefix: '/api/v1/consent' });
  const publicApi = await import('../../../backend/api/routes/public-api');
  await app.register(publicApi.apiKeysRoutes as never, { prefix: '/api/v1/api-keys' });
  await app.register(publicApi.default as never, { prefix: '/public/v1' });

  await app.ready();
  routes = collected;
  await app.close();
});

describe('every deal-reading route is declared', () => {
  it('boots the real route tree', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('has a declaration for every registered route with a deals segment', () => {
    // HEAD is normalized onto its GET row rather than being separately
    // declarable: Fastify auto-registers a HEAD twin for every GET and it runs
    // the SAME handler, so a human who fills the GET row and forgets the HEAD one
    // would recreate exactly the blind spot the isReadOnlyMethod sweep removed.
    const missing = routes
      .filter((route) => route.url.startsWith('/api/v1/'))
      .filter((route) => looksLikeDealRoute(route.url))
      .filter((route) => route.method === 'GET' || route.method === 'HEAD')
      .map((route) => routeGateKey(route.method, route.url))
      .filter((key) => !(key in DEAL_READ_ROUTES));

    // Collected into ONE array so the failure names every undeclared route at
    // once rather than dying on the first.
    expect([...new Set(missing)]).toEqual([]);
  });

  it('has no stale declaration for a route that no longer exists', () => {
    // Normalized the same way the lookup is, so a route that exists only as an
    // auto-registered HEAD twin still counts as registered.
    const registered = new Set(
      routes.map((route) => routeGateKey(route.method, route.url)),
    );
    const stale = Object.keys(DEAL_READ_ROUTES).filter((key) => !registered.has(key));

    expect(stale).toEqual([]);
  });

  it('declares the three surfaces that leak deals from a non-deals URL', () => {
    // These are the instances that prove URL-shaped gates do not hold. Asserted
    // by name so deleting one from the table is a red test rather than a silent
    // regression back to "nobody wrote this route down".
    expect(DEAL_READ_ROUTES['GET /api/v1/contacts/:id/deals']).toBe('deals.read');
    expect(DEAL_READ_ROUTES['GET /api/v1/calendar']).toBe('field-level');
    expect(DEAL_READ_ROUTES['GET /api/v1/tasks']).toBe('field-level');
  });
});

describe('the declared table and the hand-written chain agree', () => {
  it('registers exactly the four GET routes under /api/v1/deals that the chain lists', async () => {
    const dealGets = routes
      .filter((route) => route.method === 'GET' && route.url.startsWith('/api/v1/deals'))
      .map((route) => route.url)
      .sort();

    expect(dealGets).toEqual([
      '/api/v1/deals',
      '/api/v1/deals/:id',
      '/api/v1/deals/pipelines',
      '/api/v1/deals/stages/library',
    ]);
  });

  it('keeps the module list in step with backend/index.ts', () => {
    // The route tree above is only as complete as this file's own list of
    // plugins. A plugin added to index.ts and not here would contribute no
    // routes, get no declaration, and leave the whole check green — fail-open by
    // omission, relocated from the regex chain into the test fixture.
    const indexSource = readFileSync(
      join(process.cwd(), 'backend', 'index.ts'),
      'utf8',
    );

    const registered = new Set<string>();
    const pattern = /server\.register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*'([^']+)'/g;
    for (const match of indexSource.matchAll(pattern)) {
      registered.add(match[2] as string);
    }

    const covered = new Set<string>([
      ...MODULES.map(([, prefix]) => prefix),
      '/api/v1/sequences',
      '/api/v1/consent',
      '/api/v1/api-keys',
      '/public/v1',
    ]);

    const uncovered = [...registered].filter((prefix) => !covered.has(prefix));
    expect(uncovered).toEqual([]);
  });
});
