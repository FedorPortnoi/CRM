import crypto from 'crypto';
import { sha256 } from './crypto';

// Short-lived, single-use handshake tickets for the WebSocket upgrade. An authenticated HTTP
// endpoint (GET /api/v1/ws/ticket) issues a ticket; the client then opens the socket with
// ?ticket=<t>. This keeps the long-lived JWT out of the WS URL query string, where it would
// otherwise leak into reverse-proxy access logs, browser history and crash reports.
//
// Storage is an in-memory Map, which is correct only because the backend runs as a SINGLE
// process: the issuing HTTP request and the WS upgrade are handled by the same instance.
// If this ever runs behind more than one backend node (or with a clustered/forked server),
// move the store to Redis/Valkey (Yandex Managed Redis) keyed the same way — nothing else
// in this module needs to change. Tickets are tiny, live <= 60s, are deleted on first use,
// and expired entries are swept on every issue, so the Map cannot grow unbounded.
export const WS_TICKET_TTL_MS = 60_000;
export const WS_TICKET_TTL_SECONDS = WS_TICKET_TTL_MS / 1_000;

export type WsTicketPrincipal = {
  userId: string;
  orgId: string;
  sessionId: string;
  role: string;
};

type StoredTicket = WsTicketPrincipal & { expiresAt: number };

// Keyed by sha256(raw ticket) so the raw secret is never held in memory — mirrors the
// AuthSession.token_hash pattern in services/sessions.ts.
const tickets = new Map<string, StoredTicket>();

// Drops every ticket whose TTL has elapsed. Exported so a caller can sweep on a timer too;
// issueWsTicket() already sweeps, which is enough to bound the store in practice.
export function pruneExpiredWsTickets(now = Date.now()): number {
  let removed = 0;
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt <= now) {
      tickets.delete(key);
      removed += 1;
    }
  }

  return removed;
}

// Number of tickets currently held. For tests and observability only.
export function activeWsTicketCount(): number {
  return tickets.size;
}

// Issue a fresh ticket bound to the caller's user + org + session. Returns the raw ticket
// (handed to the client once); only its hash is stored.
export function issueWsTicket(principal: WsTicketPrincipal): string {
  const now = Date.now();
  pruneExpiredWsTickets(now);
  const raw = crypto.randomBytes(32).toString('base64url');
  tickets.set(sha256(raw), { ...principal, expiresAt: now + WS_TICKET_TTL_MS });
  return raw;
}

// Verify and consume in one step: the ticket is deleted on first lookup so it can never be
// replayed, and an expired ticket is rejected (and evicted). Returns the bound principal, or
// null when the ticket is unknown, already used, or expired. The org id comes from the ticket
// and is never taken from the client, so a ticket minted for one org can only ever join that
// org's room.
export function consumeWsTicket(raw: string): WsTicketPrincipal | null {
  if (!raw) {
    return null;
  }

  const key = sha256(raw);
  const ticket = tickets.get(key);
  if (!ticket) {
    return null;
  }

  tickets.delete(key);
  if (ticket.expiresAt <= Date.now()) {
    return null;
  }

  return {
    userId: ticket.userId,
    orgId: ticket.orgId,
    sessionId: ticket.sessionId,
    role: ticket.role,
  };
}
