/**
 * The two JWT-accepting doors that sit OUTSIDE the global preHandler.
 *
 * enforceAuthenticatedApiRequest re-asks is_active, the live role, the live
 * session and — since the invite fix — is_verified, on every /api/v1 request.
 * Two surfaces never see that hook:
 *
 *   GET /api/v1/ws  is listed in isPublicApiRoute, so the hook returns on its
 *                   first line and the handler authenticates the connection
 *                   itself. Its ticket branch is safe transitively (GET
 *                   /api/v1/ws/ticket is NOT public, so a ticket can only be
 *                   minted by a request that already passed the gate), but the
 *                   deprecated `?token=`/Authorization fallback takes a raw JWT
 *                   straight off the wire.
 *   MCP tools       reach validateMcpPrincipal, which re-read is_active, the org
 *                   and the live role — everything except the one question.
 *
 * Neither was reachable by a NEW attacker, because no account created after the
 * enforcement cutover can obtain a JWT at all. Both were wide open to the
 * accounts the pre-fix invite flow already minted, and both are where the hole
 * returns at full strength if REQUIRE_EMAIL_VERIFICATION is ever set to 'false'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VERIFICATION_ENFORCED_SINCE } from '../../../backend/config/security';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ORG_ID = '00000000-0000-4000-a000-000000000010';
const SESSION_ID = '00000000-0000-4000-a000-000000000100';

const BEFORE_CUTOVER = new Date('2026-08-01T00:00:00.000Z');
const AFTER_CUTOVER = new Date('2026-08-08T00:00:00.000Z');

const dbMock = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
  org: { findUnique: vi.fn() },
}));

const sessionsMock = vi.hoisted(() => ({ validateAuthSession: vi.fn() }));
const wsRoomsMock = vi.hoisted(() => ({ joinRoom: vi.fn(), leaveRoom: vi.fn() }));
const wsTicketMock = vi.hoisted(() => ({
  consumeWsTicket: vi.fn(),
  issueWsTicket: vi.fn(() => 'ticket'),
  WS_TICKET_TTL_SECONDS: 30,
}));
const mcpServerMock = vi.hoisted(() => ({ verifyToken: vi.fn() }));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));
vi.mock('../../../backend/services/sessions', () => sessionsMock);
vi.mock('../../../backend/services/wsRooms', () => wsRoomsMock);
vi.mock('../../../backend/services/wsTicket', () => wsTicketMock);
vi.mock('../../../backend/mcp/server', () => mcpServerMock);
vi.mock('../../../backend/api/preHandlers', () => ({ authenticate: vi.fn() }));

import { validateMcpPrincipal } from '../../../backend/mcp/validation';
import { wsRoutes } from '../../../backend/api/routes/ws';

function principal() {
  return { sub: USER_ID, org_id: ORG_ID, sid: SESSION_ID, role: 'admin' };
}

describe('MCP asks the verification question the REST preHandler asks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.org.findUnique.mockResolvedValue({ id: ORG_ID });
    // Resolves TRUTHY on purpose. If the session check were the thing refusing
    // these principals the tests below would pass for the wrong reason and keep
    // passing after the gate was removed again.
    sessionsMock.validateAuthSession.mockResolvedValue({ id: SESSION_ID });
  });

  it('refuses a principal whose account never proved its email', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, role: 'admin', is_verified: false, created_at: AFTER_CUTOVER,
    });

    await expect(validateMcpPrincipal(principal())).resolves.toEqual({
      error: {
        code: 'ACCOUNT_NOT_VERIFIED',
        message: 'Please verify your account via the code sent to your email.',
      },
    });
  });

  it('refuses before the session is looked up', () => {
    // Same ordering as authenticate.ts, for the same reason: a SESSION_REVOKED
    // answer routes a client to login, which is the one place that cannot help
    // an account that has never proved its address.
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, role: 'admin', is_verified: false, created_at: AFTER_CUTOVER,
    });

    return validateMcpPrincipal(principal()).then(() => {
      expect(sessionsMock.validateAuthSession).not.toHaveBeenCalled();
    });
  });

  /**
   * Positive controls. Without them a gate accidentally keyed on created_at
   * alone — refusing every recent account, verified or not — would pass the two
   * tests above, and so would a gate that simply refused everybody.
   */
  it('admits an unverified account created before the enforcement cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, role: 'admin', is_verified: false, created_at: BEFORE_CUTOVER,
    });

    await expect(validateMcpPrincipal(principal())).resolves.toBeNull();
  });

  it('admits a verified account created after the cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, role: 'admin', is_verified: true, created_at: AFTER_CUTOVER,
    });

    await expect(validateMcpPrincipal(principal())).resolves.toBeNull();
  });

  /**
   * THE ONE THAT KEEPS THE REST HONEST.
   *
   * requiresEmailVerification treats a row with no created_at as grandfathered —
   * the right direction for a gate whose worst outcome is locking real users out
   * of a live CRM, but it means a `select` tidy-up that drops these two columns
   * reopens the hole while every behavioural test above still passes. The REST
   * side has the identical assertion (authenticate.test.ts) for the identical
   * reason.
   */
  it('selects the columns it judges on', async () => {
    dbMock.user.findFirst.mockResolvedValue({
      id: USER_ID, role: 'admin', is_verified: true, created_at: AFTER_CUTOVER,
    });

    await validateMcpPrincipal(principal());

    const { select } = dbMock.user.findFirst.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(select.is_verified).toBe(true);
    expect(select.created_at).toBe(true);
    // Still the live role, which the principal is rewritten from further down.
    expect(select.role).toBe(true);
  });

  it('pins the cutover this gate shares with the REST door', () => {
    expect(VERIFICATION_ENFORCED_SINCE.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(BEFORE_CUTOVER < VERIFICATION_ENFORCED_SINCE).toBe(true);
    expect(AFTER_CUTOVER > VERIFICATION_ENFORCED_SINCE).toBe(true);
  });
});

