import { FastifyRequest, FastifyReply } from 'fastify';
import { DealStatus, Prisma, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';

// ─── Local request types ──────────────────────────────────────────────────────

type DateRangeQuery = {
  start?: string;
  end?: string;
  period: 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
  pipeline_id?: string;
  assigned_to?: string;
};

type RevenueQuery = DateRangeQuery & {
  group_by: 'day' | 'week' | 'month' | 'quarter';
  currency: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    default: // month
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
  return `${y}-${m}`; // month (default)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function funnel(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to } = request.query;
  const { startDate, endDate } = resolveDateRange(period, start, end);

  const where: Prisma.DealWhereInput = {
    organization_id: request.user.org_id,
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

  // Aggregate counts per stage
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
    const conversion_rate = closed > 0 ? Math.round((data.won / closed) * 10_000) / 100 : null;
    return {
      stage_id,
      open: data.open,
      won: data.won,
      lost: data.lost,
      total: data.open + data.won + data.lost + data.archived,
      total_value: Math.round(data.total_value * 100) / 100,
      conversion_rate,
    };
  });

  const totalDeals = stages.reduce((s, x) => s + x.total, 0);
  const totalWon = stages.reduce((s, x) => s + x.won, 0);
  const totalLost = stages.reduce((s, x) => s + x.lost, 0);
  const totalClosed = totalWon + totalLost;

  reply.send({
    data: {
      period: { start: startDate, end: endDate },
      stages,
      summary: {
        total_deals: totalDeals,
        total_won: totalWon,
        total_lost: totalLost,
        total_value: Math.round(stages.reduce((s, x) => s + x.total_value, 0) * 100) / 100,
        overall_conversion_rate:
          totalClosed > 0 ? Math.round((totalWon / totalClosed) * 10_000) / 100 : null,
      },
    },
    meta: {},
  });
}

async function revenue(
  request: FastifyRequest<{ Querystring: RevenueQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to, group_by } = request.query;
  const { startDate, endDate } = resolveDateRange(period, start, end);

  const deals = await db.deal.findMany({
    where: {
      organization_id: request.user.org_id,
      status: DealStatus.won,
      actual_close: { gte: startDate, lte: endDate },
      ...(pipeline_id && { pipeline_id }),
      ...(assigned_to && { assigned_to }),
    },
    select: { actual_close: true, value: true },
    orderBy: { actual_close: 'asc' },
  });

  // Group by period in application layer (avoids db.$queryRaw for portability)
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
      avg_deal_value:
        data.count > 0 ? Math.round((data.revenue / data.count) * 100) / 100 : 0,
    }));

  const totalRevenue = periods.reduce((s, p) => s + p.revenue, 0);
  const totalDeals = periods.reduce((s, p) => s + p.deal_count, 0);

  reply.send({
    data: {
      period: { start: startDate, end: endDate, group_by },
      periods,
      summary: {
        total_revenue: Math.round(totalRevenue * 100) / 100,
        total_deals: totalDeals,
        avg_deal_value:
          totalDeals > 0 ? Math.round((totalRevenue / totalDeals) * 100) / 100 : 0,
      },
    },
    meta: {},
  });
}

// ─── Analytics: Team Activity + Rep Performance ──────────────────────────────

