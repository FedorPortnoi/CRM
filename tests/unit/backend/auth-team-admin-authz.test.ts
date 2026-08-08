/**
 * TEAM ADMINISTRATION, ASKED OF THE CAPABILITY MAP RATHER THAN OF A STRING.
 *
 * Eight authorization decisions in controllers/auth.ts compared role names
 * directly — `callerRole !== 'owner' && callerRole !== 'admin'` — and
 * adminRoutePolicy had no branch for /auth/users or /auth/company-code at all,
 * so `requiredCapability` was undefined, the capability check was skipped
 * entirely, and the string comparison was the only gate. The denial was
 * therefore never audited either.
 *
 * The audit's headline reading was WRONG and it is worth saying so: no role
 * below admin could reach any of these. The allow-lists are {owner, admin},
 * which is exactly the team.manage holder set, and an unknown role falls outside
 * an allow-list, so they did fail closed. There was no low-to-high escalation.
 *
 * What WAS live, and what the first two tests below pin, is admin-on-admin:
 *   • deactivateUser guarded only `target.role === 'owner'`, so an admin could
 *     deactivate a PEER admin — and since requiresEmailVerification/is_active is
 *     re-read on every request, that locks the target out of the whole product.
 *   • setUserManager selected `{ id: true }` and had NO target guard of any
 *     kind, so an admin could reparent the OWNER under a `head`, and the
 *     recursive CTE in services/visibility.ts would then hand that head the
 *     owner's contacts, deals and tasks.
 * CAPABILITIES reserves both ("team.manage_admins — create or modify
 * admin-level members (owner only)") to the owner. Neither wrote an audit row.
 *
 * No test anywhere called any of these five handlers before this file.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  apiKey: { updateMany: vi.fn() },
  org: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

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

import { AuthController, TEAM_DENIAL_MESSAGES } from '../../../backend/api/controllers/auth';
import { enforceAuthenticatedApiRequest } from '../../../backend/api/authenticate';
import { ROLE_CAPABILITIES, type Role } from '../../../backend/services/capabilities';

const ORG = '00000000-0000-4000-a000-000000000001';
const OWNER = '00000000-0000-4000-a000-00000000000a';
const ADMIN_A = '00000000-0000-4000-a000-00000000000b';
const ADMIN_B = '00000000-0000-4000-a000-00000000000c';
const MEMBER = '00000000-0000-4000-a000-00000000000d';
const HEAD = '00000000-0000-4000-a000-00000000000e';

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

function createRequest(
  role: string,
  sub: string,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {},
) {
  return {
    user: { sub, org_id: ORG, role },
    params,
    body,
    headers: { 'user-agent': 'vitest' },
    ip: '127.0.0.1',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$executeRaw.mockResolvedValue(1);
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.user.update.mockResolvedValue({
    id: MEMBER, email: null, name: 'X', role: 'member', organization_id: ORG,
  });
  dbMock.apiKey.updateMany.mockResolvedValue({ count: 0 });
});

describe('an admin may not modify an admin-level member', () => {
  it('refuses an admin deactivating another admin', async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: ADMIN_B, role: 'admin', is_active: true });
    const reply = createReply();

    await AuthController.deactivateUser(
      createRequest('admin', ADMIN_A, { id: ADMIN_B }),
      reply as never,
    );

    expect(reply.statusCode).toBe(403);
    // The assertion that matters. A status-only check would also pass against a
    // handler that 403s AFTER having already written.
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  it('refuses an admin reparenting the owner', async () => {
    // Answerable only because the target select was widened to include `role` —
    // that widening IS the fix; before it the handler could not have known.
    dbMock.user.findFirst.mockResolvedValueOnce({ id: OWNER, role: 'owner' });
    const reply = createReply();

    await AuthController.setUserManager(
      createRequest('admin', ADMIN_A, { id: OWNER }, { manager_id: HEAD }),
      reply as never,
    );

    expect(reply.statusCode).toBe(403);
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  it('refuses an admin reparenting a peer admin', async () => {
    dbMock.user.findFirst.mockResolvedValueOnce({ id: ADMIN_B, role: 'admin' });
    const reply = createReply();

    await AuthController.setUserManager(
      createRequest('admin', ADMIN_A, { id: ADMIN_B }, { manager_id: HEAD }),
      reply as never,
    );

    expect(reply.statusCode).toBe(403);
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  it('records the refusal where the owner can see it', async () => {
    // Four of the five most sensitive mutations in the product wrote no audit row
    // at all, and because adminRoutePolicy matched nothing the preHandler's
    // denial-audit branch was unreachable too. The whole attack was invisible.
    dbMock.user.findFirst.mockResolvedValue({ id: ADMIN_B, role: 'admin', is_active: true });

    await AuthController.deactivateUser(
      createRequest('admin', ADMIN_A, { id: ADMIN_B }),
      createReply() as never,
    );

    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'team.deactivate_member',
        outcome: 'denied',
        organizationId: ORG,
      }),
    );
  });
});

/**
 * THE POSITIVE CONTROLS. These must pass both before and after — a fix that
 * closes admin-on-admin by breaking ordinary team administration is not a fix,
 * and there is no owner-transfer endpoint to route around it with.
 */
