import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const routeMocks = vi.hoisted(() => {
  type ReplyLike = {
    send: (payload: unknown) => unknown;
    status: (code: number) => ReplyLike;
  };

  const noop = vi.fn(async (_request: unknown, reply: { send: (payload: unknown) => unknown }) => {
    reply.send({ data: {}, meta: {} });
  });

  return {
    noop,
    create: vi.fn(async (request: { body: unknown }, reply: ReplyLike) => {
      reply.status(201).send({ data: request.body, meta: {} });
    }),
    update: vi.fn(async (request: { body: unknown }, reply: { send: (payload: unknown) => unknown }) => {
      reply.send({ data: request.body, meta: {} });
    }),
  };
});

vi.mock('../../../backend/api/controllers/deals', () => ({
  DealsController: {
    list: routeMocks.noop,
    evaluateStale: routeMocks.noop,
    create: routeMocks.create,
    getById: routeMocks.noop,
    update: routeMocks.update,
    moveStage: routeMocks.noop,
    markWon: routeMocks.noop,
    markLost: routeMocks.noop,
    archive: routeMocks.noop,
    listPipelines: routeMocks.noop,
    createPipeline: routeMocks.noop,
    getPipeline: routeMocks.noop,
    updatePipeline: routeMocks.noop,
    deletePipeline: routeMocks.noop,
    listStages: routeMocks.noop,
    stageLibrary: routeMocks.noop,
    createStage: routeMocks.noop,
    updateStage: routeMocks.noop,
    deleteStage: routeMocks.noop,
    reorderStages: routeMocks.noop,
  },
}));

import dealsRoutes from '../../../backend/api/routes/deals';

