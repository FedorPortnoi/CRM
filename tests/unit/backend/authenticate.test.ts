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
import { VERIFICATION_ENFORCED_SINCE } from '../../../backend/config/security';

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

// `headers` and `ip` are load-bearing, not decoration: auditLog() calls
// extractClientInfo(request), which reads request.headers['user-agent']. Without them it
// throws, auditLog swallows the error, and NO row is written — so an audit assertion would
// fail for a reason that has nothing to do with the gate under test.
function createRequest(method: string, url = '/api/v1/contacts') {
  return {
    url,
    method,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'vitest' },
    user: {
      sub: '00000000-0000-4000-a000-000000000001',
      org_id: '00000000-0000-4000-a000-000000000010',
      sid: '00000000-0000-4000-a000-000000000100',
    },
    jwtVerify: vi.fn(async () => undefined),
  };
}

/**
 * The audit rows written during a request. `$executeRaw` is NOT audit-only — validateAuthSession
 * touches AuthSession.last_seen_at through the same mock, so indexing calls[0] reads the session
 * touch and asserting "not called at all" fails on every allowed request. Match the statement.
 *
 * auditLog() uses a tagged template, so a call is (templateStrings, ...interpolatedValues);
 * the values are what actually reach the column, which is what these assertions care about.
 */
function auditRowValues(): unknown[][] {
  return dbMock.$executeRaw.mock.calls
    .filter((call) => String((call[0] as string[] | undefined)?.[0] ?? '').includes('"AuditEvent"'))
    .map((call) => call.slice(1));
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

  it.each([
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/logout-all'],
    ['PATCH', '/api/v1/auth/me/password'],
    ['PATCH', '/api/v1/auth/me/credentials'],
    ['PATCH', '/api/v1/auth/me/timezone'],
    ['PATCH', '/api/v1/auth/me/session-preference'],
  ])('allows a read-only user to maintain their own account: %s %s', async (method, url) => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'viewer',
    });
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.send).not.toHaveBeenCalled();
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

  it.each([
    ['GET', '/api/v1/amocrm/status'],
    ['POST', '/api/v1/amocrm/reconcile'],
  ])('rejects non-admin amoCRM access: %s %s', async (method, url) => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'managing the amoCRM integration requires owner or admin',
      },
    });
  });

  /**
   * THE LOAD-BEARING ONE. `sequences.manage_admin` MUST stay in ACTION_CAPABILITY: an
   * unmapped action falls back to `org.manage`, which marketer does not hold, and every
   * live marketer would be 403'd off the entire marketing product — the one surface that
   * is their job. That failure is typecheck-clean and invisible to every other test, so
   * this is the only thing standing between a missing table row and an outage.
   */
  it.each([
    ['GET', '/api/v1/sequences'],
    ['POST', '/api/v1/sequences'],
    ['PATCH', '/api/v1/sequences/00000000-0000-4000-a000-000000000021'],
    ['POST', '/api/v1/sequences/00000000-0000-4000-a000-000000000021/enrollments/bulk'],
  ])('lets marketer through the sequences surface: %s %s', async (method, url) => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'marketer',
    });
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.send).not.toHaveBeenCalled();
    expect(auditRowValues()).toHaveLength(0);
  });

  /**
   * The hole this entry closes. Asserting only the 403 proves nothing — the controller
   * already returned one, silently. The audit ROW is the whole point.
   */
  it('audits the denial when a role without sequences.manage hits the surface', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'support',
    });
    const request = createRequest('GET', '/api/v1/sequences?status=active');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(403);
    // Byte-identical to SEQUENCE_ADMIN_DENIAL_MESSAGE in controllers/sequences.ts. The gate
    // moved earlier in the pipeline; the body a client sees did not change.
    expect(reply.payload).toEqual({
      error: { code: 'FORBIDDEN', message: 'Only owner or admin can manage email sequences' },
    });

    const rows = auditRowValues();
    expect(rows).toHaveLength(1);
    const values = rows[0];
    expect(values).toContain('sequences.manage_admin');
    expect(values).toContain('denied');
    const metadata = JSON.parse(values.find((v) => typeof v === 'string' && v.startsWith('{')) as string);
    expect(metadata).toMatchObject({
      method: 'GET',
      path: '/api/v1/sequences',
      role: 'support',
    });
  });

  it.each([
    ['GET', '/api/v1/sequences'],
    ['POST', '/api/v1/sequences'],
    ['GET', '/api/v1/sequences/00000000-0000-4000-a000-000000000021'],
    ['PATCH', '/api/v1/sequences/00000000-0000-4000-a000-000000000021'],
    ['POST', '/api/v1/sequences/00000000-0000-4000-a000-000000000021/enrollments/bulk'],
    ['DELETE', '/api/v1/sequences/00000000-0000-4000-a000-000000000021/steps/00000000-0000-4000-a000-000000000031'],
  ])('denies and audits the whole sequences surface for member: %s %s', async (method, url) => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'member',
    });
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(auditRowValues()).toEqual([expect.arrayContaining(['sequences.manage_admin', 'denied'])]);
  });

  /**
   * The one client-visible diff in this change, pinned deliberately rather than discovered
   * later: the policy branch runs BEFORE the read-only gate, so accountant and viewer now
   * get the sequences message instead of 'This role has read-only access' on a write here.
   * Same 403, same FORBIDDEN code, and now an audit row where there was none.
   */
  it.each(['accountant', 'viewer'])(
    'gives %s the sequences message, not the read-only one, on a sequences write',
    async (role) => {
      dbMock.user.findFirst.mockResolvedValue({
        id: '00000000-0000-4000-a000-000000000001',
        organization_id: '00000000-0000-4000-a000-000000000010',
        role,
      });
      const request = createRequest('POST', '/api/v1/sequences');
      const reply = createReply();

      await enforceAuthenticatedApiRequest(request as never, reply as never);

      expect(reply.statusCode).toBe(403);
      expect(reply.payload).toEqual({
        error: { code: 'FORBIDDEN', message: 'Only owner or admin can manage email sequences' },
      });
      expect(auditRowValues()).toEqual([expect.arrayContaining(['sequences.manage_admin', 'denied'])]);
    },
  );

  /**
   * The guard rails on the path match. A later "simplification" to a bare
   * startsWith('/api/v1/sequences') passes every test above and breaks these.
   *
   * The consent case is the expensive one: withdrawal must remain possible at any moment
   * (ФЗ-38 art. 18), so it must never acquire a capability gate. email-templates reads are
   * open to any org member by design even though its MUTATIONS share this capability.
   */
  it.each([
    // ФЗ-38 art. 18 — refusal at any moment. support holds no sequences.manage.
    ['support', 'DELETE', '/api/v1/consent/contacts/00000000-0000-4000-a000-000000000002'],
    ['member', 'GET', '/api/v1/email-templates'],
    // A neighbouring mount that merely starts with the same word is not this surface.
    ['member', 'GET', '/api/v1/sequences-archive'],
  ])('the sequences policy does not reach %s %s %s', async (role, method, url) => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role,
    });
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(reply.send).not.toHaveBeenCalled();
  });

  it('allows a task-capable role to change a visible task reminder', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'support',
    });
    const request = createRequest(
      'POST',
      '/api/v1/tasks/00000000-0000-4000-a000-000000000011/reminders',
    );
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

  it('returns the reply when the sequences surface is denied', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'support',
    });
    const request = createRequest('GET', '/api/v1/sequences');
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
    ['GET', '/api/v1/amocrm/callback?code=one-time&state=signed'],
    ['POST', '/api/v1/integrations/amocrm/webhook?amocrm_token=secret'],
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
    ['POST', '/api/v1/amocrm/callback'],
    ['GET', '/api/v1/integrations/amocrm/webhook'],
  ];

  it.each(enforced)('%s %s still requires a JWT', async (method, url) => {
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(request.jwtVerify).toHaveBeenCalled();
  });
});

