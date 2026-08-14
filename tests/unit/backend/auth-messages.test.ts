import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  contact: {
    findFirst: vi.fn(),
  },
  org: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  message: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  pendingCapture: {
    create: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({
  db: dbMock,
}));

import { AuthController } from '../../../backend/api/controllers/auth';
import { MessagesController } from '../../../backend/api/controllers/messages';
import { VERIFICATION_ENFORCED_SINCE } from '../../../backend/config/security';
import * as emailService from '../../../backend/services/email';
import * as verificationService from '../../../backend/services/verification';

const orgId = '00000000-0000-4000-a000-000000000123';

type TestReply = {
  statusCode: number;
  payload: unknown;
  code: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
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
    status: vi.fn(function setStatus(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    send: vi.fn(function send(this: TestReply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
    jwtSign: vi.fn(async () => 'signed-token'),
  };

  return reply as unknown as TestReply;
}

describe('AuthController.login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$executeRaw.mockResolvedValue(1);
    dbMock.$queryRaw.mockResolvedValue([]);
    dbMock.user.update.mockResolvedValue({});
  });

  it('rejects inactive users with the generic invalid credentials envelope', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    dbMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'inactive@example.com',
      password_hash: passwordHash,
      name: 'Inactive User',
      role: 'owner',
      organization_id: orgId,
      is_active: false,
      is_verified: true,
      failed_login_count: 0,
      locked_until: null,
      onboarding_state: null,
    });
    const reply = createReply();

    await AuthController.login(
      { body: { email: 'inactive@example.com', password: 'Password123!' } } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
    });
    expect(reply.jwtSign).not.toHaveBeenCalled();
  });

  it('normalizes email before login lookup', async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    const reply = createReply();

    await AuthController.login(
      { body: { email: '  Owner@Example.COM ', password: 'Password123!' } } as never,
      reply as never,
    );

    expect(dbMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'owner@example.com' },
    });
    expect(reply.statusCode).toBe(401);
  });

  it('creates a revocable session and signs the session id into successful login tokens', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    dbMock.user.findUnique.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      email: 'owner@example.com',
      password_hash: passwordHash,
      name: 'Owner User',
      role: 'owner',
      organization_id: orgId,
      is_active: true,
      is_verified: true,
      failed_login_count: 0,
      locked_until: null,
      onboarding_state: null,
    });
    const reply = createReply();

    await AuthController.login(
      {
        body: { email: 'owner@example.com', password: 'Password123!' },
        headers: { 'user-agent': 'vitest' },
        ip: '127.0.0.1',
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.$executeRaw).toHaveBeenCalled();
    expect(reply.jwtSign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: '00000000-0000-4000-a000-000000000001',
        org_id: orgId,
        role: 'owner',
        sid: expect.any(String),
      }),
      { expiresIn: '7d' },
    );
  });

  it('lists audit events scoped to the requester organization', async () => {
    const createdAt = new Date('2026-05-23T00:00:00.000Z');
    dbMock.$queryRaw
      .mockResolvedValueOnce([{
        id: 'audit-1',
        organization_id: orgId,
        user_id: 'user-1',
        action: 'auth.login',
        outcome: 'success',
        target_type: null,
        target_id: null,
        ip_address: '127.0.0.1',
        user_agent: 'vitest',
        metadata: { email: 'owner@example.com' },
        created_at: createdAt,
      }])
      .mockResolvedValueOnce([{ total: BigInt(1) }]);
    const reply = createReply();

    await AuthController.listAuditEvents(
      {
        query: { page: 1, per_page: 50, action: 'auth.login' },
        user: { org_id: orgId, sub: 'user-1' },
        headers: { 'user-agent': 'vitest' },
        ip: '127.0.0.1',
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      data: [expect.objectContaining({
        id: 'audit-1',
        organization_id: orgId,
        action: 'auth.login',
      })],
      meta: { total: 1, page: 1, per_page: 50 },
    });
    expect(dbMock.$executeRaw).toHaveBeenCalled();
  });
});


