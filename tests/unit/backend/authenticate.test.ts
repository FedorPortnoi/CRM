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
      error: { code: 'FORBIDDEN', message: 'This role has read-only access' },
    });
  });

  /**
   * The gate used to read `role === 'viewer'`, so a role added later defaulted
   * to writable. accountant is the first such role: org-wide read of the money,
   * no writes. If this ever returns 200, the gate has regressed to a deny-list.
   */
  it('rejects write requests for accountant, not just viewer', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'accountant',
    });
    const request = createRequest('POST');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: { code: 'FORBIDDEN', message: 'This role has read-only access' },
    });
  });

  it('still allows writes for a sales role', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    const request = createRequest('POST');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).not.toBe(403);
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

/**
 * Every assertion above is satisfied by `reply.status(401).send(...); return;` — which does
 * NOT halt the hook chain, lets the route handler send a second response, and kills the
 * process with an uncatchable ERR_HTTP_HEADERS_SENT. The only thing that distinguishes the
 * two is what the hook RESOLVES TO, so that is what these tests assert.
 */
describe('enforceAuthenticatedApiRequest halts the hook chain on rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$queryRaw.mockResolvedValue([{ id: '00000000-0000-4000-a000-000000000100' }]);
    dbMock.$executeRaw.mockResolvedValue(1);
  });

  it('returns the reply when the token carries no session id', async () => {
    const request = createRequest('GET');
    delete (request.user as { sid?: string }).sid;
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBe(reply);
  });

  it('returns the reply when the user is inactive or gone', async () => {
    dbMock.user.findFirst.mockResolvedValue(null);
    const request = createRequest('GET');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBe(reply);
  });

  it('returns the reply when the session was revoked', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    dbMock.$queryRaw.mockResolvedValue([]);
    const request = createRequest('GET');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBe(reply);
  });

  it('returns the reply when an admin-only route is denied', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    const request = createRequest('GET', '/api/v1/auth/audit');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBe(reply);
  });

  it('returns the reply when a viewer attempts a write', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'viewer',
    });
    const request = createRequest('POST');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBe(reply);
  });

  it('resolves to undefined when the request is allowed through', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    const request = createRequest('GET');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBeUndefined();
  });
});

/**
 * The public allowlist. `jwtVerify` is the tell: an exempt route returns before it is ever
 * called, an enforced one always calls it. The negative cases are the point — they are what
 * proves the two new prefixes cannot be widened into a hole.
 */
describe('isPublicApiRoute exemptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$queryRaw.mockResolvedValue([{ id: '00000000-0000-4000-a000-000000000100' }]);
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
  });

  const exempt: [string, string][] = [
    ['GET', '/api/v1/tracking/open/AbC-123_xyz'],
    ['GET', '/api/v1/tracking/open/AbC-123_xyz.gif'],
    ['GET', '/api/v1/tracking/open/AbC-123_xyz?utm=mail'],
    ['GET', '/api/v1/consent/unsubscribe/AbC-123_xyz'],
    ['POST', '/api/v1/consent/unsubscribe/AbC-123_xyz'],
  ];

  it.each(exempt)('%s %s is public', async (method, url) => {
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(request.jwtVerify).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  const enforced: [string, string][] = [
    // No token segment: apiPath() strips the trailing slash, so the prefix no longer matches.
    ['GET', '/api/v1/tracking/open/'],
    ['GET', '/api/v1/tracking/open'],
    // Only GET is exempt on the pixel; Fastify auto-exposes HEAD, which stays authenticated.
    ['HEAD', '/api/v1/tracking/open/AbC-123_xyz'],
    ['POST', '/api/v1/tracking/open/AbC-123_xyz'],
    // A neighbouring path that merely starts with the same words is not the pixel route.
    ['GET', '/api/v1/tracking/opens/AbC-123_xyz'],
    ['GET', '/api/v1/tracking'],
    // The authenticated consent routes must never be caught by the unsubscribe prefix.
    ['GET', '/api/v1/consent/contacts/00000000-0000-4000-a000-000000000002'],
    ['POST', '/api/v1/consent/contacts/00000000-0000-4000-a000-000000000002'],
    ['DELETE', '/api/v1/consent/unsubscribe/AbC-123_xyz'],
    ['GET', '/api/v1/consent/unsubscribe'],
    // The features this wiring registered are authenticated, all of them.
    ['GET', '/api/v1/assistant/status'],
    ['POST', '/api/v1/assistant/messages'],
    ['POST', '/api/v1/ai/contacts/autofill'],
    ['GET', '/api/v1/sequences'],
    ['GET', '/api/v1/email-templates'],
  ];

  it.each(enforced)('%s %s still requires a JWT', async (method, url) => {
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(request.jwtVerify).toHaveBeenCalled();
  });
});
