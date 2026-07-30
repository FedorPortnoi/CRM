/**
 * Regression tests for four visibility-cone leaks, all of the same shape: a
 * handler that scoped its query to the ORGANIZATION and stopped there, on a
 * surface where its neighbours already applied the manager cone.
 *
 *   1. GET /captures                — joined the linked Contact in and DECRYPTED
 *                                     its phone for every role in the org.
 *   2. POST /captures/:id/match     — resolved the target contact org-wide and
 *                                     then WROTE a Message and a Task onto it.
 *   3. move_deal_to_stage (MCP)     — moved any deal in the org, while its REST
 *                                     twin refused. The assistant was more
 *                                     permissive than the API behind it.
 *   4. /contacts/:id/{deals,tasks,activity}
 *                                   — checked the cone on the CONTACT and then
 *                                     returned every child record attached to it.
 *
 * Each leak is asserted from the member side (nothing of the other branch comes
 * back, and nothing is written) and from the owner side (`visibility.all` still
 * means everything — the fix must not have coned the roles that are org-wide by
 * the nature of the job).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DealStatus, PendingCaptureStatus, PendingCaptureType, TaskStatus } from '@prisma/client';

// encryptField/decryptField derive their key from this, and the fixtures below
// are encrypted at module scope — so it has to be set before anything imports
// backend/services/encryption.
vi.hoisted(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'cone-leaks-regression-fixture-key-000000';
});

import { encryptField } from '../../../backend/services/encryption';

// ─── Fixture world ────────────────────────────────────────────────────────────
// One org, four users. MGR is a `member` who manages REP; OUT sits in another
// branch entirely, so nothing of OUT's may ever be read or written by MGR.

const ORG = '33333333-3333-4333-8333-000000000001';
const OWNER = '33333333-3333-4333-8333-00000000000a';
const MGR = '33333333-3333-4333-8333-00000000000b';
const REP = '33333333-3333-4333-8333-00000000000c';
const OUT = '33333333-3333-4333-8333-00000000000d';

const CONE = [MGR, REP];

const IN_PHONE = '+7 999 111-22-33';
const OUT_PHONE = '+7 495 987-65-43';
const OUT_NAME = 'Соколов';

const T0 = new Date('2026-07-20T09:00:00.000Z');
const T1 = new Date('2026-07-21T09:00:00.000Z');
const T2 = new Date('2026-07-22T09:00:00.000Z');

type Row = Record<string, unknown>;

// c-in belongs to the cone (assigned to REP). c-out is another branch's, and is
// the record whose name and phone must never surface.
const CONTACTS: Row[] = [
  {
    id: 'c-in',
    organization_id: ORG,
    assigned_to: REP,
    created_by: MGR,
    first_name: 'Ирина',
    last_name: 'Волкова',
    phone: encryptField(IN_PHONE),
    email: null,
    mobile: null,
    status: 'active',
  },
  {
    id: 'c-out',
    organization_id: ORG,
    assigned_to: OUT,
    created_by: OUT,
    first_name: 'Пётр',
    last_name: OUT_NAME,
    phone: encryptField(OUT_PHONE),
    email: null,
    mobile: null,
    status: 'active',
  },
];

// cap-unmatched is the shared inbox row: no contact, so no contact PII, and it
// must stay visible to everyone — that is what the screen exists for.
const CAPTURES: Row[] = [
  {
    id: 'cap-unmatched',
    org_id: ORG,
    contact_id: null,
    type: PendingCaptureType.call,
    raw_data: { notes: 'unattributed inbound call' },
    phone_number: '+7 900 000-00-00',
    status: PendingCaptureStatus.pending,
    created_at: T0,
  },
  {
    id: 'cap-in',
    org_id: ORG,
    contact_id: 'c-in',
    type: PendingCaptureType.call,
    raw_data: { notes: 'call with my own client' },
    phone_number: IN_PHONE,
    status: PendingCaptureStatus.matched,
    created_at: T1,
  },
  {
    id: 'cap-out',
    org_id: ORG,
    contact_id: 'c-out',
    type: PendingCaptureType.call,
    raw_data: { notes: 'call with another branch client' },
    phone_number: OUT_PHONE,
    status: PendingCaptureStatus.matched,
    created_at: T2,
  },
  {
    id: 'cap-pending',
    org_id: ORG,
    contact_id: null,
    type: PendingCaptureType.call,
    raw_data: { notes: 'waiting to be matched' },
    phone_number: '+7 900 111-11-11',
    status: PendingCaptureStatus.pending,
    created_at: T2,
  },
];

// Both deals hang off c-in, the contact MGR legitimately sees. d-out is owned by
// the other branch: seeing the contact never made its deal visible.
const DEALS: Row[] = [
  {
    id: 'd-in',
    organization_id: ORG,
    contact_id: 'c-in',
    assigned_to: REP,
    created_by: MGR,
    title: 'in-cone deal',
    value: 100,
    status: DealStatus.open,
    pipeline_id: 'pipe-1',
    stage_id: 'stage-1',
    created_at: T0,
  },
  {
    id: 'd-out',
    organization_id: ORG,
    contact_id: 'c-in',
    assigned_to: OUT,
    created_by: OUT,
    title: 'other branch deal',
    value: 999_000,
    status: DealStatus.open,
    pipeline_id: 'pipe-1',
    stage_id: 'stage-1',
    created_at: T1,
  },
];

const TASKS: Row[] = [
  {
    id: 't-in',
    organization_id: ORG,
    contact_id: 'c-in',
    assigned_to: REP,
    title: 'in-cone task',
    status: TaskStatus.pending,
    due_date: T1,
    created_at: T1,
  },
  {
    id: 't-out',
    organization_id: ORG,
    contact_id: 'c-in',
    assigned_to: OUT,
    title: 'other branch task',
    status: TaskStatus.pending,
    due_date: T2,
    created_at: T2,
  },
];

// m-inbound has NO user_id — an inbound touch belongs to the contact rather than
// to an operator, and the capture-match path writes exactly such a Message.
const MESSAGES: Row[] = [
  { id: 'm-in', organization_id: ORG, contact_id: 'c-in', user_id: MGR, body: 'in-cone message', created_at: T0 },
  { id: 'm-out', organization_id: ORG, contact_id: 'c-in', user_id: OUT, body: 'other branch message', created_at: T1 },
  { id: 'm-inbound', organization_id: ORG, contact_id: 'c-in', user_id: null, body: 'inbound with no operator', created_at: T2 },
];

const EVENTS: Row[] = [
  { id: 'e-in', organization_id: ORG, contact_id: 'c-in', created_by: MGR, title: 'in-cone meeting', created_at: T0 },
  { id: 'e-out', organization_id: ORG, contact_id: 'c-in', created_by: OUT, title: 'other branch meeting', created_at: T1 },
];

// ─── Minimal Prisma-shaped query engine over the fixtures ─────────────────────

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
    if ('not' in c) {
      return c.not === null ? value !== null && value !== undefined : value !== c.not;
    }
    return true;
  }
  return value === cond;
}

/** Resolves a to-one relation named in a where-clause; undefined = not a relation. */
type RelationResolver = (field: string, row: Row) => Row | null | undefined;

