import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DealStatus, TaskStatus } from '@prisma/client';
import { DEFAULT_CURRENCY } from '../../../backend/config/market';

// ─── Fixture world ────────────────────────────────────────────────────────────
// One org, four users. MGR is a `member` who manages REP; OUT sits in a
// different branch entirely, so nothing of OUT's may ever reach MGR.

const ORG = '11111111-1111-4111-8111-000000000001';
const OWNER = '11111111-1111-4111-8111-00000000000a';
const MGR = '11111111-1111-4111-8111-00000000000b';
const REP = '11111111-1111-4111-8111-00000000000c';
const OUT = '11111111-1111-4111-8111-00000000000d';

const CONE = [MGR, REP];

const YESTERDAY = new Date(Date.now() - 86_400_000);
const LONG_AGO = new Date(Date.now() - 400 * 86_400_000);

const TODAY_UTC = new Date();
TODAY_UTC.setUTCHours(12, 0, 0, 0);

type DealRow = {
  id: string;
  organization_id: string;
  assigned_to: string | null;
  status: DealStatus;
  value: number;
  currency: string;
  source: string | null;
  pipeline_id: string;
  stage_id: string;
  created_at: Date;
  updated_at: Date;
  actual_close: Date | null;
  stage: { position: number };
};

function deal(
  id: string,
  assigned_to: string | null,
  status: DealStatus,
  value: number,
  source: string,
  stage_id: string,
  position: number,
  updated_at: Date = YESTERDAY,
): DealRow {
  return {
    id,
    organization_id: ORG,
    assigned_to,
    status,
    value,
    currency: DEFAULT_CURRENCY,
    source,
    pipeline_id: 'pipe-1',
    stage_id,
    created_at: YESTERDAY,
    updated_at,
    actual_close: status === DealStatus.won ? YESTERDAY : null,
    stage: { position },
  };
}

// In-cone: one won (100) for MGR, one open (200) for REP.
// Out-of-cone: one won (1000), one lost (700), one stalled-open (400) for OUT.
const DEALS: DealRow[] = [
  deal('d-mgr-won', MGR, DealStatus.won, 100, 'ads', 'stage-2', 1),
  deal('d-rep-open', REP, DealStatus.open, 200, 'ads', 'stage-1', 0),
  deal('d-out-won', OUT, DealStatus.won, 1000, 'cold', 'stage-2', 1),
  deal('d-out-lost', OUT, DealStatus.lost, 700, 'cold', 'stage-1', 0),
  deal('d-out-open', OUT, DealStatus.open, 400, 'cold', 'stage-1', 0, LONG_AGO),
];

const TASKS = [
  { id: 't-mgr', organization_id: ORG, assigned_to: MGR, title: 'cone task', status: TaskStatus.pending, due_date: TODAY_UTC, created_at: YESTERDAY },
  { id: 't-out', organization_id: ORG, assigned_to: OUT, title: 'other branch task', status: TaskStatus.pending, due_date: TODAY_UTC, created_at: YESTERDAY },
];

const MESSAGES = [
  { id: 'm-mgr', organization_id: ORG, user_id: MGR, body: 'cone message', created_at: YESTERDAY },
  { id: 'm-out', organization_id: ORG, user_id: OUT, body: 'confidential other-branch message', created_at: YESTERDAY },
];

const EVENTS = [
  { id: 'e-mgr', organization_id: ORG, created_by: MGR, title: 'cone meeting', created_at: YESTERDAY },
  { id: 'e-out', organization_id: ORG, created_by: OUT, title: 'other branch meeting', created_at: YESTERDAY },
];

const USERS = [
  { id: OWNER, organization_id: ORG, name: 'Owner' },
  { id: MGR, organization_id: ORG, name: 'Manager' },
  { id: REP, organization_id: ORG, name: 'Rep' },
  { id: OUT, organization_id: ORG, name: 'Outsider' },
];

// ─── Minimal Prisma-shaped query engine over the fixtures ─────────────────────

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return (a as number) - (b as number);
}

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
    let ok = true;
    if (c.gte !== undefined) ok = ok && compare(value, c.gte) >= 0;
    if (c.gt !== undefined) ok = ok && compare(value, c.gt) > 0;
    if (c.lte !== undefined) ok = ok && compare(value, c.lte) <= 0;
    if (c.lt !== undefined) ok = ok && compare(value, c.lt) < 0;
    return ok;
  }
  return value === cond;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => matchField(row[field], cond));
}