describe('deals routes validation', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      return undefined;
    });
    await app.register(dealsRoutes, { prefix: '/deals' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows PATCH deal value to be set to zero', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/deals/00000000-0000-4000-a000-000000000001',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 0 }),
    });

    expect(response.statusCode).toBe(200);
    expect(routeMocks.update).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({ data: { value: 0 }, meta: {} });
  });

  it('defaults new deals to the Russia market currency', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/deals',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        title: 'Russia market deal',
        contact_id: '00000000-0000-4000-a000-000000000001',
        pipeline_id: '00000000-0000-4000-a000-000000000002',
        stage_id: '00000000-0000-4000-a000-000000000003',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(routeMocks.create).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      data: {
        title: 'Russia market deal',
        contact_id: '00000000-0000-4000-a000-000000000001',
        pipeline_id: '00000000-0000-4000-a000-000000000002',
        stage_id: '00000000-0000-4000-a000-000000000003',
        currency: 'RUB',
      },
      meta: {},
    });
  });

  it('normalizes lowercase deal currency input', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/deals',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        title: 'Lowercase currency deal',
        contact_id: '00000000-0000-4000-a000-000000000001',
        pipeline_id: '00000000-0000-4000-a000-000000000002',
        stage_id: '00000000-0000-4000-a000-000000000003',
        currency: 'rub',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.currency).toBe('RUB');
  });

  // ─── Refusals ───────────────────────────────────────────────────────────────
  //
  // Three acceptance cases and no refusals is not a validation suite: every
  // assertion above survives deleting `schema: { body: … }` from the route,
  // which would hand the controller — and Prisma behind it — whatever JSON the
  // caller felt like sending. What follows asserts the other half: the request
  // is refused with a 4xx AND the controller never runs, because a 400 that
  // still reached the handler has already touched the database.

  const VALID_UUID = '00000000-0000-4000-a000-000000000001';
  const validDeal = {
    title: 'Valid',
    pipeline_id: '00000000-0000-4000-a000-000000000002',
    stage_id: '00000000-0000-4000-a000-000000000003',
  };

  const badCreateBodies: Array<[string, Record<string, unknown>]> = [
    ['no title at all', { pipeline_id: validDeal.pipeline_id, stage_id: validDeal.stage_id }],
    ['an empty title', { ...validDeal, title: '' }],
    ['a title past 200 characters', { ...validDeal, title: 'т'.repeat(201) }],
    ['a non-string title', { ...validDeal, title: 42 }],
    ['no pipeline_id', { title: 'x', stage_id: validDeal.stage_id }],
    ['no stage_id', { title: 'x', pipeline_id: validDeal.pipeline_id }],
    ['a pipeline_id that is not a uuid', { ...validDeal, pipeline_id: 'pipeline-1' }],
    ['a stage_id that is not a uuid', { ...validDeal, stage_id: '../../etc/passwd' }],
    ['a contact_id that is not a uuid', { ...validDeal, contact_id: 'nope' }],
    ['an assigned_to that is not a uuid', { ...validDeal, assigned_to: 'somebody' }],
    ['a negative value', { ...validDeal, value: -1 }],
    ['a value that is a string', { ...validDeal, value: '100000' }],
    ['a probability above 100', { ...validDeal, probability: 101 }],
    ['a negative probability', { ...validDeal, probability: -1 }],
    ['a two-letter currency', { ...validDeal, currency: 'RU' }],
    ['a four-letter currency', { ...validDeal, currency: 'RUBL' }],
    ['a non-ISO expected_close', { ...validDeal, expected_close: '31/12/2026' }],
    ['an expected_close that is a timestamp', { ...validDeal, expected_close: '2026-12-31T00:00:00Z' }],
    ['a next_action past 500 characters', { ...validDeal, next_action: 'a'.repeat(501) }],
    ['a source past 100 characters', { ...validDeal, source: 'a'.repeat(101) }],
    ['custom_fields that are not an object', { ...validDeal, custom_fields: 'nope' }],
  ];

  for (const [label, payload] of badCreateBodies) {
    it(`refuses POST /deals with ${label}`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/deals',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });

      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      // The point of validating at the edge: the handler is never entered, so
      // nothing downstream has to re-check this.
      expect(routeMocks.create).not.toHaveBeenCalled();
    });
  }

  const badUpdateBodies: Array<[string, Record<string, unknown>]> = [
    ['a negative value', { value: -1 }],
    ['a value that is a string', { value: 'free' }],
    ['a pipeline_id that is not a uuid', { pipeline_id: 'pipeline-1' }],
    ['a one-character currency', { currency: 'р' }],
    ['a next_action past 500 characters', { next_action: 'a'.repeat(501) }],
    ['a probability above 100', { probability: 100.5, value: -0.5 }],
    ['a title past 200 characters', { title: 'т'.repeat(201) }],
  ];

  for (const [label, payload] of badUpdateBodies) {
    it(`refuses PATCH /deals/:id with ${label}`, async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/deals/${VALID_UUID}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });

      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(routeMocks.update).not.toHaveBeenCalled();
    });
  }

  it('refuses a stage move without a real stage id, and accepts one with', async () => {
    for (const payload of [{}, { stage_id: null }, { stage_id: 'first' }, { stage_id: 7 }]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/deals/${VALID_UUID}/stage`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });

      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(routeMocks.noop).not.toHaveBeenCalled();

    // Positive control: the same route DOES accept a well-formed move, so the
    // refusals above are the schema working rather than the route being broken.
    const ok = await app.inject({
      method: 'PATCH',
      url: `/deals/${VALID_UUID}/stage`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ stage_id: '00000000-0000-4000-a000-000000000003' }),
    });

    expect(ok.statusCode).toBe(200);
    expect(routeMocks.noop).toHaveBeenCalledTimes(1);
  });

  it('refuses a close date that is not a calendar date on won and lost', async () => {
    for (const url of [`/deals/${VALID_UUID}/won`, `/deals/${VALID_UUID}/lost`]) {
      for (const payload of [{ actual_close: 'yesterday' }, { actual_close: '2026-13-45' }, { actual_close: 1 }]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        });

        expect(response.statusCode, `${url} ${JSON.stringify(payload)}`).toBe(400);
      }
    }

    const longReason = await app.inject({
      method: 'POST',
      url: `/deals/${VALID_UUID}/lost`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ reason: 'д'.repeat(501) }),
    });
    expect(longReason.statusCode).toBe(400);

    expect(routeMocks.noop).not.toHaveBeenCalled();
  });

  const badQueries: Array<[string, string]> = [
    ['a per_page above the 100 ceiling', 'per_page=101'],
    ['a per_page of zero', 'per_page=0'],
    ['a per_page that is not a number', 'per_page=all'],
    ['a page of zero', 'page=0'],
    ['a sort column that is not on the allowlist', 'sort=custom_fields'],
    ['an order that is neither asc nor desc', 'order=random'],
    ['a status outside the enum', 'status=deleted'],
    ['a scope outside the enum', 'scope=everything'],
    ['a pipeline_id that is not a uuid', 'pipeline_id=main'],
    ['an assigned_to that is not a uuid', 'assigned_to=me'],
  ];

  for (const [label, query] of badQueries) {
    it(`refuses GET /deals with ${label}`, async () => {
      const response = await app.inject({ method: 'GET', url: `/deals?${query}` });

      expect(response.statusCode, query).toBe(400);
      expect(routeMocks.noop).not.toHaveBeenCalled();
    });
  }

  it('bounds the stale-deal scan instead of letting a caller pick any threshold', async () => {
    // An unbounded threshold_days is a full-table scan an authenticated member
    // could ask for repeatedly.
    for (const query of ['threshold_days=366', 'threshold_days=-1', 'threshold_days=1.5', 'threshold_days=lots']) {
      const response = await app.inject({ method: 'POST', url: `/deals/stale/evaluate?${query}` });
      expect(response.statusCode, query).toBe(400);
    }
    expect(routeMocks.noop).not.toHaveBeenCalled();

    const ok = await app.inject({ method: 'POST', url: '/deals/stale/evaluate?threshold_days=365' });
    expect(ok.statusCode).toBe(200);
  });

  it('reports a refusal as a validation failure, never as a 500', async () => {
    // A schema that throws instead of rejecting reaches the caller as a 500 and
    // an unhandled error in the log; the difference matters to whoever is
    // paging.
    const response = await app.inject({
      method: 'POST',
      url: '/deals',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...validDeal, value: -1 }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.json()).toMatchObject({ statusCode: 400 });
    // Nothing about the server's internals leaks through the refusal.
    expect(response.body).not.toContain('node_modules');
    expect(response.body).not.toContain('at Object.');
  });

  // ─── Documented, and absent ─────────────────────────────────────────────────
  //
  // docs/architecture/api-design.md listed `DELETE /deals/:id  Archive deal` from the
  // Sprint-0 spec onward. No such route was ever built and there is no
  // DealsController.archive to serve one: `is_archived` belongs to PipelineStage, not to
  // Deal, and the only writer of DealStatus.archived is the amoCRM sync worker. The
  // document now records that under Known Gaps instead of claiming the route.
  //
  // IF EITHER ASSERTION BELOW FLIPS, that Known Gaps entry is stale and must be corrected
  // in the same commit that adds the route — the doc drifted in the first place precisely
  // because nothing mechanical ever read it.

  it('has no DELETE /deals/:id — archiving a deal is not an API operation', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/deals/${VALID_UUID}` });

    expect(response.statusCode).toBe(404);
    expect(routeMocks.noop).not.toHaveBeenCalled();
  });

  it('does not archive a deal through PATCH /deals/:id either', async () => {
    // The obvious second reading of "archive a deal". UpdateDealSchema carries neither
    // `is_archived` nor `status`, so Zod strips both and the controller is handed an
    // update that says nothing about archival — it does not merely ignore the fields
    // downstream, they never arrive.
    const response = await app.inject({
      method: 'PATCH',
      url: `/deals/${VALID_UUID}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ is_archived: true, status: 'archived' }),
    });

    expect(response.statusCode).toBe(200);
    expect(routeMocks.update).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({ data: {}, meta: {} });
  });

  it('has no GET /deals/pipelines/:id — read the list instead', async () => {
    const response = await app.inject({ method: 'GET', url: `/deals/pipelines/${VALID_UUID}` });

    expect(response.statusCode).toBe(404);
  });
});
