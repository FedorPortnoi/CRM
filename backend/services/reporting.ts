import { DealStatus, Prisma, TaskStatus } from '@prisma/client';
import { db } from './db';
import { DEFAULT_CURRENCY, normalizeCurrencyCode } from '../config/market';
import {
  getVisibleUserIds,
  ownerVisibilityWhere,
  type Requester,
  type VisibilityScope,
} from './visibility';

// ─── Shared vocabulary ────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** Guard against a five-year day-by-day request generating an unbounded series. */
const MAX_REVENUE_BUCKETS = 400;

export const REPORT_PERIODS = ['7d', '30d', '90d', 'month', 'quarter', 'year', 'custom'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REVENUE_GRANULARITIES = ['day', 'week', 'month'] as const;
export type RevenueGranularity = (typeof REVENUE_GRANULARITIES)[number];

export type ReportQuery = {
  period?: ReportPeriod;
  /** ISO date (`2026-01-31`) or datetime. A date-only value is read as UTC midnight. */
  date_from?: string;
  /** ISO date (`2026-01-31`) or datetime. A date-only value covers the whole day. */
  date_to?: string;
  pipeline_id?: string;
  scope?: VisibilityScope;
};

export type RevenueQuery = ReportQuery & {
  granularity?: RevenueGranularity;
  currency?: string;
};

export type ReportRange = {
  period: ReportPeriod;
  /** Inclusive lower bound. */
  start: Date;
  /** Exclusive upper bound — every range in this module is half-open. */
  end: Date;
};

export type ReportEnvelope<T> = {
  data: T;
  meta: Record<string, unknown>;
};

// ─── Numeric helpers ──────────────────────────────────────────────────────────

type NumericLike = Prisma.Decimal | number | string | bigint | null | undefined;

function toNumber(value: NumericLike): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Percentage with two decimals, matching the rounding used by /analytics/dashboard. */
function percentage(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 10_000) / 100;
}

function safeAverage(total: number, count: number): number {
  return count <= 0 ? 0 : round2(total / count);
}

// ─── Date range ───────────────────────────────────────────────────────────────

function parseBoundary(value: string, inclusiveEndOfDay: boolean): Date | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return null;
  // `date_to=2026-01-31` should include everything that happened on the 31st.
  return dateOnly && inclusiveEndOfDay ? new Date(parsed.getTime() + MS_PER_DAY) : parsed;
}

/**
 * Resolve the reporting window. An explicit `date_from`/`date_to` always wins and marks the
 * period as `custom`; otherwise a preset is measured back from `now` in UTC. `month`, `quarter`
 * and `year` are calendar-to-date, which is what a sales manager means by «за месяц».
 */
export function resolveReportRange(query: ReportQuery = {}, now: Date = new Date()): ReportRange {
  const from = query.date_from ? parseBoundary(query.date_from, false) : null;
  const to = query.date_to ? parseBoundary(query.date_to, true) : null;

  if (from || to) {
    const start = from ?? new Date(now.getTime() - 30 * MS_PER_DAY);
    const end = to ?? now;
    return start.getTime() > end.getTime()
      ? { period: 'custom', start: end, end: start }
      : { period: 'custom', start, end };
  }

  const period: ReportPeriod = query.period && query.period !== 'custom' ? query.period : '30d';
  const end = new Date(now.getTime());
  let start: Date;

  if (period === 'month') {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  } else if (period === 'quarter') {
    start = new Date(Date.UTC(end.getUTCFullYear(), Math.floor(end.getUTCMonth() / 3) * 3, 1));
  } else if (period === 'year') {
    start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  } else {
    start = new Date(end.getTime() - Number.parseInt(period, 10) * MS_PER_DAY);
  }

  return { period, start, end };
}

// ─── Org reporting settings ───────────────────────────────────────────────────

export type OrgReportingSettings = {
  stalled_threshold_days: number;
  decay_factor: number;
  currency: string;
};

/**
 * Currency comes from the org's own settings; the fallback is DEFAULT_CURRENCY, which is the
 * backend mirror of DEFAULT_MARKET_PROFILE.currency (RUB). Nothing here formats money — the
 * clients do that with the market profile's locale.
 */
export async function loadOrgReportingSettings(orgId: string): Promise<OrgReportingSettings> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { stalled_threshold_days: true, decay_factor: true, settings: true },
  });

  const settings = (org.settings as Record<string, unknown> | null) ?? {};
  const configured = typeof settings.currency === 'string' ? normalizeCurrencyCode(settings.currency) : '';

  return {
    stalled_threshold_days: org.stalled_threshold_days,
    decay_factor: org.decay_factor,
    currency: /^[A-Z]{3}$/.test(configured) ? configured : DEFAULT_CURRENCY,
  };
}

