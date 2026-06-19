import { FastifyRequest, FastifyReply } from 'fastify';
import { CalendarEventStatus, DealStatus, Prisma, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';
import { getAccessibleUserIds } from '../../services/visibility';


async function dashboard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const orgId = request.user.org_id;
  const visibleIds = await getAccessibleUserIds(request.user);

  const org = await db.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { stalled_threshold_days: true, decay_factor: true, settings: true },
  });

  const stalledThreshold = new Date(Date.now() - org.stalled_threshold_days * 86_400_000);

  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const tomorrowUTC = new Date(todayUTC.getTime() + 86_400_000);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const staleCutoff = new Date(Date.now() - 14 * 86_400_000);
  const staleContactsWhere = {
    organization_id: orgId,
    updated_at: { lt: staleCutoff },
    ...(visibleIds && { assigned_to: { in: visibleIds } }),
  };

  const [dealStatusAgg, tasksDueCount, overdueTasksCount, dealsWithoutTasksCount, todaysEvents, staleContactsList, staleContactsCount, recentMsgs, recentTasks, recentEvents, stalledCount, monthlyRevenueAgg] = await Promise.all([
    db.deal.groupBy({
      by: ['status'],
      where: {
        organization_id: orgId,
        status: { in: [DealStatus.open, DealStatus.won, DealStatus.lost] },
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
      },
      _count: { _all: true },
      _sum: { value: true },
    }),
    db.task.count({
      where: {
        organization_id: orgId,
        status: { notIn: [TaskStatus.cancelled, TaskStatus.done] },
        due_date: { gte: todayUTC, lt: tomorrowUTC },
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
      },
    }),
    db.task.count({
      where: {
        organization_id: orgId,
        status: { notIn: [TaskStatus.cancelled, TaskStatus.done] },
        due_date: { lt: todayUTC },
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
      },
    }),
    db.deal.count({
      where: {
        organization_id: orgId,
        status: DealStatus.open,
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
        tasks: {
          none: {
            status: { notIn: [TaskStatus.cancelled, TaskStatus.done] },
          },
        },
      },
    }),
    db.calendarEvent.findMany({
      where: {
        organization_id: orgId,
        start_time: { gte: todayUTC, lt: tomorrowUTC },
        status: { not: CalendarEventStatus.cancelled },
        ...(visibleIds && { created_by: { in: visibleIds } }),
      },
      orderBy: { start_time: 'asc' },
      take: 5,
      select: {
        id: true,
        title: true,
        start_time: true,
        contact: { select: { first_name: true, last_name: true } },
      },
    }),
    db.contact.findMany({
      where: staleContactsWhere,
      orderBy: { updated_at: 'asc' },
      take: 5,
      select: { id: true, first_name: true, last_name: true, company: true, updated_at: true },
    }),
    db.contact.count({ where: staleContactsWhere }),
    db.message.findMany({
      where: {
        organization_id: orgId,
        ...(visibleIds && { user_id: { in: visibleIds } }),
      },
      orderBy: { created_at: 'desc' },
      take: 3,
      select: { id: true, body: true, channel: true, created_at: true },
    }),
    db.task.findMany({
      where: {
        organization_id: orgId,
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
      },
      orderBy: { created_at: 'desc' },
      take: 3,
      select: { id: true, title: true, created_at: true },
    }),
    db.calendarEvent.findMany({
      where: {
        organization_id: orgId,
        ...(visibleIds && { created_by: { in: visibleIds } }),
      },
      orderBy: { created_at: 'desc' },
      take: 3,
      select: { id: true, title: true, created_at: true },
    }),
    db.deal.count({
      where: {
        organization_id: orgId,
        status: DealStatus.open,
        updated_at: { lt: stalledThreshold },
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
      },
    }),
    db.deal.aggregate({
      where: {
        organization_id: orgId,
        status: DealStatus.won,
        actual_close: { gte: monthStart },
        ...(visibleIds && { assigned_to: { in: visibleIds } }),
      },
      _sum: { value: true },
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

  const orgSettings = (org.settings as Record<string, unknown> | null) ?? {};
  const monthly_revenue_target =
    typeof orgSettings.monthly_revenue_target === 'number' ? orgSettings.monthly_revenue_target : null;
  const monthly_revenue_actual = monthlyRevenueAgg._sum.value
    ? Math.round(parseFloat(monthlyRevenueAgg._sum.value.toString()) * 100) / 100
    : 0;

  return reply.send({
    data: {
      open_deals: {
        count: openAgg?._count._all ?? 0,
        total_value: Math.round(parseFloat(openTotalValue.toString()) * 100) / 100,
      },
      tasks_due_today: tasksDueCount,
      overdue_tasks_count: overdueTasksCount,
      deals_without_tasks_count: dealsWithoutTasksCount,
      todays_events: todaysEvents,
      stale_contacts: staleContactsList,
      stale_contacts_count: staleContactsCount,
      recent_activity: activity,
      pipeline_health_score,
      monthly_revenue_target,
      monthly_revenue_actual,
    },
    meta: {},
  });
}


export const AnalyticsController = {
  dashboard,
};
