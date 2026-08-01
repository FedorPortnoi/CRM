/**
 * The occurrence engine: what "09:00 every weekday" means as a UTC instant.
 *
 * Every assertion below states the answer twice — once as the UTC instant the scheduler will
 * store in next_fire_at, and once as the wall clock a person in that zone reads. Pinning only
 * the instant would let a fix that shifts everything by an hour pass; pinning only the wall
 * clock would let one that returns the wrong DAY pass. The pair is the property:
 *
 *     the wall clock is invariant, the UTC instant is what moves.
 *
 * The DST cases use America/New_York deliberately. Russia has not observed DST since 2014, so
 * Europe/Moscow can never exercise any of this — and TaskReminder.timezone is a free IANA
 * field copied from User.timezone, so the first customer outside Russia gets the whole class
 * at once, twice a year. A suite that only ever tested Moscow would be green throughout.
 *
 * 2026 transitions used here: forward 08 Mar (02:00 EST → 03:00 EDT), back 01 Nov (02:00 EDT
 * → 01:00 EST).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderFrequency } from '@prisma/client';

// The occurrence maths is pure, but reminders.ts also owns the CRUD that the controller
// calls. Only the last describe block reaches this double.
const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  task: { findFirst: vi.fn() },
  user: { findFirst: vi.fn(), findUnique: vi.fn() },
  taskReminder: {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const {
  computeNextFire,
  nextFireAfterCatchup,
  zonedWallClockToUtc,
  createTaskReminder,
  validateRule,
  isValidTimeZone,
  REMINDER_CATCHUP_MAX_AGE_MS,
} = await import('../../../backend/services/reminders');

type Rule = Parameters<typeof computeNextFire>[0];

const NEW_YORK = 'America/New_York';
const MOSCOW = 'Europe/Moscow';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    frequency: ReminderFrequency.daily,
    time_of_day: '09:00',
    days_of_week: [],
    recurrence_rule: null,
    timezone: MOSCOW,
    starts_at: new Date('2020-01-01T00:00:00Z'),
    expires_at: null,
    ...overrides,
  };
}

/** What a clock in `zone` reads at `instant`, as "YYYY-MM-DD HH:MM". */
function wallClock(zone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// ─── Frequencies ──────────────────────────────────────────────────────────────

describe('computeNextFire — frequencies', () => {
  it('once fires at starts_at and never again', () => {
    const once = rule({
      frequency: ReminderFrequency.once,
      starts_at: new Date('2026-08-04T06:00:00Z'),
    });

    expect(computeNextFire(once, new Date('2026-08-01T00:00:00Z'))).toEqual(new Date('2026-08-04T06:00:00Z'));
    // Strictly after: asking from the instant it fired must not hand back the same instant.
    expect(computeNextFire(once, new Date('2026-08-04T06:00:00Z'))).toBeNull();
    expect(computeNextFire(once, new Date('2026-08-05T00:00:00Z'))).toBeNull();
  });

  it('daily fires at the same wall clock every day', () => {
    const daily = rule({ timezone: MOSCOW, time_of_day: '09:00' });

    // Moscow is UTC+3 year round, so 09:00 local is 06:00Z.
    const first = computeNextFire(daily, new Date('2026-08-01T00:00:00Z'));
    expect(first).toEqual(new Date('2026-08-01T06:00:00Z'));
    expect(wallClock(MOSCOW, first!)).toBe('2026-08-01 09:00');

    const second = computeNextFire(daily, first!);
    expect(second).toEqual(new Date('2026-08-02T06:00:00Z'));
    expect(wallClock(MOSCOW, second!)).toBe('2026-08-02 09:00');
  });

  it('daily rolls to tomorrow when today has already passed', () => {
    const daily = rule({ time_of_day: '09:00' });
    // 2026-08-01 10:00 Moscow is past 09:00.
    const next = computeNextFire(daily, new Date('2026-08-01T07:00:00Z'));
    expect(wallClock(MOSCOW, next!)).toBe('2026-08-02 09:00');
  });

  it('weekdays skips Saturday and Sunday', () => {
    const weekdays = rule({ frequency: ReminderFrequency.weekdays });

    // 2026-08-01 is a Saturday; the next fire is Monday the 3rd.
    const afterSaturday = computeNextFire(weekdays, new Date('2026-08-01T00:00:00Z'));
    expect(wallClock(MOSCOW, afterSaturday!)).toBe('2026-08-03 09:00');

    // Friday the 7th at 09:00 → Monday the 10th.
    const friday = computeNextFire(weekdays, new Date('2026-08-07T06:00:00Z'));
    expect(wallClock(MOSCOW, friday!)).toBe('2026-08-10 09:00');
  });

  it('weekly crosses the week boundary to the next matching day', () => {
    // Mondays only. 2026-08-04 is a Tuesday, so the answer is six days out, in the next week.
    const weekly = rule({ frequency: ReminderFrequency.weekly, days_of_week: [1] });

    const next = computeNextFire(weekly, new Date('2026-08-04T12:00:00Z'));
    expect(wallClock(MOSCOW, next!)).toBe('2026-08-10 09:00');
    expect(next).toEqual(new Date('2026-08-10T06:00:00Z'));

    // And the one after that is a full week later, not the day after.
    expect(wallClock(MOSCOW, computeNextFire(weekly, next!)!)).toBe('2026-08-17 09:00');
  });

  it('weekly with several days walks them in calendar order, wrapping the week', () => {
    // Monday and Thursday.
    const weekly = rule({ frequency: ReminderFrequency.weekly, days_of_week: [1, 4] });

    const monday = computeNextFire(weekly, new Date('2026-08-09T00:00:00Z'))!; // Sunday
    expect(wallClock(MOSCOW, monday)).toBe('2026-08-10 09:00');

    const thursday = computeNextFire(weekly, monday)!;
    expect(wallClock(MOSCOW, thursday)).toBe('2026-08-13 09:00');

    // Thursday → the following Monday: the wrap, not another Thursday.
    expect(wallClock(MOSCOW, computeNextFire(weekly, thursday)!)).toBe('2026-08-17 09:00');
  });

  it('custom takes its days from the RRULE and its time from time_of_day', () => {
    const custom = rule({
      frequency: ReminderFrequency.custom,
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      time_of_day: '18:30',
      starts_at: new Date('2026-08-01T00:00:00Z'),
    });

    const first = computeNextFire(custom, new Date('2026-08-01T00:00:00Z'))!;
    expect(wallClock(MOSCOW, first)).toBe('2026-08-03 18:30');

    const second = computeNextFire(custom, first)!;
    expect(wallClock(MOSCOW, second)).toBe('2026-08-05 18:30');

    const third = computeNextFire(custom, second)!;
    expect(wallClock(MOSCOW, third)).toBe('2026-08-10 18:30');
  });

  it('custom exhausts when the RRULE runs out of occurrences', () => {
    const custom = rule({
      frequency: ReminderFrequency.custom,
      recurrence_rule: 'FREQ=DAILY;COUNT=2',
      starts_at: new Date('2026-08-01T00:00:00Z'),
    });

    const first = computeNextFire(custom, new Date('2026-08-01T00:00:00Z'))!;
    expect(wallClock(MOSCOW, first)).toBe('2026-08-01 09:00');
    const second = computeNextFire(custom, first)!;
    expect(wallClock(MOSCOW, second)).toBe('2026-08-02 09:00');
    expect(computeNextFire(custom, second)).toBeNull();
  });

  it('does not fire before starts_at', () => {
    const daily = rule({ starts_at: new Date('2026-08-10T00:00:00Z') });
    const next = computeNextFire(daily, new Date('2026-08-01T00:00:00Z'))!;
    expect(wallClock(MOSCOW, next)).toBe('2026-08-10 09:00');
  });

  it('never returns an instant at or before `after`', () => {
    const daily = rule();
    const exact = new Date('2026-08-01T06:00:00Z'); // 09:00 Moscow, exactly a fire instant
    expect(computeNextFire(daily, exact)).toEqual(new Date('2026-08-02T06:00:00Z'));
  });
});

// ─── DST ──────────────────────────────────────────────────────────────────────

describe('computeNextFire — daylight saving', () => {
  it('holds 09:00 across spring-forward, moving the UTC instant instead', () => {
    const daily = rule({ timezone: NEW_YORK, time_of_day: '09:00' });

    // Saturday 07 Mar 2026, still EST (UTC-5).
    const beforeTransition = computeNextFire(daily, new Date('2026-03-07T00:00:00Z'))!;
    expect(beforeTransition).toEqual(new Date('2026-03-07T14:00:00Z'));
    expect(wallClock(NEW_YORK, beforeTransition)).toBe('2026-03-07 09:00');

    // Sunday 08 Mar, the clocks went forward overnight: EDT (UTC-4).
    const afterTransition = computeNextFire(daily, beforeTransition)!;
    expect(wallClock(NEW_YORK, afterTransition)).toBe('2026-03-08 09:00');
    // Naive +24 h arithmetic would have produced 15:00Z, i.e. 10:00 local — an hour late,
    // for good, from that day on.
    expect(afterTransition).toEqual(new Date('2026-03-08T13:00:00Z'));
    expect(afterTransition.getTime() - beforeTransition.getTime()).toBe(23 * 3600_000);
  });

  it('holds 09:00 across fall-back, moving the UTC instant the other way', () => {
    const daily = rule({ timezone: NEW_YORK, time_of_day: '09:00' });

    // Saturday 31 Oct 2026, EDT (UTC-4).
    const beforeTransition = computeNextFire(daily, new Date('2026-10-31T00:00:00Z'))!;
    expect(beforeTransition).toEqual(new Date('2026-10-31T13:00:00Z'));
    expect(wallClock(NEW_YORK, beforeTransition)).toBe('2026-10-31 09:00');

    // Sunday 01 Nov, back on EST (UTC-5).
    const afterTransition = computeNextFire(daily, beforeTransition)!;
    expect(wallClock(NEW_YORK, afterTransition)).toBe('2026-11-01 09:00');
    expect(afterTransition).toEqual(new Date('2026-11-01T14:00:00Z'));
    expect(afterTransition.getTime() - beforeTransition.getTime()).toBe(25 * 3600_000);
  });

  it('fires once, not twice, on the repeated hour of fall-back', () => {
    // 01:30 happens twice on 01 Nov 2026: 05:30Z (EDT) and 06:30Z (EST). A reminder set for
    // 01:30 must pick one — the earlier — and must not be handed back a second time when the
    // engine is asked what comes after it.
    const daily = rule({ timezone: NEW_YORK, time_of_day: '01:30' });

    const ambiguous = computeNextFire(daily, new Date('2026-11-01T00:00:00Z'))!;
    expect(ambiguous).toEqual(new Date('2026-11-01T05:30:00Z'));
    expect(wallClock(NEW_YORK, ambiguous)).toBe('2026-11-01 01:30');

    const next = computeNextFire(daily, ambiguous)!;
    // The next answer is the NEXT DAY, not the second 01:30 an hour later.
    expect(wallClock(NEW_YORK, next)).toBe('2026-11-02 01:30');
    expect(next).toEqual(new Date('2026-11-02T06:30:00Z'));
  });

  it('still fires on a spring-forward day when the requested wall clock does not exist', () => {
    // 02:30 never happens on 08 Mar 2026 — the clock jumps 02:00 → 03:00. Skipping the day
    // would silently drop one occurrence of a daily reminder once a year, so the request is
    // shifted forward by the gap. 03:30 EDT is 07:30Z, and matches what luxon answers for
    // the same input.
    const daily = rule({ timezone: NEW_YORK, time_of_day: '02:30' });

    const gapDay = computeNextFire(daily, new Date('2026-03-08T00:00:00Z'))!;
    expect(gapDay).toEqual(new Date('2026-03-08T07:30:00Z'));
    expect(wallClock(NEW_YORK, gapDay)).toBe('2026-03-08 03:30');

    // The day before and the day after are ordinary 02:30s, so the sequence is monotonic and
    // the gap day is neither doubled nor lost.
    const dayBefore = computeNextFire(daily, new Date('2026-03-07T00:00:00Z'))!;
    expect(wallClock(NEW_YORK, dayBefore)).toBe('2026-03-07 02:30');
    expect(computeNextFire(daily, dayBefore)).toEqual(gapDay);

    const dayAfter = computeNextFire(daily, gapDay)!;
    expect(wallClock(NEW_YORK, dayAfter)).toBe('2026-03-09 02:30');
    expect(dayAfter.getTime()).toBeGreaterThan(gapDay.getTime());
  });

  it('a weekly rule keeps its weekday across a transition', () => {
    // Sundays at 09:00, spanning the 08 Mar transition.
    const weekly = rule({ frequency: ReminderFrequency.weekly, days_of_week: [7], timezone: NEW_YORK });

    const firstSunday = computeNextFire(weekly, new Date('2026-03-01T00:00:00Z'))!;
    expect(wallClock(NEW_YORK, firstSunday)).toBe('2026-03-01 09:00');

    const transitionSunday = computeNextFire(weekly, firstSunday)!;
    expect(wallClock(NEW_YORK, transitionSunday)).toBe('2026-03-08 09:00');
    expect(transitionSunday).toEqual(new Date('2026-03-08T13:00:00Z'));
  });

  it('zonedWallClockToUtc round-trips every hour of a transition day', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const instant = zonedWallClockToUtc(NEW_YORK, 2026, 3, 8, hour, 0);
      const local = wallClock(NEW_YORK, instant);
      // 02:00 is the one hour that does not exist; everything else must survive the round trip.
      if (hour === 2) {
        expect(local).toBe('2026-03-08 03:00');
      } else {
        expect(local).toBe(`2026-03-08 ${String(hour).padStart(2, '0')}:00`);
      }
    }
  });
});

