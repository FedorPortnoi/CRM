import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarEventStatus } from '@prisma/client';

// ─── Fixture world ────────────────────────────────────────────────────────────
// One org, four users. MGR is a `member` who manages REP; OUT sits in a
// different branch entirely, so nothing of OUT's may ever be read *or written*
// by MGR. The calendar cone runs on `created_by`, mirroring the REST calendar
// controller (CalendarEvent has no assigned_to).

const ORG = '22222222-2222-4222-8222-000000000001';
const OWNER = '22222222-2222-4222-8222-00000000000a';
const MGR = '22222222-2222-4222-8222-00000000000b';
const REP = '22222222-2222-4222-8222-00000000000c';
const OUT = '22222222-2222-4222-8222-00000000000d';

const CONE = [MGR, REP];

const START = new Date('2026-07-25T10:00:00.000Z');
const END = new Date('2026-07-25T11:00:00.000Z');

type EventRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  title: string;
  status: CalendarEventStatus;
  start_time: Date;
  end_time: Date;
  completed_at: Date | null;
  attendee_ids: string[];
};

function event(
  id: string,
  created_by: string | null,
  title: string,
  status: CalendarEventStatus = CalendarEventStatus.scheduled,
  attendee_ids: string[] = [],
): EventRow {
  return {
    id,
    organization_id: ORG,
    created_by,
    title,
    status,
    start_time: START,
    end_time: END,
    completed_at: status === CalendarEventStatus.completed ? START : null,
    attendee_ids,
  };
}

// e-out-attendee lists MGR as an attendee: attendance must NOT widen the cone,
// exactly as in REST where attendee_ids is only ever a caller-supplied filter.
// e-orphan has a NULL creator and so falls outside every non-null cone.
const EVENTS: EventRow[] = [
  event('e-mgr', MGR, 'my own meeting'),
  event('e-rep', REP, 'my report meeting'),
  event('e-out', OUT, 'confidential other-branch meeting'),
  event('e-out-done', OUT, 'other-branch retro', CalendarEventStatus.completed),
  event('e-out-attendee', OUT, 'other-branch meeting I merely attend', CalendarEventStatus.scheduled, [MGR]),
  event('e-orphan', null, 'imported meeting with no creator'),
];

// ─── Minimal Prisma-shaped query engine over the fixtures ────────────────────

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === 'object') {
    const c = cond as Record<string, unknown>;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
    if ('not' in c) {
      return c.not === null ? value !== null && value !== undefined : value !== c.not;
    }
    return true;
  }
  return value === cond;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => matchField(row[field], cond));
}

function findRows(args: { where?: Record<string, unknown>; take?: number } | undefined): EventRow[] {
  const matched = EVENTS.filter((r) => matchesWhere(r as unknown as Record<string, unknown>, args?.where));
  return args?.take ? matched.slice(0, args.take) : matched;
}

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  calendarEvent: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  contact: { findFirst: vi.fn() },
  deal: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  org: { findUnique: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

type ToolHandler = (
  args: Record<string, unknown>,
  user: { sub: string; org_id: string; role: string },
) => Promise<Record<string, unknown>>;

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../backend/mcp/server', () => ({
  registerTool: (name: string, _description: string, _schema: unknown, handler: unknown) => {
    registry.set(name, handler);
  },
}));

import '../../../backend/mcp/tools/calendar';

function tool(name: string): ToolHandler {
  const handler = registry.get(name);
  if (!handler) throw new Error(`tool ${name} was never registered`);
  return handler as ToolHandler;
}

const ownerUser = { sub: OWNER, org_id: ORG, role: 'owner' };
const memberUser = { sub: MGR, org_id: ORG, role: 'member' };
// A token whose role claim is missing/garbage must be treated as restricted.
const unknownRoleUser = { sub: MGR, org_id: ORG, role: '' };

/** The `where` the tool handed to a given mocked Prisma call. */
function whereOf(mock: { mock: { calls: unknown[][] } }, callIndex = 0): Record<string, unknown> {
  const args = mock.mock.calls[callIndex]?.[0] as { where?: Record<string, unknown> } | undefined;
  return args?.where ?? {};
}

/** Every mocked write entry point on CalendarEvent. */
function writeMocks() {
  return [dbMock.calendarEvent.update, dbMock.calendarEvent.create];
}

function expectNoWrite(): void {
  for (const m of writeMocks()) expect(m).not.toHaveBeenCalled();
}

function errorOf(res: Record<string, unknown>): { code: string; message: string } | undefined {
  return (res as { error?: { code: string; message: string } }).error;
}