/**
 * /auth/join IS A LOGIN DOOR, and it must ask what the other login door asks.
 *
 * It drifted: /auth/login required `is_verified`, /auth/join simply omitted it.
 * Accounts created by invite acceptance are permanently is_verified = false —
 * that flow never issued an OTP — so this door re-minted a fresh seven-day
 * session for them, forever, on an address nobody had proven.
 *
 * The two positive controls in this block are not decoration. Closing this door
 * naively locks out real people:
 *   • accounts created by AuthController.inviteUser carry is_verified: true and
 *     must never be touched — they are the ordinary employee-onboarding path;
 *   • accounts that were ALREADY unverified when the gate shipped are
 *     grandfathered by VERIFICATION_ENFORCED_SINCE, because /auth/login already
 *     refuses them and no OTP was ever mailed to them. Gating them here would
 *     take away their last working door and leave no recovery path at all.
 */
describe('AuthController.join asks the same question /auth/login asks', () => {
  const JOIN_CODE = 'ROMASHKA-7F3Q';
  const PASSWORD = 'Password123!';

  /** Well after the cutover: an account the fixed invite flow could not create. */
  const AFTER_CUTOVER = new Date('2026-09-01T12:00:00.000Z');
  /**
   * Before it, and deliberately the exact fingerprint found in the database:
   * invite-created, never verified, still using join as its only door.
   */
  const BEFORE_CUTOVER = new Date('2026-07-30T09:00:00.000Z');

  async function joinUser(overrides: Record<string, unknown>) {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    return {
      id: '00000000-0000-4000-a000-0000000000f1',
      email: 'petr@example.ru',
      username: 'petr',
      password_hash: passwordHash,
      name: 'Пётр Смирнов',
      role: 'member',
      organization_id: orgId,
      is_active: true,
      failed_login_count: 0,
      locked_until: null,
      onboarding_state: null,
      must_change_password: false,
      must_change_email: false,
      ...overrides,
    };
  }

  async function callJoin(user: Record<string, unknown>): Promise<TestReply> {
    dbMock.org.findFirst.mockResolvedValue({
      id: orgId,
      join_code_expires_at: new Date(Date.now() + 86_400_000),
    });
    dbMock.user.findFirst.mockResolvedValue(user);
    const reply = createReply();
    await AuthController.join(
      {
        body: { company_code: JOIN_CODE, username: 'petr', password: PASSWORD },
        headers: { 'user-agent': 'vitest' },
        ip: '127.0.0.1',
      } as never,
      reply as never,
    );
    return reply;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$executeRaw.mockResolvedValue(1);
    dbMock.$queryRaw.mockResolvedValue([]);
    dbMock.user.update.mockResolvedValue({});
  });

  it('refuses an unverified account with the same 403 body /auth/login sends', async () => {
    // The reference is /auth/login's ACTUAL output, not a copy of its literal:
    // a copy drifts silently the moment either message is reworded, and these
    // two have already drifted once, which is the whole reason for this file.
    dbMock.user.findUnique.mockResolvedValue(
      await joinUser({ is_verified: false, created_at: AFTER_CUTOVER }),
    );
    const loginReply = createReply();
    await AuthController.login(
      { body: { email: 'petr@example.ru', password: PASSWORD } } as never,
      loginReply as never,
    );
    expect(loginReply.statusCode).toBe(403);

    const reply = await callJoin(await joinUser({ is_verified: false, created_at: AFTER_CUTOVER }));

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual(loginReply.payload);
    expect(reply.payload).toEqual({
      error: {
        code: 'ACCOUNT_NOT_VERIFIED',
        message: 'Please verify your account via the code sent to your phone and email.',
        // Lets a killed-and-reopened app reattach to /auth/verify instead of
        // dead-ending — see the comment on this branch in controllers/auth.ts.
        // Safe to disclose: unreachable without the correct password.
        user_id: '00000000-0000-4000-a000-0000000000f1',
        email: 'petr@example.ru',
      },
    });
    // No token, and no session row either — a 403 that still signed one would
    // read as closed and behave as open.
    expect(reply.jwtSign).not.toHaveBeenCalled();
  });

  it('does not count the refusal against the lockout counter', async () => {
    // The caller typed the RIGHT password. Incrementing failed_login_count here
    // would lock a legitimate invitee out for being unverified — the wrong
    // answer twice over, and unrecoverable once /auth/login refuses them too.
    //
    // This is WHY the gate sits after verifyPasswordWithLockout rather than
    // inside its classifier: returning 'failure' from the classifier would have
    // been the one-line version of this change and would have incremented on
    // every attempt. Mirrors login's 'non_counted_failure'.
    const reply = await callJoin(await joinUser({ is_verified: false, created_at: AFTER_CUTOVER }));

    expect(reply.statusCode).toBe(403);
    const writes = dbMock.user.update.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    for (const write of writes) {
      expect(write.failed_login_count).not.toEqual({ increment: 1 });
      expect(write).not.toHaveProperty('locked_until', expect.any(Date));
    }
    // The correct password RESET the counter, which is the pre-existing
    // behaviour and must survive the new branch.
    expect(writes).toContainEqual({ failed_login_count: 0, locked_until: null });
  });

  it('still admits an account created by inviteUser, which never verifies an address', async () => {
    // AuthController.inviteUser writes is_verified: true and must_change_email:
    // true. This is the ordinary way an owner adds an employee and it must be
    // untouched — the gate narrows exactly the accounts invite ACCEPTANCE made.
    const reply = await callJoin(await joinUser({
      is_verified: true,
      must_change_email: true,
      must_change_password: true,
      created_at: AFTER_CUTOVER,
    }));

    expect(reply.statusCode).toBe(200);
    expect(reply.jwtSign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: '00000000-0000-4000-a000-0000000000f1', org_id: orgId }),
      { expiresIn: '7d' },
    );
  });

  /**
   * THE FAIL-SAFE. If this test ever goes red, the change has begun locking real
   * people out of a live CRM rather than closing a hole in it.
   */
  it('still admits an unverified account that predates the enforcement cutover', async () => {
    const reply = await callJoin(await joinUser({ is_verified: false, created_at: BEFORE_CUTOVER }));

    expect(reply.statusCode).toBe(200);
    expect(reply.jwtSign).toHaveBeenCalled();
  });

  it('pins the cutover to a literal instant, not to process start', async () => {
    // Written as `new Date()` the constant would be re-evaluated at every boot,
    // grandfather every account that exists at that moment, and leave a gate
    // that reads like a gate and refuses nobody. Asserted against a LITERAL,
    // because comparing the constant to itself would pass either way.
    expect(VERIFICATION_ENFORCED_SINCE.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });
});

