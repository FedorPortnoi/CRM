import { DealStatus, TaskStatus, Prisma } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';

type PeriodValue = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
type GroupByValue = 'day' | 'week' | 'month' | 'quarter';

function isPeriod(v: unknown): v is PeriodValue {
  return v === 'today' || v === 'week' || v === 'month' || v === 'quarter' || v === 'year' || v === 'custom';
}

function isGroupBy(v: unknown): v is GroupByValue {
  return v === 'day' || v === 'week' || v === 'month' || v === 'quarter';
}

function resolveDateRange(
  period: string,
  start?: string,
  end?: string,
): { startDate: Date; endDate: Date } {
  const now = new Date();
  if (period === 'custom' && start && end) {
    return { startDate: new Date(start), endDate: new Date(end) };
  }
  const startDate = new Date(now);
  switch (period) {
    case 'today':
      startDate.setUTCHours(0, 0, 0, 0);
      break;
    case 'week':
      startDate.setUTCDate(now.getUTCDate() - 7);
      break;
    case 'quarter':
      startDate.setUTCMonth(now.getUTCMonth() - 3);
      break;
    case 'year':
      startDate.setUTCFullYear(now.getUTCFullYear() - 1);
      break;
    default:
      startDate.setUTCMonth(now.getUTCMonth() - 1);
  }
  return { startDate, endDate: now };
}

function getPeriodKey(date: Date, groupBy: string): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  if (groupBy === 'day') return `${y}-${m}-${d}`;
  if (groupBy === 'week') {
    const startOfYear = new Date(Date.UTC(y, 0, 1));
    const dayOfYear = Math.floor((date.getTime() - startOfYear.getTime()) / 86_400_000);
    const week = Math.ceil((dayOfYear + startOfYear.getUTCDay() + 1) / 7);
    return `${y}-W${String(week).padStart(2, '0')}`;
  }
  if (groupBy === 'quarter') {
    const q = Math.ceil((date.getUTCMonth() + 1) / 3);
    return `${y}-Q${q}`;
  }
  return `${y}-${m}`;
}

registerTool(
  'get_dashboard',
  'Get the CRM dashboard summary: open deals, tasks due today, recent activity, and pipeline health score',
  {
    type: 'object',
    properties: {},
  },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const orgId = user.org_id;

    const org = await db.org.findUniqueOrThrow({
      where: { id: orgId },
      select: { stalled_threshold_days: true, decay_factor: true },
    });

    const stalledThreshold = new Date(Date.now() - org.stalled_threshold_days * 86_400_000);
    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);
    const tomorrowUTC = new Date(todayUTC.getTime() + 86_400_000);

    const [dealStatusAgg, tasksDueCount, recentMsgs, recentTasks, recentEvents, stalledCount] = await Promise.all([
      db.deal.groupBy({
        by: ['status'],
        where: {
          organization_id: orgId,
          status: { in: [DealStatus.open, DealStatus.won, DealStatus.lost] },
        },
        _count: { _all: true },
        _sum: { value: true },
      }),
      db.task.count({
        where: {
          organization_id: orgId,
          status: { notIn: [TaskStatus.cancelled, TaskStatus.done] },
          due_date: { gte: todayUTC, lt: tomorrowUTC },
        },
      }),
      db.message.findMany({
        where: { organization_id: orgId },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: { id: true, body: true, created_at: true },
      }),
      db.task.findMany({
        where: { organization_id: orgId },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: { id: true, title: true, created_at: true },
      }),
      db.calendarEvent.findMany({
        where: { organization_id: orgId },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: { id: true, title: true, created_at: true },
      }),
      db.deal.count({
        where: {
          organization_id: orgId,
          status: DealStatus.open,
          updated_at: { lt: stalledThreshold },
        },
      }),
    ]);

    const openAgg = dealStatusAgg.find((r) => r.status === DealStatus.open);
    const wonCount = dealStatusAgg.find((r) => r.status === DealStatus.won)?._count._all ?? 0;
    const lostCount = dealStatusAgg.find((r) => r.status === DealStatus.lost)?._count._all ?? 0;
    const openTotalValue = openAgg?._sum.value ?? 0;

    const activity = [
      ...recentMsgs.map((m) => ({ type: 'message' as const, id: m.id, summary: m.body, created_at: m.created_at })),
      ...recentTasks.map((t) => ({ type: 'task' as const, id: t.id, summary: t.title, created_at: t.created_at })),
      ...recentEvents.map((e) => ({ type: 'meeting' as const, id: e.id, summary: e.title, created_at: e.created_at })),
    ]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 5);

    const denominator = wonCount + lostCount + stalledCount * org.decay_factor;
    const rawScore = denominator === 0 ? 0 : wonCount / denominator;
    const pipeline_health_score = Math.round(rawScore * 10_000) / 100;

    return {
      data: {
        open_deals: {
          count: openAgg?._count._all ?? 0,
          total_value: Math.round(parseFloat(openTotalValue.toString()) * 100) / 100,
        },
        tasks_due_today: tasksDueCount,
        recent_activity: activity,
        pipeline_health_score,
      },
      meta: {},
    };
  },
);