describe('ordinary team administration still works', () => {
  it('lets the owner deactivate an admin', async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: ADMIN_B, role: 'admin', is_active: true });
    const reply = createReply();

    await AuthController.deactivateUser(
      createRequest('owner', OWNER, { id: ADMIN_B }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalledWith({
      where: { id: ADMIN_B },
      data: { is_active: false },
    });
  });

  it('lets an admin deactivate a member', async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: MEMBER, role: 'member', is_active: true });
    const reply = createReply();

    await AuthController.deactivateUser(
      createRequest('admin', ADMIN_A, { id: MEMBER }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalled();
  });

  it('lets an admin set a member\'s manager', async () => {
    dbMock.user.findFirst
      .mockResolvedValueOnce({ id: MEMBER, role: 'member' })
      .mockResolvedValueOnce({ id: HEAD, manager_id: null });
    dbMock.$queryRaw.mockResolvedValue([]); // the cycle-detection CTE
    const reply = createReply();

    await AuthController.setUserManager(
      createRequest('admin', ADMIN_A, { id: MEMBER }, { manager_id: HEAD }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.user.update).toHaveBeenCalledWith({
      where: { id: MEMBER },
      data: { manager_id: HEAD },
    });
  });

  it('lets the owner deactivate another owner, as before', async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: ADMIN_B, role: 'owner', is_active: true });
    const reply = createReply();

    await AuthController.deactivateUser(
      createRequest('owner', OWNER, { id: ADMIN_B }),
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
  });
});

/**
 * DEACTIVATION HAS TO CLOSE EVERY DOOR.
 *
 * It closed none: no session revocation (changeUserRole has always called it;
 * this handler never did) and no API-key revocation. services/public-api-auth.ts
 * validates a key row alone and never consults the creator, so removing a rogue
 * admin left intact the one channel an admin is uniquely able to mint — and when
 * the creator goes inactive, resolveActorUserId falls through to the org's first
 * active owner, so the orphaned key gains BETTER attribution.
 */
describe('deactivation revokes the target\'s other credentials', () => {
  beforeEach(() => {
    dbMock.user.findFirst.mockResolvedValue({ id: MEMBER, role: 'member', is_active: true });
  });

  it('revokes live sessions', async () => {
    await AuthController.deactivateUser(
      createRequest('admin', ADMIN_A, { id: MEMBER }),
      createReply() as never,
    );

    expect(sessionsMock.revokeAllUserSessions).toHaveBeenCalledWith(MEMBER, ORG, 'deactivated');
  });

  it('revokes API keys the target minted', async () => {
    await AuthController.deactivateUser(
      createRequest('admin', ADMIN_A, { id: MEMBER }),
      createReply() as never,
    );

    expect(dbMock.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG, created_by: MEMBER, revoked_at: null },
      }),
    );
  });
});

/**
 * THE TRANSLATION FROM ROLE STRINGS TO CAPABILITIES CHANGED NOBODY'S ACCESS.
 *
 * Run over every role the product has, per handler. If this table ever shifts,
 * the "refactor" widened or narrowed something.
 */
describe('who may reach each team-admin handler', () => {
  const ALL_ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];

  it.each(ALL_ROLES)('deactivateUser: %s', async (role) => {
    dbMock.user.findFirst.mockResolvedValue({ id: MEMBER, role: 'member', is_active: true });
    const reply = createReply();
    await AuthController.deactivateUser(createRequest(role, ADMIN_A, { id: MEMBER }), reply as never);

    const allowed = role === 'owner' || role === 'admin';
    expect(reply.statusCode).toBe(allowed ? 200 : 403);
    if (!allowed) {
      expect(reply.payload).toEqual({
        error: { code: 'FORBIDDEN', message: TEAM_DENIAL_MESSAGES.deactivate },
      });
    }
  });

  it.each(ALL_ROLES)('changeUserRole is owner-only: %s', async (role) => {
    dbMock.user.findFirst.mockResolvedValue({ id: MEMBER });
    dbMock.user.update.mockResolvedValue({ id: MEMBER, role: 'head' });
    const reply = createReply();
    await AuthController.changeUserRole(
      createRequest(role, ADMIN_A, { id: MEMBER }, { role: 'head' }),
      reply as never,
    );

    // team.manage_admins, NOT team.manage. Translating this one to team.manage
    // would have handed re-roling to every admin — a widening dressed up as a
    // refactor, and the reason the two capabilities are separate at all.
    expect(reply.statusCode).toBe(role === 'owner' ? 200 : 403);
  });

  it.each(ALL_ROLES)('getCompanyCode: %s', async (role) => {
    dbMock.org.findUnique.mockResolvedValue({
      id: ORG, name: 'Ромашка', join_code: 'X-1', join_code_expires_at: new Date(Date.now() + 86_400_000),
    });
    const reply = createReply();
    await AuthController.getCompanyCode(createRequest(role, ADMIN_A), reply as never);

    expect(reply.statusCode).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
  });
});