describe('AuthController.setCredentials proves the address it is given', () => {
  const originalEnforce = process.env.REQUIRE_EMAIL_VERIFICATION;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$executeRaw.mockResolvedValue(1);
    dbMock.$queryRaw.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalEnforce === undefined) {
      delete process.env.REQUIRE_EMAIL_VERIFICATION;
    } else {
      process.env.REQUIRE_EMAIL_VERIFICATION = originalEnforce;
    }
    vi.restoreAllMocks();
  });

  function callSetCredentials(reply: TestReply) {
    return AuthController.setCredentials(
      {
        body: { email: 'Novy@Example.RU', new_password: 'Password123!' },
        user: { sub: 'user-1', org_id: orgId },
        headers: { 'user-agent': 'vitest' },
        ip: '127.0.0.1',
        log: { error: vi.fn() },
      } as never,
      reply as never,
    );
  }

  it('clears is_verified, issues a code and returns a pending_verification handle when the address can be proven', async () => {
    // The whole point: inviteUser mints these accounts is_verified: true so they
    // can /auth/join before they own an email. This screen is where the real
    // address is named, so it is where the proof begins — is_verified flips false
    // and an OTP goes to the address just typed. POST /auth/verify flips both
    // is_verified and email_verified back true against a code only the real
    // mailbox receives, so a typo dead-ends at the code screen instead of
    // redirecting recovery to a stranger.
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    vi.spyOn(emailService, 'isEmailSendingEnabled').mockReturnValue(true);
    const sendSpy = vi.spyOn(emailService, 'sendEmail').mockResolvedValue({ success: true, messageId: 'm1' });
    const issueSpy = vi.spyOn(verificationService, 'issueCode').mockResolvedValue('123456');

    dbMock.user.findUnique
      .mockResolvedValueOnce({ must_change_email: true })  // the entry gate
      .mockResolvedValueOnce(null);                        // no address collision
    dbMock.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'novy@example.ru',
      name: 'Пётр',
      role: 'member',
      organization_id: orgId,
    });
    const reply = createReply();

    await callSetCredentials(reply);

    expect(reply.statusCode).toBe(200);
    const written = dbMock.user.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(written.data.is_verified).toBe(false);
    expect(written.data.email_verified).toBe(false);
    expect(written.data.email).toBe('novy@example.ru');
    expect(written.data.must_change_email).toBe(false);
    expect(written.data.must_change_password).toBe(false);

    expect(issueSpy).toHaveBeenCalledWith('user-1', 'email');
    expect(sendSpy).toHaveBeenCalledWith('novy@example.ru', expect.any(String), expect.stringContaining('123456'));

    const payload = reply.payload as { data: { pending_verification?: { user_id: string; email: string } } };
    expect(payload.data.pending_verification).toEqual({ user_id: 'user-1', email: 'novy@example.ru' });
  });

  it('fails open with no mail provider: records the address unverified and skips the verification step', async () => {
    // With no way to deliver an OTP, requiring one would lock the employee out
    // for good. So the address is set, is_verified is left untouched (inviteUser's
    // true), email_verified stays honestly false, and no pending_verification is
    // returned — the client proceeds straight in, exactly as before this feature.
    vi.spyOn(emailService, 'isEmailSendingEnabled').mockReturnValue(false);
    const sendSpy = vi.spyOn(emailService, 'sendEmail');
    const issueSpy = vi.spyOn(verificationService, 'issueCode');

    dbMock.user.findUnique
      .mockResolvedValueOnce({ must_change_email: true })
      .mockResolvedValueOnce(null);
    dbMock.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'novy@example.ru',
      name: 'Пётр',
      role: 'member',
      organization_id: orgId,
    });
    const reply = createReply();

    await callSetCredentials(reply);

    expect(reply.statusCode).toBe(200);
    const written = dbMock.user.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(written.data.email_verified).toBe(false);
    expect(written.data).not.toHaveProperty('is_verified');
    expect(written.data.must_change_email).toBe(false);
    expect(written.data.must_change_password).toBe(false);

    expect(issueSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();

    const payload = reply.payload as { data: { pending_verification?: unknown } };
    expect(payload.data.pending_verification).toBeUndefined();
  });
});