// ─── Pipeline Health Score ────────────────────────────────────────────────────

export type PipelineHealthInput = {
  won: number;
  lost: number;
  stalled: number;
  decay_factor: number;
};

/**
 * `won / (won + lost + stalled * decay_factor)`, expressed as a percentage.
 *
 * Locked product decision: this number is ALWAYS presented as the «Pipeline Health Score»
 * («Здоровье воронки»), never as a "win rate". Stalled deals sit in the denominator precisely so
 * that a rep who lets deals rot cannot look healthy by simply never marking anything lost.
 *
 * Same formula and rounding as GET /analytics/dashboard, so the dashboard tile and these reports
 * can never disagree.
 */
export function pipelineHealthScore({ won, lost, stalled, decay_factor }: PipelineHealthInput): number {
  const wonCount = Math.max(0, won);
  const denominator =
    wonCount + Math.max(0, lost) + Math.max(0, stalled) * Math.max(0, decay_factor);
  if (denominator <= 0) return 0;
  return Math.round((wonCount / denominator) * 10_000) / 100;
}

// ─── Org scope + visibility cone ──────────────────────────────────────────────

type ReportScope = {
  orgId: string;
  /** `null` = owner/admin, no per-user restriction. */
  visibleIds: string[] | null;
  scope: VisibilityScope;
};

/**
 * Reports default to `subtree`: a manager running a report wants their whole branch, not just
 * their direct reports. Owners and admins get `null` (whole org).
 */
async function resolveReportScope(requester: Requester, query: ReportQuery): Promise<ReportScope> {
  const scope: VisibilityScope = query.scope ?? 'subtree';
  return {
    orgId: requester.org_id,
    visibleIds: await getVisibleUserIds(requester, scope),
    scope,
  };
}

/**
 * Org scope + the deal visibility cone. Mirrors the deal list: a member sees deals assigned to
 * anyone in their cone plus deals they created that were never assigned.
 */
function dealBaseWhere(scope: ReportScope, query: ReportQuery): Prisma.DealWhereInput {
  return {
    organization_id: scope.orgId,
    ...(query.pipeline_id ? { pipeline_id: query.pipeline_id } : {}),
    ...ownerVisibilityWhere(scope.visibleIds),
  };
}

/**
 * Per-assignee reports use the strict assignee cone instead of `ownerVisibilityWhere`: the
 * `created_by` leg would otherwise surface the name of a rep outside the caller's branch just
 * because the caller created a deal that was later reassigned upward.
 */
function dealAssigneeWhere(visibleIds: string[] | null): Prisma.DealWhereInput {
  return visibleIds === null ? { assigned_to: { not: null } } : { assigned_to: { in: visibleIds } };
}

function taskAssigneeWhere(visibleIds: string[] | null): Prisma.TaskWhereInput {
  return visibleIds === null ? {} : { assigned_to: { in: visibleIds } };
}

function activityUserWhere(visibleIds: string[] | null): Prisma.ActivityLogWhereInput {
  return visibleIds === null ? { user_id: { not: null } } : { user_id: { in: visibleIds } };
}

function reportMeta(
  range: ReportRange,
  scope: ReportScope,
  currency: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    period: range.period,
    date_from: range.start.toISOString(),
    date_to: range.end.toISOString(),
    currency,
    scope: scope.scope,
    restricted_to_visible_users: scope.visibleIds !== null,
    ...extra,
  };
}

// ─── 1. Sales funnel ──────────────────────────────────────────────────────────

export type FunnelStageInput = {
  stage_id: string;
  stage_name: string;
  position: number;
  is_won_stage: boolean;
  is_lost_stage: boolean;
};

export type FunnelStageAggregate = {
  stage_id: string;
  deal_count: number;
  open_count: number;
  won_count: number;
  lost_count: number;
  total_value: number;
};

export type FunnelStage = FunnelStageInput &
  Omit<FunnelStageAggregate, 'stage_id'> & {
    /** Percentage of the deals that reached this stage which also reached the next one. */
    conversion_to_next: number | null;
  };

export type FunnelPipeline = {
  pipeline_id: string;
  pipeline_name: string;
  stages: FunnelStage[];
  totals: { deal_count: number; total_value: number };
};

export type SalesFunnelReport = {
  period: ReportPeriod;
  pipelines: FunnelPipeline[];
  totals: {
    deal_count: number;
    total_value: number;
    unstaged_deal_count: number;
    unstaged_value: number;
  };
};