/**
 * THE PREHANDLER SIDE. These routes were the last authorization decisions in the
 * product made entirely outside the central gate, which is also why their
 * denials were never audited.
 */
describe('the central preHandler now gates these routes too', () => {
  function hookRequest(method: string, url: string, role: string) {
    return {
      method,
      url,
      user: { sub: MEMBER, org_id: ORG, sid: 'sid', role },
      jwtVerify: vi.fn(async () => undefined),
      headers: {},
      ip: '127.0.0.1',
      routeOptions: {},
    } as never;
  }

  beforeEach(() => {
    dbMock.user.findFirst.mockResolvedValue({
      id: MEMBER,
      organization_id: ORG,
      role: 'support',
      is_verified: true,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    dbMock.$queryRaw.mockResolvedValue([
      { id: 'sid', user_id: MEMBER, organization_id: ORG, revoked_at: null },
    ]);
  });

  it.each([
    ['PATCH', `/api/v1/auth/users/${MEMBER}/deactivate`],
    ['PATCH', `/api/v1/auth/users/${MEMBER}/manager`],
    ['PATCH', `/api/v1/auth/users/${MEMBER}/role`],
    ['POST', '/api/v1/auth/users/invite'],
    ['GET', '/api/v1/auth/company-code'],
    ['POST', '/api/v1/auth/company-code/rotate'],
  ])('refuses %s %s for a support user', async (method, url) => {
    const reply = createReply();
    const request = hookRequest(method, url, 'support');

    // `resolves.toBe(reply)`, not merely "a 403 was sent". An async preHandler
    // that resolves to undefined does NOT halt the hook chain — the handler runs
    // anyway, sends a second response, and the ERR_HTTP_HEADERS_SENT is thrown
    // where no handler catches it and the process exits. Asserting only the
    // status passes either way and misses exactly that.
    await expect(
      enforceAuthenticatedApiRequest(request, reply as never),
    ).resolves.toBe(reply);
    expect(reply.statusCode).toBe(403);
  });

  it('does NOT refuse GET /auth/users for a support user', async () => {
    // The single most dangerous line in this change. GET /auth/users is called by
    // every role from the assignee picker, the DM composer and the API-keys
    // screen; the unmapped fallback is org.manage, so a missing 'team.read'
    // mapping would 403 six of eight roles on shipped 1.1.6 builds.
    const reply = createReply();
    const request = hookRequest('GET', '/api/v1/auth/users', 'support');

    await expect(
      enforceAuthenticatedApiRequest(request, reply as never),
    ).resolves.toBeUndefined();
  });

  it('leaves self-service account maintenance alone', async () => {
    // A bare startsWith('/api/v1/auth') would have swallowed these and locked
    // every read-only role out of its own password and timezone.
    for (const url of ['/api/v1/auth/me/password', '/api/v1/auth/me/timezone', '/api/v1/auth/sessions']) {
      const reply = createReply();
      await expect(
        enforceAuthenticatedApiRequest(hookRequest('PATCH', url, 'support'), reply as never),
      ).resolves.toBeUndefined();
    }
  });
});

/**
 * The preHandler answers FIRST for these routes now, so its message is what the
 * client renders — src/app/settings/team.tsx pipes `json.error.message` straight
 * into an Alert. Byte-identical on both sides, pinned here so they cannot drift,
 * exactly as SEQUENCE_ADMIN_DENIAL_MESSAGE is.
 */
describe('the preHandler and the controller say the same thing', () => {
  it.each([
    ['PATCH', `/api/v1/auth/users/${MEMBER}/deactivate`, TEAM_DENIAL_MESSAGES.deactivate],
    ['PATCH', `/api/v1/auth/users/${MEMBER}/manager`, TEAM_DENIAL_MESSAGES.setManager],
    ['PATCH', `/api/v1/auth/users/${MEMBER}/role`, TEAM_DENIAL_MESSAGES.changeRole],
    ['POST', '/api/v1/auth/users/invite', TEAM_DENIAL_MESSAGES.invite],
    ['GET', '/api/v1/auth/company-code', TEAM_DENIAL_MESSAGES.readCompanyCode],
    ['POST', '/api/v1/auth/company-code/rotate', TEAM_DENIAL_MESSAGES.rotateCompanyCode],
  ])('%s %s', async (method, url, message) => {
    dbMock.user.findFirst.mockResolvedValue({
      id: MEMBER,
      organization_id: ORG,
      role: 'support',
      is_verified: true,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    dbMock.$queryRaw.mockResolvedValue([
      { id: 'sid', user_id: MEMBER, organization_id: ORG, revoked_at: null },
    ]);

    const reply = createReply();
    await enforceAuthenticatedApiRequest(
      {
        method,
        url,
        user: { sub: MEMBER, org_id: ORG, sid: 'sid', role: 'support' },
        jwtVerify: vi.fn(async () => undefined),
        headers: {},
        ip: '127.0.0.1',
        routeOptions: {},
      } as never,
      reply as never,
    );

    expect(reply.payload).toEqual({ error: { code: 'FORBIDDEN', message } });
  });
});
