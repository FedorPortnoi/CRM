import crypto from 'node:crypto';
import { RRule } from 'rrule';
import { DealStatus, TaskStatus } from '@prisma/client';
import { db } from './db';
import { sendPush } from './push';
import { dispatchNotification, taskCtx, dealCtx } from './notificationEngine';
import { runWebhookDeliveryTick } from './webhooks';
import { reapIdempotencyKeys } from './idempotency';
import { runSequenceTick } from './sequences';

const JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildJoinCode(orgName: string): string {
  const prefix = orgName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 16) || 'TEAM';
  return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function nextOccurrence(rule: string, after: Date): Date | null {
  try {
    const rrule = RRule.fromString(rule);
    return rrule.after(after, false);
  } catch {
    return null;
  }
}

// ─── Overlap guard ────────────────────────────────────────────────────────────

/**
 * Which jobs are running right now, by name.
 *
 * The 60 s interval below fires its jobs with `void` and does not await them, which is the
 * only thing it can do — a setInterval callback cannot hold the timer back. So a job that
 * outruns its own period used to run ALONGSIDE ITS OWN SUCCESSOR, on one instance, with no
 * second process involved: two passes reading the same due rows and both acting on them.
 * runDeadlineNotifications is the loudest example — it fetches a context per task and awaits
 * a database round trip for each — but runRecurrence and the webhook tick have the same
 * shape, and the webhook tick can legitimately run for minutes against slow endpoints.
 *
 * services/sequences.ts already owns this guard for the mailer, inside the service, so every
 * caller of runSequenceTick gets it. The jobs here have no such internal guard, so the
 * scheduler holds it for them.
 *
 * WHAT THIS IS NOT: it is a lock in ONE process. Production runs a single pm2 fork, so it is
 * a complete answer there — but nothing in the repo pins the instance count, and a
 * `pm2 scale` would put a second copy of every job in a second process where this Set is
 * empty. Where a cheap per-row claim exists, the jobs below take one as well, and those are
 * marked; where one does not (runRecurrence), it is called out at the site.
 */
const jobsInFlight = new Set<string>();

/**
 * Run `job` unless it is already running, and never let it reject into the timer.
 *
 * A skip is warned about rather than passed over in silence, for the reason tickSequences
 * gives: a job that keeps being skipped means it no longer fits in its interval, and that is
 * only visible if it is said out loud.
 */
export async function runExclusively(name: string, job: () => Promise<void>): Promise<void> {
  if (jobsInFlight.has(name)) {
    console.warn(`[scheduler] ${name} skipped — the previous run is still in flight`);
    return;
  }

  jobsInFlight.add(name);
  try {
    await job();
  } catch (error) {
    console.error(`[scheduler] ${name} failed`, error);
  } finally {
    // Released in a finally: a job that throws must not wedge itself off forever.
    jobsInFlight.delete(name);
  }
}

/**
 * Claim the right to fire one scheduled push about one entity, to one user, exactly once.
 *
 * The unique index on NotificationSent (event_type, entity_id, recipient_id) is the claim,
 * and `skipDuplicates` makes taking it a single INSERT ... ON CONFLICT DO NOTHING: `count`
 * of 1 means this run won and owes the push, 0 means it was already sent. Unlike the in-
 * process guard above this holds across processes, which is why the reminder job uses it.
 *
 * It is also the fix for a duplicate that needed no concurrency at all: the reminder window
 * below is 60 s wide (±30 s) and the interval is 60 s, so a reminder sitting near a window
 * edge is picked up by two consecutive ticks and the phone buzzed twice for one task.
 */
async function claimScheduledPush(
  eventType: string,
  entityId: string,
  recipientId: string,
): Promise<boolean> {
  const claimed = await db.notificationSent.createMany({
    data: [{ event_type: eventType, entity_id: entityId, recipient_id: recipientId }],
    skipDuplicates: true,
  });

  return claimed.count === 1;
}

/**
 * The claim is per REMINDER INSTANT, not per task.
 *
 * Keying it on the task alone would mean one reminder per task per user for the lifetime of
 * the row: an employee who pushes a reminder back an hour would get nothing at the new time,
 * because the old claim still stands and NotificationSent has no reaper. Folding reminder_at
 * into the event type makes "the same reminder" mean the same task at the same moment, which
 * is what the deduplication is actually for — a rescheduled reminder is a different reminder
 * and fires, while the same one seen by two overlapping windows does not.
 */
function reminderEventType(reminderAt: Date): string {
  return `task.reminder:${reminderAt.getTime()}`;
}

