import crypto from 'node:crypto';
import { RRule } from 'rrule';
import { DealStatus, ReminderFrequency, TaskStatus } from '@prisma/client';
import { db } from './db';
import { sendPushToUser } from './push';
import { dispatchNotification, taskCtx, dealCtx } from './notificationEngine';
import { runWebhookDeliveryTick } from './webhooks';
import { reapIdempotencyKeys } from './idempotency';
import { runSequenceTick } from './sequences';
import {
  computeNextFire,
  nextFireAfterCatchup,
  shouldStayActive,
  REMINDER_CATCHUP_MAX_AGE_MS,
} from './reminders';
import { runAmoSyncTick } from './amocrm/sync-worker';
import { runAmoReconciliationTick } from './amocrm/reconcile';

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
 * because the old claim still stands and NotificationSent has no reaper. Folding the instant
 * into the event type makes "the same reminder" mean the same schedule at the same moment,
 * which is what the deduplication is actually for — a rescheduled reminder is a different
 * reminder and fires, while the same one seen twice does not.
 *
 * The REMINDER ROW's id is now in the key as well as the instant. A task can carry several
 * schedules at once — "every weekday at 09:00" for the assignee and "Fridays at 17:00" for
 * their head — and two of them can legitimately land on the same minute. Keyed on the instant
 * alone they would collide on the (event_type, entity_id, recipient_id) index and one of the
 * two would be silently swallowed as a duplicate of the other.
 */
function reminderEventType(reminderId: string, firesAt: Date): string {
  return `task.reminder:${reminderId}:${firesAt.getTime()}`;
}

/**
 * Run `worker` over `items`, at most `limit` of them in flight.
 *
 * The reminder job's unit of work is one RECIPIENT, not one row: a daily 09:00 reminder
 * attached to an org-wide task is N pushes at the same instant, and awaiting them one after
 * another means the last employee on the list hears about their morning at 09:04. Sequential
 * within a recipient (one person, one device queue, in order), parallel across recipients.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** How many due reminders one tick will look at. A backlog drains over several ticks. */
const REMINDER_BATCH_LIMIT = 500;
/** How many recipients are pushed to at once. */
const REMINDER_RECIPIENT_CONCURRENCY = 8;

type DueReminder = {
  id: string;
  task_id: string;
  recipient_id: string;
  frequency: ReminderFrequency;
  time_of_day: string;
  days_of_week: number[];
  recurrence_rule: string | null;
  timezone: string;
  starts_at: Date;
  expires_at: Date | null;
  next_fire_at: Date | null;
  task: { title: string };
};

/**
 * Move a reminder on to its next occurrence.
 *
 * The `next_fire_at` in the WHERE is a compare-and-set, and it is what makes advancing safe
 * to call from more than one place in this file: whoever writes first moves the row, and any
 * second attempt to advance the same occurrence matches nothing and does nothing. Without it,
 * the "someone else already claimed this instant" path below could advance a schedule the
 * claim holder is about to advance too, and the reminder would skip a day.
 */
async function advanceReminder(
  reminder: DueReminder,
  after: Date,
  now: Date,
  delivered: boolean,
): Promise<void> {
  const next = nextFireAfterCatchup(reminder, after, now);

  await db.taskReminder.updateMany({
    where: { id: reminder.id, next_fire_at: reminder.next_fire_at },
    data: {
      next_fire_at: next,
      // A rule with no occurrences left stops being scanned — a `once` that has fired, an
      // RRULE whose COUNT ran out, a weekly whose next Monday is past the horizon.
      //
      // EXCEPT when it has an expires_at that has not arrived yet, and this is the whole
      // reason the flag is not simply `next !== null`. "Every Monday until the 14th" runs out
      // of Mondays on the 10th. Retiring it there would put it beyond the reach of
      // expireLapsedReminders, which only looks at active rows, and the task.expired
      // notification the operator is owed on the 14th would never be sent — the reminder
      // would have gone quiet four days early with nothing to show for it. Left active with
      // next_fire_at NULL it costs nothing: the delivery seek below is on `next_fire_at <=
      // now`, and NULL matches no comparison.
      is_active: shouldStayActive(next, reminder.expires_at),
      ...(delivered ? { last_fired_at: now, fire_count: { increment: 1 } } : {}),
    },
  });
}

