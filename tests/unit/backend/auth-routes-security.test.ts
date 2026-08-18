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
  // Must actually SEND, or app.inject() hangs until the 5s test timeout: the
  // Proxy fallback below hands back a bare vi.fn() that resolves undefined and
  // never answers the request.
  forgotPassword: vi.fn(async (_request: unknown, reply: { code: (s: number) => { send: (p: unknown) => unknown } }) => {
    reply.code(202).send({ data: { sent: true }, meta: {} });
  }),
  resetPassword: vi.fn(async (_request: unknown, reply: { code: (s: number) => { send: (p: unknown) => unknown } }) => {
    reply.code(200).send({ data: { reset: true }, meta: {} });
  }),
  setupTotp: vi.fn(async (_request: unknown, reply: { send: (p: unknown) => unknown }) => {
    reply.send({ data: { secret: 'x', qr_code: 'data:image/png;base64,', otpauth_url: 'otpauth://totp/x' }, meta: {} });
  }),
  enableTotp: vi.fn(async (_request: unknown, reply: { send: (p: unknown) => unknown }) => {
    reply.send({ data: { backup_codes: [] }, meta: {} });
  }),
  disableTotp: vi.fn(async (_request: unknown, reply: { send: (p: unknown) => unknown }) => {
    reply.send({ data: {}, meta: {} });
  }),
  regenerateBackupCodes: vi.fn(async (_request: unknown, reply: { send: (p: unknown) => unknown }) => {
    reply.send({ data: { backup_codes: [] }, meta: {} });
  }),
  verifyTotp: vi.fn(async (_request: unknown, reply: { send: (p: unknown) => unknown }) => {
    reply.send({ data: { user: {}, token: 'x' }, meta: {} });
  }),
  getMe: vi.fn(async (_request: unknown, reply: { send: (p: unknown) => unknown }) => {
    reply.send({ data: {}, meta: {} });
  }),
}));

/** The invite plugin's own controller — /auth/invites/accept is registered from it. */
const inviteMocks = vi.hoisted(() => ({
  accept: vi.fn(async (_request: unknown, reply: { code: (s: number) => { send: (p: unknown) => unknown } }) => {
    reply.code(200).send({ data: {}, meta: {} });
  }),
}));

vi.mock('../../../backend/api/controllers/invites', () => ({
  InviteController: new Proxy(inviteMocks as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop] = vi.fn();
      }
      return target[prop];
    },
  }),
}));

/**
 * The durable rate-limit store, stubbed.
 *
 * Every public auth route now carries `onRequest: enforceAuthIpFloor`, which
 * calls consumeAuthIpBudget → Postgres. This file mocks the controller but not
 * the database, so without this the floor reaches a real Prisma client, fails
 * closed by design, and turns the 201 assertion below into a 500 — a red suite
 * that has nothing to do with what it is testing. Stubbed as a resolved VALUE,
 * not a `…Once`, because a single request now spends two budgets (the shared
 * per-IP floor, then the route's own bucket through the store).
 */
vi.mock('../../../backend/services/rate-limit-store', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../backend/services/rate-limit-store')
  >();
  return {
    ...actual,
    consumeAuthIpBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
    consumeScopedBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
    // Route-level `store:` still points at the real class; swap it for one that
    // never touches a database so route registration keeps working.
    PostgresRateLimitStore: class {
      incr(_key: string, cb: (e: Error | null, r: { current: number; ttl: number }) => void) {
        cb(null, { current: 1, ttl: 900_000 });
      }

      child() {
        return this;
      }
    },
  };
});

vi.mock('../../../backend/api/controllers/auth', () => ({
  // Any handler not explicitly mocked above gets a plain vi.fn(), so newly
  // added routes don't break registration in this test.
  AuthController: new Proxy(routeMocks as Record<PropertyKey, unknown>, {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop] = vi.fn();
      }
      return target[prop];
    },
  }),
}));

