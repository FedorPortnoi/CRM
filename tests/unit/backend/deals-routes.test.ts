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
    createStage: routeMocks.noop,
    updateStage: routeMocks.noop,
    deleteStage: routeMocks.noop,
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
});