/**
 * Reminders whose horizon has passed, while the task itself is still open.
 *
 * This is the "until the task stops being valuable" half of the feature. The reminder simply
 * stopping would be silent — nobody learns that the thing they wanted chasing is still not
 * done — so the person who asked for it (the task's creator) is told once, and only once.
 *
 * `next_fire_at: null` in the WHERE is what keeps this from stealing the last buzz. expires_at
 * is INCLUSIVE (see computeNextFire), so a reminder can legitimately have one occurrence left
 * that lands exactly on its horizon — and this sweep runs BEFORE the delivery pass, so
 * without that clause it would retire the row seconds after the final occurrence came due and
 * before anything sent it. Only a rule with nothing left to fire is retired here; the one with
 * a pending occurrence is retired by advanceReminder on the following tick, after it has been
 * delivered.
 *
 * The conditional `updateMany` is the claim, the same shape as rotateExpiredJoinCodes below:
 * whoever flips is_active owes the notification, and everyone else's WHERE stops matching.
 * dispatchNotification deduplicates on top of that, per recipient, which is what stops two
 * reminders on the same task expiring in the same minute from sending two of these.
 */
async function expireLapsedReminders(now: Date): Promise<void> {
  const lapsed = await db.taskReminder.findMany({
    where: { is_active: true, expires_at: { lte: now }, next_fire_at: null },
    select: {
      id: true,
      task_id: true,
      organization_id: true,
      task: { select: { status: true } },
    },
    take: REMINDER_BATCH_LIMIT,
  });

  for (const reminder of lapsed) {
    const claimed = await db.taskReminder.updateMany({
      where: { id: reminder.id, is_active: true },
      data: { is_active: false, next_fire_at: null },
    });
    if (claimed.count !== 1) continue;

    // A finished task's reminder expiring is not news. The notification is about work that
    // outlived the window somebody gave it.
    if (reminder.task.status === TaskStatus.done || reminder.task.status === TaskStatus.cancelled) {
      continue;
    }

    const ctx = await taskCtx(reminder.task_id);
    if (!ctx) continue;

    // `task.expired` is NOT yet a member of NotificationEventType. Adding it means editing
    // services/notificationEngine.ts, which another agent is inside, so the exact addition is
    // reported in the handover rather than made here. The cast keeps this compiling today and
    // becomes redundant the moment the union, the SCHEDULED_EVENTS set and the buildMessages
    // case exist. UNTIL THEY DO, THIS DISPATCH IS A NO-OP: the switch has no case, so no
    // message is built and nothing is sent.
    await dispatchNotification({
      eventType: 'task.expired',
      orgId: reminder.organization_id,
      task: ctx,
    } as unknown as Parameters<typeof dispatchNotification>[0]);
  }
}

/**
 * Deliver every reminder that is due, including ones this process was not running for.
 *
 * THIS DELIBERATELY CHANGES WHAT "DUE" MEANS, AND THE CHANGE IS THE FIX. The old job scanned
 * Task.reminder_at inside a ±30 s window around the current minute, which made delivery
 * conditional on the server being awake for one particular tick. A deploy, a restart, or the
 * overlap guard above skipping a slow tick did not DELAY that reminder — it destroyed it,
 * silently and permanently, because the window had moved on by the time anything looked
 * again. The scan is now an index seek on (is_active, next_fire_at) for everything already
 * past its time, so a missed tick is caught up on the next one.
 *
 * Catch-up is capped, because unbounded catch-up is its own defect. A reminder that surfaces
 * hours after the moment it was meant to change what someone did is not a reminder, and a
 * server that was down overnight would hand a phone every occurrence it slept through at
 * once. Anything older than REMINDER_CATCHUP_MAX_AGE (4 h) is not delivered: it is rolled
 * forward to its next occurrence, so the schedule survives even though that instance did not.
 *
 * Exported for the tests only — startScheduler is the sole caller in the running server.
 */
