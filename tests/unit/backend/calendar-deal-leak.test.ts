/**
 * THE PIPELINE LEAK THAT DOES NOT LIVE ON A /deals URL.
 *
 * `deals.read` is enforced in api/authenticate.ts by matching the request PATH,
 * and nothing there matches `/api/v1/calendar` or `/api/v1/tasks`. So `support`
 * — the one role the gate exists to exclude, defined as "contact record and
 * activity, no pipeline, no money" — read deal identity through the calendar:
 *
 *   1. GET /api/v1/tasks returned whole Task rows including `deal_id`, handing
 *      out real deal UUIDs. That is the step that turns the oracles below from
 *      "guess a v4 UUID" into a working attack.
 *   2. POST /api/v1/calendar with that deal_id answered 201 or 403 depending on
 *      whether the deal exists in the org — dealBelongsToOrg is org-wide with no
 *      capability of its own — so it was a free existence oracle.
 *   3. GET /api/v1/calendar then returned `deal: { id, title }` on every event,
 *      and `?deal_id=` filtered by a deal the caller may not read.
 *
 * The fix is field-level omission, not a 403 on the route: support legitimately
 * has a calendar and tasks. Both the RELATION and the `deal_id` SCALAR have to
 * go — dropping only the `include` leaves the linkage on every row, which is
 * also what would make ignoring the filter pointless.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  calendarEvent: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  deal: { findFirst: vi.fn() },
  contact: { findFirst: vi.fn() },
  task: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

vi.mock('../../../backend/services/visibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../backend/services/visibility')>();
  return {
    ...actual,
    getVisibleUserIds: vi.fn(async () => null),
    getAccessibleUserIds: vi.fn(async () => null),
  };
});

vi.mock('../../../backend/services/yandex-calendar', () => ({
  yandexConfigured: () => false,
  resolveYandexRedirectUri: () => '',
  buildYandexOAuthUrl: () => '',
  handleYandexOAuthCallback: vi.fn(),
  disconnectYandexSync: vi.fn(),
  getYandexSyncStatus: vi.fn(),
  syncYandexEventForUser: vi.fn(async () => undefined),
  deleteYandexEventForUser: vi.fn(async () => undefined),
  extractYandexWebhookSecret: vi.fn(),
  readConfiguredWebhookSecret: vi.fn(),
  timingSafeEqualString: vi.fn(),
  verifyState: vi.fn(),
}));

vi.mock('../../../backend/services/audit', () => ({
  auditLog: vi.fn(async () => undefined),
  listAuditEvents: vi.fn(async () => ({ data: [], total: 0 })),
}));

import { CalendarController } from '../../../backend/api/controllers/calendar';
import { listTasksForUser } from '../../../backend/services/task-domain';

const ORG = '00000000-0000-4000-a000-000000000001';
const DEAL = '00000000-0000-4000-a000-0000000000d1';
const SUPPORT = { sub: 'u-support', org_id: ORG, role: 'support' };
const MEMBER = { sub: 'u-member', org_id: ORG, role: 'member' };

function createReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn(function setStatus(this: Record<string, unknown>, code: number) {
      this.statusCode = code;
      return this;
    }),
    code: vi.fn(function setCode(this: Record<string, unknown>, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function send(this: Record<string, unknown>, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };
  return reply as unknown as {
    statusCode: number;
    payload: unknown;
    send: ReturnType<typeof vi.fn>;
  };
}

const EVENT_ROW = {
  id: 'ev-1',
  title: 'Встреча',
  organization_id: ORG,
  created_by: 'u-member',
  contact_id: null,
  deal_id: DEAL,
  deal: { id: DEAL, title: 'Ромашка — поставка' },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.calendarEvent.count.mockResolvedValue(1);
  dbMock.calendarEvent.findMany.mockResolvedValue([{ ...EVENT_ROW }]);
  dbMock.calendarEvent.findFirst.mockResolvedValue({ ...EVENT_ROW });
  dbMock.calendarEvent.create.mockResolvedValue({ ...EVENT_ROW });
  dbMock.deal.findFirst.mockResolvedValue({ id: DEAL });
  dbMock.contact.findFirst.mockResolvedValue({ id: 'c-1' });
  dbMock.task.count.mockResolvedValue(1);
  dbMock.task.findMany.mockResolvedValue([
    { id: 't-1', title: 'Позвонить', organization_id: ORG, deal_id: DEAL, assigned_to: 'u-support' },
  ]);
});

describe('the calendar withholds deal data from a role without deals.read', () => {
  it('does not return the deal relation or the deal_id scalar in the list', async () => {
    const reply = createReply();
    await CalendarController.list(
      { user: SUPPORT, query: { page: 1, per_page: 20 } } as never,
      reply as never,
    );

    const body = JSON.stringify(reply.payload);
    expect(body).not.toContain('Ромашка — поставка');
    // The scalar too. Dropping only the `include` leaves this on every row and
    // the linkage is disclosed anyway.
    expect(body).not.toContain(DEAL);
  });

  it('does not return them from the single-event read either', async () => {
    const reply = createReply();
    await CalendarController.getById(
      { user: SUPPORT, params: { id: 'ev-1' } } as never,
      reply as never,
    );

    const body = JSON.stringify(reply.payload);
    expect(body).not.toContain('Ромашка — поставка');
    expect(body).not.toContain(DEAL);
  });

  it('ignores a ?deal_id= filter rather than answering it', async () => {
    await CalendarController.list(
      { user: SUPPORT, query: { page: 1, per_page: 20, deal_id: DEAL } } as never,
      createReply() as never,
    );

    const where = dbMock.calendarEvent.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // Ignored, NOT rejected: a 400 would answer the same question the filter
    // was asking.
    expect(where).not.toHaveProperty('deal_id');
  });

  it('never queries the deal when creating an event, so there is no existence oracle', async () => {
    const reply = createReply();
    await CalendarController.create(
      {
        user: SUPPORT,
        body: {
          title: 'x',
          start_time: '2026-09-01T10:00:00.000Z',
          end_time: '2026-09-01T11:00:00.000Z',
          deal_id: DEAL,
          reminder_minutes: 10,
          send_invite: false,
        },
      } as never,
      reply as never,
    );

    // The deal must not be looked up at all — and the refusal must be the SAME
    // body an out-of-org deal produces, or the two are still distinguishable.
    expect(dbMock.deal.findFirst).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: { code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    });
  });
});

/**
 * THE POSITIVE CONTROLS. Without these the fix could "pass" by deleting the deal
 * relation for everybody, which would break the calendar for every sales role.
 */
