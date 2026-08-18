/**
 * GET /auth/me and the must_change_password branch of PATCH /auth/me/password.
 *
 * Neither had a real unit test before this file — auth-routes-security.test.ts
 * only pins route REGISTRATION against a Proxy-mocked controller, never the
 * actual handler logic. That gap is how PATCH /auth/me/password shipped
 * unreachable for its one real caller: set-password.tsx (the forced
 * must_change_password/must_change_email screen) calls changePassword(newPassword)
 * with no current_password, but the handler unconditionally required one — every
 * invited member (inviteUser sets must_change_password: true) hit a 400 trying to
 * complete onboarding, with no back button off that screen. current_password is
 * now required only when the account is NOT mid a forced reset — a valid session
 * already establishes identity there, same reasoning as setCredentials/acceptInvite
 * asking nothing for the equivalent must_change_email case.
 *
 * GET /auth/me exists so the mobile boot path (src/app/index.tsx) can reconcile
 * its SecureStore-cached user against the server instead of trusting it forever —
 * without it, a server-side correction to must_change_password/must_change_email
 * never reaches an already-installed app, which is what let this exact flag stay
 * stuck on for one real account across a close-and-reopen (SecureStore is only
 * ever written by login, this refresh, or completing /set-password itself).
 *
 * Only services/db, services/audit and services/sessions are mocked, mirroring
 * auth-team-admin-authz.test.ts — bcrypt runs for real (fast: saltRounds is 4 in
 * NODE_ENV=test, see controllers/auth.ts), which is the point for this file.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const dbMock = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const auditMock = vi.hoisted(() => ({
  auditLog: vi.fn(async () => undefined),
}));

vi.mock('../../../backend/services/audit', () => auditMock);

const sessionsMock = vi.hoisted(() => ({
  createAuthSession: vi.fn(async () => 'fresh-session-id'),
  revokeAllUserSessions: vi.fn(async () => undefined),
}));

vi.mock('../../../backend/services/sessions', () => sessionsMock);

import { AuthController } from '../../../backend/api/controllers/auth';

const ORG = '00000000-0000-4000-a000-000000000001';
const USER = '00000000-0000-4000-a000-00000000000a';
const CURRENT_PASSWORD = 'Correct-Horse-1!';

type TestReply = {
  statusCode: number;
  payload: unknown;
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  jwtSign: ReturnType<typeof vi.fn>;
};

function createReply(): TestReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn(function setCode(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    send: vi.fn(function send(this: TestReply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
    jwtSign: vi.fn(async () => 'fresh-session-token'),
  };
  return reply as unknown as TestReply;
}

function createRequest(body: Record<string, unknown> = {}) {
  return {
    user: { sub: USER, org_id: ORG, role: 'member' },
    body,
    headers: { 'user-agent': 'vitest' },
    ip: '127.0.0.1',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.user.update.mockResolvedValue({ id: USER });
});

describe('GET /auth/me', () => {
  it('returns the publicUser shape for a valid session', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER, email: 'a@example.com', username: 'a', name: 'Ann', role: 'member',
      organization_id: ORG, timezone: 'Europe/Moscow', onboarding_state: { completed: true },
      must_change_password: false, must_change_email: false, manager_id: null, stay_signed_in: true,
    });
    const reply = createReply();

    await AuthController.getMe(createRequest(), reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({
      data: {
        id: USER, org_id: ORG, onboarding_completed: true,
        must_change_password: false, must_change_email: false,
      },
    });
  });

  it('answers SESSION_REVOKED, not a crash, when the row behind the token is gone', async () => {
    dbMock.user.findFirst.mockResolvedValue(null);
    const reply = createReply();

    await AuthController.getMe(createRequest(), reply as never);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.payload).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  it('never reports must_change_password/email true for an owner, whatever the row says', async () => {
    // register() is the only path that mints an owner (hardcoded 'owner'::"UserRole"),
    // so an owner is never invited — but the row's own flags went wrong at least once
    // on a real account with no confirmed root cause, so this is deliberately NOT
    // "the flag happens to be false right now": it holds even with a row insisting
    // otherwise, exactly the case that put a real owner on a screen with no way off it.
    dbMock.user.findFirst.mockResolvedValue({
      id: USER, email: 'owner@example.com', name: 'Owner', role: 'owner', organization_id: ORG,
      must_change_password: true, must_change_email: true,
    });
    const reply = createReply();

    await AuthController.getMe(createRequest(), reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({
      data: { role: 'owner', must_change_password: false, must_change_email: false },
    });
  });
});

describe('PATCH /auth/me/password', () => {
  it('lets a forced reset through with no current_password at all — the regression this file exists for', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER,
      organization_id: ORG,
      role: 'member',
      stay_signed_in: false,
      password_hash: 'irrelevant-stale-hash',
      must_change_password: true,
    });
    const reply = createReply();

    await AuthController.changePassword(
      createRequest({ new_password: 'Brand-New-1!' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: expect.objectContaining({ must_change_password: false }),
    });
    expect(sessionsMock.revokeAllUserSessions).toHaveBeenCalledWith(USER, ORG, 'password_changed');
    expect(sessionsMock.createAuthSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      organizationId: ORG,
    }));
    expect(sessionsMock.revokeAllUserSessions.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsMock.createAuthSession.mock.invocationCallOrder[0],
    );
    expect(reply.jwtSign).toHaveBeenCalledWith(
      { sub: USER, org_id: ORG, role: 'member', sid: 'fresh-session-id' },
      { expiresIn: '7d' },
    );
    expect(reply.payload).toEqual({
      data: { updated: true, token: 'fresh-session-token' },
      meta: {},
    });
  });

  it('ignores an incorrect current_password during a forced reset rather than checking it', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER,
      organization_id: ORG,
      role: 'member',
      stay_signed_in: false,
      password_hash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      must_change_password: true,
    });
    const reply = createReply();

    await AuthController.changePassword(
      createRequest({ current_password: 'definitely-wrong', new_password: 'Brand-New-1!' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalled();
  });

  it('still requires the correct current_password for a normal, already-onboarded account', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER,
      organization_id: ORG,
      role: 'member',
      stay_signed_in: true,
      password_hash: await bcrypt.hash(CURRENT_PASSWORD, 4),
      must_change_password: false,
    });
    const reply = createReply();

    await AuthController.changePassword(
      createRequest({ current_password: CURRENT_PASSWORD, new_password: 'Brand-New-1!' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalled();
    expect(reply.jwtSign).toHaveBeenCalledWith(expect.any(Object), { expiresIn: '90d' });
  });

  it('refuses a normal account that sends no current_password — no regression from the optional schema field', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      password_hash: await bcrypt.hash(CURRENT_PASSWORD, 4), must_change_password: false,
    });
    const reply = createReply();

    await AuthController.changePassword(
      createRequest({ new_password: 'Brand-New-1!' }),
      reply as never,
    );

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.payload).toMatchObject({ error: { code: 'INVALID_CURRENT_PASSWORD' } });
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  it('refuses a normal account that sends the wrong current_password', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      password_hash: await bcrypt.hash(CURRENT_PASSWORD, 4), must_change_password: false,
    });
    const reply = createReply();

    await AuthController.changePassword(
      createRequest({ current_password: 'nope', new_password: 'Brand-New-1!' }),
      reply as never,
    );

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });
});