async function fireDueReminders(now: Date): Promise<void> {
  const horizon = new Date(now.getTime() - REMINDER_CATCHUP_MAX_AGE_MS);

  const due = await db.taskReminder.findMany({
    where: {
      is_active: true,
      next_fire_at: { lte: now },
      task: { status: { notIn: [TaskStatus.done, TaskStatus.cancelled] } },
    },
    orderBy: { next_fire_at: 'asc' },
    take: REMINDER_BATCH_LIMIT,
    select: {
      id: true,
      task_id: true,
      recipient_id: true,
      frequency: true,
      time_of_day: true,
      days_of_week: true,
      recurrence_rule: true,
      timezone: true,
      starts_at: true,
      expires_at: true,
      next_fire_at: true,
      task: { select: { title: true } },
    },
  });

  if (due.length === 0) return;

  const byRecipient = new Map<string, DueReminder[]>();
  for (const reminder of due) {
    const group = byRecipient.get(reminder.recipient_id);
    if (group) group.push(reminder);
    else byRecipient.set(reminder.recipient_id, [reminder]);
  }

  await mapWithConcurrency([...byRecipient.values()], REMINDER_RECIPIENT_CONCURRENCY, async (group) => {
    for (const reminder of group) {
      await fireOneReminder(reminder, now, horizon);
    }
  });
}

async function fireOneReminder(
  reminder: DueReminder,
  now: Date,
  horizon: Date,
): Promise<void> {
  const firesAt = reminder.next_fire_at;
  if (!firesAt) return;

  // Defensive: computeNextFire never schedules past the horizon, so this only fires if a row
  // was written by something that is not this file. Retire it rather than deliver it.
  if (reminder.expires_at && firesAt.getTime() > reminder.expires_at.getTime()) {
    await advanceReminder(reminder, firesAt, now, false);
    return;
  }

  // Too stale to be worth waking anyone for — roll the schedule forward instead. Advancing
  // from `horizon` rather than from the missed instant is what stops a week-long outage
  // becoming a week of ticks walking one occurrence at a time.
  if (firesAt.getTime() < horizon.getTime()) {
    await advanceReminder(reminder, horizon, now, false);
    return;
  }

  const eventType = reminderEventType(reminder.id, firesAt);

  if (!(await claimScheduledPush(eventType, reminder.task_id, reminder.recipient_id))) {
    // Someone already delivered this instant. Advance anyway rather than returning: the
    // compare-and-set inside advanceReminder makes it harmless if the claim holder advances
    // too, and NOT advancing leaves a row that is permanently due and permanently deduplicated
    // — a hot loop that pushes nothing. NotificationSent has no reaper, so an edit that lands
    // a reminder back on an instant it already fired reaches this branch with one process.
    await advanceReminder(reminder, firesAt, now, false);
    return;
  }

  const result = await sendPushToUser(reminder.recipient_id, 'Напоминание', reminder.task.title, {
    taskId: reminder.task_id,
    reminderId: reminder.id,
  });

  const hasTransientFailure = result.devices.some(
    (device) => !device.result.ok && device.result.code === 'SEND_FAILED',
  );

  if (result.sent === 0 && hasTransientFailure) {
    // A provider-side failure is transient. Give the claim back and leave next_fire_at where
    // it is, so the next tick retries the same instant — it is still inside the catch-up
    // window, which is precisely what that window is for.
    await db.notificationSent
      .deleteMany({
        where: { event_type: eventType, entity_id: reminder.task_id, recipient_id: reminder.recipient_id },
      })
      .catch(() => undefined);
    return;
  }

  // With no devices, or only permanently-dead devices, advancing avoids scanning the same
  // occurrence every minute forever. A partial success also advances: the person was reached
  // on at least one device, while dead rows were pruned independently by the push router.
  await advanceReminder(reminder, firesAt, now, result.sent > 0);
}