describe('MCP calendar tools respect the manager visibility cone', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // The recursive-CTE lookup inside getVisibleUserIds('subtree'). Owner/admin
    // short-circuit before reaching it, so this only ever answers for MGR.
    dbMock.$queryRaw.mockImplementation((_strings: unknown, ...values: unknown[]) => {
      const requester = values[0];
      return Promise.resolve(requester === MGR ? CONE.map((id) => ({ id })) : []);
    });

    dbMock.calendarEvent.findMany.mockImplementation((args: { where?: Record<string, unknown>; take?: number }) =>
      Promise.resolve(findRows(args)),
    );
    dbMock.calendarEvent.count.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(findRows(args).length),
    );
    dbMock.calendarEvent.findFirst.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(findRows(args)[0] ?? null),
    );
    // Never mutates the fixture array — each test asserts on the call itself.
    dbMock.calendarEvent.update.mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = EVENTS.find((e) => e.id === args.where.id);
      return Promise.resolve({ ...row, ...args.data });
    });
    dbMock.calendarEvent.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'e-new', ...args.data }),
    );
  });

  // ─── get_events ─────────────────────────────────────────────────────────────

  describe('get_events', () => {
    it('lists the whole org for the owner', async () => {
      const res = await tool('get_events')({}, ownerUser);
      const data = res.data as EventRow[];

      expect(data.map((e) => e.id)).toContain('e-out');
      expect(res.meta).toMatchObject({ total: data.length });
      expect(whereOf(dbMock.calendarEvent.findMany)).not.toHaveProperty('created_by');
      expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('lists only the member branch', async () => {
      const res = await tool('get_events')({}, memberUser);
      const data = res.data as EventRow[];

      expect(data.map((e) => e.id).sort()).toEqual(['e-mgr', 'e-rep']);
      expect(data.map((e) => e.title)).not.toContain('confidential other-branch meeting');
      // Attendance and NULL creators never widen the cone.
      expect(data.map((e) => e.id)).not.toContain('e-out-attendee');
      expect(data.map((e) => e.id)).not.toContain('e-orphan');
    });

    it('cones the list and its count on created_by, keeping organization_id', async () => {
      await tool('get_events')({}, memberUser);

      expect(whereOf(dbMock.calendarEvent.findMany)).toMatchObject({
        organization_id: ORG,
        created_by: { in: CONE },
      });
      expect(whereOf(dbMock.calendarEvent.count)).toMatchObject({
        organization_id: ORG,
        created_by: { in: CONE },
      });
    });

    it('does not let the total leak the out-of-cone rows', async () => {
      const res = await tool('get_events')({}, memberUser);
      expect((res.meta as { total: number }).total).toBe(2);
    });

    it('treats an unknown role as restricted (fails closed)', async () => {
      const res = await tool('get_events')({}, unknownRoleUser);
      const data = res.data as EventRow[];

      expect(dbMock.$queryRaw).toHaveBeenCalled();
      expect(data.map((e) => e.id).sort()).toEqual(['e-mgr', 'e-rep']);
      expect(whereOf(dbMock.calendarEvent.findMany)).toMatchObject({ created_by: { in: CONE } });
    });
  });

  // ─── get_event ──────────────────────────────────────────────────────────────

  describe('get_event', () => {
    it('lets the owner read any event in the org', async () => {
      const res = await tool('get_event')({ id: 'e-out' }, ownerUser);

      expect((res.data as EventRow).id).toBe('e-out');
      expect(whereOf(dbMock.calendarEvent.findFirst)).not.toHaveProperty('created_by');
    });

    it('lets a member read their own branch', async () => {
      const res = await tool('get_event')({ id: 'e-rep' }, memberUser);

      expect((res.data as EventRow).id).toBe('e-rep');
      expect(whereOf(dbMock.calendarEvent.findFirst)).toMatchObject({
        organization_id: ORG,
        created_by: { in: CONE },
      });
    });

    it('hides an out-of-cone event behind the same not-found error as a bad id', async () => {
      const outOfCone = await tool('get_event')({ id: 'e-out' }, memberUser);
      const nonExistent = await tool('get_event')({ id: 'e-does-not-exist' }, memberUser);

      expect(outOfCone.data).toBeUndefined();
      expect(errorOf(outOfCone)?.code).toBe('EVENT_NOT_FOUND');
      // Byte-identical to a genuinely missing id — no existence oracle.
      expect(errorOf(outOfCone)).toEqual(errorOf(nonExistent));
    });

    it('does not grant read access through attendee_ids', async () => {
      const res = await tool('get_event')({ id: 'e-out-attendee' }, memberUser);
      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
    });
  });

  // ─── update_event (WRITE) ───────────────────────────────────────────────────

  describe('update_event', () => {
    it('lets the owner update any event in the org', async () => {
      const res = await tool('update_event')({ id: 'e-out', title: 'renamed by owner' }, ownerUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.update).toHaveBeenCalledTimes(1);
      expect(whereOf(dbMock.calendarEvent.findFirst)).not.toHaveProperty('created_by');
    });

    it('lets a member update an event inside their branch', async () => {
      const res = await tool('update_event')({ id: 'e-rep', title: 'renamed by manager' }, memberUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.update).toHaveBeenCalledTimes(1);
      expect(whereOf(dbMock.calendarEvent.findFirst)).toMatchObject({
        organization_id: ORG,
        created_by: { in: CONE },
      });
    });

    it('refuses to update an out-of-cone event and writes nothing', async () => {
      const res = await tool('update_event')({ id: 'e-out', title: 'hijacked' }, memberUser);

      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
      expect(res.data).toBeUndefined();
      expectNoWrite();
    });

    it('refuses even when the member is an attendee of the event', async () => {
      const res = await tool('update_event')({ id: 'e-out-attendee', title: 'hijacked' }, memberUser);

      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
      expectNoWrite();
    });

    it('refuses for an unknown role (fails closed)', async () => {
      const res = await tool('update_event')({ id: 'e-out', title: 'hijacked' }, unknownRoleUser);

      // Since the capability layer landed, an unrecognised role is refused by
      // the write gate before the visibility cone is ever consulted — `can()`
      // grants nothing to a role it cannot interpret. That is a strictly
      // stronger refusal than the old EVENT_NOT_FOUND, and a more honest one:
      // the caller is not permitted, rather than the record not existing.
      // What this test actually guards is that the refusal happens at all.
      expect(errorOf(res)?.code).toBe('FORBIDDEN');
      expectNoWrite();
    });
  });

  // ─── cancel_event (WRITE) ───────────────────────────────────────────────────

  describe('cancel_event', () => {
    it('lets the owner cancel any event in the org', async () => {
      const res = await tool('cancel_event')({ id: 'e-out' }, ownerUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.update).toHaveBeenCalledTimes(1);
      expect(dbMock.calendarEvent.update.mock.calls[0]?.[0]).toMatchObject({
        data: { status: CalendarEventStatus.cancelled },
      });
    });

    it('lets a member cancel an event inside their branch', async () => {
      const res = await tool('cancel_event')({ id: 'e-mgr' }, memberUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.update).toHaveBeenCalledTimes(1);
      expect(whereOf(dbMock.calendarEvent.findFirst)).toMatchObject({
        organization_id: ORG,
        created_by: { in: CONE },
      });
    });

    it('refuses to cancel an out-of-cone event and writes nothing', async () => {
      const res = await tool('cancel_event')({ id: 'e-out' }, memberUser);

      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
      expect(res.data).toBeUndefined();
      expectNoWrite();
    });

    it('does not reveal that an out-of-cone event was already cancelled', async () => {
      // e-out-done is completed, not cancelled; the member must still get the
      // plain not-found error rather than any status-specific error code.
      const res = await tool('cancel_event')({ id: 'e-out-done' }, memberUser);

      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
      expectNoWrite();
    });
  });

  // ─── complete_event (WRITE) ─────────────────────────────────────────────────

  describe('complete_event', () => {
    it('lets the owner complete any event in the org', async () => {
      const res = await tool('complete_event')({ id: 'e-out' }, ownerUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.update).toHaveBeenCalledTimes(1);
      expect(dbMock.calendarEvent.update.mock.calls[0]?.[0]).toMatchObject({
        data: { status: CalendarEventStatus.completed },
      });
    });

    it('lets the owner toggle an already-completed event back to scheduled', async () => {
      await tool('complete_event')({ id: 'e-out-done' }, ownerUser);

      expect(dbMock.calendarEvent.update.mock.calls[0]?.[0]).toMatchObject({
        data: { status: CalendarEventStatus.scheduled, completed_at: null },
      });
    });

    it('lets a member complete an event inside their branch', async () => {
      const res = await tool('complete_event')({ id: 'e-rep' }, memberUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.update).toHaveBeenCalledTimes(1);
      expect(whereOf(dbMock.calendarEvent.findFirst)).toMatchObject({
        organization_id: ORG,
        created_by: { in: CONE },
      });
    });

    it('refuses to complete an out-of-cone event and writes nothing', async () => {
      const res = await tool('complete_event')({ id: 'e-out' }, memberUser);

      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
      expect(res.data).toBeUndefined();
      expectNoWrite();
    });

    it('refuses to un-complete an out-of-cone event', async () => {
      const res = await tool('complete_event')({ id: 'e-out-done' }, memberUser);

      expect(errorOf(res)?.code).toBe('EVENT_NOT_FOUND');
      expectNoWrite();
    });
  });

  // ─── create_event ───────────────────────────────────────────────────────────

  describe('create_event', () => {
    it('pins created_by to the caller, so a new event lands inside their cone', async () => {
      const res = await tool('create_event')(
        { title: 'new', start_time: START.toISOString(), end_time: END.toISOString() },
        memberUser,
      );

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.calendarEvent.create.mock.calls[0]?.[0]).toMatchObject({
        data: { created_by: MGR, organization_id: ORG },
      });
    });
  });
});