type GroupByArgs = { by: string[]; where?: Record<string, unknown> };

function groupRows(rows: DealRow[], args: GroupByArgs): Array<Record<string, unknown>> {
  const matched = rows.filter((r) => matchesWhere(r as unknown as Record<string, unknown>, args.where));
  const groups = new Map<string, { key: Record<string, unknown>; count: number; sum: number }>();
  for (const row of matched) {
    const key: Record<string, unknown> = {};
    for (const field of args.by) key[field] = (row as unknown as Record<string, unknown>)[field] ?? null;
    const id = JSON.stringify(args.by.map((f) => key[f]));
    const entry = groups.get(id) ?? { key, count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += row.value;
    groups.set(id, entry);
  }
  return Array.from(groups.values()).map((g) => ({
    ...g.key,
    _count: { _all: g.count },
    _sum: { value: g.sum },
  }));
}

function findRows<T extends Record<string, unknown>>(
  rows: T[],
  args: { where?: Record<string, unknown>; take?: number } | undefined,
): T[] {
  const matched = rows.filter((r) => matchesWhere(r, args?.where));
  return args?.take ? matched.slice(0, args.take) : matched;
}

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  org: { findUniqueOrThrow: vi.fn() },
  deal: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  task: { count: vi.fn(), findMany: vi.fn() },
  message: { findMany: vi.fn() },
  calendarEvent: { findMany: vi.fn() },
  pipeline: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
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

import '../../../backend/mcp/tools/analytics';

function tool(name: string): ToolHandler {
  const handler = registry.get(name);
  if (!handler) throw new Error(`tool ${name} was never registered`);
  return handler as ToolHandler;
}

const ownerUser = { sub: OWNER, org_id: ORG, role: 'owner' };
const memberUser = { sub: MGR, org_id: ORG, role: 'member' };

/** The `where` the tool handed to a given mocked Prisma call. */
function whereOf(mock: { mock: { calls: unknown[][] } }, callIndex = 0): Record<string, unknown> {
  const args = mock.mock.calls[callIndex]?.[0] as { where?: Record<string, unknown> } | undefined;
  return args?.where ?? {};
}

describe('MCP analytics tools respect the manager visibility cone', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // The recursive-CTE lookup inside getVisibleUserIds('subtree'). Owner/admin
    // short-circuit before reaching it, so this only ever answers for MGR.
    dbMock.$queryRaw.mockImplementation((_strings: unknown, ...values: unknown[]) => {
      const requester = values[0];
      return Promise.resolve(requester === MGR ? CONE.map((id) => ({ id })) : []);
    });

    dbMock.org.findUniqueOrThrow.mockResolvedValue({ stalled_threshold_days: 30, decay_factor: 0.5 });
    dbMock.deal.groupBy.mockImplementation((args: GroupByArgs) => Promise.resolve(groupRows(DEALS, args)));
    dbMock.deal.count.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(findRows(DEALS as unknown as Array<Record<string, unknown>>, args).length),
    );
    dbMock.deal.findMany.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(findRows(DEALS as unknown as Array<Record<string, unknown>>, args)),
    );
    dbMock.task.count.mockImplementation((args: { where?: Record<string, unknown> }) =>
      Promise.resolve(findRows(TASKS as unknown as Array<Record<string, unknown>>, args).length),
    );
    dbMock.task.findMany.mockImplementation((args: { where?: Record<string, unknown>; take?: number }) =>
      Promise.resolve(findRows(TASKS as unknown as Array<Record<string, unknown>>, args)),
    );
    dbMock.message.findMany.mockImplementation((args: { where?: Record<string, unknown>; take?: number }) =>
      Promise.resolve(findRows(MESSAGES as unknown as Array<Record<string, unknown>>, args)),
    );
    dbMock.calendarEvent.findMany.mockImplementation((args: { where?: Record<string, unknown>; take?: number }) =>
      Promise.resolve(findRows(EVENTS as unknown as Array<Record<string, unknown>>, args)),
    );
    dbMock.pipeline.findMany.mockResolvedValue([
      {
        id: 'pipe-1',
        name: 'Воронка продаж',
        stages: [
          { id: 'stage-1', name: 'Новый лид', position: 0 },
          { id: 'stage-2', name: 'Сделка выиграна', position: 1 },
        ],
      },
    ]);
    dbMock.user.findMany.mockImplementation((args: { where?: { id?: { in: string[] } } }) => {
      const ids = args.where?.id?.in ?? [];
      return Promise.resolve(USERS.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, name: u.name })));
    });
  });

  // ─── get_dashboard ──────────────────────────────────────────────────────────

  describe('get_dashboard', () => {
    it('gives the owner org-wide totals', async () => {
      const res = await tool('get_dashboard')({}, ownerUser);
      const data = res.data as Record<string, never> & {
        open_deals: { count: number; total_value: number };
        tasks_due_today: number;
        recent_activity: Array<{ summary: string }>;
        pipeline_health_score: number;
      };

      expect(data.open_deals).toEqual({ count: 2, total_value: 600 });
      expect(data.tasks_due_today).toBe(2);
      // won 2 / (won 2 + lost 1 + stalled 1 × 0.5)
      expect(data.pipeline_health_score).toBeCloseTo(57.14, 2);
      expect(data.recent_activity.map((a) => a.summary)).toContain('confidential other-branch message');
      expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('restricts a member to their own branch, including message bodies', async () => {
      const res = await tool('get_dashboard')({}, memberUser);
      const data = res.data as {
        open_deals: { count: number; total_value: number };
        tasks_due_today: number;
        recent_activity: Array<{ summary: string }>;
        pipeline_health_score: number;
      };

      expect(data.open_deals).toEqual({ count: 1, total_value: 200 });
      expect(data.tasks_due_today).toBe(1);
      // won 1 / (won 1 + lost 0 + stalled 0)
      expect(data.pipeline_health_score).toBe(100);

      const summaries = data.recent_activity.map((a) => a.summary);
      expect(summaries).toContain('cone message');
      expect(summaries).not.toContain('confidential other-branch message');
      expect(summaries).not.toContain('other branch task');
      expect(summaries).not.toContain('other branch meeting');
    });

    it('narrows each collection on its own user column', async () => {
      await tool('get_dashboard')({}, memberUser);

      expect(whereOf(dbMock.deal.groupBy)).toMatchObject({ assigned_to: { in: CONE } });
      expect(whereOf(dbMock.task.count)).toMatchObject({ assigned_to: { in: CONE } });
      expect(whereOf(dbMock.message.findMany)).toMatchObject({ user_id: { in: CONE } });
      expect(whereOf(dbMock.task.findMany)).toMatchObject({ assigned_to: { in: CONE } });
      expect(whereOf(dbMock.calendarEvent.findMany)).toMatchObject({ created_by: { in: CONE } });
      expect(whereOf(dbMock.deal.count)).toMatchObject({ assigned_to: { in: CONE } });
    });
  });

  // ─── get_pipeline_health ────────────────────────────────────────────────────

  describe('get_pipeline_health', () => {
    it('counts every deal in the pipeline for the owner', async () => {
      const res = await tool('get_pipeline_health')({}, ownerUser);
      const [pipeline] = res.data as Array<{ transitions: Array<{ entered_count: number; progressed_count: number }> }>;

      // All five deals sit at position >= 0; two are won and at position 1.
      expect(pipeline?.transitions[0]).toMatchObject({ entered_count: 5, progressed_count: 2 });
      expect(whereOf(dbMock.deal.findMany)).not.toHaveProperty('assigned_to');
    });

    it('counts only in-cone deals for a member', async () => {
      const res = await tool('get_pipeline_health')({}, memberUser);
      const [pipeline] = res.data as Array<{ transitions: Array<{ entered_count: number; progressed_count: number }> }>;

      expect(pipeline?.transitions[0]).toMatchObject({ entered_count: 2, progressed_count: 1 });
      expect(whereOf(dbMock.deal.findMany)).toMatchObject({ assigned_to: { in: CONE } });
    });
  });

  // ─── get_funnel ─────────────────────────────────────────────────────────────

  describe('get_funnel', () => {
    it('sums the whole org for the owner', async () => {
      const res = await tool('get_funnel')({}, ownerUser);
      const data = res.data as { summary: { total_deals: number; total_won: number; total_lost: number; total_value: number } };

      expect(data.summary).toMatchObject({ total_deals: 5, total_won: 2, total_lost: 1, total_value: 2400 });
    });

    it('sums only the member branch', async () => {
      const res = await tool('get_funnel')({}, memberUser);
      const data = res.data as { summary: { total_deals: number; total_won: number; total_lost: number; total_value: number } };

      expect(data.summary).toMatchObject({ total_deals: 2, total_won: 1, total_lost: 0, total_value: 300 });
    });

    it('cannot be widened by passing an out-of-cone assigned_to', async () => {
      const res = await tool('get_funnel')({ assigned_to: OUT }, memberUser);
      const data = res.data as { summary: { total_deals: number; total_value: number } };

      expect(whereOf(dbMock.deal.groupBy)).toMatchObject({ assigned_to: { in: [] } });
      expect(data.summary).toMatchObject({ total_deals: 0, total_value: 0 });
    });

    it('still lets a member filter down to one of their own reports', async () => {
      const res = await tool('get_funnel')({ assigned_to: REP }, memberUser);
      const data = res.data as { summary: { total_deals: number; total_value: number } };

      expect(whereOf(dbMock.deal.groupBy)).toMatchObject({ assigned_to: { in: [REP] } });
      expect(data.summary).toMatchObject({ total_deals: 1, total_value: 200 });
    });

    it('leaves an owner-supplied assignee filter untouched', async () => {
      await tool('get_funnel')({ assigned_to: OUT }, ownerUser);
      expect(whereOf(dbMock.deal.groupBy)).toMatchObject({ assigned_to: OUT });
    });
  });

  // ─── get_revenue ────────────────────────────────────────────────────────────

  describe('get_revenue', () => {
    it('reports org-wide won revenue for the owner', async () => {
      const res = await tool('get_revenue')({}, ownerUser);
      const data = res.data as { summary: { total_revenue: number; total_deals: number } };

      expect(data.summary).toMatchObject({ total_revenue: 1100, total_deals: 2 });
    });

    it('reports only in-cone won revenue for a member', async () => {
      const res = await tool('get_revenue')({}, memberUser);
      const data = res.data as { summary: { total_revenue: number; total_deals: number } };

      expect(data.summary).toMatchObject({ total_revenue: 100, total_deals: 1 });
      expect(whereOf(dbMock.deal.findMany)).toMatchObject({ assigned_to: { in: CONE } });
    });
  });

  // ─── get_rep_performance ────────────────────────────────────────────────────

  describe('get_rep_performance', () => {
    it('enumerates every rep for the owner', async () => {
      const res = await tool('get_rep_performance')({}, ownerUser);
      const data = res.data as Array<{ user_id: string; name: string; total_value: number; win_rate: number }>;

      expect(data.map((r) => r.user_id).sort()).toEqual([MGR, REP, OUT].sort());
      expect(data.find((r) => r.user_id === OUT)).toMatchObject({ name: 'Outsider', total_value: 2100 });
    });

    it('never names or scores a rep outside the member cone', async () => {
      const res = await tool('get_rep_performance')({}, memberUser);
      const data = res.data as Array<{ user_id: string; name: string; total_value: number; win_rate: number }>;

      expect(data.map((r) => r.user_id).sort()).toEqual([MGR, REP].sort());
      expect(data.some((r) => r.user_id === OUT)).toBe(false);
      expect(data.find((r) => r.user_id === MGR)).toMatchObject({ deals_won: 1, win_rate: 100, total_value: 100 });

      // The rep set itself is bounded, not just the aggregates.
      expect(whereOf(dbMock.deal.groupBy)).toMatchObject({ assigned_to: { in: CONE } });
      const userWhere = dbMock.user.findMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } } };
      expect(userWhere.where.id.in).not.toContain(OUT);
    });
  });

  // ─── get_lead_sources ───────────────────────────────────────────────────────

  describe('get_lead_sources', () => {
    it('shows every source to the owner', async () => {
      const res = await tool('get_lead_sources')({}, ownerUser);
      const data = res.data as Array<{ source: string; count: number; total_value: number }>;

      expect(data.find((r) => r.source === 'ads')).toMatchObject({ count: 2, total_value: 300 });
      expect(data.find((r) => r.source === 'cold')).toMatchObject({ count: 3, total_value: 2100 });
    });

    it('hides sources that exist only outside the member cone', async () => {
      const res = await tool('get_lead_sources')({}, memberUser);
      const data = res.data as Array<{ source: string; count: number; total_value: number }>;

      expect(data.find((r) => r.source === 'ads')).toMatchObject({ count: 2, total_value: 300 });
      expect(data.find((r) => r.source === 'cold')).toBeUndefined();
      expect(whereOf(dbMock.deal.groupBy)).toMatchObject({ assigned_to: { in: CONE } });
    });
  });
});
