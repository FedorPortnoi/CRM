/**
 * POST /auth/me/delete — self-service account deletion.
 *
 * What must hold, per the handler's contract:
 *  - password re-auth: wrong password or a vanished row answers 401 and writes
 *    NOTHING — the DUMMY_HASH branch must not be distinguishable by side effects;
 *  - the owner is refused (409) while any other active account exists in the
 *    org, and the refusal is audited as denied;
 *  - a sole owner may delete — that path is the App Store 5.1.1(v) requirement;
 *  - success is scrub-and-close, not row deletion: PII fields cleared,
 *    is_active false, sessions revoked as 'account_deleted', personal tables
 *    purged, invite name scrubbed, API keys revoked.
 *
 * Only services/db, services/audit and services/sessions are mocked, mirroring
 * auth-me-and-change-password.test.ts — bcrypt runs for real (saltRounds is 4
 * under NODE_ENV=test).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const dbMock = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  totpBackupCode: { deleteMany: vi.fn() },
  pushDevice: { deleteMany: vi.fn() },
  userCalendarSync: { deleteMany: vi.fn() },
  verificationCode: { deleteMany: vi.fn() },
  notification: { deleteMany: vi.fn() },
  taskReminder: { deleteMany: vi.fn() },
  invite: { updateMany: vi.fn() },
  apiKey: { updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const auditMock = vi.hoisted(() => ({
  auditLog: vi.fn(async () => undefined),
  listAuditEvents: vi.fn(),
}));

vi.mock('../../../backend/services/audit', () => auditMock);

const sessionsMock = vi.hoisted(() => ({
  createAuthSession: vi.fn(async () => 'fresh-session-id'),
  listActiveUserSessions: vi.fn(async () => []),
  revokeAllUserSessions: vi.fn(async () => undefined),
  revokeAuthSession: vi.fn(async () => undefined),
}));

vi.mock('../../../backend/services/sessions', () => sessionsMock);

import { AuthController } from '../../../backend/api/controllers/auth';

const ORG = '00000000-0000-4000-a000-000000000001';
const USER = '00000000-0000-4000-a000-00000000000a';
const PASSWORD = 'Correct-Horse-1!';

type TestReply = {
  statusCode: number;
  payload: unknown;
  code: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
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
  };
  return reply as unknown as TestReply;
}

function createRequest(body: Record<string, unknown> = {}, role = 'member') {
  return {
    user: { sub: USER, org_id: ORG, role },
    body,
    headers: { 'user-agent': 'vitest' },
    ip: '127.0.0.1',
  } as never;
}

function userRow(role: string) {
  return {
    id: USER,
    organization_id: ORG,
    role,
    password_hash: bcrypt.hashSync(PASSWORD, 4),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.user.update.mockResolvedValue({ id: USER });
  dbMock.user.updateMany.mockResolvedValue({ count: 0 });
  dbMock.totpBackupCode.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.pushDevice.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.userCalendarSync.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.verificationCode.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.notification.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.taskReminder.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.invite.updateMany.mockResolvedValue({ count: 0 });
  dbMock.apiKey.updateMany.mockResolvedValue({ count: 0 });
});

describe('POST /auth/me/delete', () => {
  it('answers 401 on a wrong password and writes nothing', async () => {
    dbMock.user.findFirst.mockResolvedValue(userRow('member'));
    const reply = createReply();

    await AuthController.deleteAccount(createRequest({ password: 'not-the-password' }), reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.payload as { error: { code: string } }).error.code).toBe('INVALID_PASSWORD');
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(sessionsMock.revokeAllUserSessions).not.toHaveBeenCalled();
  });

  it('answers the same 401 when the row behind the token is gone', async () => {
    dbMock.user.findFirst.mockResolvedValue(null);
    const reply = createReply();

    await AuthController.deleteAccount(createRequest({ password: PASSWORD }), reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.payload as { error: { code: string } }).error.code).toBe('INVALID_PASSWORD');
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the owner while other active accounts exist, and audits the denial', async () => {
    dbMock.user.findFirst.mockResolvedValue(userRow('owner'));
    dbMock.user.count.mockResolvedValue(3);
    const reply = createReply();

    await AuthController.deleteAccount(createRequest({ password: PASSWORD }, 'owner'), reply as never);

    expect(reply.statusCode).toBe(409);
    expect((reply.payload as { error: { code: string } }).error.code).toBe('OWNER_HAS_ACTIVE_MEMBERS');
    expect(dbMock.user.count).toHaveBeenCalledWith({
      where: { organization_id: ORG, is_active: true, id: { not: USER } },
    });
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.delete_account', outcome: 'denied' }),
    );
  });

  it('lets a sole owner delete the account', async () => {
    dbMock.user.findFirst.mockResolvedValue(userRow('owner'));
    dbMock.user.count.mockResolvedValue(0);
    const reply = createReply();

    await AuthController.deleteAccount(createRequest({ password: PASSWORD }, 'owner'), reply as never);

    expect(reply.statusCode).toBe(200);
    expect((reply.payload as { data: { deleted: boolean } }).data.deleted).toBe(true);
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('scrubs the row, purges personal tables, revokes sessions and audits on success', async () => {
    dbMock.user.findFirst.mockResolvedValue(userRow('member'));
    const reply = createReply();

    await AuthController.deleteAccount(createRequest({ password: PASSWORD }), reply as never);

    expect(reply.statusCode).toBe(200);
    // A member never triggers the owner guard's count query.
    expect(dbMock.user.count).not.toHaveBeenCalled();

    expect(dbMock.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: expect.objectContaining({
        name: 'Удалённый пользователь',
        email: null,
        username: null,
        phone: null,
        avatar_url: null,
        push_token: null,
        is_active: false,
        is_verified: false,
        totp_secret: null,
        totp_enabled: false,
        stay_signed_in: false,
        manager_id: null,
      }),
    });
    // The replacement hash must not verify the old password.
    const newHash = (dbMock.user.update.mock.calls[0][0] as { data: { password_hash: string } }).data.password_hash;
    expect(bcrypt.compareSync(PASSWORD, newHash)).toBe(false);

    expect(dbMock.user.updateMany).toHaveBeenCalledWith({
      where: { organization_id: ORG, manager_id: USER },
      data: { manager_id: null },
    });
    expect(dbMock.totpBackupCode.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } });
    expect(dbMock.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } });
    expect(dbMock.userCalendarSync.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } });
    expect(dbMock.verificationCode.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } });
    expect(dbMock.notification.deleteMany).toHaveBeenCalledWith({ where: { recipient_id: USER } });
    expect(dbMock.taskReminder.deleteMany).toHaveBeenCalledWith({ where: { recipient_id: USER } });
    expect(dbMock.invite.updateMany).toHaveBeenCalledWith({
      where: { user_id: USER },
      data: { name: 'Удалённый пользователь' },
    });
    expect(dbMock.apiKey.updateMany).toHaveBeenCalledWith({
      where: { organization_id: ORG, created_by: USER, revoked_at: null },
      data: { revoked_at: expect.any(Date) },
    });

    expect(sessionsMock.revokeAllUserSessions).toHaveBeenCalledWith(USER, ORG, 'account_deleted');
    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.delete_account', outcome: 'success' }),
    );
  });
});
