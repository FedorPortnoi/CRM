import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: {
    findFirst: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({
  db: dbMock,
}));

import { enforceAuthenticatedApiRequest } from '../../../backend/api/authenticate';

type TestReply = {
  statusCode: number;
  payload: unknown;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function createReply(): TestReply {
  const reply = {
    statusCode: 200,
    payload: undefined,
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

function createRequest(method: string, url = '/api/v1/contacts') {
  return {
    url,
    method,
    user: {
      sub: '00000000-0000-4000-a000-000000000001',
      org_id: '00000000-0000-4000-a000-000000000010',
      sid: '00000000-0000-4000-a000-000000000100',
    },
    jwtVerify: vi.fn(async () => undefined),
  };
}

describe('enforceAuthenticatedApiRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$queryRaw.mockResolvedValue([{ id: '00000000-0000-4000-a000-000000000100' }]);
    dbMock.$executeRaw.mockResolvedValue(1);
  });

  it('rejects write requests for viewer users', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'viewer',
    });
    const request = createRequest('POST');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: { code: 'FORBIDDEN', message: 'Viewer users have read-only access' },
    });
  });

  it('allows read requests for viewer users', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'viewer',
    });
    const request = createRequest('GET');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.send).not.toHaveBeenCalled();
  });

  it('rejects tokens without a session id', async () => {
    const request = createRequest('GET');
    delete (request.user as { sid?: string }).sid;
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token' },
    });
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
  });

  it('rejects revoked or expired sessions', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    dbMock.$queryRaw.mockResolvedValue([]);
    const request = createRequest('GET');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'SESSION_REVOKED', message: 'Authentication session has expired or was revoked' },
    });
  });

  it('rejects member access to admin-only audit routes', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    const request = createRequest('GET', '/api/v1/auth/audit');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: { code: 'FORBIDDEN', message: 'audit access requires owner or admin' },
    });
  });

  it('allows admin access to admin-only export routes', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'admin',
    });
    const request = createRequest('POST', '/api/v1/analytics/export');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.send).not.toHaveBeenCalled();
  });
});