describe('AuthController.setSessionPreference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$executeRaw.mockResolvedValue(1);
    dbMock.$queryRaw.mockResolvedValue([]);
  });

  function callSetSessionPreference(stayOn: boolean, reply: TestReply) {
    return AuthController.setSessionPreference(
      {
        body: { stay_signed_in: stayOn },
        user: { sub: 'user-1', org_id: orgId, role: 'member', sid: 'session-abc' },
        headers: { 'user-agent': 'vitest' },
        ip: '127.0.0.1',
      } as never,
      reply as never,
    );
  }

  it('turning it ON persists the flag and immediately re-mints the current session at the long expiry', async () => {
    // A JWT carries its own expiry baked in at mint time — flipping the DB flag
    // alone would do nothing the person tapping the switch could see until
    // their next login. So this is the one branch that returns a fresh token.
    dbMock.user.updateMany.mockResolvedValue({ count: 1 });
    const reply = createReply();

    await callSetSessionPreference(true, reply);

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', organization_id: orgId, is_active: true },
      data: { stay_signed_in: true },
    });
    // reply.jwtSign is createReply()'s stub — its call proves signSessionToken
    // actually ran, not just that a truthy token string appeared in the payload.
    expect(reply.jwtSign).toHaveBeenCalled();
    const payload = reply.payload as { data: { stay_signed_in: boolean; token?: string } };
    expect(payload.data.stay_signed_in).toBe(true);
    expect(payload.data.token).toBe('signed-token');
  });

  it('turning it OFF persists the flag but does not force a re-login', async () => {
    // The session already running keeps the expiry it was minted with. Forcing
    // a logout the instant someone unchecks the box would be a worse surprise
    // than what the setting's own description promises — only the NEXT login
    // is shorter.
    dbMock.user.updateMany.mockResolvedValue({ count: 1 });
    const reply = createReply();

    await callSetSessionPreference(false, reply);

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', organization_id: orgId, is_active: true },
      data: { stay_signed_in: false },
    });
    expect(reply.jwtSign).not.toHaveBeenCalled();
    const payload = reply.payload as { data: { stay_signed_in: boolean; token?: string } };
    expect(payload.data.stay_signed_in).toBe(false);
    expect(payload.data.token).toBeUndefined();
  });

  it('answers 404 rather than silently no-op when the row cannot be reached', async () => {
    // Mirrors setTimezone's guard: a deactivated account or a stale org_id
    // (impossible under normal auth, but not something to paper over) updates
    // zero rows, and that must surface rather than answer 200 for nothing.
    dbMock.user.updateMany.mockResolvedValue({ count: 0 });
    const reply = createReply();

    await callSetSessionPreference(true, reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.jwtSign).not.toHaveBeenCalled();
  });
});
