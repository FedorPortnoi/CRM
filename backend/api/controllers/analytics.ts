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

type ExportBody = DateRangeQuery & {
  format: 'csv' | 'pdf';
  report: 'funnel' | 'revenue' | 'team_activity' | 'win_loss' | 'lead_sources';
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const escape = (v: string | number | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [headers, ...rows].map(row => row.map(escape).join(',')).join('\n');
}

function toSimplePdf(title: string, lines: string[]): Buffer {
  const escapePdf = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const text = [
    `BT /F1 16 Tf 48 780 Td (${escapePdf(title)}) Tj ET`,
    ...lines.slice(0, 42).map((line, index) =>
      `BT /F1 9 Tf 48 ${750 - index * 16} Td (${escapePdf(line.slice(0, 110))}) Tj ET`,
    ),
  ].join('\n');

  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(text)} >> stream\n${text}\nendstream endobj`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to } = request.query as DateRangeQuery;
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to, group_by } = request.query as RevenueQuery;
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period } = request.query as DateRangeQuery;
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period } = request.query as DateRangeQuery;
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to } = request.query as DateRangeQuery;
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
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, period, pipeline_id, assigned_to } = request.query as DateRangeQuery;
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
    db.deal.count({
      where: {
        organization_id: orgId,
        status: DealStatus.open,
        updated_at: { lt: stalledThreshold },
      },
    }),
  ]);

  const openAgg = dealStatusAgg.find((row) => row.status === DealStatus.open);
  const wonCount = dealStatusAgg.find((row) => row.status === DealStatus.won)?._count._all ?? 0;
  const lostCount = dealStatusAgg.find((row) => row.status === DealStatus.lost)?._count._all ?? 0;
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

  return reply.send({
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
  });
}

async function conversionRates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { pipeline_id } = request.query as DateRangeQuery;
  const orgId = request.user.org_id;

  const pipelines = await db.pipeline.findMany({
    where: {
      organization_id: orgId,
      ...(pipeline_id ? { id: pipeline_id } : {}),
    },
    include: {
      stages: { orderBy: { position: 'asc' } },
    },
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
          from_stage_position: fromStage.position,
          to_stage_id: toStage.id,
          to_stage_name: toStage.name,
          to_stage_position: toStage.position,
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

  reply.send({ data, meta: {} });
}

async function stageDuration(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { pipeline_id } = request.query as DateRangeQuery;
  const orgId = request.user.org_id;
  const now = Date.now();

  const deals = await db.deal.findMany({
    where: {
      organization_id: orgId,
      status: { not: DealStatus.archived },
      stage_id: { not: null },
      ...(pipeline_id ? { pipeline_id } : {}),
    },
    select: {
      stage_id: true,
      status: true,
      updated_at: true,
      actual_close: true,
      pipeline_id: true,
      stage: { select: { name: true, position: true } },
      pipeline: { select: { name: true } },
    },
  });

  const stageMap = new Map<
    string,
    { name: string; position: number; pipeline_id: string; pipeline_name: string; total_days: number; count: number }
  >();

  for (const deal of deals) {
    if (!deal.stage_id || !deal.stage) continue;

    const closeMs =
      deal.status === DealStatus.won || deal.status === DealStatus.lost
        ? (deal.actual_close?.getTime() ?? deal.updated_at.getTime())
        : now;

    const days_in_stage = Math.max(0, (closeMs - deal.updated_at.getTime()) / 86_400_000);

    const existing = stageMap.get(deal.stage_id) ?? {
      name: deal.stage.name,
      position: deal.stage.position,
      pipeline_id: deal.pipeline_id ?? '',
      pipeline_name: deal.pipeline?.name ?? '',
      total_days: 0,
      count: 0,
    };

    existing.total_days += days_in_stage;
    existing.count += 1;
    stageMap.set(deal.stage_id, existing);
  }

  const data = Array.from(stageMap.entries())
    .map(([stage_id, s]) => ({
      stage_id,
      stage_name: s.name,
      pipeline_id: s.pipeline_id,
      pipeline_name: s.pipeline_name,
      avg_days: Math.round((s.total_days / s.count) * 100) / 100,
      deal_count: s.count,
    }))
    .sort((a, b) => {
      if (a.pipeline_id < b.pipeline_id) return -1;
      if (a.pipeline_id > b.pipeline_id) return 1;
      const posA = stageMap.get(a.stage_id)?.position ?? 0;
      const posB = stageMap.get(b.stage_id)?.position ?? 0;
      return posA - posB;
    });

  reply.send({
    data,
    meta: { note: 'Stage duration uses updated_at delta as a proxy — no stage history table available' },
  });
}

async function exportReport(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { format, report, period, start, end, pipeline_id, assigned_to } =
    request.body as ExportBody;

  const orgId = request.user.org_id;
  const { startDate, endDate } = resolveDateRange(period, start, end);
  const baseWhere: Prisma.DealWhereInput = {
    organization_id: orgId,
    created_at: { gte: startDate, lte: endDate },
    ...(pipeline_id && { pipeline_id }),
    ...(assigned_to && { assigned_to }),
  };

  let csv = '';

  if (report === 'funnel') {
    const groups = await db.deal.groupBy({
      by: ['stage_id', 'status'],
      where: baseWhere,
      _count: { _all: true },
      _sum: { value: true },
    });
    const stageMap = new Map<string, { open: number; won: number; lost: number; total_value: number }>();
    for (const row of groups) {
      const key = row.stage_id ?? 'unassigned';
      const e = stageMap.get(key) ?? { open: 0, won: 0, lost: 0, total_value: 0 };
      if (row.status === DealStatus.open) e.open += row._count._all;
      else if (row.status === DealStatus.won) e.won += row._count._all;
      else if (row.status === DealStatus.lost) e.lost += row._count._all;
      e.total_value += row._sum.value ? parseFloat(row._sum.value.toString()) : 0;
      stageMap.set(key, e);
    }
    const rows = Array.from(stageMap.entries()).map(([stage_id, d]) => {
      const closed = d.won + d.lost;
      return [stage_id, d.open, d.won, d.lost, d.open + d.won + d.lost,
        Math.round(d.total_value * 100) / 100,
        closed > 0 ? Math.round((d.won / closed) * 10_000) / 100 : null,
      ] as (string | number | null)[];
    });
    csv = toCsv(['stage_id', 'open', 'won', 'lost', 'total', 'total_value', 'conversion_rate'], rows);

  } else if (report === 'revenue') {
    const deals = await db.deal.findMany({
      where: {
        organization_id: orgId,
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
      const key = getPeriodKey(deal.actual_close, 'month');
      const ex = buckets.get(key) ?? { count: 0, revenue: 0 };
      buckets.set(key, {
        count: ex.count + 1,
        revenue: ex.revenue + (deal.value ? parseFloat(deal.value.toString()) : 0),
      });
    }
    const rows = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, d]) => [p, d.count, Math.round(d.revenue * 100) / 100,
        d.count > 0 ? Math.round((d.revenue / d.count) * 100) / 100 : 0,
      ] as (string | number | null)[]);
    csv = toCsv(['period', 'deal_count', 'revenue', 'avg_deal_value'], rows);

  } else if (report === 'team_activity') {
    const dateRange = { created_at: { gte: startDate, lte: endDate } };
    const [msgGroups, taskGroups, meetingGroups] = await Promise.all([
      db.message.groupBy({ by: ['user_id'], where: { organization_id: orgId, user_id: { not: null }, ...dateRange }, _count: { _all: true } }),
      db.task.groupBy({ by: ['assigned_to'], where: { organization_id: orgId, ...dateRange }, _count: { _all: true } }),
      db.calendarEvent.groupBy({ by: ['created_by'], where: { organization_id: orgId, created_by: { not: null }, ...dateRange }, _count: { _all: true } }),
    ]);
    const allUserIds = new Set<string>();
    msgGroups.forEach(r => { if (r.user_id) allUserIds.add(r.user_id); });
    taskGroups.forEach(r => allUserIds.add(r.assigned_to));
    meetingGroups.forEach(r => { if (r.created_by) allUserIds.add(r.created_by); });
    const users = await db.user.findMany({
      where: { id: { in: Array.from(allUserIds) }, organization_id: orgId },
      select: { id: true, name: true },
    });
    const userMap = new Map(users.map(u => [u.id, u.name]));
    const msgMap = new Map(msgGroups.flatMap(r => r.user_id ? [[r.user_id, r._count._all] as [string, number]] : []));
    const taskMap = new Map(taskGroups.map(r => [r.assigned_to, r._count._all] as [string, number]));
    const meetingMap = new Map(meetingGroups.flatMap(r => r.created_by ? [[r.created_by, r._count._all] as [string, number]] : []));
    const rows = Array.from(allUserIds).map(uid => {
      const msgs = msgMap.get(uid) ?? 0;
      const tasks = taskMap.get(uid) ?? 0;
      const meetings = meetingMap.get(uid) ?? 0;
      return [uid, userMap.get(uid) ?? 'Unknown', msgs, tasks, meetings, msgs + tasks + meetings] as (string | number | null)[];
    });
    csv = toCsv(['user_id', 'name', 'messages', 'tasks', 'meetings', 'total'], rows);

  } else if (report === 'win_loss') {
    const [statusGroups, reasonGroups] = await Promise.all([
      db.deal.groupBy({ by: ['status'], where: { ...baseWhere, status: { in: [DealStatus.won, DealStatus.lost] } }, _count: { _all: true }, _sum: { value: true } }),
      db.deal.groupBy({ by: ['lost_reason'], where: { ...baseWhere, status: DealStatus.lost }, _count: { _all: true } }),
    ]);
    const rows: (string | number | null)[][] = statusGroups.map(r => [
      r.status, r._count._all,
      r._sum.value ? Math.round(parseFloat(r._sum.value.toString()) * 100) / 100 : 0,
      null, null,
    ]);
    for (const r of reasonGroups) {
      rows.push([null, null, null, r.lost_reason ?? 'unspecified', r._count._all]);
    }
    csv = toCsv(['status', 'count', 'total_value', 'lost_reason', 'reason_count'], rows);

  } else {
    // lead_sources
    const groups = await db.deal.groupBy({
      by: ['source'],
      where: baseWhere,
      _count: { _all: true },
      _sum: { value: true },
    });
    const rows = groups.map(r => [
      r.source ?? 'unknown', r._count._all,
      r._sum.value ? Math.round(parseFloat(r._sum.value.toString()) * 100) / 100 : 0,
    ] as (string | number | null)[]);
    csv = toCsv(['source', 'count', 'total_value'], rows);
  }

  if (format === 'pdf') {
    const pdf = toSimplePdf(
      `${report.replace('_', ' ')} report`,
      csv.split('\n'),
    );
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="export-${report}-${Date.now()}.pdf"`)
      .send(pdf);
    return;
  }

  reply
    .header('Content-Type', 'text/csv')
    .header('Content-Disposition', `attachment; filename="export-${report}-${Date.now()}.csv"`)
    .send(csv);
}

const exportStatus = (_req: FastifyRequest, reply: FastifyReply): void => {
  reply.send({
    data: {
      status: 'completed',
      mode: 'synchronous',
      message: 'Exports are generated synchronously by POST /api/v1/analytics/export',
    },
    meta: {},
  });
};

const exportDownload = (_req: FastifyRequest, reply: FastifyReply): void => {
  reply.status(404).send({
    error: {
      code: 'EXPORT_NOT_FOUND',
      message: 'No async export file exists; use POST /api/v1/analytics/export for immediate download',
    },
  });
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const AnalyticsController = {
  dashboard,
  funnel,
  conversionRates,
  stageDuration,
  leadSources,
  winLoss,
  revenue,
  teamActivity,
  repPerformance,
  exportReport,
  exportStatus,
  exportDownload,
};
