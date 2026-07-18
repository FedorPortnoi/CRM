import type { WebSocket } from '@fastify/websocket';

// Maps org_id -> connected WebSocket clients and their authenticated user ids
const rooms = new Map<string, Map<WebSocket, string>>();

export function joinRoom(orgId: string, userId: string, socket: WebSocket): void {
  let room = rooms.get(orgId);
  if (!room) {
    room = new Map();
    rooms.set(orgId, room);
  }
  room.set(socket, userId.toLowerCase());
}

export function leaveRoom(orgId: string, socket: WebSocket): void {
  const room = rooms.get(orgId);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) rooms.delete(orgId);
}

export function broadcastToOrg(orgId: string, payload: unknown): void {
  const room = rooms.get(orgId);
  if (!room) return;
  const json = JSON.stringify(payload);
  for (const client of room.keys()) {
    try {
      if ((client.readyState as number) === 1 /* OPEN */) {
        client.send(json);
      }
    } catch {
      // best-effort
    }
  }
}

export function broadcastToUsers(
  orgId: string,
  userIds: readonly string[],
  payload: unknown,
): void {
  const room = rooms.get(orgId);
  if (!room) return;
  const recipients = new Set(userIds.map((userId) => userId.toLowerCase()));
  const json = JSON.stringify(payload);

  for (const [client, userId] of room) {
    if (!recipients.has(userId)) continue;
    try {
      if ((client.readyState as number) === 1 /* OPEN */) {
        client.send(json);
      }
    } catch {
      // best-effort
    }
  }
}