describe('a role WITH deals.read still sees everything it did', () => {
  it('gets the deal relation in the list', async () => {
    const reply = createReply();
    await CalendarController.list(
      { user: MEMBER, query: { page: 1, per_page: 20 } } as never,
      reply as never,
    );

    const include = dbMock.calendarEvent.findMany.mock.calls[0][0].include as Record<string, unknown>;
    expect(include).toHaveProperty('deal');
    expect(JSON.stringify(reply.payload)).toContain('Ромашка — поставка');
  });

  it('can still filter by deal_id', async () => {
    await CalendarController.list(
      { user: MEMBER, query: { page: 1, per_page: 20, deal_id: DEAL } } as never,
      createReply() as never,
    );

    const where = dbMock.calendarEvent.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.deal_id).toBe(DEAL);
  });

  it('can still attach a deal to a new event', async () => {
    const reply = createReply();
    await CalendarController.create(
      {
        user: MEMBER,
        body: {
          title: 'x',
          start_time: '2026-09-01T10:00:00.000Z',
          end_time: '2026-09-01T11:00:00.000Z',
          deal_id: DEAL,
          reminder_minutes: 10,
          send_invite: false,
        },
      } as never,
      reply as never,
    );

    expect(dbMock.deal.findFirst).toHaveBeenCalled();
    expect(reply.statusCode).toBe(201);
  });
});

describe('the task list stops handing out deal UUIDs', () => {
  it('strips deal_id for a role without deals.read', async () => {
    const result = await listTasksForUser(ORG, SUPPORT, {});

    // This is the harvesting step. Without it the attacker has to guess a v4
    // UUID and the whole chain collapses to a theoretical oracle.
    expect(result.data[0]).not.toHaveProperty('deal_id');
  });

  it('keeps deal_id for a role with deals.read', async () => {
    const result = await listTasksForUser(ORG, MEMBER, {});
    expect(result.data[0]).toHaveProperty('deal_id', DEAL);
  });

  it('ignores a deal_id filter for a role without deals.read', async () => {
    await listTasksForUser(ORG, SUPPORT, { deal_id: DEAL });

    const where = dbMock.task.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty('deal_id');
  });
});