function matchesWhere(row: Row, where: Row | undefined, relation?: RelationResolver): boolean {
  if (!where) return true;

  return Object.entries(where).every(([field, cond]) => {
    if (cond === undefined) return true;
    if (field === 'OR') return (cond as Row[]).some((sub) => matchesWhere(row, sub, relation));
    if (field === 'AND') return (cond as Row[]).every((sub) => matchesWhere(row, sub, relation));

    const related = relation?.(field, row);
    if (related !== undefined) {
      // A relation filter on an absent relation matches nothing.
      return related === null ? false : matchesWhere(related, cond as Row, relation);
    }

    return matchField(row[field], cond);
  });
}

type FindArgs = { where?: Row; skip?: number; take?: number } | undefined;

function findRows(rows: Row[], args: FindArgs, relation?: RelationResolver): Row[] {
  const matched = rows.filter((r) => matchesWhere(r, args?.where, relation));
  const skipped = args?.skip ? matched.slice(args.skip) : matched;
  return args?.take ? skipped.slice(0, args.take) : skipped;
}

const captureContactRelation: RelationResolver = (field, row) =>
  field === 'contact' ? CONTACTS.find((c) => c.id === row.contact_id) ?? null : undefined;

/** What GET /captures selects off the joined contact — nothing wider. */
function captureContactProjection(contactId: unknown): Row | null {
  const contact = CONTACTS.find((c) => c.id === contactId);
  if (!contact) return null;
  return {
    id: contact.id,
    first_name: contact.first_name,
    last_name: contact.last_name,
    phone: contact.phone,
  };
}

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  pendingCapture: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  contact: { findFirst: vi.fn(), findMany: vi.fn() },
  deal: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
  task: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  message: { findMany: vi.fn(), create: vi.fn() },
  calendarEvent: { findMany: vi.fn() },
  pipelineStage: { findFirst: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

// Side effects the handlers fire and forget. None of them is under test here;
// stubbing them keeps the assertions about reads and writes to the CRM tables.
vi.mock('../../../backend/services/workflows', () => ({
  evaluateWorkflows: vi.fn(async () => undefined),
}));
vi.mock('../../../backend/api/controllers/activities', () => ({
  logActivity: vi.fn(async () => undefined),
}));
vi.mock('../../../backend/services/notificationEngine', () => ({
  dispatchNotification: vi.fn(async () => undefined),
  dealCtx: vi.fn(async () => null),
  taskCtx: vi.fn(async () => null),
  contactCtx: vi.fn(async () => null),
}));
vi.mock('../../../backend/services/webhooks', () => ({
  fireWebhookEvent: vi.fn(),
}));

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../backend/mcp/server', () => ({
  registerTool: (name: string, _description: string, _schema: unknown, handler: unknown) => {
    registry.set(name, handler);
  },
}));