// ─── Expiry ───────────────────────────────────────────────────────────────────

describe('computeNextFire — expiry', () => {
  it('fires at an expires_at that lands exactly on a fire instant, then stops', () => {
    // "Valuable until 09:00 on the 3rd" has to include that 09:00 — it is the last and most
    // urgent buzz, and dropping it is the difference between a horizon and an off-by-one.
    const lastFire = new Date('2026-08-03T06:00:00Z'); // 09:00 Moscow
    const daily = rule({ expires_at: lastFire });

    const secondLast = computeNextFire(daily, new Date('2026-08-02T00:00:00Z'))!;
    expect(wallClock(MOSCOW, secondLast)).toBe('2026-08-02 09:00');

    expect(computeNextFire(daily, secondLast)).toEqual(lastFire);
    // Having fired at exactly the horizon, it is done.
    expect(computeNextFire(daily, lastFire)).toBeNull();
  });

  it('returns null once expires_at is behind us', () => {
    const daily = rule({ expires_at: new Date('2026-08-03T06:00:00Z') });
    expect(computeNextFire(daily, new Date('2026-08-04T00:00:00Z'))).toBeNull();
  });

  it('returns null when the next occurrence would land past expires_at', () => {
    // Expires at 09:00 Moscow on the 3rd minus a second — the 3rd's fire is outside.
    const daily = rule({ expires_at: new Date('2026-08-03T05:59:59Z') });
    const secondLast = computeNextFire(daily, new Date('2026-08-02T00:00:00Z'))!;
    expect(wallClock(MOSCOW, secondLast)).toBe('2026-08-02 09:00');
    expect(computeNextFire(daily, secondLast)).toBeNull();
  });

  it('expires a weekly rule whose next matching day is past the horizon', () => {
    const weekly = rule({
      frequency: ReminderFrequency.weekly,
      days_of_week: [1],
      expires_at: new Date('2026-08-14T00:00:00Z'),
    });

    const monday = computeNextFire(weekly, new Date('2026-08-04T00:00:00Z'))!;
    expect(wallClock(MOSCOW, monday)).toBe('2026-08-10 09:00');
    // The following Monday is the 17th, past the horizon.
    expect(computeNextFire(weekly, monday)).toBeNull();
  });
});

