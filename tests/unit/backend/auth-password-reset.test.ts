/**
 * PASSWORD RECOVERY, WHICH DID NOT EXIST.
 *
 * docs/architecture/api-design.md listed `POST /auth/forgot-password` and
 * `POST /auth/reset-password` as shipped for two years while neither was ever
 * registered. `PATCH /auth/me/password` and `/auth/me/credentials` both sit
 * behind jwtVerify, so they are useless to someone locked out;
 * `POST /auth/users/invite` CREATES an account rather than resetting one; and
 * `/auth/invites/accept` answers 409 EMAIL_TAKEN at the victim's own address.
 * The remedy was a hand-written UPDATE against the production User table — psql
 * against live customer data as the standard support procedure, which is a
 * bigger risk than the lockout it fixes.
 *
 * The two properties this file exists to pin, because getting either wrong turns
 * a fix into a new hole:
 *   • forgot-password must not become an account-enumeration oracle, in the
 *     status code, in the body, OR on the clock.
 *   • the reset code must be issued on its own channel. POST /auth/verify is
 *     PUBLIC, takes a bare user_id plus a six-digit code on channel 'email', and
 *     mints a seven-day session on success — a reset code on that channel would
 *     be a password-free login for any not-yet-verified account.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const verificationMock = vi.hoisted(() => ({
  issueCode: vi.fn(async () => '123456'),
  verifyCode: vi.fn(async () => true),
}));

vi.mock('../../../backend/services/verification', () => verificationMock);

const emailMock = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  isEmailSendingEnabled: vi.fn(() => true),
}));

vi.mock('../../../backend/services/email', () => emailMock);

const auditMock = vi.hoisted(() => ({
  auditLog: vi.fn(async () => undefined),
  listAuditEvents: vi.fn(async () => ({ data: [], total: 0 })),
}));

vi.mock('../../../backend/services/audit', () => auditMock);

const sessionsMock = vi.hoisted(() => ({
  revokeAllUserSessions: vi.fn(async () => undefined),
  createAuthSession: vi.fn(async () => 'sid'),
  listActiveUserSessions: vi.fn(async () => []),
  revokeAuthSession: vi.fn(async () => undefined),
  validateAuthSession: vi.fn(async () => ({ id: 'sid' })),
}));

vi.mock('../../../backend/services/sessions', () => sessionsMock);

const rateLimitMock = vi.hoisted(() => ({
  consumeScopedBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
  consumeAuthIpBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
}));

vi.mock('../../../backend/services/rate-limit-store', () => rateLimitMock);

import { AuthController } from '../../../backend/api/controllers/auth';

const ORG = '00000000-0000-4000-a000-000000000001';
const USER = '00000000-0000-4000-a000-00000000000a';

type TestReply = { statusCode: number; payload: unknown };

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
  };
  return reply as unknown as TestReply;
}

function request(body: Record<string, unknown>) {
  return { body, headers: { 'user-agent': 'vitest' }, ip: '127.0.0.1' } as never;
}

const ACTIVE_USER = {
  id: USER,
  email: 'owner@example.ru',
  is_active: true,
  organization_id: ORG,
  is_verified: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$executeRaw.mockResolvedValue(1);
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.user.update.mockResolvedValue({});
  verificationMock.issueCode.mockResolvedValue('123456');
  verificationMock.verifyCode.mockResolvedValue(true);
  emailMock.sendEmail.mockResolvedValue({ success: true });
  emailMock.isEmailSendingEnabled.mockReturnValue(true);
  rateLimitMock.consumeScopedBudget.mockResolvedValue({ allowed: true, retryAfterSec: 1 });
});

describe('forgotPassword tells nobody whether an account exists', () => {
  it.each([
    ['a real account', ACTIVE_USER],
    ['a deactivated account', { ...ACTIVE_USER, is_active: false }],
    ['an account with no address', { ...ACTIVE_USER, email: null }],
    ['no account at all', null],
  ])('answers 202 with the same body for %s', async (_label, row) => {
    dbMock.user.findUnique.mockResolvedValue(row);
    const reply = createReply();

    await AuthController.forgotPassword(request({ email: 'owner@example.ru' }), reply as never);

    expect(reply.statusCode).toBe(202);
    // No user_id in the body. Returning one would rebuild the oracle AND hand an
    // attacker the exact input POST /auth/verify wants.
    expect(reply.payload).toEqual({ data: { sent: true }, meta: {} });
  });

  it('does not await the send, so the branches cannot be told apart by a clock', async () => {
    // Identical status and identical bytes are not enough. The hit path is a live
    // Resend round trip bounded at EMAIL_SEND_TIMEOUT_MS = 20s; the miss path is
    // one indexed SELECT. This codebase already fixed the same class of gap in
    // login, where a locked account answered in ~5ms against ~300ms for every
    // other rejection behind an identical INVALID_CREDENTIALS body.
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    emailMock.sendEmail.mockReturnValue(new Promise(() => {}) as never);

    const reply = createReply();
    await AuthController.forgotPassword(request({ email: 'owner@example.ru' }), reply as never);

    expect(reply.statusCode).toBe(202);
  });

  it('issues the code on its OWN channel, never on the one /auth/verify accepts', async () => {
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    await AuthController.forgotPassword(request({ email: 'owner@example.ru' }), createReply() as never);
    // Awaiting a microtask so the detached send has run.
    await Promise.resolve();
    await Promise.resolve();

    expect(verificationMock.issueCode).toHaveBeenCalledWith(USER, 'password_reset');
    expect(verificationMock.issueCode).not.toHaveBeenCalledWith(USER, 'email');
  });

  it('mails nothing when there is no account to mail', async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    await AuthController.forgotPassword(request({ email: 'ghost@example.ru' }), createReply() as never);
    await Promise.resolve();

    expect(verificationMock.issueCode).not.toHaveBeenCalled();
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
  });

  it('caps reset mail per ACCOUNT, not per caller address', async () => {
    // Otherwise anyone who knows a colleague's address sends unlimited reset mail
    // from rotating IPs, burning the shared Resend quota the OTP path also
    // depends on and eventually starving the person actually recovering.
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    rateLimitMock.consumeScopedBudget.mockResolvedValue({ allowed: false, retryAfterSec: 900 });

    const reply = createReply();
    await AuthController.forgotPassword(request({ email: 'owner@example.ru' }), reply as never);

    expect(rateLimitMock.consumeScopedBudget).toHaveBeenCalledWith(
      'password-reset-user', USER, expect.any(Number), expect.any(Number),
    );
    expect(verificationMock.issueCode).not.toHaveBeenCalled();
    // Still the same answer. A 429 here would be the oracle from the other end.
    expect(reply.statusCode).toBe(202);
  });
});

describe('resetPassword', () => {
  it('answers one indistinguishable 400 for every failure mode', async () => {
    const answers: TestReply[] = [];

    dbMock.user.findUnique.mockResolvedValue(null);
    const a = createReply();
    await AuthController.resetPassword(
      request({ email: 'ghost@example.ru', code: '123456', new_password: 'Mgla7#kvartira' }),
      a as never,
    );
    answers.push(a);

    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    verificationMock.verifyCode.mockResolvedValue(false);
    const b = createReply();
    await AuthController.resetPassword(
      request({ email: 'owner@example.ru', code: '000000', new_password: 'Mgla7#kvartira' }),
      b as never,
    );
    answers.push(b);

    for (const answer of answers) {
      expect(answer.statusCode).toBe(400);
      expect(answer.payload).toEqual({
        error: { code: 'INVALID_CODE', message: 'Code is invalid or has expired' },
      });
    }
  });

  it('clears the lockout as well as the password', async () => {
    // A reset that leaves failed_login_count at 11 and locked_until half an hour
    // out has changed the password and recovered nobody: verifyPasswordWithLockout
    // returns 'locked' BEFORE classifying, so even the new, correct password
    // answers INVALID_CREDENTIALS.
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    const reply = createReply();

    await AuthController.resetPassword(
      request({ email: 'owner@example.ru', code: '123456', new_password: 'Mgla7#kvartira' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    const written = dbMock.user.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.failed_login_count).toBe(0);
    expect(written.locked_until).toBeNull();
    expect(written.must_change_password).toBe(false);
    expect(written.password_hash).toEqual(expect.any(String));
  });

  it('marks the account verified, so recovery actually restores access', async () => {
    // Without this, a post-cutover unverified account completes a perfect reset
    // and /auth/login still answers 403 ACCOUNT_NOT_VERIFIED — in a body that
    // carries no user_id, which leaves POST /auth/verify/resend uninvokable and
    // the person exactly as stuck as before. A code delivered to the address on
    // file is the same proof POST /auth/verify accepts before setting this.
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    await AuthController.resetPassword(
      request({ email: 'owner@example.ru', code: '123456', new_password: 'Mgla7#kvartira' }),
      createReply() as never,
    );

    const written = dbMock.user.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written.is_verified).toBe(true);
  });

  it('revokes every session and returns NO token', async () => {
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    const reply = createReply();

    await AuthController.resetPassword(
      request({ email: 'owner@example.ru', code: '123456', new_password: 'Mgla7#kvartira' }),
      reply as never,
    );

    expect(sessionsMock.revokeAllUserSessions).toHaveBeenCalledWith(
      USER, ORG, 'credentials_changed',
    );
    // A six-digit code must not be a login primitive. The user signs in normally.
    expect(JSON.stringify(reply.payload)).not.toContain('token');
  });

  it('verifies the code on the reset channel, never on the session-minting one', async () => {
    dbMock.user.findUnique.mockResolvedValue(ACTIVE_USER);
    await AuthController.resetPassword(
      request({ email: 'owner@example.ru', code: '123456', new_password: 'Mgla7#kvartira' }),
      createReply() as never,
    );

    expect(verificationMock.verifyCode).toHaveBeenCalledWith(USER, '123456', 'password_reset');
  });
});