/**
 * Deal stage history is not stored, so conversion uses a current-stage snapshot proxy: deals
 * sitting at or past stage N+1 (plus deals already won earlier) divided by deals at or past
 * stage N. That keeps the ratio bounded by 100% instead of dividing mutually exclusive buckets.
 */
export function buildFunnelStages(
  stages: FunnelStageInput[],
  aggregates: FunnelStageAggregate[],
): FunnelStage[] {
  const byStage = new Map(aggregates.map((row) => [row.stage_id, row]));
  const ordered = [...stages].sort(
    (a, b) => a.position - b.position || a.stage_name.localeCompare(b.stage_name),
  );

  const reachedFrom = (minimumIndex: number): number =>
    ordered.reduce((sum, stage, index) => {
      const aggregate = byStage.get(stage.stage_id);
      if (!aggregate) return sum;
      return sum + (index >= minimumIndex ? aggregate.deal_count : aggregate.won_count);
    }, 0);

  return ordered.map((stage, index) => {
    const aggregate = byStage.get(stage.stage_id);
    return {
      ...stage,
      deal_count: aggregate?.deal_count ?? 0,
      open_count: aggregate?.open_count ?? 0,
      won_count: aggregate?.won_count ?? 0,
      lost_count: aggregate?.lost_count ?? 0,
      total_value: round2(aggregate?.total_value ?? 0),
      conversion_to_next:
        index === ordered.length - 1 ? null : percentage(reachedFrom(index + 1), reachedFrom(index)),
    };
  });
}