registerTool(
  'get_pipeline_health',
  'Get stage conversion rates for one or all pipelines',
  {
    type: 'object',
    properties: {
      pipeline_id: { type: 'string', description: 'Optional pipeline UUID — omit for all pipelines' },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : undefined;
    const orgId = user.org_id;

    const pipelines = await db.pipeline.findMany({
      where: {
        organization_id: orgId,
        ...(pipeline_id ? { id: pipeline_id } : {}),
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    });

    const data = await Promise.all(
      pipelines.map(async (pipeline) => {
        const deals = await db.deal.findMany({
          where: {
            organization_id: orgId,
            pipeline_id: pipeline.id,
            status: { not: DealStatus.archived },
          },
          select: {
            status: true,
            stage: { select: { position: true } },
          },
        });

        const transitions = pipeline.stages.slice(1).flatMap((toStage, index) => {
          const fromStage = pipeline.stages[index];
          if (!fromStage) return [];

          const entered_count = deals.filter(
            (d) => (d.stage?.position ?? -1) >= fromStage.position || d.status === DealStatus.won,
          ).length;

          const progressed_count = deals.filter(
            (d) => (d.stage?.position ?? -1) >= toStage.position || d.status === DealStatus.won,
          ).length;

          const conversion_rate =
            entered_count === 0 ? 0 : Math.round((progressed_count / entered_count) * 10_000) / 100;

          return [{
            from_stage_id: fromStage.id,
            from_stage_name: fromStage.name,
            to_stage_id: toStage.id,
            to_stage_name: toStage.name,
            entered_count,
            progressed_count,
            conversion_rate,
          }];
        });

        return {
          pipeline_id: pipeline.id,
          pipeline_name: pipeline.name,
          transitions,
          note: 'Conversion rates use current stage position as a proxy — no stage history table available',
        };
      }),
    );

    return { data, meta: {} };
  },
);

registerTool(
  'get_funnel',
  'Get funnel analytics: deal counts and values grouped by stage and status',
  {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year', 'custom'], default: 'month' },
      start: { type: 'string', description: 'ISO 8601 start (required when period=custom)' },
      end: { type: 'string', description: 'ISO 8601 end (required when period=custom)' },
      pipeline_id: { type: 'string', description: 'Optional pipeline filter' },
      assigned_to: { type: 'string', description: 'Optional assignee filter' },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const period = isPeriod(args.period) ? args.period : 'month';
    const start = typeof args.start === 'string' ? args.start : undefined;
    const end = typeof args.end === 'string' ? args.end : undefined;
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;

    const { startDate, endDate } = resolveDateRange(period, start, end);

    const where: Prisma.DealWhereInput = {
      organization_id: user.org_id,
      created_at: { gte: startDate, lte: endDate },
      ...(pipeline_id && { pipeline_id }),
      ...(assigned_to && { assigned_to }),
    };

    const groups = await db.deal.groupBy({
      by: ['stage_id', 'status'],
      where,
      _count: { _all: true },
      _sum: { value: true },
    });

    const stageMap = new Map<
      string,
      { open: number; won: number; lost: number; archived: number; total_value: number }
    >();

    for (const row of groups) {
      const key = row.stage_id ?? 'unassigned';
      const entry = stageMap.get(key) ?? { open: 0, won: 0, lost: 0, archived: 0, total_value: 0 };
      const count = row._count._all;
      const val = row._sum.value ? parseFloat(row._sum.value.toString()) : 0;
      if (row.status === DealStatus.open) entry.open += count;
      else if (row.status === DealStatus.won) entry.won += count;
      else if (row.status === DealStatus.lost) entry.lost += count;
      else entry.archived += count;
      entry.total_value += val;
      stageMap.set(key, entry);
    }

    const stages = Array.from(stageMap.entries()).map(([stage_id, data]) => {
      const closed = data.won + data.lost;
      return {
        stage_id,
        open: data.open,
        won: data.won,
        lost: data.lost,
        total: data.open + data.won + data.lost + data.archived,
        total_value: Math.round(data.total_value * 100) / 100,
        conversion_rate: closed > 0 ? Math.round((data.won / closed) * 10_000) / 100 : null,
      };
    });

    const totalWon = stages.reduce((s, x) => s + x.won, 0);
    const totalLost = stages.reduce((s, x) => s + x.lost, 0);
    const totalClosed = totalWon + totalLost;

    return {
      data: {
        period: { start: startDate, end: endDate },
        stages,
        summary: {
          total_deals: stages.reduce((s, x) => s + x.total, 0),
          total_won: totalWon,
          total_lost: totalLost,
          total_value: Math.round(stages.reduce((s, x) => s + x.total_value, 0) * 100) / 100,
          overall_conversion_rate: totalClosed > 0 ? Math.round((totalWon / totalClosed) * 10_000) / 100 : null,
        },
      },
      meta: {},
    };
  },
);

registerTool(
  'get_revenue',
  'Get revenue analytics: won deals grouped by time period',
  {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year', 'custom'], default: 'month' },
      group_by: { type: 'string', enum: ['day', 'week', 'month', 'quarter'], default: 'month' },
      start: { type: 'string', description: 'ISO 8601 start (required when period=custom)' },
      end: { type: 'string', description: 'ISO 8601 end (required when period=custom)' },
      pipeline_id: { type: 'string' },
      assigned_to: { type: 'string' },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const period = isPeriod(args.period) ? args.period : 'month';
    const group_by = isGroupBy(args.group_by) ? args.group_by : 'month';
    const start = typeof args.start === 'string' ? args.start : undefined;
    const end = typeof args.end === 'string' ? args.end : undefined;
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;

    const { startDate, endDate } = resolveDateRange(period, start, end);

    const deals = await db.deal.findMany({
      where: {
        organization_id: user.org_id,
        status: DealStatus.won,
        actual_close: { gte: startDate, lte: endDate },
        ...(pipeline_id && { pipeline_id }),
        ...(assigned_to && { assigned_to }),
      },
      select: { actual_close: true, value: true },
      orderBy: { actual_close: 'asc' },
    });

    const buckets = new Map<string, { count: number; revenue: number }>();
    for (const deal of deals) {
      if (!deal.actual_close) continue;
      const key = getPeriodKey(deal.actual_close, group_by);
      const existing = buckets.get(key) ?? { count: 0, revenue: 0 };
      buckets.set(key, {
        count: existing.count + 1,
        revenue: existing.revenue + (deal.value ? parseFloat(deal.value.toString()) : 0),
      });
    }

    const periods = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period_key, data]) => ({
        period: period_key,
        deal_count: data.count,
        revenue: Math.round(data.revenue * 100) / 100,
        avg_deal_value: data.count > 0 ? Math.round((data.revenue / data.count) * 100) / 100 : 0,
      }));

    const totalRevenue = periods.reduce((s, p) => s + p.revenue, 0);
    const totalDeals = periods.reduce((s, p) => s + p.deal_count, 0);

    return {
      data: {
        period: { start: startDate, end: endDate, group_by },
        periods,
        summary: {
          total_revenue: Math.round(totalRevenue * 100) / 100,
          total_deals: totalDeals,
          avg_deal_value: totalDeals > 0 ? Math.round((totalRevenue / totalDeals) * 100) / 100 : 0,
        },
      },
      meta: {},
    };
  },
);

