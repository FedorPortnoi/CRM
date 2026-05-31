import type { FastifyInstance } from 'fastify';
import { verifyToken } from '../../mcp/server';
import { validateAuthSession } from '../../services/sessions';
import { joinRoom, leaveRoom } from '../../services/wsRooms';

export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    const token = (request.query as Record<string, string>)['token'];
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

    const activeSession = await validateAuthSession({
      sessionId: user.sid,
      userId: user.sub,
      organizationId: user.org_id,
    });

    if (!activeSession) {
      socket.close(1008, 'Session revoked');
      return;
    }

    joinRoom(user.org_id, socket);
    socket.on('close', () => { leaveRoom(user.org_id, socket); });
  });
}
