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

export function startScheduler(): void {
  setInterval(() => {
    void runReminders().catch(console.error);
    void runRecurrence().catch(console.error);
  }, 60_000);
}
