import type { FastifyInstance } from 'fastify';
import { verifyToken } from '../../mcp/server';
import { validateAuthSession } from '../../services/sessions';
import { joinRoom, leaveRoom } from '../../services/wsRooms';
import {
  consumeWsTicket,
  issueWsTicket,
  WS_TICKET_TTL_SECONDS,
  type WsTicketPrincipal,
} from '../../services/wsTicket';
import { authenticate } from '../preHandlers';

export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  // Authenticated issuer: the client sends its JWT in the Authorization header and receives a
  // short-lived, single-use ticket, then opens the socket with ?ticket=<t>. This keeps the JWT
  // out of the WS URL query string (where it leaks into proxy/access logs and history).
  //
  // Deliberately a GET: enforceAuthenticatedApiRequest rejects every non-read-only method for
  // the `viewer` role, and viewers need real-time updates too. Minting a ticket has no
  // client-visible side effect, auth is Bearer-only (no cookies, so no CSRF surface), and the
  // global onSend hook already sets Cache-Control: no-store on /api/ responses.
  fastify.get('/ws/ticket', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user.sid) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token' },
      });
    }

    const ticket = issueWsTicket({
      userId: request.user.sub,
      orgId: request.user.org_id,
      sessionId: request.user.sid,
      role: request.user.role,
    });

    return reply.send({ data: { ticket, expires_in: WS_TICKET_TTL_SECONDS }, meta: {} });
  });

  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    const query = request.query as Record<string, string>;
    let principal: WsTicketPrincipal;

    if (query['ticket']) {
      // Preferred path: single-use ticket, consumed here so a replay is rejected.
      const ticketPrincipal = consumeWsTicket(query['ticket']);
      if (!ticketPrincipal) {
        socket.close(1008, 'Invalid ticket');
        return;
      }

      principal = ticketPrincipal;
    } else {
      const authHeader = request.headers['authorization'];
      const headerToken =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined;
      // DEPRECATED: `?token=<JWT>` puts a long-lived bearer token in the URL. It stays only
      // because App Store build 1.0.4 (live) and 1.0.5 (in review) connect that way. Drop the
      // `query['token']` fallback below once those builds are retired — the Authorization
      // header path stays supported for non-browser clients that can set headers on upgrade.
      const token = headerToken ?? query['token'];
      if (!token) {
        socket.close(1008, 'Missing token');
        return;
      }

      let user: ReturnType<typeof verifyToken>;
      try {
        user = verifyToken(token);
      } catch {
        socket.close(1008, 'Invalid token');
        return;
      }

      if (!user.sid) {
        socket.close(1008, 'Invalid token');
        return;
      }

      principal = {
        userId: user.sub,
        orgId: user.org_id,
        sessionId: user.sid,
        role: user.role,
      };
    }

    // Even with a valid ticket, re-check the session has not been revoked or expired between
    // ticket issue and connect.
    const activeSession = await validateAuthSession({
      sessionId: principal.sessionId,
      userId: principal.userId,
      organizationId: principal.orgId,
    });

    if (!activeSession) {
      socket.close(1008, 'Session revoked');
      return;
    }

    joinRoom(principal.orgId, principal.userId, socket);
    socket.on('close', () => { leaveRoom(principal.orgId, socket); });
  });
}