import authRoutes from '../../../backend/api/routes/auth';
import { consumeAuthIpBudget } from '../../../backend/services/rate-limit-store';

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
        // WAS 'Password123!', which the blocklist now refuses. This case has
        // never been about strength — it needed a string that parsed.
        password: 'Mgla7#kvartira',
        name: 'Owner',
        org_name: 'Example',
        phone: '+15551234567',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(routeMocks.register).toHaveBeenCalledTimes(1);
  });

  /**
   * THE BLOCKLIST REACHES EVERY PATH THAT SETS A PASSWORD, not just register.
   *
   * All four reference the one PasswordSchema object, which is exactly why the
   * list was added there — but "they share an object" is an implementation
   * detail, and this asserts the property instead. `not.toHaveBeenCalled()` is
   * the load-bearing half: a 400 alone would also be satisfied by a controller
   * that ran, did work, and then declined.
   */
  it.each([
    ['register', 'POST', '/auth/', 'register', { email: 'a@b.ru', name: 'A', org_name: 'B', phone: '+15551234567' }, 'password'],
    ['invite accept', 'POST', '/auth/invites/accept', 'accept', { accept_token: 'x'.repeat(24), phone: '+79001234567', email: 'a@b.ru' }, 'password'],
    ['set credentials', 'PATCH', '/auth/me/credentials', 'setCredentials', { email: 'a@b.ru' }, 'new_password'],
    ['change password', 'PATCH', '/auth/me/password', 'changePassword', { current_password: 'whatever' }, 'new_password'],
    ['password reset', 'POST', '/auth/reset-password', 'resetPassword', { email: 'a@b.ru', code: '123456' }, 'new_password'],
  ])('refuses Password1! on %s before the controller runs', async (
    _label, method, url, handler, body, field,
  ) => {
    const response = await app.inject({
      method: method as 'POST' | 'PATCH',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...body, [field]: 'Password1!' }),
    });

    expect(response.statusCode).toBe(400);
    const spies = { ...routeMocks, ...inviteMocks } as Record<string, unknown>;
    expect(spies[handler]).not.toHaveBeenCalled();
  });

  /**
   * Regression test for the gap fixed 2026-08-17: enforceAuthIpFloor used to
   * run as `preHandler`, which Fastify only invokes AFTER schema validation
   * succeeds. A malformed body never reached it, so a flood of invalid
   * `/auth/login` bodies was completely unmetered — cheaper per request than a
   * real attempt, and invisible to every rate limiter in this file. It is now
   * `onRequest`, which runs before body validation (and before parsing), so
   * the floor is spent regardless of whether the body turns out to be valid.
   */
  it('spends the per-IP floor even when the request body fails schema validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'not-an-email', password: '' }),
    });

    expect(response.statusCode).toBe(400);
    expect(routeMocks.login).not.toHaveBeenCalled();
    expect(consumeAuthIpBudget).toHaveBeenCalledTimes(1);
  });
});

/**
 * Password recovery, which did not exist.
 *
 * These two routes are the only way back in for a user who forgets their
 * password: /auth/me/password and /auth/me/credentials both sit behind
 * jwtVerify, and /auth/invites/accept answers 409 EMAIL_TAKEN at the victim's
 * own address. The remedy used to be a hand-written UPDATE against the
 * production database.
 */