import { CapturesController } from '../../../backend/api/controllers/captures';
import { ContactsController } from '../../../backend/api/controllers/contacts';
import '../../../backend/mcp/tools/deals';

type ToolHandler = (
  args: Row,
  user: { sub: string; org_id: string; role: string },
) => Promise<Row>;

function tool(name: string): ToolHandler {
  const handler = registry.get(name);
  if (!handler) throw new Error(`tool ${name} was never registered`);
  return handler as ToolHandler;
}

// ─── Request/reply doubles ────────────────────────────────────────────────────

type Reply = {
  statusCode?: number;
  payload?: unknown;
  status: (code: number) => Reply;
  code: (code: number) => Reply;
  send: (body: unknown) => Reply;
};

function makeReply(): Reply {
  const reply = { statusCode: undefined, payload: undefined } as unknown as Reply;
  const setStatus = (code: number): Reply => {
    reply.statusCode = code;
    return reply;
  };
  reply.status = vi.fn(setStatus) as unknown as Reply['status'];
  reply.code = vi.fn(setStatus) as unknown as Reply['code'];
  reply.send = vi.fn((body: unknown) => {
    reply.payload = body;
    return reply;
  }) as unknown as Reply['send'];
  return reply;
}

function makeRequest(
  role: string,
  parts: { params?: Row; query?: Row; body?: Row } = {},
): never {
  const sub = role === 'owner' ? OWNER : MGR;
  return {
    params: parts.params ?? {},
    query: parts.query ?? {},
    body: parts.body ?? {},
    user: { sub, org_id: ORG, role },
  } as never;
}

const ownerUser = { sub: OWNER, org_id: ORG, role: 'owner' };
const memberUser = { sub: MGR, org_id: ORG, role: 'member' };

/** The `where` a mocked Prisma call was handed. */
function whereOf(mock: { mock: { calls: unknown[][] } }, callIndex = 0): Row {
  const args = mock.mock.calls[callIndex]?.[0] as { where?: Row } | undefined;
  return args?.where ?? {};
}

function dataOf(reply: Reply): unknown {
  return (reply.payload as { data?: unknown } | undefined)?.data;
}