/** Exported for the tests only — startScheduler is the sole caller in the running server. */
export async function runReminders(): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 30_000);
  const windowEnd = new Date(now.getTime() + 30_000);

  const tasks = await db.task.findMany({
    where: {
      reminder_at: { gte: windowStart, lte: windowEnd },
      status: { not: TaskStatus.done },
    },
    select: { id: true, title: true, assigned_to: true, reminder_at: true },
  });

  const assigneeIds = [...new Set(tasks.map(t => t.assigned_to).filter((id): id is string => Boolean(id)))];
  const users = await db.user.findMany({
    where: { id: { in: assigneeIds } },
    select: { id: true, push_token: true },
  });
  const userMap = new Map(users.map(u => [u.id, u]));

  for (const task of tasks) {
    if (!task.assigned_to || !task.reminder_at) continue;
    const user = userMap.get(task.assigned_to);
    if (!user?.push_token) continue;

    const eventType = reminderEventType(task.reminder_at);
    if (!(await claimScheduledPush(eventType, task.id, task.assigned_to))) {
      continue;
    }

    const result = await sendPush(user.push_token, 'Напоминание', task.title, { taskId: task.id });

    if (!result.ok && result.code === 'DEVICE_NOT_REGISTERED') {
      await db.user.update({ where: { id: task.assigned_to }, data: { push_token: null } });
      continue;
    }

    if (!result.ok) {
      // A provider-side failure is transient and the task is probably still inside its
      // window on the next tick, so give the claim back rather than silently dropping the
      // only reminder this task gets. A device that is simply gone (above) is not retried:
      // there is nothing left to deliver to.
      await db.notificationSent
        .deleteMany({
          where: { event_type: eventType, entity_id: task.id, recipient_id: task.assigned_to },
        })
        .catch(() => undefined);
    }
  }
}

/**
 * Spawn the next occurrence of every completed recurring task.
 *
 * THE CLAIM THIS JOB DOES NOT HAVE. "Look for a sibling, and create one if there isn't"
 * is a check-then-act, and there is no unique constraint on Task that could turn the create
 * into the decision — nothing like (organization_id, title, assigned_to, due_date) exists.
 * At one instance the overlap guard in startScheduler is a complete answer: the read and the
 * write are in the same sequential pass and no second pass can interleave with it. At two
 * instances both would read "no sibling" and both would create one, and the only real fix is
 * that missing unique index — a schema change, not something this function can arrange.
 *
 * The sibling test itself was also its own duplicate source, with no concurrency involved.
 * It asked for a sibling due in the FUTURE, but the occurrence it creates can land in the
 * past: a weekly task completed months after its due date gets `rrule.after(due_date)`, a
 * date still in the past, and the sibling it just wrote therefore does not answer the next
 * tick's question either. That produced one new task every 60 s, forever — 1440 a day off a
 * single stale recurring task. The test now also accepts an OPEN sibling regardless of when
 * it is due, which is the honest reading of "this chain has already advanced": the next
 * occurrence is created when that sibling is completed, not before.
 *
 * Exported for the tests only — startScheduler is the sole caller in the running server.
 */
