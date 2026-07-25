import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeWsTicketCount,
  consumeWsTicket,
  issueWsTicket,
  pruneExpiredWsTickets,
  WS_TICKET_TTL_MS,
} from '../../../backend/services/wsTicket';
import { broadcastToOrg, joinRoom, leaveRoom } from '../../../backend/services/wsRooms';

const ORG_A = '00000000-0000-4000-a000-0000000000a1';
const ORG_B = '00000000-0000-4000-a000-0000000000b2';
const USER_A = '00000000-0000-4000-a000-000000000001';
const SESSION_A = '00000000-0000-4000-a000-000000000100';

function principal(overrides: Partial<Parameters<typeof issueWsTicket>[0]> = {}) {
  return {
    userId: USER_A,
    orgId: ORG_A,
    sessionId: SESSION_A,
    role: 'member',
    ...overrides,
  };
}

type FakeSocket = { readyState: number; send: ReturnType<typeof vi.fn> };

function createSocket(): FakeSocket {
  return { readyState: 1, send: vi.fn() };
}

describe('wsTicket', () => {
  beforeEach(() => {
    // Module-level store — drop every ticket so counts are deterministic per test.
    pruneExpiredWsTickets(Number.POSITIVE_INFINITY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues an opaque ticket that resolves to the bound principal', () => {
    const ticket = issueWsTicket(principal());

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(consumeWsTicket(ticket)).toEqual({
      userId: USER_A,
      orgId: ORG_A,
      sessionId: SESSION_A,
      role: 'member',
    });
  });

  it('accepts a ticket exactly once and rejects the replay', () => {
    const ticket = issueWsTicket(principal());

    expect(consumeWsTicket(ticket)).not.toBeNull();
    expect(consumeWsTicket(ticket)).toBeNull();
    expect(consumeWsTicket(ticket)).toBeNull();
  });

  it('rejects a ticket after its TTL has elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));

    const ticket = issueWsTicket(principal());

    vi.advanceTimersByTime(WS_TICKET_TTL_MS - 1_000);
    expect(consumeWsTicket(ticket)).not.toBeNull();

    const second = issueWsTicket(principal());
    vi.advanceTimersByTime(WS_TICKET_TTL_MS + 1);
    expect(consumeWsTicket(second)).toBeNull();
  });

  it('rejects unknown, empty and malformed tickets', () => {
    expect(consumeWsTicket('')).toBeNull();
    expect(consumeWsTicket('not-a-real-ticket')).toBeNull();
    expect(consumeWsTicket('a'.repeat(43))).toBeNull();

    // A ticket that was issued must not make an unrelated value valid.
    issueWsTicket(principal());
    expect(consumeWsTicket('not-a-real-ticket')).toBeNull();
  });

  it('sweeps expired tickets so the store cannot grow unbounded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T12:00:00.000Z'));

    for (let i = 0; i < 5; i += 1) {
      issueWsTicket(principal());
    }
    expect(activeWsTicketCount()).toBe(5);

    vi.advanceTimersByTime(WS_TICKET_TTL_MS + 1);
    // The next issue prunes everything that expired while idle.
    issueWsTicket(principal());
    expect(activeWsTicketCount()).toBe(1);
  });

  it('binds the org to the ticket so it cannot be used to join another org room', () => {
    const ticket = issueWsTicket(principal({ orgId: ORG_A }));
    const resolved = consumeWsTicket(ticket);

    expect(resolved).not.toBeNull();
    expect(resolved?.orgId).toBe(ORG_A);
    expect(resolved?.orgId).not.toBe(ORG_B);

    // The /ws handler joins principal.orgId — never an org id supplied by the client — so a
    // ticket minted for ORG_A only ever lands in ORG_A's room.
    const socket = createSocket();
    joinRoom(resolved!.orgId, resolved!.userId, socket as never);

    const otherOrgSocket = createSocket();
    joinRoom(ORG_B, '00000000-0000-4000-a000-000000000002', otherOrgSocket as never);

    broadcastToOrg(ORG_B, { type: 'org_b_only' });
    expect(socket.send).not.toHaveBeenCalled();
    expect(otherOrgSocket.send).toHaveBeenCalledTimes(1);

    broadcastToOrg(ORG_A, { type: 'org_a_only' });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'org_a_only' }));
    expect(otherOrgSocket.send).toHaveBeenCalledTimes(1);

    leaveRoom(ORG_A, socket as never);
    leaveRoom(ORG_B, otherOrgSocket as never);
  });

  it('does not leak a ticket issued for one org into another org principal', () => {
    const ticketA = issueWsTicket(principal({ orgId: ORG_A }));
    const ticketB = issueWsTicket(principal({ orgId: ORG_B, userId: '00000000-0000-4000-a000-000000000002' }));

    expect(consumeWsTicket(ticketA)?.orgId).toBe(ORG_A);
    expect(consumeWsTicket(ticketB)?.orgId).toBe(ORG_B);
  });
});