function errorOf(res: Row): { code: string; message: string } | undefined {
  return (res as { error?: { code: string; message: string } }).error;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('visibility-cone leaks', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // The recursive-CTE lookup inside getVisibleUserIds. Owner short-circuits on
    // `visibility.all` before reaching it, so this only ever answers for MGR.
    dbMock.$queryRaw.mockImplementation((_strings: unknown, ...values: unknown[]) => {
      const requester = values[0];
      return Promise.resolve(requester === MGR ? CONE.map((id) => ({ id })) : []);
    });

    dbMock.pendingCapture.findMany.mockImplementation((args: FindArgs) =>
      Promise.resolve(
        findRows(CAPTURES, args, captureContactRelation).map((capture) => ({
          ...capture,
          contact: captureContactProjection(capture.contact_id),
        })),
      ),
    );
    dbMock.pendingCapture.findFirst.mockImplementation((args: FindArgs) =>
      Promise.resolve(findRows(CAPTURES, args, captureContactRelation)[0] ?? null),
    );
    dbMock.pendingCapture.update.mockImplementation((args: { where: { id: string }; data: Row }) =>
      Promise.resolve({ ...CAPTURES.find((c) => c.id === args.where.id), ...args.data }),
    );

    dbMock.contact.findFirst.mockImplementation((args: FindArgs) =>
      Promise.resolve(findRows(CONTACTS, args)[0] ?? null),
    );
    dbMock.contact.findMany.mockImplementation((args: FindArgs) => Promise.resolve(findRows(CONTACTS, args)));

    dbMock.deal.findFirst.mockImplementation((args: FindArgs) => Promise.resolve(findRows(DEALS, args)[0] ?? null));
    dbMock.deal.findMany.mockImplementation((args: FindArgs) => Promise.resolve(findRows(DEALS, args)));
    dbMock.deal.count.mockImplementation((args: FindArgs) => Promise.resolve(findRows(DEALS, args).length));
    // Never mutates the fixtures — each test asserts on the call itself.
    dbMock.deal.update.mockImplementation((args: { where: { id: string }; data: Row }) =>
      Promise.resolve({
        ...DEALS.find((d) => d.id === args.where.id),
        ...args.data,
        stage: { id: 'stage-2', name: 'Переговоры', position: 1 },
      }),
    );

    dbMock.task.findMany.mockImplementation((args: FindArgs) => Promise.resolve(findRows(TASKS, args)));
    dbMock.task.count.mockImplementation((args: FindArgs) => Promise.resolve(findRows(TASKS, args).length));
    dbMock.task.create.mockImplementation((args: { data: Row }) => Promise.resolve({ id: 't-new', ...args.data }));

    dbMock.message.findMany.mockImplementation((args: FindArgs) => Promise.resolve(findRows(MESSAGES, args)));
    dbMock.message.create.mockImplementation((args: { data: Row }) => Promise.resolve({ id: 'm-new', ...args.data }));

    dbMock.calendarEvent.findMany.mockImplementation((args: FindArgs) => Promise.resolve(findRows(EVENTS, args)));

    dbMock.pipelineStage.findFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(
        args.where.id === 'stage-2' ? { id: 'stage-2', pipeline_id: 'pipe-1', name: 'Переговоры', position: 1 } : null,
      ),
    );

    dbMock.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        pendingCapture: { update: dbMock.pendingCapture.update },
        message: { create: dbMock.message.create },
        task: { create: dbMock.task.create },
      }),
    );
  });

  // ─── 1. GET /captures ───────────────────────────────────────────────────────

  describe('GET /captures cones the linked contact', () => {
    it('never hands a member another branch\'s contact name or plaintext phone', async () => {
      const reply = makeReply();
      await CapturesController.list(makeRequest('member', { query: { status: 'all' } }), reply as never);

      const data = dataOf(reply) as Array<{ id: string }>;
      expect(data.map((c) => c.id).sort()).toEqual(['cap-in', 'cap-pending', 'cap-unmatched']);

      // The whole payload, not just the ids: neither the ciphertext, nor the
      // number it decrypts to, nor the ФИО may appear anywhere in the response.
      const serialized = JSON.stringify(reply.payload);
      expect(serialized).not.toContain(OUT_PHONE);
      expect(serialized).not.toContain(CONTACTS[1]?.phone as string);
      expect(serialized).not.toContain(OUT_NAME);
      expect(serialized).not.toContain('c-out');
    });

    it('still decrypts the phone of a contact inside the cone', async () => {
      const reply = makeReply();
      await CapturesController.list(makeRequest('member', { query: { status: 'all' } }), reply as never);

      const data = dataOf(reply) as Array<{ id: string; contact?: { phone: string } }>;
      const matched = data.find((c) => c.id === 'cap-in');
      expect(matched?.contact?.phone).toBe(IN_PHONE);
    });

    it('keeps unmatched captures visible — the shared inbox belongs to nobody', async () => {
      const reply = makeReply();
      await CapturesController.list(makeRequest('member', { query: { status: 'pending' } }), reply as never);

      const data = dataOf(reply) as Array<{ id: string }>;
      expect(data.map((c) => c.id).sort()).toEqual(['cap-pending', 'cap-unmatched']);
    });

    it('scopes through the contact relation while keeping the org filter', async () => {
      await CapturesController.list(makeRequest('member', { query: { status: 'all' } }), makeReply() as never);

      expect(whereOf(dbMock.pendingCapture.findMany)).toMatchObject({
        org_id: ORG,
        OR: [
          { contact_id: null },
          { contact: { OR: [{ assigned_to: { in: CONE } }, { created_by: { in: CONE } }] } },
        ],
      });
    });

    it('leaves an owner unrestricted', async () => {
      const reply = makeReply();
      await CapturesController.list(makeRequest('owner', { query: { status: 'all' } }), reply as never);

      const data = dataOf(reply) as Array<{ id: string }>;
      expect(data.map((c) => c.id)).toContain('cap-out');
      expect(JSON.stringify(reply.payload)).toContain(OUT_PHONE);
      expect(whereOf(dbMock.pendingCapture.findMany)).not.toHaveProperty('OR');
      expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ─── 2. POST /captures/:id/match ────────────────────────────────────────────

  describe('POST /captures/:id/match cones the target contact', () => {
    const matchRequest = (role: string, contactId: string): never =>
      makeRequest(role, { params: { id: 'cap-pending' }, body: { contact_id: contactId } });

    it('refuses to match a member\'s capture onto an out-of-cone contact, and writes nothing', async () => {
      const reply = makeReply();
      await CapturesController.match(matchRequest('member', 'c-out'), reply as never);

      expect(reply.statusCode).toBe(404);
      expect((reply.payload as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      // The point of the defect: this endpoint WRITES. Nothing may have landed.
      expect(dbMock.$transaction).not.toHaveBeenCalled();
      expect(dbMock.message.create).not.toHaveBeenCalled();
      expect(dbMock.task.create).not.toHaveBeenCalled();
      expect(dbMock.pendingCapture.update).not.toHaveBeenCalled();
    });

    it('answers an out-of-cone contact exactly as it answers a nonexistent one', async () => {
      const outOfCone = makeReply();
      await CapturesController.match(matchRequest('member', 'c-out'), outOfCone as never);

      const missing = makeReply();
      await CapturesController.match(matchRequest('member', 'c-nope'), missing as never);

      expect(outOfCone.statusCode).toBe(missing.statusCode);
      expect(outOfCone.payload).toEqual(missing.payload);
    });

    it('still matches onto a contact inside the cone', async () => {
      const reply = makeReply();
      await CapturesController.match(matchRequest('member', 'c-in'), reply as never);

      expect(reply.statusCode).toBeUndefined();
      expect(dbMock.message.create).toHaveBeenCalledTimes(1);
      expect(dbMock.task.create).toHaveBeenCalledTimes(1);
      expect((dataOf(reply) as { follow_up_task_created: boolean }).follow_up_task_created).toBe(true);
    });

    it('lets an owner match onto any contact in the org', async () => {
      const reply = makeReply();
      await CapturesController.match(matchRequest('owner', 'c-out'), reply as never);

      expect(reply.statusCode).toBeUndefined();
      expect(dbMock.message.create).toHaveBeenCalledTimes(1);
      expect(dbMock.task.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 3. move_deal_to_stage (MCP) ────────────────────────────────────────────

  describe('move_deal_to_stage matches its REST twin', () => {
    it('refuses to move an out-of-cone deal and writes nothing', async () => {
      const res = await tool('move_deal_to_stage')({ id: 'd-out', stage_id: 'stage-2' }, memberUser);

      expect(errorOf(res)?.code).toBe('DEAL_NOT_FOUND');
      expect(res.data).toBeUndefined();
      expect(dbMock.deal.update).not.toHaveBeenCalled();
    });

    it('hides the out-of-cone deal behind the same error as a bad id', async () => {
      const outOfCone = await tool('move_deal_to_stage')({ id: 'd-out', stage_id: 'stage-2' }, memberUser);
      const nonExistent = await tool('move_deal_to_stage')({ id: 'd-nope', stage_id: 'stage-2' }, memberUser);

      expect(errorOf(outOfCone)).toEqual(errorOf(nonExistent));
    });

    it('still moves a deal inside the cone', async () => {
      const res = await tool('move_deal_to_stage')({ id: 'd-in', stage_id: 'stage-2' }, memberUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.deal.update).toHaveBeenCalledTimes(1);
      expect(dbMock.deal.update.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'd-in', organization_id: ORG },
        data: { stage_id: 'stage-2' },
      });
    });

    it('leaves an owner unrestricted', async () => {
      const res = await tool('move_deal_to_stage')({ id: 'd-out', stage_id: 'stage-2' }, ownerUser);

      expect(errorOf(res)).toBeUndefined();
      expect(dbMock.deal.update).toHaveBeenCalledTimes(1);
      expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ─── 4. /contacts/:id/{deals,tasks,activity} ────────────────────────────────

  describe('contact children are coned, not just the contact', () => {
    const childRequest = (role: string): never => makeRequest(role, { params: { id: 'c-in' } });

    it('getDeals: a member sees only the deals in their branch', async () => {
      const reply = makeReply();
      await ContactsController.getDeals(childRequest('member'), reply as never);

      const deals = dataOf(reply) as Array<{ id: string }>;
      expect(deals.map((d) => d.id)).toEqual(['d-in']);
      expect(JSON.stringify(reply.payload)).not.toContain('other branch deal');
      // The value of another branch's deal is the part that actually matters.
      expect(JSON.stringify(reply.payload)).not.toContain('999000');
    });

    it('getDeals: an owner sees every deal on the contact', async () => {
      const reply = makeReply();
      await ContactsController.getDeals(childRequest('owner'), reply as never);

      const deals = dataOf(reply) as Array<{ id: string }>;
      expect(deals.map((d) => d.id).sort()).toEqual(['d-in', 'd-out']);
    });

    it('getTasks: a member sees only the tasks in their branch', async () => {
      const reply = makeReply();
      await ContactsController.getTasks(childRequest('member'), reply as never);

      const tasks = dataOf(reply) as Array<{ id: string }>;
      expect(tasks.map((t) => t.id)).toEqual(['t-in']);
      expect(JSON.stringify(reply.payload)).not.toContain('other branch task');
    });

    it('getTasks: an owner sees every task on the contact', async () => {
      const reply = makeReply();
      await ContactsController.getTasks(childRequest('owner'), reply as never);

      const tasks = dataOf(reply) as Array<{ id: string }>;
      expect(tasks.map((t) => t.id).sort()).toEqual(['t-in', 't-out']);
    });

    it('getActivity: a member\'s timeline drops the other branch\'s entries', async () => {
      const reply = makeReply();
      await ContactsController.getActivity(childRequest('member'), reply as never);

      const timeline = dataOf(reply) as { contact_id: string; items: Array<{ id: string }> };
      expect(timeline.contact_id).toBe('c-in');
      expect(timeline.items.map((i) => i.id).sort()).toEqual(['e-in', 'm-in', 'm-inbound', 't-in']);

      const serialized = JSON.stringify(reply.payload);
      expect(serialized).not.toContain('other branch message');
      expect(serialized).not.toContain('other branch task');
      expect(serialized).not.toContain('other branch meeting');
    });

    it('getActivity: an owner\'s timeline is the whole contact history', async () => {
      const reply = makeReply();
      await ContactsController.getActivity(childRequest('owner'), reply as never);

      const timeline = dataOf(reply) as { items: Array<{ id: string }> };
      expect(timeline.items.map((i) => i.id).sort()).toEqual(['e-in', 'e-out', 'm-in', 'm-inbound', 'm-out', 't-in', 't-out']);
    });

    it('getActivity: an unowned inbound message stays on the timeline', async () => {
      // A Message with a NULL user_id — what the capture-match path writes — is
      // the contact's, not an operator's. Coning it away would empty the very
      // history the screen exists to show.
      const reply = makeReply();
      await ContactsController.getActivity(childRequest('member'), reply as never);

      const timeline = dataOf(reply) as { items: Array<{ id: string }> };
      expect(timeline.items.map((i) => i.id)).toContain('m-inbound');
    });

    it('an out-of-cone contact is still refused outright by all three', async () => {
      for (const handler of [ContactsController.getDeals, ContactsController.getTasks, ContactsController.getActivity]) {
        const reply = makeReply();
        await handler(makeRequest('member', { params: { id: 'c-out' } }), reply as never);

        expect(reply.statusCode).toBe(404);
        expect((reply.payload as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      }
    });
  });
});