/**
 * The `/auth` prefix is NOT blanket-public — and this is the only place that says so
 * mechanically.
 *
 * docs/architecture/api-design.md claimed, from the Sprint-0 spec until it was reconciled,
 * that every endpoint needs a bearer token "except /auth/*". That is inverted for 17 of
 * the 25 auth routes, and it is the one documentation drift with a security consequence:
 * an engineer or agent reconciling THIS file against that sentence would "fix" the
 * disagreement in the wrong direction — widening isPublicApiRoute() to a
 * `path.startsWith('/api/v1/auth')` match — and in one edit unauthenticate the whole
 * organization audit log, the member roster with roles, the join code that /auth/join
 * accepts, and the role-change route. Nothing has done it; the document is what would have
 * justified it in review.
 *
 * The document now names this file as the authority and lists the eight exceptions as a
 * summary of it. That prose can drift again the moment a public route is added, so the
 * table below is the half that cannot: the eight public paths are pinned by exact
 * path AND method, and their sensitive siblings are pinned as enforced. A prefix-match
 * rewrite passes neither.
 */
describe('the /auth prefix is not blanket-public', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$queryRaw.mockResolvedValue([{ id: '00000000-0000-4000-a000-000000000100' }]);
    dbMock.user.findFirst.mockResolvedValue({
      id: '00000000-0000-4000-a000-000000000001',
      organization_id: '00000000-0000-4000-a000-000000000010',
      role: 'owner',
    });
  });

  // Exactly the eight in isPublicApiRoute(), and exactly the eight the document lists.
  // Registration is reachable without a token by a second route as well — the hook's own
  // guard is `startsWith('/api/v1/')` WITH the trailing slash, and '/api/v1/auth' has
  // none — but it is on the allowlist regardless, so the entry is not load-bearing twice.
  const publicAuthRoutes: [string, string][] = [
    ['POST', '/api/v1/auth'],
    ['POST', '/api/v1/auth/login'],
    ['POST', '/api/v1/auth/join'],
    ['POST', '/api/v1/auth/verify'],
    ['POST', '/api/v1/auth/verify/resend'],
    ['POST', '/api/v1/auth/invites/open'],
    ['POST', '/api/v1/auth/invites/lookup'],
    ['POST', '/api/v1/auth/invites/accept'],
  ];

  it.each(publicAuthRoutes)('%s %s is public', async (method, url) => {
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(request.jwtVerify).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  const enforcedAuthRoutes: [string, string][] = [
    // What a prefix match would give away, in descending order of how bad it is.
    ['PATCH', '/api/v1/auth/users/00000000-0000-4000-a000-000000000002/role'],
    ['GET', '/api/v1/auth/audit'],
    ['GET', '/api/v1/auth/users'],
    ['GET', '/api/v1/auth/company-code'],
    ['POST', '/api/v1/auth/company-code/rotate'],
    ['PATCH', '/api/v1/auth/users/00000000-0000-4000-a000-000000000002/deactivate'],
    ['PATCH', '/api/v1/auth/me/password'],
    ['PATCH', '/api/v1/auth/me/credentials'],
    ['GET', '/api/v1/auth/sessions'],
    ['GET', '/api/v1/auth/invites'],
    ['POST', '/api/v1/auth/invites'],
    // The allowlist is keyed on method too: the public entries above are POST-only.
    ['GET', '/api/v1/auth/login'],
    ['GET', '/api/v1/auth/invites/open'],
    ['PATCH', '/api/v1/auth/join'],
    // A path that merely begins with a public one is not that route.
    ['POST', '/api/v1/auth/verify/resend/again'],
    ['POST', '/api/v1/auth/logins'],
  ];

  it.each(enforcedAuthRoutes)('%s %s still requires a JWT', async (method, url) => {
    const request = createRequest(method, url);
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    expect(request.jwtVerify).toHaveBeenCalled();
  });
});

