import { FastifyRequest, FastifyReply } from 'fastify';
import { DealStatus, Prisma } from '@prisma/client';
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

// ─── Stubs (Sprint 3+) ────────────────────────────────────────────────────────

const stub = (_req: FastifyRequest, reply: FastifyReply): void => {
  reply.status(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not yet implemented' } });
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const AnalyticsController = {
  dashboard: stub,
  funnel,
  conversionRates: stub,
  stageDuration: stub,
  leadSources: stub,
  winLoss: stub,
  revenue,
  teamActivity: stub,
  repPerformance: stub,
  exportReport: stub,
  exportStatus: stub,
  exportDownload: stub,
};