async function teamActivity(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period } = request.query;
  const { startDate, endDate } = resolveDateRange(period, start, end);
  const orgId = request.user.org_id;
  const dateRange = { created_at: { gte: startDate, lte: endDate } };

  const [msgGroups, taskGroups, meetingGroups] = await Promise.all([
    db.message.groupBy({
      by: ['user_id'],
      where: { organization_id: orgId, user_id: { not: null }, ...dateRange },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ['assigned_to'],
      where: { organization_id: orgId, ...dateRange },
      _count: { _all: true },
    }),
    db.calendarEvent.groupBy({
      by: ['created_by'],
      where: { organization_id: orgId, created_by: { not: null }, ...dateRange },
      _count: { _all: true },
    }),
  ]);

  const allUserIds = new Set<string>();
  msgGroups.forEach(r => { if (r.user_id) allUserIds.add(r.user_id); });
  taskGroups.forEach(r => allUserIds.add(r.assigned_to));
  meetingGroups.forEach(r => { if (r.created_by) allUserIds.add(r.created_by); });

  const users = await db.user.findMany({
    where: { id: { in: Array.from(allUserIds) }, organization_id: orgId },
    select: { id: true, name: true },
  });

  const userMap = new Map<string, string>(users.map(u => [u.id, u.name]));
  const msgMap = new Map<string, number>(
    msgGroups.flatMap(r => (r.user_id ? [[r.user_id, r._count._all]] : [])),
  );
  const taskMap = new Map<string, number>(taskGroups.map(r => [r.assigned_to, r._count._all]));
  const meetingMap = new Map<string, number>(
    meetingGroups.flatMap(r => (r.created_by ? [[r.created_by, r._count._all]] : [])),
  );

  const data = Array.from(allUserIds).map(uid => {
    const messages = msgMap.get(uid) ?? 0;
    const tasks = taskMap.get(uid) ?? 0;
    const meetings = meetingMap.get(uid) ?? 0;
    return { user_id: uid, name: userMap.get(uid) ?? 'Unknown', messages, tasks, meetings, total: messages + tasks + meetings };
  });

  reply.send({ data, meta: {} });
}

async function repPerformance(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period } = request.query;
  const { startDate, endDate } = resolveDateRange(period, start, end);
  const orgId = request.user.org_id;
  const baseWhere: Prisma.DealWhereInput = {
    organization_id: orgId,
    assigned_to: { not: null },
    created_at: { gte: startDate, lte: endDate },
  };

  const [allGroups, wonGroups, lostGroups] = await Promise.all([
    db.deal.groupBy({
      by: ['assigned_to'],
      where: baseWhere,
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.groupBy({
      by: ['assigned_to'],
      where: { ...baseWhere, status: DealStatus.won },
      _count: { _all: true },
    }),
    db.deal.groupBy({
      by: ['assigned_to'],
      where: { ...baseWhere, status: DealStatus.lost },
      _count: { _all: true },
    }),
  ]);

  const userIds = allGroups.flatMap(r => (r.assigned_to ? [r.assigned_to] : []));
  const users = await db.user.findMany({
    where: { id: { in: userIds }, organization_id: orgId },
    select: { id: true, name: true },
  });

  const userMap = new Map<string, string>(users.map(u => [u.id, u.name]));
  const wonMap = new Map<string, number>(
    wonGroups.flatMap(r => (r.assigned_to ? [[r.assigned_to, r._count._all]] : [])),
  );
  const lostMap = new Map<string, number>(
    lostGroups.flatMap(r => (r.assigned_to ? [[r.assigned_to, r._count._all]] : [])),
  );

  const data = allGroups.flatMap(r => {
    if (!r.assigned_to) return [];
    const uid = r.assigned_to;
    const deals_total = r._count._all;
    const deals_won = wonMap.get(uid) ?? 0;
    const deals_lost = lostMap.get(uid) ?? 0;
    const total_value = r._sum.value ? Math.round(parseFloat(r._sum.value.toString()) * 100) / 100 : 0;
    const win_rate = deals_total > 0 ? Math.round((deals_won / deals_total) * 10_000) / 100 : 0;
    return [{ user_id: uid, name: userMap.get(uid) ?? 'Unknown', deals_total, deals_won, deals_lost, total_value, win_rate }];
  });

  reply.send({ data, meta: {} });
}

// ─── Analytics: Win-Loss + Lead Sources ──────────────────────────────────────

async function leadSources(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to } = request.query;
  const { startDate, endDate } = resolveDateRange(period, start, end);

  const groups = await db.deal.groupBy({
    by: ['source'],
    where: {
      organization_id: request.user.org_id,
      created_at: { gte: startDate, lte: endDate },
      ...(pipeline_id && { pipeline_id }),
      ...(assigned_to && { assigned_to }),
    },
    _count: { _all: true },
    _sum: { value: true },
  });

  const data = groups.map(r => ({
    source: r.source ?? 'unknown',
    count: r._count._all,
    total_value: r._sum.value ? Math.round(parseFloat(r._sum.value.toString()) * 100) / 100 : 0,
  }));

  reply.send({ data, meta: {} });
}