/**
 * IDENTITY, RE-ASKED ON EVERY REQUEST.
 *
 * This hook already re-read is_active, org membership, the live role and the live
 * session â€” a token is a claim about the past, and each of those is the present being
 * consulted. The one question it never re-asked was whether the holder had ever proved
 * they own the address on the account. Invite acceptance was minting seven-day sessions
 * for addresses nobody had proven, so that token worked on every route in the product
 * until it expired, and could be traded for a public API key that outlived it.
 *
 * Two properties are under test here and they pull in opposite directions, which is why
 * neither is safe to assert alone:
 *
 *   â€¢ the GATE â€” an unverified account created after the cutover is refused, and the
 *     rejection RETURNS THE REPLY (see the block comment above the hook: an async
 *     preHandler resolving to undefined does not halt the chain, the route handler runs
 *     anyway, and the second response takes the process down);
 *
 *   â€¢ the GRANDFATHER â€” an unverified account that already existed when this shipped is
 *     admitted. Those accounts are real people who were handed a session by a flow that
 *     never issued them an OTP; /auth/login already refuses them, so gating them here
 *     would revoke a live session mid-shift and leave no recovery path at all. The
 *     production database could not be measured before this shipped, so this half is not
 *     prudence, it is the thing standing between a security fix and an outage.
 */