type SocketStub = {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

function socketStub(): SocketStub {
  return { close: vi.fn(), on: vi.fn() };
}

/** Registers wsRoutes against a fake Fastify and hands back the /ws handler. */
async function wsHandler(): Promise<(socket: SocketStub, request: unknown) => Promise<void>> {
  const routes = new Map<string, unknown>();
  const fastify = {
    get(path: string, ...rest: unknown[]) {
      routes.set(path, rest[rest.length - 1]);
    },
  };

  await wsRoutes(fastify as never);
  const handler = routes.get('/ws');
  expect(handler, '/ws route was not registered').toBeTypeOf('function');
  return handler as (socket: SocketStub, request: unknown) => Promise<void>;
}

function bearerRequest() {
  return { query: {}, headers: { authorization: 'Bearer raw.jwt.token' } };
}

describe('the deprecated raw-JWT WebSocket door', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpServerMock.verifyToken.mockReturnValue({
      sub: USER_ID, org_id: ORG_ID, sid: SESSION_ID, role: 'admin',
    });
    sessionsMock.validateAuthSession.mockResolvedValue({ id: SESSION_ID });
  });

  it('closes the socket for an account that never proved its email', async () => {
    dbMock.user.findFirst.mockResolvedValue({ is_verified: false, created_at: AFTER_CUTOVER });

    const socket = socketStub();
    await (await wsHandler())(socket, bearerRequest());

    expect(socket.close).toHaveBeenCalledWith(1008, 'Account not verified');
    expect(wsRoomsMock.joinRoom).not.toHaveBeenCalled();
  });

  it('still admits an account created before the enforcement cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({ is_verified: false, created_at: BEFORE_CUTOVER });

    const socket = socketStub();
    await (await wsHandler())(socket, bearerRequest());

    expect(socket.close).not.toHaveBeenCalled();
    expect(wsRoomsMock.joinRoom).toHaveBeenCalledWith(ORG_ID, USER_ID, socket);
  });

  it('admits a verified account created after the cutover', async () => {
    dbMock.user.findFirst.mockResolvedValue({ is_verified: true, created_at: AFTER_CUTOVER });

    const socket = socketStub();
    await (await wsHandler())(socket, bearerRequest());

    expect(socket.close).not.toHaveBeenCalled();
    expect(wsRoomsMock.joinRoom).toHaveBeenCalledWith(ORG_ID, USER_ID, socket);
  });

  it('reads the columns it judges on', async () => {
    dbMock.user.findFirst.mockResolvedValue({ is_verified: true, created_at: AFTER_CUTOVER });

    await (await wsHandler())(socketStub(), bearerRequest());

    const { select } = dbMock.user.findFirst.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(select.is_verified).toBe(true);
    expect(select.created_at).toBe(true);
  });

  /**
   * The cost control. GET /api/v1/ws/ticket is not in isPublicApiRoute, so a
   * ticket can only exist because a request already passed the verification gate
   * — and tickets are single-use with a short TTL. Charging the ticket path a
   * database read per connect would put a new query on every reconnect storm to
   * re-answer a question already answered. If this assertion ever fails, the
   * check has been hoisted out of the `else` and the ticket path is paying for a
   * guarantee it already has.
   */
  it('costs the ticket path nothing', async () => {
    wsTicketMock.consumeWsTicket.mockReturnValue({
      userId: USER_ID, orgId: ORG_ID, sessionId: SESSION_ID, role: 'admin',
    });

    const socket = socketStub();
    await (await wsHandler())(socket, { query: { ticket: 't' }, headers: {} });

    expect(socket.close).not.toHaveBeenCalled();
    expect(wsRoomsMock.joinRoom).toHaveBeenCalledWith(ORG_ID, USER_ID, socket);
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
  });
});