describe('password recovery routes', () => {
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

  it.each([
    ['POST', '/auth/forgot-password', { email: 'owner@example.com' }],
    ['POST', '/auth/reset-password', { email: 'owner@example.com', code: '123456', new_password: 'Mgla7#kvartira' }],
  ])('%s %s is registered and reaches its handler', async (method, url, payload) => {
    const response = await app.inject({
      method: method as 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    // 404 was the answer for the whole life of this product; the block below
    // used to assert it. Anything but 404 means the route exists.
    expect(response.statusCode).not.toBe(404);
  });

  it('rejects a six-digit code that is not six digits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        code: 'abcdef',
        new_password: 'Mgla7#kvartira',
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('applies the 72-BYTE cap, not a character count, to the new password', async () => {
    // 37 Cyrillic characters = 74 bytes. A hand-rolled `.max(100)` on the new
    // schema would let this through and bcrypt would silently ignore the tail —
    // the exact defect PasswordSchema's byte cap exists to prevent, on the one
    // path a locked-out user reaches.
    const value = `${'Пароль'.repeat(6)}aB1!`;
    expect(Buffer.byteLength(value, 'utf8')).toBeGreaterThan(72);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'owner@example.com',
        code: '123456',
        new_password: value,
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('72');
  });
});

/**
 * Two-factor authentication (TOTP) routes.
 *
 * This file cannot exercise the public/authenticated split — that is
 * authenticate.test.ts's job, since this app registers authRoutes directly
 * with no global preHandler. What belongs here is what always belonged here:
 * that all five routes are actually wired up, and that each Zod body schema
 * rejects a malformed request BEFORE the (mocked) controller ever runs.
 */
describe('two-factor authentication routes', () => {
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

  it.each([
    ['POST', '/auth/2fa/setup', {}],
    ['POST', '/auth/2fa/enable', { code: '123456' }],
    ['POST', '/auth/2fa/disable', { password: 'whatever' }],
    ['POST', '/auth/2fa/backup-codes/regenerate', { password: 'whatever' }],
    ['POST', '/auth/2fa/verify', { user_id: '00000000-0000-4000-a000-000000000001', code: '123456' }],
  ])('%s %s is registered and reaches its handler', async (method, url, payload) => {
    const response = await app.inject({
      method: method as 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(response.statusCode).not.toBe(404);
  });

  it('rejects an empty body on /2fa/enable before the controller runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/enable',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    expect(routeMocks.enableTotp).not.toHaveBeenCalled();
  });

  it.each([
    ['/auth/2fa/disable', 'disableTotp'],
    ['/auth/2fa/backup-codes/regenerate', 'regenerateBackupCodes'],
  ])('rejects an empty body on %s before the controller runs', async (url, handler) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
    expect((routeMocks as Record<string, unknown>)[handler]).not.toHaveBeenCalled();
  });

  it('rejects /2fa/verify with a non-uuid user_id before the controller runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ user_id: 'not-a-uuid', code: '123456' }),
    });

    expect(response.statusCode).toBe(400);
    expect(routeMocks.verifyTotp).not.toHaveBeenCalled();
  });

  it('rejects /2fa/verify with a code shorter than a backup code before the controller runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/verify',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ user_id: '00000000-0000-4000-a000-000000000001', code: '12' }),
    });

    expect(response.statusCode).toBe(400);
    expect(routeMocks.verifyTotp).not.toHaveBeenCalled();
  });
});

/**
 * Auth routes this product deliberately does NOT have.
 *
 * Every path below is recorded under "Known Gaps" in docs/architecture/api-design.md,
 * which listed several of them as shipped for two years while none of them existed.
 *
 * IF ONE OF THESE STOPS RETURNING 404, the Known Gaps section is stale and must be
 * corrected in the same commit that adds the route. That is the whole point of the test:
 * the doc drifted precisely because nothing mechanical ever read it.
 *
 * `POST /auth/forgot-password` and `POST /auth/reset-password` USED TO BE IN THIS TABLE
 * and have been removed because they now exist. Their Known Gaps entry was rewritten in
 * the same change rather than deleted — reset-by-email does not reach invited members
 * whose `User.email` is still NULL — and the two positive assertions below are what stop
 * the routes from silently disappearing again.
 *
 * The controller is Proxy-mocked above, so a genuinely new route registers fine and fails
 * here on its status code rather than on a missing handler — the failure names the drift.
 */
describe('auth routes that are deliberately absent', () => {
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

  it.each([
    // No app refresh tokens: login returns an access token only. Every `refresh_token`
    // in the repo belongs to amoCRM or Yandex Calendar OAuth.
    ['POST', '/auth/refresh'],
    // No generic profile WRITE route — only narrow, single-purpose PATCH /me/* routes.
    // GET /auth/me (below, registered) is the one generic read, added so the mobile
    // boot path can reconcile its cached user snapshot against the server instead of
    // trusting SecureStore indefinitely — see AuthController.getMe.
    ['PATCH', '/auth/me'],
    // No single-member read; only GET /auth/users.
    ['GET', '/auth/users/00000000-0000-4000-a000-000000000001'],
  ])('%s %s is not registered', async (method, url) => {
    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PATCH',
      url,
      headers: { 'content-type': 'application/json' },
      payload: method === 'GET' ? undefined : JSON.stringify({}),
    });

    expect(response.statusCode).toBe(404);
  });

  it('does register the four narrow /me routes the absent ones are confused with', async () => {
    for (const url of ['/auth/me/password', '/auth/me/credentials', '/auth/me/timezone', '/auth/me/session-preference']) {
      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });

      // 400 (schema rejected the empty body), never 404 — the route is there.
      expect(response.statusCode).not.toBe(404);
    }
  });

  it('does register GET /auth/me, the one generic read', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { 'content-type': 'application/json' },
    });

    // Reaches the (mocked) handler rather than 404ing at the router — the route is there.
    expect(response.statusCode).not.toBe(404);
  });
});