describe('enforceAuthenticatedApiRequest asks whether the address was ever proved', () => {
  const USER_ID = '00000000-0000-4000-a000-000000000001';
  const ORG_ID = '00000000-0000-4000-a000-000000000010';

  /**
   * Both dates are LITERALS on either side of a literal cutover, never arithmetic on
   * VERIFICATION_ENFORCED_SINCE itself. A constant written `new Date()` would be
   * re-evaluated at every process start, grandfather every account alive at boot, and
   * leave a gate that reads like a gate and refuses nobody â€” and a test phrased as
   * `new Date(VERIFICATION_ENFORCED_SINCE.getTime() + 1)` would sail straight through it.
   */
  const AFTER_CUTOVER = new Date('2026-09-01T12:00:00.000Z');
  const BEFORE_CUTOVER = new Date('2026-07-30T09:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$queryRaw.mockResolvedValue([{ id: '00000000-0000-4000-a000-000000000100' }]);
    dbMock.$executeRaw.mockResolvedValue(1);
  });

  it('pins the cutover to a literal instant, not to process start', async () => {
    expect(VERIFICATION_ENFORCED_SINCE.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(BEFORE_CUTOVER < VERIFICATION_ENFORCED_SINCE).toBe(true);
    expect(AFTER_CUTOVER > VERIFICATION_ENFORCED_SINCE).toBe(true);
  });

  it('refuses an unverified account that postdates the enforcement cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'member',
      is_verified: false, created_at: AFTER_CUTOVER,
    });
    const request = createRequest('GET');
    const reply = createReply();

    await enforceAuthenticatedApiRequest(request as never, reply as never);

    // 403 and not 401: the account is real and the token is valid, so the client routes
    // to the verification step. A 401 sends it to the login screen, where /auth/login
    // refuses the same account for the same reason and the person has nowhere to go.
    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: {
        code: 'ACCOUNT_NOT_VERIFIED',
        message: 'Please verify your account via the code sent to your email.',
      },
    });
  });

  /**
   * `resolves.toBe(reply)`, never merely "a 403 was sent". Asserting the status alone
   * passes whether or not the hook halts the chain, and the failure it misses is not a
   * leaked request â€” it is ERR_HTTP_HEADERS_SENT thrown off the reply lifecycle, which
   * exits the process. One request from an unverified account would then take the API
   * down for every tenant.
   */
  it('returns the reply when it refuses, so the hook chain actually halts', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'member',
      is_verified: false, created_at: AFTER_CUTOVER,
    });
    const request = createRequest('GET');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBe(reply);
  });

  it('audits the refusal, where the organisation can see it', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'admin',
      is_verified: false, created_at: AFTER_CUTOVER,
    });

    await enforceAuthenticatedApiRequest(createRequest('GET') as never, createReply() as never);

    const rows = auditRowValues();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('auth.unverified_session_rejected');
    expect(rows[0]).toContain('failure');
  });

  it('refuses before the session is even looked up', async () => {
    // The order matters for the message the caller gets. A revoked-session 401 would
    // send the client to /login, which is the one place that cannot help this account.
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'member',
      is_verified: false, created_at: AFTER_CUTOVER,
    });

    const reply = createReply();
    await enforceAuthenticatedApiRequest(createRequest('GET') as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
  });

  /**
   * THE GRANDFATHER TEST. If this goes red, the change has started locking real people
   * out of a live CRM rather than closing a hole in it.
   */
  it('admits an unverified account created before the enforcement cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'member',
      is_verified: false, created_at: BEFORE_CUTOVER,
    });
    const request = createRequest('GET');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBeUndefined();
    expect(reply.send).not.toHaveBeenCalled();
    expect(auditRowValues()).toHaveLength(0);
  });

  /**
   * Positive control. Without it, a gate accidentally keyed on created_at alone â€”
   * refusing everything recent, verified or not â€” would pass every test above.
   */
  it('admits a verified account created after the cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'member',
      is_verified: true, created_at: AFTER_CUTOVER,
    });
    const request = createRequest('GET');
    const reply = createReply();

    await expect(enforceAuthenticatedApiRequest(request as never, reply as never)).resolves.toBeUndefined();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('reads both columns it judges on', async () => {
    // Neither was in the projection before this change. A future `select` tidy-up that
    // drops them leaves is_verified undefined on every row, and created_at undefined
    // makes the gate fail open â€” so dropping them silently reopens the hole while every
    // behavioural test above still passes.
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, organization_id: ORG_ID, role: 'member',
      is_verified: true, created_at: AFTER_CUTOVER,
    });

    await enforceAuthenticatedApiRequest(createRequest('GET') as never, createReply() as never);

    const { select } = dbMock.user.findFirst.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(select.is_verified).toBe(true);
    expect(select.created_at).toBe(true);
  });

  /**
   * The revert switch, exercised rather than asserted. It exists because the OTP leg of
   * invite acceptance needs a client that can enter a code, and binaries already
   * installed cannot; ten seconds is the right amount of time for that to be undone.
   */
  it('stops asking entirely when REQUIRE_EMAIL_VERIFICATION=false', async () => {
    const previous = process.env.REQUIRE_EMAIL_VERIFICATION;
    process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
    try {
      dbMock.user.findFirst.mockResolvedValue({
        id: USER_ID, organization_id: ORG_ID, role: 'member',
        is_verified: false, created_at: AFTER_CUTOVER,
      });
      const reply = createReply();

      await expect(
        enforceAuthenticatedApiRequest(createRequest('GET') as never, reply as never),
      ).resolves.toBeUndefined();
      expect(reply.send).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
      else process.env.REQUIRE_EMAIL_VERIFICATION = previous;
    }
  });
});
