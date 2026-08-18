/**
 * Opt-in TOTP two-factor authentication.
 *
 * Three properties matter more than the rest and get their own describe block:
 *   • login refuses to mint a session for a totp_enabled account until
 *     POST /auth/2fa/verify completes the second factor (see
 *     requiresTotpChallenge in controllers/auth.ts);
 *   • a backup code is SINGLE-USE. The second attempt with the identical code
 *     must fail even though the first one just succeeded — this is the one
 *     test in the file that would silently let an intercepted backup code be
 *     replayed if it ever went red;
 *   • POST /auth/2fa/verify answers the same generic 401 whatever fails
 *     (unknown user, disabled 2FA, wrong code) — no account-existence oracle
 *     on a public endpoint.
 *
 * services/totp and services/encryption run FOR REAL here — both are pure,
 * fast, and the whole point of the backup-code test is exercising their actual
 * hashing/normalization, not a stand-in for it. Only services/db, services/audit,
 * services/sessions and services/rate-limit-store are mocked, mirroring
 * tests/unit/backend/auth-messages.test.ts and auth-password-reset.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  org: {
    findFirst: vi.fn(),
  },
  totpBackupCode: {
    createMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const auditMock = vi.hoisted(() => ({
  auditLog: vi.fn(async () => undefined),
  listAuditEvents: vi.fn(async () => ({ data: [], total: 0 })),
}));

vi.mock('../../../backend/services/audit', () => auditMock);

const sessionsMock = vi.hoisted(() => ({
  createAuthSession: vi.fn(async () => 'session-id'),
  revokeAllUserSessions: vi.fn(async () => undefined),
  revokeAuthSession: vi.fn(async () => undefined),
  listActiveUserSessions: vi.fn(async () => []),
  validateAuthSession: vi.fn(async () => true),
}));

vi.mock('../../../backend/services/sessions', () => sessionsMock);

const rateLimitMock = vi.hoisted(() => ({
  consumeScopedBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
  consumeAuthIpBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
}));

vi.mock('../../../backend/services/rate-limit-store', () => rateLimitMock);

import { AuthController } from '../../../backend/api/controllers/auth';
import {
  generateTotpSecret,
  generateBackupCodes,
  hashBackupCode,
} from '../../../backend/services/totp';
import { encryptField } from '../../../backend/services/encryption';
import { authenticator } from 'otplib';

const ORG = '00000000-0000-4000-a000-000000000123';
const USER_ID = '00000000-0000-4000-a000-0000000000f1';
const PASSWORD = 'Password123!';

type TestReply = {
  statusCode: number;
  payload: unknown;
  code: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
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
    header: vi.fn(function header(this: TestReply) {
      return this;
    }),
    jwtSign: vi.fn(async () => 'signed-token'),
  };
  return reply as unknown as TestReply;
}

function request(body: Record<string, unknown>, user?: Record<string, unknown>) {
  return {
    body,
    user,
    headers: { 'user-agent': 'vitest' },
    ip: '127.0.0.1',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$executeRaw.mockResolvedValue(1);
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof dbMock) => Promise<unknown>)(dbMock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  dbMock.user.update.mockResolvedValue({});
  dbMock.totpBackupCode.createMany.mockResolvedValue({ count: 10 });
  dbMock.totpBackupCode.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.totpBackupCode.updateMany.mockResolvedValue({ count: 0 });
  rateLimitMock.consumeScopedBudget.mockResolvedValue({ allowed: true, retryAfterSec: 1 });
});

async function baseUser(overrides: Record<string, unknown> = {}) {
  const password_hash = await bcrypt.hash(PASSWORD, 4);
  return {
    id: USER_ID,
    email: 'petr@example.ru',
    username: 'petr',
    password_hash,
    name: 'Пётр Смирнов',
    role: 'member',
    organization_id: ORG,
    is_active: true,
    is_verified: true,
    failed_login_count: 0,
    locked_until: null,
    onboarding_state: null,
    manager_id: null,
    must_change_password: false,
    must_change_email: false,
    stay_signed_in: false,
    totp_enabled: false,
    totp_secret: null,
    ...overrides,
  };
}

describe('login gates on totp_enabled', () => {
  it('login returns 403 TOTP_REQUIRED when totp_enabled is true', async () => {
    dbMock.user.findUnique.mockResolvedValue(await baseUser({ totp_enabled: true }));
    const reply = createReply();

    await AuthController.login(request({ email: 'petr@example.ru', password: PASSWORD }), reply as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: {
        code: 'TOTP_REQUIRED',
        message: 'Enter your two-factor authentication code.',
        user_id: USER_ID,
      },
    });
    expect(reply.jwtSign).not.toHaveBeenCalled();
  });

  it('login does NOT require TOTP when totp_enabled is false', async () => {
    dbMock.user.findUnique.mockResolvedValue(await baseUser({ totp_enabled: false }));
    const reply = createReply();

    await AuthController.login(request({ email: 'petr@example.ru', password: PASSWORD }), reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.jwtSign).toHaveBeenCalled();
  });

});

describe('AuthController.enableTotp', () => {
  it('rejects when there is no pending secret', async () => {
    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: null, totp_enabled: false }),
    );
    const reply = createReply();

    await AuthController.enableTotp(
      request({ code: '123456' }, { sub: USER_ID, org_id: ORG }),
      reply as never,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({
      error: { code: 'TOTP_SETUP_NOT_PENDING', message: 'Call POST /auth/2fa/setup first.' },
    });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when totp is already enabled, even with a secret on file', async () => {
    const secret = generateTotpSecret();
    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: true }),
    );
    const reply = createReply();

    await AuthController.enableTotp(
      request({ code: authenticator.generate(secret) }, { sub: USER_ID, org_id: ORG }),
      reply as never,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({
      error: { code: 'TOTP_SETUP_NOT_PENDING', message: 'Call POST /auth/2fa/setup first.' },
    });
  });

  it('confirms a pending secret with a valid code and returns 10 backup codes', async () => {
    const secret = generateTotpSecret();
    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: false }),
    );
    const reply = createReply();

    await AuthController.enableTotp(
      request({ code: authenticator.generate(secret) }, { sub: USER_ID, org_id: ORG }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as { data: { backup_codes: string[] } };
    expect(payload.data.backup_codes).toHaveLength(10);
    expect(dbMock.totpBackupCode.createMany).toHaveBeenCalledTimes(1);
    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.totp_enabled', outcome: 'success' }),
    );
  });

  it('rejects a wrong code without enabling anything', async () => {
    const secret = generateTotpSecret();
    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: false }),
    );
    const reply = createReply();

    await AuthController.enableTotp(
      request({ code: '000000' }, { sub: USER_ID, org_id: ORG }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'INVALID_TOTP_CODE', message: 'That code is incorrect or has expired.' },
    });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('AuthController.disableTotp', () => {
  it('rejects a wrong password', async () => {
    dbMock.user.findUnique.mockResolvedValue(await baseUser({ totp_enabled: true }));
    const reply = createReply();

    await AuthController.disableTotp(
      request({ password: 'not-the-password' }, { sub: USER_ID, org_id: ORG }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'INVALID_PASSWORD', message: 'Password is incorrect' },
    });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it('succeeds with the right password: clears totp state and deletes backup codes', async () => {
    dbMock.user.findUnique.mockResolvedValue(await baseUser({ totp_enabled: true }));
    const reply = createReply();

    await AuthController.disableTotp(
      request({ password: PASSWORD }, { sub: USER_ID, org_id: ORG }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { totp_secret: null, totp_enabled: false, totp_confirmed_at: null },
    });
    expect(dbMock.totpBackupCode.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER_ID } });
    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.totp_disabled', outcome: 'success' }),
    );
  });
});

describe('AuthController.verifyTotp', () => {
  it('succeeds with a valid TOTP code and mints a token', async () => {
    const secret = generateTotpSecret();
    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: true }),
    );
    const reply = createReply();

    await AuthController.verifyTotp(
      request({ user_id: USER_ID, code: authenticator.generate(secret) }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.jwtSign).toHaveBeenCalled();
    const payload = reply.payload as { data: { user: { id: string }; token: string } };
    expect(payload.data.user.id).toBe(USER_ID);
    expect(payload.data.token).toBe('signed-token');
  });

  it('rejects a wrong code', async () => {
    const secret = generateTotpSecret();
    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: true }),
    );
    const reply = createReply();

    await AuthController.verifyTotp(
      request({ user_id: USER_ID, code: '000000' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'INVALID_TOTP_CODE', message: 'That code is incorrect or has expired.' },
    });
    expect(reply.jwtSign).not.toHaveBeenCalled();
  });

  it('answers the same generic 401 for an unknown user_id (no account-existence oracle)', async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    const reply = createReply();

    await AuthController.verifyTotp(
      request({ user_id: '00000000-0000-4000-a000-000000000999', code: '123456' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'INVALID_TOTP_CODE', message: 'That code is incorrect or has expired.' },
    });
  });

  /**
   * THE SINGLE MOST IMPORTANT TEST IN THIS FILE.
   *
   * A backup code that verifies twice is a standing bypass of the whole
   * second factor: anyone who ever saw one code (a shoulder-surf, a leaked
   * screenshot, a compromised password manager entry) gets unlimited logins
   * forever instead of exactly one. The mock below reproduces the real
   * updateMany's atomicity: it only flips a row whose WHERE clause
   * (user_id, code_hash, used_at: null) still matches, exactly like the
   * live "TotpBackupCode".used_at column does.
   */
  it('accepts a valid unused backup code once, then rejects the SAME code on a second attempt', async () => {
    const secret = generateTotpSecret();
    const [backupCode] = generateBackupCodes(1);
    const codeHash = hashBackupCode(backupCode);

    const backupRow = { user_id: USER_ID, code_hash: codeHash, used_at: null as Date | null };
    dbMock.totpBackupCode.updateMany.mockImplementation(async (args: {
      where: { user_id: string; code_hash: string; used_at: null };
      data: { used_at: Date };
    }) => {
      const matches =
        args.where.user_id === backupRow.user_id &&
        args.where.code_hash === backupRow.code_hash &&
        backupRow.used_at === null;
      if (matches) {
        backupRow.used_at = args.data.used_at;
        return { count: 1 };
      }
      return { count: 0 };
    });

    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: true }),
    );

    // First attempt: a wrong TOTP forces the fallback to the backup code, which matches.
    const firstReply = createReply();
    await AuthController.verifyTotp(
      request({ user_id: USER_ID, code: backupCode }),
      firstReply as never,
    );
    expect(firstReply.statusCode).toBe(200);
    expect(firstReply.jwtSign).toHaveBeenCalled();

    // Second attempt with the IDENTICAL code: the row's used_at is no longer
    // null, so the updateMany's WHERE clause matches nothing.
    const secondReply = createReply();
    await AuthController.verifyTotp(
      request({ user_id: USER_ID, code: backupCode }),
      secondReply as never,
    );

    expect(secondReply.statusCode).toBe(401);
    expect(secondReply.payload).toEqual({
      error: { code: 'INVALID_TOTP_CODE', message: 'That code is incorrect or has expired.' },
    });
    expect(secondReply.jwtSign).not.toHaveBeenCalled();
  });

  it('accepts a backup code typed lowercase with the dash omitted', async () => {
    const secret = generateTotpSecret();
    const [backupCode] = generateBackupCodes(1);
    const codeHash = hashBackupCode(backupCode);

    dbMock.totpBackupCode.updateMany.mockImplementation(async (args: {
      where: { code_hash: string };
    }) => (args.where.code_hash === codeHash ? { count: 1 } : { count: 0 }));

    dbMock.user.findUnique.mockResolvedValue(
      await baseUser({ totp_secret: encryptField(secret), totp_enabled: true }),
    );

    const typedLoose = backupCode.toLowerCase().replace('-', '');
    const reply = createReply();
    await AuthController.verifyTotp(
      request({ user_id: USER_ID, code: typedLoose }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
  });
});