export async function getSalesFunnel(
  requester: Requester,
  query: ReportQuery = {},
): Promise<ReportEnvelope<SalesFunnelReport>> {
  const range = resolveReportRange(query);
  const scope = await resolveReportScope(requester, query);

  const where: Prisma.DealWhereInput = {
    ...dealBaseWhere(scope, query),
    status: { not: DealStatus.archived },
    created_at: { gte: range.start, lt: range.end },
  };

  const [settings, pipelines, stageRows, unstaged] = await Promise.all([
    loadOrgReportingSettings(scope.orgId),
    db.pipeline.findMany({
      where: {
        organization_id: scope.orgId,
        ...(query.pipeline_id ? { id: query.pipeline_id } : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        stages: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            name: true,
            position: true,
            is_won_stage: true,
            is_lost_stage: true,
          },
        },
      },
    }),
    db.deal.groupBy({
      by: ['stage_id', 'status'],
      where,
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.aggregate({
      where: { ...where, stage_id: null },
      _count: { _all: true },
      _sum: { value: true },
    }),
  ]);

  const aggregatesByStage = new Map<string, FunnelStageAggregate>();
  for (const row of stageRows) {
    if (!row.stage_id) continue;
    const entry = aggregatesByStage.get(row.stage_id) ?? {
      stage_id: row.stage_id,
      deal_count: 0,
      open_count: 0,
      won_count: 0,
      lost_count: 0,
      total_value: 0,
    };
    const count = row._count._all;
    entry.deal_count += count;
    if (row.status === DealStatus.won) entry.won_count += count;
    else if (row.status === DealStatus.lost) entry.lost_count += count;
    else entry.open_count += count;
    entry.total_value += toNumber(row._sum.value);
    aggregatesByStage.set(row.stage_id, entry);
  }

  const funnelPipelines: FunnelPipeline[] = pipelines.map((pipeline) => {
    const stages = buildFunnelStages(
      pipeline.stages.map((stage) => ({
        stage_id: stage.id,
        stage_name: stage.name,
        position: stage.position,
        is_won_stage: stage.is_won_stage,
        is_lost_stage: stage.is_lost_stage,
      })),
      pipeline.stages.flatMap((stage) => {
        const aggregate = aggregatesByStage.get(stage.id);
        return aggregate ? [aggregate] : [];
      }),
    );

    return {
      pipeline_id: pipeline.id,
      pipeline_name: pipeline.name,
      stages,
      totals: {
        deal_count: stages.reduce((sum, stage) => sum + stage.deal_count, 0),
        total_value: round2(stages.reduce((sum, stage) => sum + stage.total_value, 0)),
      },
    };
  });

  return {
    data: {
      period: range.period,
      pipelines: funnelPipelines,
      totals: {
        deal_count: funnelPipelines.reduce((sum, pipeline) => sum + pipeline.totals.deal_count, 0),
        total_value: round2(
          funnelPipelines.reduce((sum, pipeline) => sum + pipeline.totals.total_value, 0),
        ),
        unstaged_deal_count: unstaged._count._all,
        unstaged_value: round2(toNumber(unstaged._sum.value)),
      },
    },
    meta: reportMeta(range, scope, settings.currency, {
      note:
        'Cohort of deals created inside the range, placed at their current stage. Stage history is not stored, so conversion_to_next is a snapshot proxy: deals at or past the next stage divided by deals at or past this one.',
    }),
  };
}

// ─── 2. Rep performance ───────────────────────────────────────────────────────

export type RepPerformanceRow = {
  user_id: string;
  name: string | null;
  role: string | null;
  deals_won: number;
  deals_lost: number;
  deals_open: number;
  stalled_deals: number;
  revenue: number;
  lost_value: number;
  open_value: number;
  average_deal_value: number;
  tasks_completed: number;
  activity_count: number;
  pipeline_health_score: number;
};

export type RepPerformanceReport = {
  period: ReportPeriod;
  reps: RepPerformanceRow[];
  totals: Omit<RepPerformanceRow, 'user_id' | 'name' | 'role'>;
};

export async function getRepPerformance(
  requester: Requester,
  query: ReportQuery = {},
): Promise<ReportEnvelope<RepPerformanceReport>> {
  const range = resolveReportRange(query);
  const scope = await resolveReportScope(requester, query);
  const settings = await loadOrgReportingSettings(scope.orgId);
  const stalledSince = new Date(Date.now() - settings.stalled_threshold_days * MS_PER_DAY);

  const dealScope: Prisma.DealWhereInput = {
    organization_id: scope.orgId,
    ...(query.pipeline_id ? { pipeline_id: query.pipeline_id } : {}),
    ...dealAssigneeWhere(scope.visibleIds),
  };

  const [closedRows, openRows, stalledRows, taskRows, activityRows, users] = await Promise.all([
    db.deal.groupBy({
      by: ['assigned_to', 'status'],
      where: {
        ...dealScope,
        status: { in: [DealStatus.won, DealStatus.lost] },
        actual_close: { gte: range.start, lt: range.end },
      },
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.groupBy({
      by: ['assigned_to'],
      where: { ...dealScope, status: DealStatus.open },
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.groupBy({
      by: ['assigned_to'],
      where: { ...dealScope, status: DealStatus.open, updated_at: { lt: stalledSince } },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ['assigned_to'],
      where: {
        organization_id: scope.orgId,
        status: TaskStatus.done,
        completed_at: { gte: range.start, lt: range.end },
        ...taskAssigneeWhere(scope.visibleIds),
      },
      _count: { _all: true },
    }),
    db.activityLog.groupBy({
      by: ['user_id'],
      where: {
        organization_id: scope.orgId,
        created_at: { gte: range.start, lt: range.end },
        ...activityUserWhere(scope.visibleIds),
      },
      _count: { _all: true },
    }),
    db.user.findMany({
      where: {
        organization_id: scope.orgId,
        ...(scope.visibleIds ? { id: { in: scope.visibleIds } } : {}),
      },
      select: { id: true, name: true, role: true },
    }),
  ]);

  const blank = (): Omit<RepPerformanceRow, 'user_id' | 'name' | 'role'> => ({
    deals_won: 0,
    deals_lost: 0,
    deals_open: 0,
    stalled_deals: 0,
    revenue: 0,
    lost_value: 0,
    open_value: 0,
    average_deal_value: 0,
    tasks_completed: 0,
    activity_count: 0,
    pipeline_health_score: 0,
  });

  const byUser = new Map<string, ReturnType<typeof blank>>();
  const ensure = (userId: string) => {
    const existing = byUser.get(userId);
    if (existing) return existing;
    const created = blank();
    byUser.set(userId, created);
    return created;
  };

  for (const user of users) ensure(user.id);

  for (const row of closedRows) {
    if (!row.assigned_to) continue;
    const entry = ensure(row.assigned_to);
    if (row.status === DealStatus.won) {
      entry.deals_won += row._count._all;
      entry.revenue += toNumber(row._sum.value);
    } else {
      entry.deals_lost += row._count._all;
      entry.lost_value += toNumber(row._sum.value);
    }
  }

  for (const row of openRows) {
    if (!row.assigned_to) continue;
    const entry = ensure(row.assigned_to);
    entry.deals_open += row._count._all;
    entry.open_value += toNumber(row._sum.value);
  }

  for (const row of stalledRows) {
    if (!row.assigned_to) continue;
    ensure(row.assigned_to).stalled_deals += row._count._all;
  }

  for (const row of taskRows) {
    ensure(row.assigned_to).tasks_completed += row._count._all;
  }

  for (const row of activityRows) {
    if (!row.user_id) continue;
    ensure(row.user_id).activity_count += row._count._all;
  }

  const nameById = new Map(users.map((user) => [user.id, user]));
  const reps: RepPerformanceRow[] = [...byUser.entries()].map(([userId, entry]) => {
    const user = nameById.get(userId);
    return {
      user_id: userId,
      name: user?.name ?? null,
      role: user?.role ?? null,
      ...entry,
      revenue: round2(entry.revenue),
      lost_value: round2(entry.lost_value),
      open_value: round2(entry.open_value),
      average_deal_value: safeAverage(entry.revenue, entry.deals_won),
      pipeline_health_score: pipelineHealthScore({
        won: entry.deals_won,
        lost: entry.deals_lost,
        stalled: entry.stalled_deals,
        decay_factor: settings.decay_factor,
      }),
    };
  });

  reps.sort(
    (a, b) =>
      b.revenue - a.revenue ||
      b.deals_won - a.deals_won ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  );

  const sum = (pick: (row: RepPerformanceRow) => number): number =>
    reps.reduce((total, row) => total + pick(row), 0);

  const totalWon = sum((row) => row.deals_won);
  const totalRevenue = round2(sum((row) => row.revenue));
  const totalLost = sum((row) => row.deals_lost);
  const totalStalled = sum((row) => row.stalled_deals);

  return {
    data: {
      period: range.period,
      reps,
      totals: {
        deals_won: totalWon,
        deals_lost: totalLost,
        deals_open: sum((row) => row.deals_open),
        stalled_deals: totalStalled,
        revenue: totalRevenue,
        lost_value: round2(sum((row) => row.lost_value)),
        open_value: round2(sum((row) => row.open_value)),
        average_deal_value: safeAverage(totalRevenue, totalWon),
        tasks_completed: sum((row) => row.tasks_completed),
        activity_count: sum((row) => row.activity_count),
        pipeline_health_score: pipelineHealthScore({
          won: totalWon,
          lost: totalLost,
          stalled: totalStalled,
          decay_factor: settings.decay_factor,
        }),
      },
    },
    meta: reportMeta(range, scope, settings.currency, {
      stalled_threshold_days: settings.stalled_threshold_days,
      decay_factor: settings.decay_factor,
      stalled_since: stalledSince.toISOString(),
      note:
        'Won/lost and revenue are attributed to the assignee and dated by actual_close. Open, stalled and their values are a current snapshot, not a range. pipeline_health_score uses the org decay formula and is never a win rate.',
    }),
  };
}

// ─── 3. Win/loss analysis ─────────────────────────────────────────────────────

export type WinLossReasonRow = {
  lost_reason: string | null;
  count: number;
  value: number;
  share: number;
};

export type WinLossSourceRow = {
  source: string | null;
  won_count: number;
  won_value: number;
  lost_count: number;
  lost_value: number;
  decided_count: number;
  decided_value: number;
  /** Percentage of decided deals from this source that were won. Not the health score. */
  won_share: number;
};

export type WinLossReport = {
  period: ReportPeriod;
  totals: {
    won_count: number;
    won_value: number;
    lost_count: number;
    lost_value: number;
    decided_count: number;
    decided_value: number;
    won_share: number;
    average_won_value: number;
    average_lost_value: number;
  };
  by_lost_reason: WinLossReasonRow[];
  by_source: WinLossSourceRow[];
};

export async function getWinLossAnalysis(
  requester: Requester,
  query: ReportQuery = {},
): Promise<ReportEnvelope<WinLossReport>> {
  const range = resolveReportRange(query);
  const scope = await resolveReportScope(requester, query);

  const decidedWhere: Prisma.DealWhereInput = {
    ...dealBaseWhere(scope, query),
    status: { in: [DealStatus.won, DealStatus.lost] },
    actual_close: { gte: range.start, lt: range.end },
  };

  const [settings, statusRows, reasonRows, sourceRows] = await Promise.all([
    loadOrgReportingSettings(scope.orgId),
    db.deal.groupBy({
      by: ['status'],
      where: decidedWhere,
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.groupBy({
      by: ['lost_reason'],
      where: { ...decidedWhere, status: DealStatus.lost },
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.groupBy({
      by: ['source', 'status'],
      where: decidedWhere,
      _count: { _all: true },
      _sum: { value: true },
    }),
  ]);

  const wonRow = statusRows.find((row) => row.status === DealStatus.won);
  const lostRow = statusRows.find((row) => row.status === DealStatus.lost);
  const wonCount = wonRow?._count._all ?? 0;
  const lostCount = lostRow?._count._all ?? 0;
  const wonValue = toNumber(wonRow?._sum.value);
  const lostValue = toNumber(lostRow?._sum.value);

  const byLostReason: WinLossReasonRow[] = reasonRows
    .map((row) => ({
      lost_reason: row.lost_reason,
      count: row._count._all,
      value: round2(toNumber(row._sum.value)),
      share: percentage(row._count._all, lostCount),
    }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const sourceMap = new Map<string, WinLossSourceRow>();
  for (const row of sourceRows) {
    const key = row.source ?? '';
    const entry = sourceMap.get(key) ?? {
      source: row.source,
      won_count: 0,
      won_value: 0,
      lost_count: 0,
      lost_value: 0,
      decided_count: 0,
      decided_value: 0,
      won_share: 0,
    };
    const count = row._count._all;
    const value = toNumber(row._sum.value);
    if (row.status === DealStatus.won) {
      entry.won_count += count;
      entry.won_value += value;
    } else {
      entry.lost_count += count;
      entry.lost_value += value;
    }
    entry.decided_count += count;
    entry.decided_value += value;
    sourceMap.set(key, entry);
  }

  const bySource: WinLossSourceRow[] = [...sourceMap.values()]
    .map((entry) => ({
      ...entry,
      won_value: round2(entry.won_value),
      lost_value: round2(entry.lost_value),
      decided_value: round2(entry.decided_value),
      won_share: percentage(entry.won_count, entry.decided_count),
    }))
    .sort((a, b) => b.decided_count - a.decided_count || b.won_value - a.won_value);

  return {
    data: {
      period: range.period,
      totals: {
        won_count: wonCount,
        won_value: round2(wonValue),
        lost_count: lostCount,
        lost_value: round2(lostValue),
        decided_count: wonCount + lostCount,
        decided_value: round2(wonValue + lostValue),
        won_share: percentage(wonCount, wonCount + lostCount),
        average_won_value: safeAverage(wonValue, wonCount),
        average_lost_value: safeAverage(lostValue, lostCount),
      },
      by_lost_reason: byLostReason,
      by_source: bySource,
    },
    meta: reportMeta(range, scope, settings.currency, {
      note:
        'Deals decided inside the range, dated by actual_close. A null lost_reason or source means the field was never filled in. won_share is a plain share of decided deals — the decay-weighted metric lives on /reports/pipeline-health.',
    }),
  };
}

// ─── 4. Revenue over time ─────────────────────────────────────────────────────

export type RevenueBucket = {
  period_start: string;
  period_end: string;
  deal_count: number;
  revenue: number;
  average_deal_value: number;
};

export type RevenueReport = {
  period: ReportPeriod;
  granularity: RevenueGranularity;
  currency: string;
  series: RevenueBucket[];
  totals: { deal_count: number; revenue: number; average_deal_value: number };
  other_currencies: Array<{ currency: string; deal_count: number; revenue: number }>;
};

type RevenueRow = {
  currency_code: string | null;
  bucket: Date | string;
  deal_count: number;
  revenue: number;
};

/** UTC bucket start. `week` matches PostgreSQL `date_trunc('week', …)`, which is Monday-based. */
export function truncateToBucket(date: Date, granularity: RevenueGranularity): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (granularity === 'month') {
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  }
  if (granularity === 'week') {
    const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
    return new Date(day.getTime() - weekday * MS_PER_DAY);
  }
  return day;
}

export function nextBucket(date: Date, granularity: RevenueGranularity): Date {
  if (granularity === 'month') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  if (granularity === 'week') {
    return new Date(date.getTime() + 7 * MS_PER_DAY);
  }
  return new Date(date.getTime() + MS_PER_DAY);
}

export async function getRevenueOverTime(
  requester: Requester,
  query: RevenueQuery = {},
): Promise<ReportEnvelope<RevenueReport>> {
  const range = resolveReportRange(query);
  const scope = await resolveReportScope(requester, query);
  const settings = await loadOrgReportingSettings(scope.orgId);
  const granularity: RevenueGranularity = query.granularity ?? 'month';
  const currency = query.currency ? normalizeCurrencyCode(query.currency) : settings.currency;

  // Raw SQL is used only because Prisma groupBy cannot date_trunc. The organization predicate is
  // written out explicitly — raw queries bypass every convenience wrapper, so the tenant boundary
  // and the visibility cone both have to be spelled out here.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"organization_id" = ${scope.orgId}::uuid`,
    Prisma.sql`"status" = 'won'::"DealStatus"`,
    Prisma.sql`"actual_close" >= ${range.start}`,
    Prisma.sql`"actual_close" < ${range.end}`,
  ];

  if (query.pipeline_id) {
    conditions.push(Prisma.sql`"pipeline_id" = ${query.pipeline_id}::uuid`);
  }

  // A restricted caller with an empty cone can see nothing; `IN ()` is not valid SQL, so the
  // query is skipped entirely rather than emitted with a hole in the predicate.
  const coneIsEmpty = scope.visibleIds !== null && scope.visibleIds.length === 0;
  if (scope.visibleIds !== null && scope.visibleIds.length > 0) {
    const ids = Prisma.join(scope.visibleIds.map((id) => Prisma.sql`${id}::uuid`));
    conditions.push(Prisma.sql`("assigned_to" IN (${ids}) OR "created_by" IN (${ids}))`);
  }

  let rows: RevenueRow[] = [];
  if (!coneIsEmpty) {
    rows = await db.$queryRaw<RevenueRow[]>(Prisma.sql`
      SELECT
        COALESCE("currency", ${DEFAULT_CURRENCY}) AS "currency_code",
        date_trunc(${granularity}::text, "actual_close") AS "bucket",
        COUNT(*)::int AS "deal_count",
        COALESCE(SUM("value"), 0)::double precision AS "revenue"
      FROM "Deal"
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY 1, 2
      ORDER BY 2 ASC
    `);
  }

  const observed = new Map<number, { deal_count: number; revenue: number }>();
  const otherCurrencies = new Map<string, { deal_count: number; revenue: number }>();

  for (const row of rows) {
    const code = normalizeCurrencyCode(row.currency_code ?? DEFAULT_CURRENCY);
    const dealCount = toNumber(row.deal_count);
    const revenue = toNumber(row.revenue);

    if (code !== currency) {
      const entry = otherCurrencies.get(code) ?? { deal_count: 0, revenue: 0 };
      entry.deal_count += dealCount;
      entry.revenue += revenue;
      otherCurrencies.set(code, entry);
      continue;
    }

    const bucketStart = truncateToBucket(new Date(row.bucket), granularity).getTime();
    const entry = observed.get(bucketStart) ?? { deal_count: 0, revenue: 0 };
    entry.deal_count += dealCount;
    entry.revenue += revenue;
    observed.set(bucketStart, entry);
  }

  // Charts need a continuous axis, so empty buckets are filled in — unless the requested window
  // would produce an absurd number of them, in which case only observed buckets are returned.
  const keys: number[] = [];
  let cursor = truncateToBucket(range.start, granularity);
  while (cursor.getTime() < range.end.getTime() && keys.length <= MAX_REVENUE_BUCKETS) {
    keys.push(cursor.getTime());
    cursor = nextBucket(cursor, granularity);
  }
  const bucketKeys =
    keys.length > MAX_REVENUE_BUCKETS ? [...observed.keys()].sort((a, b) => a - b) : keys;

  const series: RevenueBucket[] = bucketKeys.map((key) => {
    const entry = observed.get(key) ?? { deal_count: 0, revenue: 0 };
    return {
      period_start: new Date(key).toISOString(),
      period_end: nextBucket(new Date(key), granularity).toISOString(),
      deal_count: entry.deal_count,
      revenue: round2(entry.revenue),
      average_deal_value: safeAverage(entry.revenue, entry.deal_count),
    };
  });

  const totalDeals = series.reduce((sum, bucket) => sum + bucket.deal_count, 0);
  const totalRevenue = series.reduce((sum, bucket) => sum + bucket.revenue, 0);

  return {
    data: {
      period: range.period,
      granularity,
      currency,
      series,
      totals: {
        deal_count: totalDeals,
        revenue: round2(totalRevenue),
        average_deal_value: safeAverage(totalRevenue, totalDeals),
      },
      other_currencies: [...otherCurrencies.entries()]
        .map(([code, entry]) => ({
          currency: code,
          deal_count: entry.deal_count,
          revenue: round2(entry.revenue),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    },
    meta: reportMeta(range, scope, currency, {
      granularity,
      buckets_truncated: keys.length > MAX_REVENUE_BUCKETS,
      note:
        'Won deals dated by actual_close, bucketed in UTC (weeks start Monday, as in PostgreSQL date_trunc). Values are never converted between currencies: deals in another currency are reported separately in other_currencies. Amounts are raw numbers — format them client-side with the market profile locale.',
    }),
  };
}

// ─── 5. Pipeline health ───────────────────────────────────────────────────────

export type PipelineHealthRow = {
  pipeline_id: string | null;
  pipeline_name: string | null;
  pipeline_health_score: number;
  won: number;
  lost: number;
  stalled: number;
  open: number;
};

export type PipelineHealthReport = {
  period: ReportPeriod;
  pipeline_health_score: number;
  components: {
    won: number;
    lost: number;
    stalled: number;
    open: number;
    decay_factor: number;
    stalled_threshold_days: number;
    stalled_since: string;
  };
  pipelines: PipelineHealthRow[];
};

export async function getPipelineHealth(
  requester: Requester,
  query: ReportQuery = {},
): Promise<ReportEnvelope<PipelineHealthReport>> {
  const range = resolveReportRange(query);
  const scope = await resolveReportScope(requester, query);
  const settings = await loadOrgReportingSettings(scope.orgId);
  const stalledSince = new Date(Date.now() - settings.stalled_threshold_days * MS_PER_DAY);
  const base = dealBaseWhere(scope, query);

  const [closedRows, openRows, stalledRows, pipelines] = await Promise.all([
    db.deal.groupBy({
      by: ['pipeline_id', 'status'],
      where: {
        ...base,
        status: { in: [DealStatus.won, DealStatus.lost] },
        actual_close: { gte: range.start, lt: range.end },
      },
      _count: { _all: true },
    }),
    db.deal.groupBy({
      by: ['pipeline_id'],
      where: { ...base, status: DealStatus.open },
      _count: { _all: true },
    }),
    db.deal.groupBy({
      by: ['pipeline_id'],
      where: { ...base, status: DealStatus.open, updated_at: { lt: stalledSince } },
      _count: { _all: true },
    }),
    db.pipeline.findMany({
      where: {
        organization_id: scope.orgId,
        ...(query.pipeline_id ? { id: query.pipeline_id } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  type Counts = { won: number; lost: number; stalled: number; open: number };
  const byPipeline = new Map<string, Counts>();
  const ensure = (pipelineId: string | null): Counts => {
    const key = pipelineId ?? '';
    const existing = byPipeline.get(key);
    if (existing) return existing;
    const created: Counts = { won: 0, lost: 0, stalled: 0, open: 0 };
    byPipeline.set(key, created);
    return created;
  };

  for (const pipeline of pipelines) ensure(pipeline.id);
  for (const row of closedRows) {
    const entry = ensure(row.pipeline_id);
    if (row.status === DealStatus.won) entry.won += row._count._all;
    else entry.lost += row._count._all;
  }
  for (const row of openRows) ensure(row.pipeline_id).open += row._count._all;
  for (const row of stalledRows) ensure(row.pipeline_id).stalled += row._count._all;

  const nameById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name]));
  const rows: PipelineHealthRow[] = [...byPipeline.entries()].map(([key, counts]) => ({
    pipeline_id: key === '' ? null : key,
    pipeline_name: key === '' ? null : nameById.get(key) ?? null,
    pipeline_health_score: pipelineHealthScore({ ...counts, decay_factor: settings.decay_factor }),
    ...counts,
  }));

  rows.sort(
    (a, b) =>
      b.won + b.lost + b.stalled - (a.won + a.lost + a.stalled) ||
      (a.pipeline_name ?? '').localeCompare(b.pipeline_name ?? ''),
  );

  const components = rows.reduce<Counts>(
    (sum, row) => ({
      won: sum.won + row.won,
      lost: sum.lost + row.lost,
      stalled: sum.stalled + row.stalled,
      open: sum.open + row.open,
    }),
    { won: 0, lost: 0, stalled: 0, open: 0 },
  );

  return {
    data: {
      period: range.period,
      pipeline_health_score: pipelineHealthScore({
        ...components,
        decay_factor: settings.decay_factor,
      }),
      components: {
        ...components,
        decay_factor: settings.decay_factor,
        stalled_threshold_days: settings.stalled_threshold_days,
        stalled_since: stalledSince.toISOString(),
      },
      pipelines: rows,
    },
    meta: reportMeta(range, scope, settings.currency, {
      formula: 'won / (won + lost + stalled * decay_factor)',
      note:
        'Always present this as the Pipeline Health Score («Здоровье воронки»), never as a win rate. Won and lost are dated by actual_close inside the range; stalled is a current snapshot of open deals untouched since stalled_since.',
    }),
  };
}
