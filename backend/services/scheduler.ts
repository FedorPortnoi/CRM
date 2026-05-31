import { RRule } from 'rrule';
import Expo from 'expo-server-sdk';
import { TaskStatus } from '@prisma/client';
import { db } from './db';

const expo = new Expo();

function nextOccurrence(rule: string, after: Date): Date | null {
  try {
    const rrule = RRule.fromString(rule);
    return rrule.after(after, false);
  } catch {
    return null;
  }
}

async function runReminders(): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 30_000);
  const windowEnd = new Date(now.getTime() + 30_000);

  const tasks = await db.task.findMany({
    where: {
      reminder_at: { gte: windowStart, lte: windowEnd },
      status: { not: TaskStatus.done },
    },
    select: { id: true, title: true, assigned_to: true },
  });

  for (const task of tasks) {
    if (!task.assigned_to) continue;
    const user = await db.user.findUnique({
      where: { id: task.assigned_to },
      select: { push_token: true },
    });
    if (!user?.push_token || !Expo.isExpoPushToken(user.push_token)) continue;
    try {
      await expo.sendPushNotificationsAsync([{
        to: user.push_token,
        title: 'Reminder',
        body: task.title,
        data: { taskId: task.id },
      }]);
    } catch {
      // best-effort
    }
  }
}

async function runRecurrence(): Promise<void> {
  const tasks = await db.task.findMany({
    where: {
      status: TaskStatus.done,
      is_recurring: true,
      recurrence_rule: { not: null },
    },
    select: {
      id: true,
      title: true,
      description: true,
      contact_id: true,
      deal_id: true,
      assigned_to: true,
      organization_id: true,
      priority: true,
      recurrence_rule: true,
      due_date: true,
      reminder_at: true,
    },
  });

  for (const task of tasks) {
    if (!task.due_date || !task.recurrence_rule) continue;

    // Skip if a future sibling already exists
    const existing = await db.task.findFirst({
      where: {
        title: task.title,
        assigned_to: task.assigned_to,
        organization_id: task.organization_id,
        due_date: { gt: new Date() },
        is_recurring: true,
      },
      select: { id: true },
    });
    if (existing) continue;

    const nextDue = nextOccurrence(task.recurrence_rule, task.due_date);
    if (!nextDue) continue;

    // Compute reminder_at offset relative to due_date
    let nextReminder: Date | undefined;
    if (task.reminder_at && task.due_date) {
      const offsetMs = task.reminder_at.getTime() - task.due_date.getTime();
      nextReminder = new Date(nextDue.getTime() + offsetMs);
    }

    await db.task.create({
      data: {
        title: task.title,
        description: task.description ?? undefined,
        contact_id: task.contact_id ?? undefined,
        deal_id: task.deal_id ?? undefined,
        assigned_to: task.assigned_to ?? undefined,
        organization_id: task.organization_id,
        priority: task.priority,
        recurrence_rule: task.recurrence_rule,
        is_recurring: true,
        due_date: nextDue,
        reminder_at: nextReminder,
        status: TaskStatus.pending,
      },
    });
  }
}

async function cleanupStaleUnverifiedAccounts(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Single-user orgs whose owner is still unverified after 24 h
  const stale = await db.$queryRaw<Array<{ org_id: string; user_id: string }>>`
    SELECT o.id AS org_id, u.id AS user_id
    FROM organizations o
    JOIN "User" u ON u.id = o.owner_id
    WHERE u.is_verified = false
      AND u.created_at < ${cutoff}
      AND (SELECT COUNT(*) FROM "User" WHERE organization_id = o.id) = 1
  `;

  for (const row of stale) {
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM "PipelineStage" ps USING "Pipeline" p WHERE ps.pipeline_id = p.id AND p.organization_id = ${row.org_id}::uuid`;
        await tx.$executeRaw`DELETE FROM "Pipeline" WHERE organization_id = ${row.org_id}::uuid`;
        await tx.$executeRaw`DELETE FROM "AuthSession" WHERE organization_id = ${row.org_id}::uuid`;
        await tx.$executeRaw`DELETE FROM "VerificationCode" WHERE user_id = ${row.user_id}::uuid`;
        await tx.$executeRaw`UPDATE organizations SET owner_id = NULL WHERE id = ${row.org_id}::uuid`;
        await tx.$executeRaw`DELETE FROM "User" WHERE id = ${row.user_id}::uuid`;
        await tx.$executeRaw`DELETE FROM organizations WHERE id = ${row.org_id}::uuid`;
      });
    } catch {
      // skip — will retry next run
    }
  }
}

export function startScheduler(): void {
  setInterval(() => {
    void runReminders().catch(console.error);
    void runRecurrence().catch(console.error);
  }, 60_000);

  // Hourly cleanup of orgs whose owner never verified within 24 h
  void cleanupStaleUnverifiedAccounts().catch(console.error);
  setInterval(() => {
    void cleanupStaleUnverifiedAccounts().catch(console.error);
  }, 60 * 60_000);
}