// ─── Catch-up ─────────────────────────────────────────────────────────────────

describe('nextFireAfterCatchup', () => {
  it('advances one step when the schedule is only slightly behind', () => {
    const daily = rule();
    const missed = new Date('2026-08-01T06:00:00Z'); // 09:00 Moscow
    const now = new Date('2026-08-01T07:00:00Z'); // an hour late

    expect(nextFireAfterCatchup(daily, missed, now)).toEqual(new Date('2026-08-02T06:00:00Z'));
  });

  it('skips a backlog rather than walking it one occurrence per tick', () => {
    const daily = rule();
    const missed = new Date('2026-08-01T06:00:00Z');
    // A week of downtime. Advancing from `missed` would answer 2 Aug, still ancient, and the
    // job would write a row a minute for hours getting back to the present.
    const now = new Date('2026-08-08T07:00:00Z');

    const next = nextFireAfterCatchup(daily, missed, now)!;
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime() - REMINDER_CATCHUP_MAX_AGE_MS);
    expect(wallClock(MOSCOW, next)).toBe('2026-08-08 09:00');
  });

  it('defaults the catch-up horizon to four hours', () => {
    expect(REMINDER_CATCHUP_MAX_AGE_MS).toBe(4 * 60 * 60 * 1000);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    expect(validateRule(rule())).toBeNull();
  });

  it('rejects a malformed time_of_day', () => {
    for (const bad of ['9:00', '24:00', '09:60', '0900', '', '09:0']) {
      expect(validateRule(rule({ time_of_day: bad }))?.code).toBe('INVALID_TIME_OF_DAY');
    }
  });

  it('rejects an unknown timezone', () => {
    expect(validateRule(rule({ timezone: 'Mars/Olympus_Mons' }))?.code).toBe('INVALID_TIMEZONE');
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone(MOSCOW)).toBe(true);
  });

  it('requires days_of_week for a weekly rule, in range', () => {
    expect(validateRule(rule({ frequency: ReminderFrequency.weekly, days_of_week: [] }))?.code)
      .toBe('DAYS_OF_WEEK_REQUIRED');
    expect(validateRule(rule({ frequency: ReminderFrequency.weekly, days_of_week: [0] }))?.code)
      .toBe('INVALID_DAYS_OF_WEEK');
    expect(validateRule(rule({ frequency: ReminderFrequency.weekly, days_of_week: [8] }))?.code)
      .toBe('INVALID_DAYS_OF_WEEK');
    expect(validateRule(rule({ frequency: ReminderFrequency.weekly, days_of_week: [1, 7] }))).toBeNull();
  });

  it('requires a parseable recurrence_rule for a custom rule', () => {
    expect(validateRule(rule({ frequency: ReminderFrequency.custom }))?.code)
      .toBe('RECURRENCE_RULE_REQUIRED');
    expect(validateRule(rule({ frequency: ReminderFrequency.custom, recurrence_rule: 'not an rrule' }))?.code)
      .toBe('INVALID_RECURRENCE_RULE');
    // A runaway COUNT is refused for the same reason api/routes/tasks.ts refuses it.
    expect(validateRule(rule({ frequency: ReminderFrequency.custom, recurrence_rule: 'FREQ=DAILY;COUNT=5000' }))?.code)
      .toBe('INVALID_RECURRENCE_RULE');
    expect(validateRule(rule({ frequency: ReminderFrequency.custom, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' })))
      .toBeNull();
  });

  it('requires expires_at to be after starts_at', () => {
    const starts = new Date('2026-08-01T00:00:00Z');
    expect(validateRule(rule({ starts_at: starts, expires_at: starts }))?.code).toBe('INVALID_EXPIRY');
    expect(validateRule(rule({ starts_at: starts, expires_at: new Date('2026-07-31T00:00:00Z') }))?.code)
      .toBe('INVALID_EXPIRY');
    expect(validateRule(rule({ starts_at: starts, expires_at: new Date('2026-08-02T00:00:00Z') }))).toBeNull();
  });
});

// ─── The client contract ──────────────────────────────────────────────────────

/**
 * What the mobile client sends, and what it must get back unchanged.
 *
 * src/hooks/useTaskReminders.ts resolves the chosen calendar date/time in the selected IANA
 * zone and sends the resulting UTC instant. The server stores that instant verbatim; the
 * client converts it back through the same zone when editing. Re-normalising here would move
 * the actual wall-clock occurrence and is exactly the kind of defect that survives a demo.
 *
 * These are pinned here rather than left to a code reading because nothing else in the
 * backend would notice if a future edit started rounding them.
 */
describe('the shape the client sends', () => {
  const ORG = '11111111-1111-1111-1111-111111111111';
  const TASK = '44444444-4444-4444-4444-444444444444';
  const ASSIGNEE = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.task.findFirst.mockResolvedValue({ id: TASK, assigned_to: ASSIGNEE, status: 'pending' });
    dbMock.taskReminder.count.mockResolvedValue(0);
    dbMock.$queryRaw.mockResolvedValue([{ id: ASSIGNEE }]);
    dbMock.user.findFirst.mockResolvedValue({ id: ASSIGNEE });
    dbMock.user.findUnique.mockResolvedValue({ timezone: MOSCOW });
    dbMock.taskReminder.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'reminder-1',
      ...data,
    }));
  });

  const created = (): Record<string, any> => dbMock.taskReminder.create.mock.calls[0][0].data;

  it('stores the client-resolved start and expiry instants verbatim', async () => {
    const result = await createTaskReminder(TASK, ORG, {
      frequency: ReminderFrequency.daily,
      time_of_day: '09:00',
      starts_at: '2026-08-30T00:00:00.000Z',
      expires_at: '2026-08-31T23:59:59.999Z',
    });

    expect(result.ok).toBe(true);
    expect(created().starts_at.toISOString()).toBe('2026-08-30T00:00:00.000Z');
    expect(created().expires_at.toISOString()).toBe('2026-08-31T23:59:59.999Z');
  });

  it('defaults the recipient to the task assignee when the client omits it', async () => {
    await createTaskReminder(TASK, ORG, { frequency: ReminderFrequency.daily, time_of_day: '09:00' });
    expect(created().recipient_id).toBe(ASSIGNEE);
  });

  it('honours an explicit recipient inside the org, and refuses one outside it', async () => {
    await createTaskReminder(TASK, ORG, {
      frequency: ReminderFrequency.daily,
      time_of_day: '09:00',
      recipient_id: OTHER,
    });
    expect(created().recipient_id).toBe(OTHER);

    dbMock.taskReminder.create.mockClear();
    dbMock.user.findFirst.mockResolvedValue(null);
    const refused = await createTaskReminder(TASK, ORG, {
      frequency: ReminderFrequency.daily,
      time_of_day: '09:00',
      recipient_id: OTHER,
    });
    expect(refused.ok).toBe(false);
    expect(dbMock.taskReminder.create).not.toHaveBeenCalled();
  });

  it('refuses an in-org recipient outside the requester hierarchy cone', async () => {
    dbMock.user.findFirst.mockResolvedValue({ id: OTHER });
    const refused = await createTaskReminder(
      TASK,
      ORG,
      {
        frequency: ReminderFrequency.daily,
        time_of_day: '09:00',
        recipient_id: OTHER,
      },
      { sub: ASSIGNEE, org_id: ORG, role: 'member' },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(dbMock.taskReminder.create).not.toHaveBeenCalled();
  });

  it('accepts days_of_week being absent for every frequency that is not weekly', async () => {
    for (const frequency of [ReminderFrequency.once, ReminderFrequency.daily, ReminderFrequency.weekdays]) {
      dbMock.taskReminder.create.mockClear();
      const result = await createTaskReminder(TASK, ORG, {
        frequency,
        time_of_day: '09:00',
        ...(frequency === ReminderFrequency.once
          ? { starts_at: '2026-08-30T06:00:00.000Z' }
          : {}),
      });
      expect(result.ok).toBe(true);
      expect(dbMock.taskReminder.create.mock.calls[0][0].data.days_of_week).toEqual([]);
    }
  });

  it('enforces the server-side per-task reminder cap', async () => {
    dbMock.taskReminder.count.mockResolvedValue(5);
    const result = await createTaskReminder(TASK, ORG, {
      frequency: ReminderFrequency.daily,
      time_of_day: '09:00',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'REMINDER_LIMIT_REACHED' },
    });
    expect(dbMock.taskReminder.create).not.toHaveBeenCalled();
  });

  it('falls back to the recipient\'s own zone when the client sends none', async () => {
    dbMock.user.findUnique.mockResolvedValue({ timezone: NEW_YORK });
    await createTaskReminder(TASK, ORG, { frequency: ReminderFrequency.daily, time_of_day: '09:00' });
    expect(created().timezone).toBe(NEW_YORK);
  });

  it('stores a custom rule under recurrence_rule, which is the field the client reads back', async () => {
    await createTaskReminder(TASK, ORG, {
      frequency: ReminderFrequency.custom,
      time_of_day: '09:00',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE',
    });
    expect(created().recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
  });
});
