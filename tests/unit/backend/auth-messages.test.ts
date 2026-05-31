import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: {
    findUnique: vi.fn(),
  },
  contact: {
    findFirst: vi.fn(),
  },
  org: {
    findUnique: vi.fn(),
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

