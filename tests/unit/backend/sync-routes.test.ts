import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const routeMocks = vi.hoisted(() => ({
  delta: vi.fn(async (_request: unknown, reply: { send: (payload: unknown) => unknown }) => {
    reply.send({ data: { contacts: [], deals: [], tasks: [] }, meta: {} });
  }),
}));

vi.mock('../../../backend/api/controllers/sync', () => ({
  // Any handler not mocked above gets a plain vi.fn(), so a route added later registers
  // cleanly and fails here on its status code rather than on a missing handler — the
  // failure then names the drift instead of looking like a broken test.
  SyncController: new Proxy(routeMocks as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop] = vi.fn();
      }
      return target[prop];
    },
  }),
}));

import syncRoutes from '../../../backend/api/routes/sync';

/**
 * Sync is READ-ONLY, and its missing other half is the second-largest gap recorded in
 * docs/architecture/api-design.md.
 *
 * That document described `POST /sync/push` — "send a batch of local mutations made while
 * offline" — in prose detail from the Sprint-0 spec onward. The route was never built, so
 * an offline write has nowhere to go server-side; `GET /sync/delta` is the whole sync
 * surface. The absence is now recorded under Known Gaps rather than papered over, because
 * a reader needs to learn the capability is ABSENT, not merely undocumented.
 *
 * IF `/sync/push` EVER STOPS RETURNING 404, that Known Gaps entry is stale and must be
 * corrected in the same commit that adds the route. This file is the mechanical half of
 * the record: the doc drifted for two years precisely because nothing ever read it.
 *
 * This is a guard, not a backlog item. Building offline write-back is a product decision.
 */
describe('sync routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      return undefined;
    });
    await app.register(syncRoutes, { prefix: '/sync' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // Positive control. Without it the refusals below would pass just as happily against a
  // plugin that registered nothing at all.
  it('registers GET /sync/delta, the whole sync surface', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sync/delta?since=2026-08-01T00:00:00.000Z',
    });

    expect(response.statusCode).toBe(200);
    expect(routeMocks.delta).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['POST', '/sync/push'],
    ['PUT', '/sync/push'],
    // The two shapes someone reaching for offline write-back would try next.
    ['POST', '/sync/mutations'],
    ['POST', '/sync/batch'],
    // Delta is a read. There is no write half of it either.
    ['POST', '/sync/delta'],
  ])('%s %s is not registered — offline mutations are not accepted', async (method, url) => {
    const response = await app.inject({
      method: method as 'POST' | 'PUT',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ contacts: [], deals: [], tasks: [] }),
    });

    expect(response.statusCode).toBe(404);
  });
});
