import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const routeMocks = vi.hoisted(() => ({
  register: vi.fn(async (_request: unknown, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) => {
    reply.code(201).send({ data: {}, meta: {} });
  }),
  login: vi.fn(async (_request: unknown, reply: { send: (payload: unknown) => unknown }) => {
    reply.send({ data: {}, meta: {} });
  }),
  logout: vi.fn(),
  logoutAll: vi.fn(),
  listSessions: vi.fn(),
  listAuditEvents: vi.fn(),
  listUsers: vi.fn(),
  getOnboarding: vi.fn(),
  updateOnboarding: vi.fn(),
}));

vi.mock('../../../backend/api/controllers/auth', () => ({
  AuthController: routeMocks,
}));

import authRoutes from '../../../backend/api/routes/auth';

describe('auth routes security validation', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      return undefined;
    });
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects weak registration passwords before calling the controller', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'password',
        name: 'Owner',
        org_name: 'Example',
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(routeMocks.register).not.toHaveBeenCalled();
    expect(response.body).toContain('Password must include an uppercase letter');
  });

  it('allows strong registration passwords through to the controller', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        password: 'Password123!',
        name: 'Owner',
        org_name: 'Example',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(routeMocks.register).toHaveBeenCalledTimes(1);
  });
});
