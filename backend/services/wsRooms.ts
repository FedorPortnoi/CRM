import type { WebSocket } from '@fastify/websocket';

// Maps org_id -> set of connected WebSocket clients
const rooms = new Map<string, Set<WebSocket>>();

export function joinRoom(orgId: string, socket: WebSocket): void {
  let set = rooms.get(orgId);
  if (!set) {
    set = new Set();
    rooms.set(orgId, set);
  }
  set.add(socket);
}

export function leaveRoom(orgId: string, socket: WebSocket): void {
  const set = rooms.get(orgId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) rooms.delete(orgId);
}

export function broadcastToOrg(orgId: string, payload: unknown): void {
  const set = rooms.get(orgId);
  if (!set) return;
  const json = JSON.stringify(payload);
  for (const client of set) {
    try {
      if ((client.readyState as number) === 1 /* OPEN */) {
        client.send(json);
      }
    } catch {
      // best-effort
    }
  }
}
