import type { FastifyInstance } from 'fastify';
import { verifyToken } from '../../mcp/server';
import { joinRoom, leaveRoom } from '../../services/wsRooms';

export async function wsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ws', { websocket: true }, (socket, request) => {
    const token = (request.query as Record<string, string>)['token'];
    if (!token) {
      socket.close(1008, 'Missing token');
      return;
    }

    let orgId: string;
    try {
      const user = verifyToken(token);
      orgId = user.org_id;
    } catch {
      socket.close(1008, 'Invalid token');
      return;
    }

    joinRoom(orgId, socket);

    socket.on('close', () => {
      leaveRoom(orgId, socket);
    });
  });
}
