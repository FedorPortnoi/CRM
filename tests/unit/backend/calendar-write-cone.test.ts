/**
 * Regression test for a live production authorization hole.
 *
 * backend/api/controllers/calendar.ts coned its READ paths (list, getById, availability)
 * but not its WRITE paths. update / cancel / markCompleted / addPostMeetingNotes all
 * looked the event up on `{ id, organization_id }` alone, so any member could PATCH,
 * cancel or complete any colleague's meeting over plain HTTP — no assistant needed. The
 * inconsistency inside a single file is what hid it: reads looked correct, so the file
 * read as coned.
 *
 * These tests assert the write gates apply the cone, and that an out-of-cone id returns
 * the same EVENT_NOT_FOUND as a nonexistent id so the response is not an existence oracle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const update = vi.fn();

vi.mock('../../../backend/services/db', () => ({
  db: {
    calendarEvent: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}));

// MGR (a member) manages REP. OUT is in another branch.
const MGR = 'aaaaaaaa-0000-4000-8000-000000000001';
const REP = 'aaaaaaaa-0000-4000-8000-000000000002';

vi.mock('../../../backend/services/visibility', () => ({
  getVisibleUserIds: vi.fn(async () => [MGR, REP]),
  getAccessibleUserIds: vi.fn(async (user: { role?: string }) =>
    user.role === 'owner' || user.role === 'admin' ? null : [MGR, REP],
  ),
  ownerVisibilityWhere: vi.fn(() => ({})),
  canSeeUser: vi.fn(() => true),
}));

import { CalendarController } from '../../../backend/api/controllers/calendar';

function makeReply() {
  const reply: Record<string, unknown> = { statusCode: undefined, payload: undefined };
  reply.status = vi.fn((c: number) => {
    reply.statusCode = c;
    return reply;
  });
  reply.send = vi.fn((b: unknown) => {
    reply.payload = b;
    return reply;
  });
  return reply;
}

function makeRequest(role: string, body: Record<string, unknown> = {}) {
  return {
    params: { id: 'eeeeeeee-0000-4000-8000-000000000009' },
    body,
    user: { sub: MGR, org_id: 'org-1', role },
  } as never;
}

/** Every write handler that takes an event id and mutates it. */
const WRITE_HANDLERS: Array<[string, (r: never, p: never) => Promise<void>]> = [
  ['update', (r, p) => CalendarController.update(r, p)],
  ['cancel', (r, p) => CalendarController.cancel(r, p)],
];

describe('calendar write paths enforce the visibility cone', () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
  });

  for (const [name, handler] of WRITE_HANDLERS) {
    it(`${name}: a member's lookup is constrained by created_by`, async () => {
      findFirst.mockResolvedValue(null);
      const reply = makeReply();

      await handler(makeRequest('member', { title: 'x' }), reply as never);

      const where = findFirst.mock.calls[0]?.[0]?.where;
      expect(where).toMatchObject({ organization_id: 'org-1' });
      // The load-bearing assertion: without created_by the member reaches any org row.
      expect(where.created_by).toEqual({ in: [MGR, REP] });
    });

    it(`${name}: an out-of-cone event is not mutated and reads as not found`, async () => {
      findFirst.mockResolvedValue(null); // cone excluded it
      const reply = makeReply();

      await handler(makeRequest('member', { title: 'hijack' }), reply as never);

      expect(update).not.toHaveBeenCalled();
      expect(reply.statusCode).toBe(404);
      expect((reply.payload as { error: { code: string } }).error.code).toBe('EVENT_NOT_FOUND');
    });

    it(`${name}: an owner is unrestricted`, async () => {
      findFirst.mockResolvedValue(null);
      const reply = makeReply();

      await handler(makeRequest('owner', { title: 'x' }), reply as never);

      const where = findFirst.mock.calls[0]?.[0]?.where;
      expect(where.created_by).toBeUndefined();
    });
  }
});