registerTool(
  'get_rep_performance',
  'Get deal performance metrics per sales rep',
  {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year', 'custom'], default: 'month' },
      start: { type: 'string' },
      end: { type: 'string' },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const period = isPeriod(args.period) ? args.period : 'month';
    const start = typeof args.start === 'string' ? args.start : undefined;
    const end = typeof args.end === 'string' ? args.end : undefined;

    const { startDate, endDate } = resolveDateRange(period, start, end);
    const orgId = user.org_id;

    const baseWhere: Prisma.DealWhereInput = {
      organization_id: orgId,
      assigned_to: { not: null },
      created_at: { gte: startDate, lte: endDate },
    };

    const [allGroups, wonGroups, lostGroups] = await Promise.all([
      db.deal.groupBy({ by: ['assigned_to'], where: baseWhere, _count: { _all: true }, _sum: { value: true } }),
      db.deal.groupBy({ by: ['assigned_to'], where: { ...baseWhere, status: DealStatus.won }, _count: { _all: true } }),
      db.deal.groupBy({ by: ['assigned_to'], where: { ...baseWhere, status: DealStatus.lost }, _count: { _all: true } }),
    ]);

    const userIds = allGroups.flatMap((r) => (r.assigned_to ? [r.assigned_to] : []));
    const users = await db.user.findMany({
      where: { id: { in: userIds }, organization_id: orgId },
      select: { id: true, name: true },
    });

    const userMap = new Map<string, string>(users.map((u) => [u.id, u.name]));
    const wonMap = new Map<string, number>(
      wonGroups.flatMap((r) => (r.assigned_to ? [[r.assigned_to, r._count._all]] : [])),
    );
    const lostMap = new Map<string, number>(
      lostGroups.flatMap((r) => (r.assigned_to ? [[r.assigned_to, r._count._all]] : [])),
    );

    const data = allGroups.flatMap((r) => {
      if (!r.assigned_to) return [];
      const uid = r.assigned_to;
      const deals_total = r._count._all;
      const deals_won = wonMap.get(uid) ?? 0;
      const deals_lost = lostMap.get(uid) ?? 0;
      const total_value = r._sum.value ? Math.round(parseFloat(r._sum.value.toString()) * 100) / 100 : 0;
      const win_rate = deals_total > 0 ? Math.round((deals_won / deals_total) * 10_000) / 100 : 0;
      return [{ user_id: uid, name: userMap.get(uid) ?? 'Unknown', deals_total, deals_won, deals_lost, total_value, win_rate }];
    });

    return { data, meta: {} };
  },
);

registerTool(
  'get_lead_sources',
  'Get deal counts and values grouped by lead source',
  {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year', 'custom'], default: 'month' },
      start: { type: 'string' },
      end: { type: 'string' },
      pipeline_id: { type: 'string' },
      assigned_to: { type: 'string' },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const period = isPeriod(args.period) ? args.period : 'month';
    const start = typeof args.start === 'string' ? args.start : undefined;
    const end = typeof args.end === 'string' ? args.end : undefined;
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;

    const { startDate, endDate } = resolveDateRange(period, start, end);

    const groups = await db.deal.groupBy({
      by: ['source'],
      where: {
        organization_id: user.org_id,
        created_at: { gte: startDate, lte: endDate },
        ...(pipeline_id && { pipeline_id }),
        ...(assigned_to && { assigned_to }),
      },
      _count: { _all: true },
      _sum: { value: true },
    });

    const data = groups.map((r) => ({
      source: r.source ?? 'unknown',
      count: r._count._all,
      total_value: r._sum.value ? Math.round(parseFloat(r._sum.value.toString()) * 100) / 100 : 0,
    }));

    return { data, meta: {} };
  },
);