/** Exported for the tests only — startScheduler is the sole caller in the running server. */
export async function runReminders(): Promise<void> {
  const now = new Date();

  // Order matters: a reminder past its horizon must be retired before the delivery pass can
  // read it as due and buzz someone one last time.
  await expireLapsedReminders(now);

  // Reminders on tasks that have been finished or cancelled are retired lazily, at the moment
  // they would have fired, rather than swept eagerly every minute. The seek is the same index
  // the delivery pass uses, so this costs nothing extra; an eager sweep would scan every
  // active reminder in the database once a minute to find the handful that changed.
  await db.taskReminder.updateMany({
    where: {
      is_active: true,
      next_fire_at: { lte: now },
      // Recurrence owns retirement for a completed recurring task: it clones the schedules and
      // retires the parent in one transaction. Sweeping those rows here would race that clone
      // because both scheduler jobs run concurrently every minute.
      task: {
        OR: [
          { status: TaskStatus.cancelled },
          { status: TaskStatus.done, is_recurring: false },
        ],
      },
    },
    data: { is_active: false, next_fire_at: null },
  });

  await fireDueReminders(now);
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
    if (existing) {
      await db.taskReminder.updateMany({
        where: { task_id: task.id, is_active: true },
        data: { is_active: false, next_fire_at: null },
      });
      continue;
    }

    const nextDue = nextOccurrence(task.recurrence_rule, task.due_date);
    if (!nextDue) continue;

    const reminderRules = await db.taskReminder.findMany({
      where: { task_id: task.id, is_active: true },
      select: {
        recipient_id: true,
        frequency: true,
        time_of_day: true,
        days_of_week: true,
        recurrence_rule: true,
        timezone: true,
        starts_at: true,
        expires_at: true,
      },
    });

    // Compute reminder_at offset relative to due_date
    let nextReminder: Date | undefined;
    if (task.reminder_at && task.due_date) {
      const offsetMs = task.reminder_at.getTime() - task.due_date.getTime();
      nextReminder = new Date(nextDue.getTime() + offsetMs);
    }

    const shiftMs = nextDue.getTime() - task.due_date.getTime();
    const shiftedReminders = reminderRules.flatMap((reminder) => {
      const startsAt = new Date(reminder.starts_at.getTime() + shiftMs);
      const expiresAt = reminder.expires_at
        ? new Date(reminder.expires_at.getTime() + shiftMs)
        : null;
      const rule = {
        frequency: reminder.frequency,
        time_of_day: reminder.time_of_day,
        days_of_week: reminder.days_of_week,
        recurrence_rule: reminder.recurrence_rule,
        timezone: reminder.timezone,
        starts_at: startsAt,
        expires_at: expiresAt,
      };
      const nextFireAt = computeNextFire(rule, now);
      if (!nextFireAt) return [];
      return [{ ...reminder, starts_at: startsAt, expires_at: expiresAt, next_fire_at: nextFireAt }];
    });

    // The successor and its schedules are one write. A crash must not leave an open recurring
    // task with no reminders, nor orphan reminder rows without the task they describe.
    await db.$transaction(async (tx) => {
      await tx.task.create({
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
        ...(shiftedReminders.length > 0
          ? {
              reminders: {
                create: shiftedReminders.map((reminder) => ({
                  organization_id: task.organization_id,
                  recipient_id: reminder.recipient_id,
                  frequency: reminder.frequency,
                  time_of_day: reminder.time_of_day,
                  days_of_week: reminder.days_of_week,
                  recurrence_rule: reminder.recurrence_rule,
                  timezone: reminder.timezone,
                  starts_at: reminder.starts_at,
                  expires_at: reminder.expires_at,
                  next_fire_at: reminder.next_fire_at,
                  is_active: true,
                })),
              },
            }
          : {}),
        },
      });
      await tx.taskReminder.updateMany({
        where: { task_id: task.id, is_active: true },
        data: { is_active: false, next_fire_at: null },
      });
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
    void runExclusively('amocrm-sync', async () => {
      await runAmoSyncTick();
    });
    tickSequences();
  };

  const hourlyJobs = (): void => {
    void runExclusively('stale-account-cleanup', cleanupStaleUnverifiedAccounts);
    void runExclusively('join-code-rotation', rotateExpiredJoinCodes);
    void runExclusively('idempotency-reaper', async () => {
      await reapIdempotencyKeys();
    });
    // The reconciliation service gates itself to one configured UTC hour, so
    // sharing the hourly loop does not turn this into an hourly full import.
    void runExclusively('amocrm-reconcile', async () => {
      await runAmoReconciliationTick();
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
