/**
 * reminders.ts — repeating task reminders.
 *
 * A reminder is a RULE, not an instant. `Task.reminder_at` held one timestamp and could
 * therefore say exactly one thing: "buzz once, then never again". Everything an operator
 * actually wants — "every weekday at 09:00 until this deal closes" — had to be re-entered by
 * hand after every buzz, and nothing recorded that they had stopped bothering. TaskReminder
 * stores what the user said (a frequency, a wall-clock time, a zone, a horizon) and this file
 * turns that back into the next UTC instant each time one fires.
 *
 * THE WALL CLOCK IS THE SOURCE OF TRUTH, NOT THE INSTANT. `time_of_day` is text — "09:00" —
 * because the instant it maps to moves with the calendar. Persisting the instant and adding
 * 24 h to it is the bug this file exists to avoid: across a DST transition that arithmetic
 * silently slides the reminder to 08:00 or 10:00 and it never comes back. Every occurrence
 * below is therefore recomputed from the wall clock in `reminder.timezone`, so 09:00 stays
 * 09:00 and the UTC instant is what moves.
 *
 * Russia has not observed DST since 2014, so none of this can be observed in production
 * today. `timezone` is a free IANA field on User, and the first customer who sets it to
 * anything European or American gets the whole class of defect at once, twice a year, in the
 * one direction nobody tests. It is cheaper to be right now than to be paged later.
 *
 * WHICH DATE LIBRARY: none. `luxon` is the right tool and is NOT in package.json — see the
 * handover note. The zone maths below is `Intl.DateTimeFormat` with an explicit `timeZone`,
 * which is the same mechanism luxon's own system zone uses underneath, and
 * `zonedWallClockToUtc` deliberately mirrors luxon's `fixOffset` case for case (including its
 * answer for a wall-clock time that does not exist). Dropping luxon in later is a
 * body-swap of two functions, not a rewrite, and the tests pin the behaviour either way.
 */

import { RRule } from 'rrule';
import { ReminderFrequency } from '@prisma/client';
import { db } from './db';
import { DEFAULT_TIME_ZONE } from '../config/market';
import { userBelongsToOrg } from './db-guards';
import { getAccessibleUserIds, type Requester } from './visibility';

// ─── Shape of a rule ──────────────────────────────────────────────────────────

/**
 * The subset of TaskReminder the occurrence maths reads.
 *
 * Structural rather than the Prisma row type so the scheduler can hand it a narrow `select`
 * and the tests can hand it an object literal — neither has to carry ids, counters or
 * timestamps that say nothing about WHEN this thing fires.
 */
export interface ReminderRule {
  frequency: ReminderFrequency;
  /** Wall-clock "HH:MM" in `timezone`. */
  time_of_day: string;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. Only consulted for `weekly`. */
  days_of_week: number[];
  /** RRULE string. Only consulted for `custom`. */
  recurrence_rule: string | null;
  timezone: string;
  starts_at: Date;
  expires_at: Date | null;
}

export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_REMINDERS_PER_TASK = 5;

/**
 * How late a reminder may be delivered before it is dropped rather than caught up.
 *
 * See the comment on fireDueReminders in services/scheduler.ts for why catch-up exists at
 * all. This is the cap on it: a 09:00 "call the client" that surfaces at 08:55 the next
 * morning is not a reminder, it is noise, and a server that was down overnight would
 * otherwise dump every missed occurrence onto the phone at once.
 */