export async function runRecurrence(): Promise<void> {
  const now = new Date();

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

    // Skip if this chain has already advanced: a sibling due in the future, or one that is
    // still open whatever its due date (see the note above — an occurrence computed from a
    // long-past due_date is itself in the past, and only the second clause catches it).
    const existing = await db.task.findFirst({
      where: {
        title: task.title,
        assigned_to: task.assigned_to,
        organization_id: task.organization_id,
        is_recurring: true,
        OR: [
          { due_date: { gt: now } },
          { status: { notIn: [TaskStatus.done, TaskStatus.cancelled] } },
        ],
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

async function runDeadlineNotifications(): Promise<void> {
  const now = new Date();

  // Task: deadline in 24h window (23h to 25h from now)
  const tasks24h = await db.task.findMany({
    where: {
      due_date: { gte: new Date(now.getTime() + 23 * 3600_000), lte: new Date(now.getTime() + 25 * 3600_000) },
      status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
    },
    select: { id: true, organization_id: true },
  });
  for (const t of tasks24h) {
    const ctx = await taskCtx(t.id);
    if (ctx) {
      await dispatchNotification({ eventType: 'task.deadline_24h', orgId: t.organization_id, task: ctx });
    }
  }

  // Task: deadline in 2h window (1h45m to 2h15m from now)
  const tasks2h = await db.task.findMany({
    where: {
      due_date: { gte: new Date(now.getTime() + 105 * 60_000), lte: new Date(now.getTime() + 135 * 60_000) },
      status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
    },
    select: { id: true, organization_id: true },
  });
  for (const t of tasks2h) {
    const ctx = await taskCtx(t.id);
    if (ctx) {
      await dispatchNotification({ eventType: 'task.deadline_2h', orgId: t.organization_id, task: ctx });
    }
  }

  // Task: overdue (due_date < now, not done, not cancelled, not already notified twice)
  const overdueTasks = await db.task.findMany({
    where: {
      due_date: { lt: now, gte: new Date(now.getTime() - 24 * 3600_000) },
      status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
    },
    select: { id: true, organization_id: true },
  });
  for (const t of overdueTasks) {
    const ctx = await taskCtx(t.id);
    if (ctx) {
      await dispatchNotification({ eventType: 'task.overdue', orgId: t.organization_id, task: ctx });
    }
  }

  // Deal: closing in 7 days (6.5d to 7.5d from now)
  const deals7d = await db.deal.findMany({
    where: {
      expected_close: { gte: new Date(now.getTime() + 6.5 * 86_400_000), lte: new Date(now.getTime() + 7.5 * 86_400_000) },
      status: DealStatus.open,
    },
    select: { id: true, organization_id: true },
  });
  for (const d of deals7d) {
    const ctx = await dealCtx(d.id);
    if (ctx) {
      await dispatchNotification({ eventType: 'deal.close_7d', orgId: d.organization_id, deal: ctx });
    }
  }

  // Deal: closing in 1 day (20h to 28h from now)
  const deals1d = await db.deal.findMany({
    where: {
      expected_close: { gte: new Date(now.getTime() + 20 * 3600_000), lte: new Date(now.getTime() + 28 * 3600_000) },
      status: DealStatus.open,
    },
    select: { id: true, organization_id: true },
  });
  for (const d of deals1d) {
    const ctx = await dealCtx(d.id);
    if (ctx) {
      await dispatchNotification({ eventType: 'deal.close_1d', orgId: d.organization_id, deal: ctx });
    }
  }
}

/**
 * Auto-rotate company join codes that have passed their 7-day TTL.
 *
 * The rotation is its own claim: the UPDATE repeats the "has expired" predicate, so whoever
 * writes first moves join_code_expires_at a week out and every other runner's WHERE stops
 * matching. Two runs can no longer rotate the same organization twice in a row and hand a
 * second new code to an owner who was reading the first. That holds across processes, not
 * just inside this one — it is decided by the row, not by a flag in memory.
 */
async function rotateExpiredJoinCodes(): Promise<void> {
  const now = new Date();

  const expired = await db.org.findMany({
    where: { join_code_expires_at: { lte: now } },
    select: { id: true, name: true },
  });

  for (const org of expired) {
    try {
      await db.org.updateMany({
        where: { id: org.id, join_code_expires_at: { lte: now } },
        data: { join_code: buildJoinCode(org.name), join_code_expires_at: new Date(Date.now() + JOIN_CODE_TTL_MS) },
      });
    } catch {
      // skip — unique-collision or transient error; will retry next run
    }
  }
}

/**
 * This interval does not await anything, so a tick that outruns the 60 s period would
 * otherwise be running alongside its own successor — and two sequence ticks reading the
 * same due enrollments is how a contact gets the same advertising message twice.
 * runSequenceTick refuses to start a second pass while one is in flight (services/
 * sequences.ts owns that guard, so every caller gets it, not just this loop). What is left
 * to do here is not swallow the refusal: a tick that keeps being skipped means the send
 * loop no longer fits in its interval, and that is only visible if it is said out loud.
 */
function tickSequences(): void {
  void runSequenceTick()
    .then((summary) => {
      if (summary.overlapped) {
        console.warn('[scheduler] sequence tick skipped — the previous tick is still running');
      }
    })
    .catch(console.error);
}

/**
 * Every job on both timers goes through runExclusively, so none of them can overlap itself.
 * They are still started concurrently with each other — the guard is per job name, and a slow
 * webhook tick has no reason to hold up reminders.
 *
 * The two `void`s that remain are deliberate: neither timer can await, and runExclusively
 * already converts a rejection into a logged line, so there is no unhandled rejection here.
 */
export function startScheduler(): void {
  const minuteJobs = (): void => {
    void runExclusively('reminders', runReminders);
    void runExclusively('recurrence', runRecurrence);
    // Deduplication for these lives one level down, in notificationEngine's per-recipient
    // claim on NotificationSent, which is atomic and holds across processes.
    void runExclusively('deadline-notifications', runDeadlineNotifications);
    // The webhook tick claims each delivery row before sending, so N>1 is safe there; this
    // guard is about the tick not being started again while it is still working through a
    // backlog it has already scanned.
    void runExclusively('webhook-delivery', runWebhookDeliveryTick);
    tickSequences();
  };

  const hourlyJobs = (): void => {
    void runExclusively('stale-account-cleanup', cleanupStaleUnverifiedAccounts);
    void runExclusively('join-code-rotation', rotateExpiredJoinCodes);
    void runExclusively('idempotency-reaper', async () => {
      await reapIdempotencyKeys();
    });
  };

  // Outbound webhook retries and email-sequence sends share this loop rather than adding
  // second and third timers.
  minuteJobs();
  setInterval(minuteJobs, 60_000);

  // Hourly cleanup of orgs whose owner never verified within 24 h, plus join-code rotation
  // and the public-API idempotency TTL sweep.
  hourlyJobs();
  setInterval(hourlyJobs, 60 * 60_000);
}
