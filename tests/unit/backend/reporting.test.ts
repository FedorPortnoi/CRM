import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  org: { findUniqueOrThrow: vi.fn() },
  pipeline: { findMany: vi.fn() },
  pipelineStage: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  deal: { groupBy: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
  task: { groupBy: vi.fn() },
  activityLog: { groupBy: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

import {
  buildFunnelStages,
  getPipelineHealth,
  getRepPerformance,
  getRevenueOverTime,
  getSalesFunnel,
  getWinLossAnalysis,
  pipelineHealthScore,
  resolveReportRange,
  truncateToBucket,
} from '../../../backend/services/reporting';

const ORG_ID = '00000000-0000-4000-a000-0000000000aa';
const OTHER_ORG_ID = '00000000-0000-4000-a000-0000000000bb';
const OWNER_ID = '00000000-0000-4000-a000-000000000001';
const MANAGER_ID = '00000000-0000-4000-a000-000000000002';
const REPORT_ID = '00000000-0000-4000-a000-000000000003';
const OUTSIDER_ID = '00000000-0000-4000-a000-000000000004';

const CONE = [MANAGER_ID, REPORT_ID];

type Requester = { sub: string; org_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' };

const owner: Requester = { sub: OWNER_ID, org_id: ORG_ID, role: 'owner' };
const member: Requester = { sub: MANAGER_ID, org_id: ORG_ID, role: 'member' };

type SqlLike = { strings: string[]; values: unknown[] };

function isTemplateStrings(value: unknown): boolean {
  return Array.isArray(value);
}

/** Every `where` object handed to a mocked Prisma method, across every model. */
function allWheres(): Array<Record<string, unknown>> {
  const calls = [
    ...dbMock.deal.groupBy.mock.calls,
    ...dbMock.deal.aggregate.mock.calls,
    ...dbMock.deal.count.mock.calls,
    ...dbMock.task.groupBy.mock.calls,
    ...dbMock.activityLog.groupBy.mock.calls,
    ...dbMock.user.findMany.mock.calls,
    ...dbMock.pipeline.findMany.mock.calls,
  ];
  return calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
}

function wheresOf(mockFn: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return mockFn.mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
}

beforeEach(() => {
  vi.clearAllMocks();

  dbMock.$queryRaw.mockImplementation((...args: unknown[]) =>
    // visibility.ts calls $queryRaw as a tagged template; the revenue report passes a Prisma.Sql.
    Promise.resolve(isTemplateStrings(args[0]) ? CONE.map((id) => ({ id })) : []),
  );
  dbMock.org.findUniqueOrThrow.mockResolvedValue({
    stalled_threshold_days: 30,
    decay_factor: 0.5,
    settings: null,
  });
  dbMock.pipeline.findMany.mockResolvedValue([]);
  dbMock.pipelineStage.findMany.mockResolvedValue([]);
  dbMock.user.findMany.mockResolvedValue([]);
  dbMock.deal.groupBy.mockResolvedValue([]);
  dbMock.deal.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { value: null } });
  dbMock.deal.count.mockResolvedValue(0);
  dbMock.task.groupBy.mockResolvedValue([]);
  dbMock.activityLog.groupBy.mockResolvedValue([]);
});

// ─── Pipeline Health Score ────────────────────────────────────────────────────

describe('pipelineHealthScore', () => {
  it('returns 0 when there are no deals at all', () => {
    expect(pipelineHealthScore({ won: 0, lost: 0, stalled: 0, decay_factor: 0.5 })).toBe(0);
  });

  it('returns 100 when every decided deal was won and nothing is stalled', () => {
    expect(pipelineHealthScore({ won: 5, lost: 0, stalled: 0, decay_factor: 0.5 })).toBe(100);
    expect(pipelineHealthScore({ won: 1, lost: 0, stalled: 0, decay_factor: 2 })).toBe(100);
  });

  it('returns 0 when everything is stalled and nothing has been won', () => {
    expect(pipelineHealthScore({ won: 0, lost: 0, stalled: 7, decay_factor: 0.5 })).toBe(0);
    expect(pipelineHealthScore({ won: 0, lost: 3, stalled: 12, decay_factor: 0.5 })).toBe(0);
  });

  it('discounts stalled deals by the org decay factor', () => {
    // 3 / (3 + 1 + 4 * 0.5) = 0.5
    expect(pipelineHealthScore({ won: 3, lost: 1, stalled: 4, decay_factor: 0.5 })).toBe(50);
    // A decay factor of 0 removes stalled deals from the denominator entirely.
    expect(pipelineHealthScore({ won: 2, lost: 0, stalled: 10, decay_factor: 0 })).toBe(100);
    // A heavier decay factor punishes the same stalled pile harder.
    expect(pipelineHealthScore({ won: 2, lost: 0, stalled: 2, decay_factor: 1 })).toBe(50);
  });

  it('rounds to two decimals like the dashboard tile', () => {
    expect(pipelineHealthScore({ won: 1, lost: 2, stalled: 0, decay_factor: 0.5 })).toBe(33.33);
  });

  it('never emits a negative or NaN score for junk inputs', () => {
    expect(pipelineHealthScore({ won: -5, lost: 0, stalled: 0, decay_factor: 0.5 })).toBe(0);
    expect(pipelineHealthScore({ won: 4, lost: -2, stalled: 3, decay_factor: -1 })).toBe(100);
  });

  it('is bounded above by 100', () => {
    expect(pipelineHealthScore({ won: 9, lost: 0, stalled: 0, decay_factor: 0.5 })).toBeLessThanOrEqual(100);
  });
});

// ─── Range + bucket helpers ───────────────────────────────────────────────────

describe('resolveReportRange', () => {
  const now = new Date('2026-07-25T10:30:00.000Z');

  it('defaults to the last 30 days', () => {
    const range = resolveReportRange({}, now);
    expect(range.period).toBe('30d');
    expect(range.end.toISOString()).toBe(now.toISOString());
    expect(range.start.toISOString()).toBe('2026-06-25T10:30:00.000Z');
  });

  it('treats month/quarter/year as calendar-to-date in UTC', () => {
    expect(resolveReportRange({ period: 'month' }, now).start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(resolveReportRange({ period: 'quarter' }, now).start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(resolveReportRange({ period: 'year' }, now).start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('makes a date-only date_to cover the whole day', () => {
    const range = resolveReportRange({ date_from: '2026-07-01', date_to: '2026-07-31' }, now);
    expect(range.period).toBe('custom');
    expect(range.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('swaps a reversed custom range instead of returning nothing', () => {
    const range = resolveReportRange({ date_from: '2026-07-31', date_to: '2026-07-01' }, now);
    expect(range.start.toISOString()).toBe('2026-07-02T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-31T00:00:00.000Z');
  });
});

describe('truncateToBucket', () => {
  it('starts weeks on Monday, matching PostgreSQL date_trunc', () => {
    // 2026-07-25 is a Saturday.
    expect(truncateToBucket(new Date('2026-07-25T18:00:00.000Z'), 'week').toISOString()).toBe(
      '2026-07-20T00:00:00.000Z',
    );
  });

  it('truncates days and months in UTC', () => {
    expect(truncateToBucket(new Date('2026-07-25T18:00:00.000Z'), 'day').toISOString()).toBe(
      '2026-07-25T00:00:00.000Z',
    );
    expect(truncateToBucket(new Date('2026-07-25T18:00:00.000Z'), 'month').toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });
});

// ─── Funnel maths ─────────────────────────────────────────────────────────────

describe('buildFunnelStages', () => {
  const stages = [
    { stage_id: 's1', stage_name: 'Новый лид', position: 0, is_won_stage: false, is_lost_stage: false },
    { stage_id: 's2', stage_name: 'Квалификация', position: 1, is_won_stage: false, is_lost_stage: false },
    { stage_id: 's3', stage_name: 'Сделка выиграна', position: 2, is_won_stage: true, is_lost_stage: false },
  ];

  it('computes stage-to-stage conversion from the reached-stage snapshot', () => {
    const result = buildFunnelStages(stages, [
      { stage_id: 's1', deal_count: 10, open_count: 10, won_count: 0, lost_count: 0, total_value: 1000 },
      { stage_id: 's2', deal_count: 5, open_count: 5, won_count: 0, lost_count: 0, total_value: 2500 },
      { stage_id: 's3', deal_count: 2, open_count: 0, won_count: 2, lost_count: 0, total_value: 4000 },
    ]);

    // 17 deals reached stage 1, 7 of them reached stage 2, 2 of those reached stage 3.
    expect(result.map((stage) => stage.conversion_to_next)).toEqual([41.18, 28.57, null]);
    expect(result[0]?.total_value).toBe(1000);
    for (const stage of result) {
      expect(stage.conversion_to_next ?? 0).toBeLessThanOrEqual(100);
    }
  });

  it('reports zeroed stages without dividing by zero', () => {
    const result = buildFunnelStages(stages, []);
    expect(result.map((stage) => stage.deal_count)).toEqual([0, 0, 0]);
    expect(result.map((stage) => stage.conversion_to_next)).toEqual([0, 0, null]);
  });
});

// ─── Org scoping + visibility cone ────────────────────────────────────────────

describe('report queries are org-scoped and cone-restricted', () => {
  it('restricts every rep-performance query to the member cone', async () => {
    dbMock.user.findMany.mockResolvedValue([
      { id: MANAGER_ID, name: 'Менеджер', role: 'member' },
      { id: REPORT_ID, name: 'Подчинённый', role: 'member' },
    ]);
    dbMock.deal.groupBy.mockResolvedValue([
      { assigned_to: MANAGER_ID, status: 'won', _count: { _all: 3 }, _sum: { value: '300000' } },
      { assigned_to: MANAGER_ID, status: 'lost', _count: { _all: 1 }, _sum: { value: '50000' } },
    ]);
    dbMock.task.groupBy.mockResolvedValue([{ assigned_to: REPORT_ID, _count: { _all: 4 } }]);
    dbMock.activityLog.groupBy.mockResolvedValue([{ user_id: MANAGER_ID, _count: { _all: 12 } }]);

    const result = await getRepPerformance(member, {});

    // Guard first: `for (const … of [])` and `[0]?.x` are both vacuously true on
    // an empty call set, so every loop below has to be told that queries were
    // actually made before it can mean anything.
    expect(allWheres().length).toBeGreaterThan(0);
    expect(wheresOf(dbMock.deal.groupBy).length).toBeGreaterThan(0);

    for (const where of allWheres()) {
      expect(where.organization_id).toBe(ORG_ID);
    }
    for (const where of wheresOf(dbMock.deal.groupBy)) {
      expect(where.assigned_to).toEqual({ in: CONE });
    }
    expect(wheresOf(dbMock.task.groupBy)[0]?.assigned_to).toEqual({ in: CONE });
    expect(wheresOf(dbMock.activityLog.groupBy)[0]?.user_id).toEqual({ in: CONE });
    expect(wheresOf(dbMock.user.findMany)[0]?.id).toEqual({ in: CONE });

    // Nobody outside the cone can appear in the output.
    expect(result.data.reps.map((rep) => rep.user_id).sort()).toEqual([...CONE].sort());
    expect(result.data.reps.map((rep) => rep.user_id)).not.toContain(OUTSIDER_ID);
    expect(result.meta.restricted_to_visible_users).toBe(true);
  });

  it('leaves owner queries unrestricted apart from the org boundary', async () => {
    await getRepPerformance(owner, {});

    // Everything below is either a `for … of` over the recorded calls or an
    // `[0]?.field).toBeUndefined()`, and BOTH of those are satisfied by an empty
    // call set: no loop body runs, and `undefined?.field` is undefined. Without
    // this guard, replacing getRepPerformance with `async () => ({})` — no org
    // filter, no queries, no report — leaves this test green. Same guard the
    // cone test below already carries at its own `dealWheres`.
    expect(allWheres().length).toBeGreaterThan(0);
    expect(wheresOf(dbMock.deal.groupBy).length).toBeGreaterThan(0);
    expect(dbMock.task.groupBy).toHaveBeenCalled();
    expect(dbMock.activityLog.groupBy).toHaveBeenCalled();
    expect(dbMock.user.findMany).toHaveBeenCalled();

    expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    for (const where of allWheres()) {
      expect(where.organization_id).toBe(ORG_ID);
    }
    for (const where of wheresOf(dbMock.deal.groupBy)) {
      expect(where.assigned_to).toEqual({ not: null });
    }
    // An owner has no cone, so these carry no per-user narrowing — assertions
    // only worth making now that the queries are known to have happened. The
    // activity log still excludes system rows, which is a `not: null`, not a
    // cone.
    expect(wheresOf(dbMock.task.groupBy)[0]?.assigned_to).toBeUndefined();
    expect(wheresOf(dbMock.activityLog.groupBy)[0]?.user_id).toEqual({ not: null });
    expect(wheresOf(dbMock.user.findMany)[0]?.id).toBeUndefined();
  });

  it('applies the deal visibility cone to funnel, win/loss and pipeline health', async () => {
    const cone = { OR: [{ assigned_to: { in: CONE } }, { created_by: { in: CONE } }] };

    for (const run of [getSalesFunnel, getWinLossAnalysis, getPipelineHealth]) {
      vi.clearAllMocks();
      dbMock.$queryRaw.mockImplementation((...args: unknown[]) =>
        Promise.resolve(isTemplateStrings(args[0]) ? CONE.map((id) => ({ id })) : []),
      );
      dbMock.org.findUniqueOrThrow.mockResolvedValue({
        stalled_threshold_days: 30,
        decay_factor: 0.5,
        settings: null,
      });
      dbMock.pipeline.findMany.mockResolvedValue([]);
      dbMock.deal.groupBy.mockResolvedValue([]);
      dbMock.deal.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { value: null } });

      await run(member, {});

      const dealWheres = [...wheresOf(dbMock.deal.groupBy), ...wheresOf(dbMock.deal.aggregate)];
      expect(dealWheres.length).toBeGreaterThan(0);
      for (const where of dealWheres) {
        expect(where.organization_id).toBe(ORG_ID);
        expect(where.OR).toEqual(cone.OR);
      }
      for (const where of wheresOf(dbMock.pipeline.findMany)) {
        expect(where.organization_id).toBe(ORG_ID);
      }
    }
  });

  it('never reads another org, even when the cone is wide open', async () => {
    await getSalesFunnel({ ...owner, org_id: OTHER_ORG_ID }, {});
    expect(allWheres().length).toBeGreaterThan(0);
    for (const where of allWheres()) {
      expect(where.organization_id).toBe(OTHER_ORG_ID);
    }
    expect(dbMock.org.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_ORG_ID } }),
    );
  });

  it('spells out the org boundary and the cone in the raw revenue aggregate', async () => {
    await getRevenueOverTime(member, { granularity: 'month' });

    const rawCall = dbMock.$queryRaw.mock.calls.find((call) => !isTemplateStrings(call[0]));
    expect(rawCall).toBeDefined();

    const sql = rawCall?.[0] as SqlLike;
    const text = sql.strings.join(' ');
    expect(text).toContain('"organization_id" =');
    expect(text).toContain('"assigned_to" IN');
    expect(text).toContain('"created_by" IN');
    expect(sql.values).toContain(ORG_ID);
    for (const id of CONE) {
      expect(sql.values).toContain(id);
    }
    expect(sql.values).not.toContain(OUTSIDER_ID);
  });
});

// ─── Report assembly ──────────────────────────────────────────────────────────

describe('report assembly', () => {
  it('scores each rep with the org decay formula and never labels it a win rate', async () => {
    dbMock.org.findUniqueOrThrow.mockResolvedValue({
      stalled_threshold_days: 30,
      decay_factor: 0.5,
      settings: null,
    });
    dbMock.user.findMany.mockResolvedValue([{ id: MANAGER_ID, name: 'Менеджер', role: 'member' }]);
    dbMock.deal.groupBy.mockImplementation(async (args: { by: string[]; where: Record<string, unknown> }) => {
      if (args.by.includes('status')) {
        return [
          { assigned_to: MANAGER_ID, status: 'won', _count: { _all: 3 }, _sum: { value: '300000' } },
          { assigned_to: MANAGER_ID, status: 'lost', _count: { _all: 1 }, _sum: { value: '50000' } },
        ];
      }
      if (args.where.stage_entered_at || args.where.OR) {
        return [{ assigned_to: MANAGER_ID, _count: { _all: 4 } }];
      }
      return [{ assigned_to: MANAGER_ID, _count: { _all: 6 }, _sum: { value: '120000' } }];
    });

    const result = await getRepPerformance(owner, {});
    const rep = result.data.reps[0];

    // 3 / (3 + 1 + 4 * 0.5) = 0.5
    expect(rep?.pipeline_health_score).toBe(50);
    expect(rep?.revenue).toBe(300000);
    expect(rep?.average_deal_value).toBe(100000);
    expect(rep?.deals_open).toBe(6);
    expect(result.data.totals.pipeline_health_score).toBe(50);
    expect(JSON.stringify(result)).not.toMatch(/win_rate/i);
  });

  it('defaults the reporting currency to the market default and honours the org override', async () => {
    const fallback = await getWinLossAnalysis(owner, {});
    expect(fallback.meta.currency).toBe('RUB');

    dbMock.org.findUniqueOrThrow.mockResolvedValue({
      stalled_threshold_days: 30,
      decay_factor: 0.5,
      settings: { currency: 'kzt' },
    });
    const overridden = await getWinLossAnalysis(owner, {});
    expect(overridden.meta.currency).toBe('KZT');
  });

  it('buckets revenue into a continuous series and separates other currencies', async () => {
    dbMock.$queryRaw.mockImplementation((...args: unknown[]) => {
      if (isTemplateStrings(args[0])) return Promise.resolve(CONE.map((id) => ({ id })));
      return Promise.resolve([
        { currency_code: 'RUB', bucket: new Date('2026-05-01T00:00:00.000Z'), deal_count: 2, revenue: 200000 },
        { currency_code: 'RUB', bucket: new Date('2026-07-01T00:00:00.000Z'), deal_count: 1, revenue: 50000 },
        { currency_code: 'USD', bucket: new Date('2026-07-01T00:00:00.000Z'), deal_count: 1, revenue: 900 },
      ]);
    });

    const result = await getRevenueOverTime(owner, {
      granularity: 'month',
      date_from: '2026-05-01',
      date_to: '2026-07-31',
    });

    expect(result.data.currency).toBe('RUB');
    expect(result.data.series.map((bucket) => bucket.period_start)).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
    expect(result.data.series.map((bucket) => bucket.revenue)).toEqual([200000, 0, 50000]);
    expect(result.data.totals).toEqual({ deal_count: 3, revenue: 250000, average_deal_value: 83333.33 });
    expect(result.data.other_currencies).toEqual([{ currency: 'USD', deal_count: 1, revenue: 900 }]);
  });

  it('groups win/loss by lost_reason and by source', async () => {
    dbMock.deal.groupBy.mockImplementation(async (args: { by: string[] }) => {
      if (args.by.includes('lost_reason')) {
        return [
          { lost_reason: 'Дорого', _count: { _all: 3 }, _sum: { value: '150000' } },
          { lost_reason: null, _count: { _all: 1 }, _sum: { value: '10000' } },
        ];
      }
      if (args.by.includes('source')) {
        return [
          { source: 'Сайт', status: 'won', _count: { _all: 6 }, _sum: { value: '600000' } },
          { source: 'Сайт', status: 'lost', _count: { _all: 2 }, _sum: { value: '100000' } },
          { source: null, status: 'lost', _count: { _all: 2 }, _sum: { value: '60000' } },
        ];
      }
      return [
        { status: 'won', _count: { _all: 6 }, _sum: { value: '600000' } },
        { status: 'lost', _count: { _all: 4 }, _sum: { value: '160000' } },
      ];
    });

    const result = await getWinLossAnalysis(owner, {});

    expect(result.data.totals.won_count).toBe(6);
    expect(result.data.totals.decided_count).toBe(10);
    expect(result.data.totals.won_share).toBe(60);
    expect(result.data.totals.average_won_value).toBe(100000);
    expect(result.data.by_lost_reason[0]).toEqual({
      lost_reason: 'Дорого',
      count: 3,
      value: 150000,
      share: 75,
    });
    expect(result.data.by_lost_reason[1]?.lost_reason).toBeNull();
    expect(result.data.by_source[0]).toMatchObject({
      source: 'Сайт',
      won_count: 6,
      lost_count: 2,
      decided_count: 8,
      won_share: 75,
    });
    expect(result.data.by_source[1]?.source).toBeNull();
  });

  it('reports pipeline health per pipeline plus an org roll-up', async () => {
    dbMock.pipeline.findMany.mockResolvedValue([
      { id: 'p1', name: 'Воронка продаж' },
      { id: 'p2', name: 'Партнёры' },
    ]);
    dbMock.deal.groupBy.mockImplementation(async (args: { by: string[]; where: Record<string, unknown> }) => {
      if (args.by.includes('status')) {
        return [
          { pipeline_id: 'p1', status: 'won', _count: { _all: 3 } },
          { pipeline_id: 'p1', status: 'lost', _count: { _all: 1 } },
        ];
      }
      if (args.where.stage_entered_at || args.where.OR) {
        return [{ pipeline_id: 'p1', _count: { _all: 4 } }];
      }
      return [{ pipeline_id: 'p1', _count: { _all: 9 } }];
    });

    const result = await getPipelineHealth(owner, {});

    expect(result.data.pipeline_health_score).toBe(50);
    expect(result.data.components).toMatchObject({
      won: 3,
      lost: 1,
      stalled: 4,
      open: 9,
      decay_factor: 0.5,
      stalled_threshold_days: 30,
    });
    const first = result.data.pipelines.find((row) => row.pipeline_id === 'p1');
    const second = result.data.pipelines.find((row) => row.pipeline_id === 'p2');
    expect(first?.pipeline_health_score).toBe(50);
    expect(second?.pipeline_health_score).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/win_rate/i);
  });

  it('uses each stage stale threshold in pipeline-health stalled queries', async () => {
    dbMock.pipelineStage.findMany.mockResolvedValue([
      { id: 'stage-fast', stale_after_days: 3 },
      { id: 'stage-default', stale_after_days: null },
    ]);

    const result = await getPipelineHealth(owner, {});

    const stalledCall = dbMock.deal.groupBy.mock.calls.find(
      (call) => Array.isArray((call[0] as { where?: { OR?: unknown[] } }).where?.OR),
    );
    const clauses = (stalledCall?.[0] as { where: { OR: Array<Record<string, unknown>> } }).where.OR;
    expect(clauses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage_id: 'stage-fast',
        stage_entered_at: { lt: expect.any(Date) },
      }),
      expect.objectContaining({
        stage_id: 'stage-default',
        stage_entered_at: { lt: expect.any(Date) },
      }),
    ]));
    expect(result.meta.stage_stale_overrides_applied).toBe(true);
  });
});