export const REMINDER_CATCHUP_MAX_AGE_MS = (() => {
  const raw = Number(process.env.REMINDER_CATCHUP_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4 * 60 * 60 * 1000;
})();

/** Ceiling on the day-by-day search. A year of probes answers every rule this file supports. */
const MAX_DAY_PROBES = 400;
/** Ceiling on the RRULE walk — a user-supplied rule must not be able to spin this loop. */
const MAX_RRULE_PROBES = 500;

// ─── Zone maths ───────────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // hourCycle, not `hour12: false` — the latter renders midnight as "24" on some ICU
      // builds, which turns 00:00 into a day-boundary bug that only shows up at night.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What a clock on the wall in `timeZone` reads at `instant`. */
export function wallClockIn(timeZone: string, instant: Date): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's offset from UTC, in milliseconds, at one instant. East of Greenwich is positive. */
function offsetMsAt(timeZone: string, instant: Date): number {
  const wall = wallClockIn(timeZone, instant);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // formatToParts has no millisecond field, so compare against the whole second.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which a clock in `timeZone` reads the given wall-clock time.
 *
 * This is the inverse of `wallClockIn`, and it is not a subtraction: the offset you need is
 * the offset AT THE ANSWER, which you do not have until you have the answer. The loop below
 * is the standard two-probe fixpoint — guess with the offset near the naive instant, re-read
 * the offset at that guess, and if it moved, try again with the new one.
 *
 * Two cases have no clean answer and both are decided here on purpose:
 *
 *   AMBIGUOUS (fall-back). 01:30 happens twice on the day the clocks go back. The first
 *   probe settles on the FIRST of the two, i.e. the reminder fires before the repeat rather
 *   than after it. Earlier is the right default for a reminder — a late one has already
 *   failed at its job.
 *
 *   NONEXISTENT (spring-forward). 02:30 never happens on the day the clocks go forward:
 *   neither offset reproduces it, so both probes disagree and the fixpoint has no solution.
 *   Rather than skip the day — which would silently drop one occurrence of a daily reminder
 *   once a year — the request is shifted forward by the size of the gap, so 02:30 fires at
 *   03:30. That is exactly what luxon does with the same input, which matters: the choice is
 *   pinned by tests, and swapping this function for luxon later must not change an answer.
 */
export function zonedWallClockToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const localTs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const firstOffset = offsetMsAt(timeZone, new Date(localTs));
  const firstGuess = localTs - firstOffset;
  const secondOffset = offsetMsAt(timeZone, new Date(firstGuess));
  if (firstOffset === secondOffset) return new Date(firstGuess);

  const secondGuess = localTs - secondOffset;
  const thirdOffset = offsetMsAt(timeZone, new Date(secondGuess));
  if (secondOffset === thirdOffset) return new Date(secondGuess);

  // In the gap. The smaller offset yields the later instant, which is the forward shift.
  return new Date(localTs - Math.min(secondOffset, thirdOffset));
}

/** Whether `Intl` will accept this as a zone. Anything it rejects would throw at fire time. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// ─── Occurrence engine ────────────────────────────────────────────────────────

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  // Validate with the shared pattern, then split — the pattern captures only the hour
  // alternation, and reading minutes out of match[2] silently yields NaN.
  if (!TIME_OF_DAY_PATTERN.test(value)) return null;
  const [hour, minute] = value.split(':');
  return { hour: Number(hour), minute: Number(minute) };
}

/** ISO weekday (1 = Monday .. 7 = Sunday) of a calendar date, read off a UTC-anchored probe. */
function isoWeekday(probe: Date): number {
  const sundayFirst = probe.getUTCDay();
  return sundayFirst === 0 ? 7 : sundayFirst;
}

function dayMatches(reminder: ReminderRule, weekday: number): boolean {
  switch (reminder.frequency) {
    case ReminderFrequency.daily:
      return true;
    case ReminderFrequency.weekdays:
      return weekday >= 1 && weekday <= 5;
    case ReminderFrequency.weekly:
      return reminder.days_of_week.includes(weekday);
    default:
      return false;
  }
}

/**
 * Build the RRULE for a `custom` reminder.
 *
 * DTSTART is always overwritten. rrule defaults it to `new Date()` when the string omits it,
 * which would make every call to this function answer a slightly different question and make
 * the tests time-dependent. It is anchored instead to the reminder's own start DATE, in the
 * reminder's zone — the rule chooses WHICH DAYS, `time_of_day` and the zone choose when on
 * those days, and mixing a real instant into DTSTART would let the rule's own time-of-day
 * fight with the stored one.
 *
 * The `count` / `interval` bounds mirror isSafeRRule in api/routes/tasks.ts. They are
 * repeated rather than imported because this path is also reachable from the scheduler, long
 * after the route that validated the string has returned.
 */
function buildRRule(rule: string, timeZone: string, startsAt: Date): RRule | null {
  try {
    const text = rule.startsWith('RRULE:') ? rule.slice('RRULE:'.length) : rule;
    const options = RRule.parseString(text);
    if (options.count !== null && options.count !== undefined && options.count > 1000) return null;
    if (options.interval !== undefined && options.interval < 1) return null;

    const start = wallClockIn(timeZone, startsAt);
    options.dtstart = new Date(Date.UTC(start.year, start.month - 1, start.day));
    return new RRule(options);
  } catch {
    return null;
  }
}

/**
 * The next UTC instant strictly after `after` at which this rule fires, or null if it never
 * fires again.
 *
 * "Strictly after" is what makes this safe to call with the instant that just fired: the
 * scheduler advances a reminder by asking for the next occurrence after the one it delivered,
 * so an off-by-one here is a reminder that fires twice or not at all.
 *
 * `expires_at` is INCLUSIVE. A reminder whose horizon lands exactly on one of its own fire
 * instants fires at that instant and is exhausted afterwards — "valuable until 18:00" reads
 * as covering 18:00, and the alternative silently drops the last and most urgent buzz.
 */
export function computeNextFire(reminder: ReminderRule, after: Date): Date | null {
  const time = parseTimeOfDay(reminder.time_of_day);
  if (!time) return null;

  // A zone that Intl rejects would throw inside the formatter on every future tick. Falling
  // back keeps the reminder firing at the market default rather than wedging the whole job.
  const zone = isValidTimeZone(reminder.timezone) ? reminder.timezone : DEFAULT_TIME_ZONE;

  if (reminder.expires_at && after.getTime() >= reminder.expires_at.getTime()) return null;

  const admissible = (candidate: Date): 'yes' | 'too-early' | 'expired' => {
    if (candidate.getTime() <= after.getTime()) return 'too-early';
    if (candidate.getTime() < reminder.starts_at.getTime()) return 'too-early';
    if (reminder.expires_at && candidate.getTime() > reminder.expires_at.getTime()) return 'expired';
    return 'yes';
  };

  // `once` is the shape Task.reminder_at always had, and the shape the migration backfilled
  // every existing reminder_at into: one instant, taken verbatim. time_of_day is not applied
  // — the user picked a moment, not a time of day.
  if (reminder.frequency === ReminderFrequency.once) {
    return admissible(reminder.starts_at) === 'yes' ? reminder.starts_at : null;
  }

  // Search forward from whichever of `after` and `starts_at` is later: a rule that has not
  // begun yet must not be probed from today, and a rule that began years ago must not be
  // probed from its start date.
  const anchor = reminder.starts_at.getTime() > after.getTime() ? reminder.starts_at : after;
  const anchorWall = wallClockIn(zone, anchor);

  if (reminder.frequency === ReminderFrequency.custom) {
    if (!reminder.recurrence_rule) return null;
    const rule = buildRRule(reminder.recurrence_rule, zone, reminder.starts_at);
    if (!rule) return null;

    // The RRULE is walked in its own floating-date space (rrule treats its dates as UTC
    // calendar days), and only the DATE it yields is used; the instant is rebuilt from
    // time_of_day in the reminder's zone. Starting one millisecond before the anchor's local
    // midnight keeps the anchor's own day in play.
    let cursor = new Date(Date.UTC(anchorWall.year, anchorWall.month - 1, anchorWall.day) - 1);

    for (let probe = 0; probe < MAX_RRULE_PROBES; probe += 1) {
      const occurrence = rule.after(cursor, false);
      if (!occurrence) return null;
      cursor = occurrence;

      const candidate = zonedWallClockToUtc(
        zone,
        occurrence.getUTCFullYear(),
        occurrence.getUTCMonth() + 1,
        occurrence.getUTCDate(),
        time.hour,
        time.minute,
      );
      const verdict = admissible(candidate);
      if (verdict === 'yes') return candidate;
      if (verdict === 'expired') return null;
    }
    return null;
  }

  for (let offset = 0; offset < MAX_DAY_PROBES; offset += 1) {
    // Date.UTC normalises an overflowing day-of-month, so this walks the calendar correctly
    // across month and year ends without any month-length table.
    const probe = new Date(Date.UTC(anchorWall.year, anchorWall.month - 1, anchorWall.day + offset));
    if (!dayMatches(reminder, isoWeekday(probe))) continue;

    const candidate = zonedWallClockToUtc(
      zone,
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      time.hour,
      time.minute,
    );
    const verdict = admissible(candidate);
    if (verdict === 'yes') return candidate;
    // Candidates only move forward, so the first one past the horizon ends the search.
    if (verdict === 'expired') return null;
  }

  return null;
}

/**
 * The next occurrence to schedule, with the catch-up cap applied.
 *
 * Advancing from the instant that just fired is what keeps a schedule aligned — a daily 09:00
 * reminder delivered at 09:00:04 must next fire at 09:00 tomorrow, not at 09:00:04. But a
 * server that was off for a week would otherwise walk one occurrence per tick to catch up,
 * delivering nothing (each is past the horizon) yet writing a row every minute for hours.
 * When the answer is already stale beyond the horizon, the search restarts from the horizon
 * and lands on something recent enough to be worth delivering.
 */
/**
 * Whether a reminder should still be scanned, given what it has left to fire.
 *
 * `next_fire_at !== null` is the obvious half. The other half is the reason this is a function
 * rather than an expression at three call sites: a reminder with a horizon stays ACTIVE after
 * it runs out of occurrences, carrying next_fire_at NULL, so that the scheduler's expiry sweep
 * can still see it and tell the task's creator that the window has closed. "Every Monday until
 * the 14th" runs out of Mondays on the 10th, and retiring it there loses the one notification
 * the operator actually needed. It costs nothing to leave it: every seek on this table is a
 * comparison against next_fire_at, and NULL matches no comparison.
 */
export function shouldStayActive(nextFireAt: Date | null, expiresAt: Date | null): boolean {
  return nextFireAt !== null || expiresAt !== null;
}

export function nextFireAfterCatchup(reminder: ReminderRule, after: Date, now: Date): Date | null {
  const horizon = new Date(now.getTime() - REMINDER_CATCHUP_MAX_AGE_MS);
  const next = computeNextFire(reminder, after);
  if (next && next.getTime() < horizon.getTime()) {
    return computeNextFire(reminder, horizon);
  }
  return next;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Same discriminated shape task-domain.ts uses, so the controller maps both the same way. */
export type ReminderError =
  | { kind: 'not_found'; code: string; message: string }
  | { kind: 'forbidden'; code: string; message: string }
  | { kind: 'unprocessable'; code: string; message: string };

export type ReminderInput = {
  frequency: ReminderFrequency;
  time_of_day: string;
  days_of_week?: number[];
  recurrence_rule?: string | null;
  timezone?: string;
  recipient_id?: string;
  starts_at?: string;
  expires_at?: string | null;
  is_active?: boolean;
};

export type ReminderPatch = Partial<ReminderInput>;

type ReminderRow = Awaited<ReturnType<typeof db.taskReminder.findFirst>>;

function invalid(code: string, message: string): { ok: false; error: ReminderError } {
  return { ok: false, error: { kind: 'unprocessable', code, message } };
}

/**
 * Everything that has to hold before a rule is worth storing.
 *
 * Run against the MERGED rule on update, not against the patch: `frequency: 'weekly'` with no
 * `days_of_week` in the same request is only valid if the row already had days, and a patch
 * that only moves `expires_at` still has to be checked against the stored `starts_at`.
 */
export function validateRule(rule: ReminderRule): ReminderError | null {
  if (!TIME_OF_DAY_PATTERN.test(rule.time_of_day)) {
    return { kind: 'unprocessable', code: 'INVALID_TIME_OF_DAY', message: 'time_of_day must be HH:MM in 24-hour form' };
  }

  if (!isValidTimeZone(rule.timezone)) {
    return { kind: 'unprocessable', code: 'INVALID_TIMEZONE', message: 'timezone must be a valid IANA zone name' };
  }

  if (rule.frequency === ReminderFrequency.weekly) {
    if (rule.days_of_week.length === 0) {
      return { kind: 'unprocessable', code: 'DAYS_OF_WEEK_REQUIRED', message: 'weekly reminders need at least one weekday' };
    }
    if (rule.days_of_week.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { kind: 'unprocessable', code: 'INVALID_DAYS_OF_WEEK', message: 'days_of_week must be ISO weekdays 1..7' };
    }
  }

  if (rule.frequency === ReminderFrequency.custom) {
    if (!rule.recurrence_rule) {
      return { kind: 'unprocessable', code: 'RECURRENCE_RULE_REQUIRED', message: 'custom reminders need a recurrence_rule' };
    }
    if (!buildRRule(rule.recurrence_rule, rule.timezone, rule.starts_at)) {
      return { kind: 'unprocessable', code: 'INVALID_RECURRENCE_RULE', message: 'recurrence_rule is not a valid or safe RRULE' };
    }
  }

  if (rule.expires_at && rule.expires_at.getTime() <= rule.starts_at.getTime()) {
    return { kind: 'unprocessable', code: 'INVALID_EXPIRY', message: 'expires_at must be after starts_at' };
  }

  return null;
}

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function recipientIsInScope(recipientId: string, requester?: Requester): Promise<boolean> {
  if (!requester || recipientId === requester.sub) return true;
  const accessible = await getAccessibleUserIds(requester);
  return accessible === null || accessible.includes(recipientId);
}

export async function listTaskReminders(taskId: string, orgId: string): Promise<NonNullable<ReminderRow>[]> {
  return db.taskReminder.findMany({
    where: { task_id: taskId, organization_id: orgId },
    orderBy: { created_at: 'asc' },
  });
}

export async function createTaskReminder(
  taskId: string,
  orgId: string,
  input: ReminderInput,
  requester?: Requester,
): Promise<{ ok: true; reminder: NonNullable<ReminderRow> } | { ok: false; error: ReminderError }> {
  const task = await db.task.findFirst({
    where: { id: taskId, organization_id: orgId },
    select: { id: true, assigned_to: true, status: true },
  });
  if (!task) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  if (task.status === 'done' || task.status === 'cancelled') {
    return invalid('TASK_CLOSED', 'Cannot add a reminder to a completed or cancelled task');
  }

  const reminderCount = await db.taskReminder.count({
    where: { task_id: taskId, organization_id: orgId },
  });
  if (reminderCount >= MAX_REMINDERS_PER_TASK) {
    return invalid('REMINDER_LIMIT_REACHED', `A task can have at most ${MAX_REMINDERS_PER_TASK} reminders`);
  }

  const recipientId = input.recipient_id ?? task.assigned_to;
  if (
    !(await userBelongsToOrg(recipientId, orgId)) ||
    !(await recipientIsInScope(recipientId, requester))
  ) {
    return { ok: false, error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Recipient is outside your organization' } };
  }

  // The zone is SNAPSHOT here, not read live at fire time — see the schema comment on
  // TaskReminder.timezone. Moving an employee between zones must not silently reschedule
  // every reminder they already agreed to.
  const recipient = await db.user.findUnique({ where: { id: recipientId }, select: { timezone: true } });

  const parsedStartsAt = parseDate(input.starts_at);
  const parsedExpiresAt = parseDate(input.expires_at);
  if (input.starts_at !== undefined && parsedStartsAt === undefined) {
    return invalid('INVALID_START', 'starts_at must be a valid ISO timestamp');
  }
  if (input.expires_at !== undefined && input.expires_at !== null && parsedExpiresAt === undefined) {
    return invalid('INVALID_EXPIRY', 'expires_at must be a valid ISO timestamp');
  }
  if (input.frequency === ReminderFrequency.once && parsedStartsAt === undefined) {
    return invalid('START_REQUIRED', 'once reminders need starts_at');
  }

  const startsAt = parsedStartsAt ?? new Date();
  const expiresAt = parsedExpiresAt ?? null;

  const rule: ReminderRule = {
    frequency: input.frequency,
    time_of_day: input.time_of_day,
    days_of_week: input.days_of_week ?? [],
    recurrence_rule: input.recurrence_rule ?? null,
    timezone: input.timezone ?? recipient?.timezone ?? DEFAULT_TIME_ZONE,
    starts_at: startsAt,
    expires_at: expiresAt,
  };

  const error = validateRule(rule);
  if (error) return { ok: false, error };

  const nextFireAt = computeNextFire(rule, new Date());
  const wantsActive = input.is_active ?? true;
  if (wantsActive && !nextFireAt) {
    return invalid('NO_FUTURE_OCCURRENCE', 'The reminder has no occurrence in the future');
  }

  const reminder = await db.taskReminder.create({
    data: {
      task_id: taskId,
      organization_id: orgId,
      recipient_id: recipientId,
      frequency: rule.frequency,
      time_of_day: rule.time_of_day,
      days_of_week: rule.days_of_week,
      recurrence_rule: rule.recurrence_rule,
      timezone: rule.timezone,
      starts_at: rule.starts_at,
      expires_at: rule.expires_at,
      next_fire_at: wantsActive ? nextFireAt : null,
      is_active: wantsActive && shouldStayActive(nextFireAt, rule.expires_at),
    },
  });

  return { ok: true, reminder };
}

export async function updateTaskReminder(
  reminderId: string,
  taskId: string,
  orgId: string,
  patch: ReminderPatch,
  requester?: Requester,
): Promise<{ ok: true; reminder: NonNullable<ReminderRow> } | { ok: false; error: ReminderError }> {
  const existing = await db.taskReminder.findFirst({
    where: { id: reminderId, task_id: taskId, organization_id: orgId },
  });
  if (!existing) {
    return { ok: false, error: { kind: 'not_found', code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } };
  }

  if (patch.recipient_id && patch.recipient_id !== existing.recipient_id) {
    if (
      !(await userBelongsToOrg(patch.recipient_id, orgId)) ||
      !(await recipientIsInScope(patch.recipient_id, requester))
    ) {
      return { ok: false, error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Recipient is outside your organization' } };
    }
  }

  const parsedStartsAt = parseDate(patch.starts_at);
  const parsedExpiresAt = parseDate(patch.expires_at);
  if (patch.starts_at !== undefined && parsedStartsAt === undefined) {
    return invalid('INVALID_START', 'starts_at must be a valid ISO timestamp');
  }
  if (patch.expires_at !== undefined && patch.expires_at !== null && parsedExpiresAt === undefined) {
    return invalid('INVALID_EXPIRY', 'expires_at must be a valid ISO timestamp');
  }

  const startsAt = parsedStartsAt ?? existing.starts_at;
  const expiresAt = patch.expires_at === undefined ? existing.expires_at : parsedExpiresAt ?? null;

  const rule: ReminderRule = {
    frequency: patch.frequency ?? existing.frequency,
    time_of_day: patch.time_of_day ?? existing.time_of_day,
    days_of_week: patch.days_of_week ?? existing.days_of_week,
    recurrence_rule: patch.recurrence_rule === undefined ? existing.recurrence_rule : patch.recurrence_rule,
    timezone: patch.timezone ?? existing.timezone,
    starts_at: startsAt,
    expires_at: expiresAt,
  };

  const error = validateRule(rule);
  if (error) return { ok: false, error };

  // Recomputed on EVERY update, not only when the schedule fields moved. next_fire_at is a
  // cache of the rule, and a stale one is a reminder that fires at the old time — the exact
  // complaint that started this work.
  const nextFireAt = computeNextFire(rule, new Date());
  const wantsActive = patch.is_active ?? true;
  if (wantsActive && !nextFireAt) {
    return invalid('NO_FUTURE_OCCURRENCE', 'The reminder has no occurrence in the future');
  }

  const reminder = await db.taskReminder.update({
    where: { id: existing.id },
    data: {
      recipient_id: patch.recipient_id ?? existing.recipient_id,
      frequency: rule.frequency,
      time_of_day: rule.time_of_day,
      days_of_week: rule.days_of_week,
      recurrence_rule: rule.recurrence_rule,
      timezone: rule.timezone,
      starts_at: rule.starts_at,
      expires_at: rule.expires_at,
      next_fire_at: wantsActive ? nextFireAt : null,
      is_active: wantsActive && shouldStayActive(nextFireAt, rule.expires_at),
    },
  });

  return { ok: true, reminder };
}

export async function deleteTaskReminder(
  reminderId: string,
  taskId: string,
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: ReminderError }> {
  const deleted = await db.taskReminder.deleteMany({
    where: { id: reminderId, task_id: taskId, organization_id: orgId },
  });

  if (deleted.count !== 1) {
    return { ok: false, error: { kind: 'not_found', code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } };
  }

  return { ok: true };
}