async function winLoss(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to } = request.query;
  const { startDate, endDate } = resolveDateRange(period, start, end);

  const baseWhere: Prisma.DealWhereInput = {
    organization_id: request.user.org_id,
    created_at: { gte: startDate, lte: endDate },
    ...(pipeline_id && { pipeline_id }),
    ...(assigned_to && { assigned_to }),
  };

  const [statusGroups, reasonGroups] = await Promise.all([
    db.deal.groupBy({
      by: ['status'],
      where: { ...baseWhere, status: { in: [DealStatus.won, DealStatus.lost] } },
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.deal.groupBy({
      by: ['lost_reason'],
      where: { ...baseWhere, status: DealStatus.lost },
      _count: { _all: true },
    }),
  ]);

  const wonRow = statusGroups.find(r => r.status === DealStatus.won);
  const lostRow = statusGroups.find(r => r.status === DealStatus.lost);

  const data = {
    won: {
      count: wonRow?._count._all ?? 0,
      total_value: wonRow?._sum.value ? Math.round(parseFloat(wonRow._sum.value.toString()) * 100) / 100 : 0,
    },
    lost: {
      count: lostRow?._count._all ?? 0,
      total_value: lostRow?._sum.value ? Math.round(parseFloat(lostRow._sum.value.toString()) * 100) / 100 : 0,
    },
    reasons: reasonGroups.map(r => ({
      reason: r.lost_reason ?? 'unspecified',
      count: r._count._all,
    })),
  };

  reply.send({ data, meta: {} });
}

// ─── Stubs (Sprint 3+) ────────────────────────────────────────────────────────


async function dashboard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orgId = request.user.org_id;

  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { stalled_threshold_days: true, decay_factor: true },
  });

  const stalledThreshold = new Date(Date.now() - org.stalled_threshold_days * 86_400_000);

  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const tomorrowUTC = new Date(todayUTC.getTime() + 86_400_000);

  const [dealsAgg, tasksDueCount, recentMsgs, recentTasks, recentEvents, wonCount, lostCount, stalledCount] =
    await Promise.all([
      db.deal.aggregate({
        where: { organization_id: orgId, status: DealStatus.open },
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
        select: { id: true, body: true, channel: true, created_at: true },
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
      db.deal.count({ where: { organization_id: orgId, status: DealStatus.won } }),
      db.deal.count({ where: { organization_id: orgId, status: DealStatus.lost } }),
      db.deal.count({
        where: {
          organization_id: orgId,
          status: DealStatus.open,
          updated_at: { lt: stalledThreshold },
        },
      }),
    ]);

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

  return reply.send({
    data: {
      open_deals: {
        count: dealsAgg._count._all,
        total_value: Math.round(parseFloat((dealsAgg._sum.value ?? 0).toString()) * 100) / 100,
      },
      tasks_due_today: tasksDueCount,
      recent_activity: activity,
      pipeline_health_score,
    },
    meta: {},
  });
}

const stub = (_req: FastifyRequest, reply: FastifyReply): void => {
  reply.status(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not yet implemented' } });
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const AnalyticsController = {
  dashboard,
  funnel,
  conversionRates: stub,
  stageDuration: stub,
  leadSources,
  winLoss,
  revenue,
  teamActivity,
  repPerformance,
  exportReport: stub,
  exportStatus: stub,
  exportDownload: stub,
};
