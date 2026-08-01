/**
 * Background work: leases, claims and atomicity.
 *
 * Everything in this file was a live defect in the scheduler and the services it drives.
 * Production runs ONE pm2 fork, so most of these needed no second process to go wrong — a
 * job that outruns its own 60 s interval is already two passes over the same rows.
 *
 *   1. THE WEBHOOK LEASE WAS WRITTEN ALREADY-EXPIRED. The claim stamped next_attempt_at from
 *      the timestamp captured when the TICK started, not from the moment the row was claimed.
 *      A tick that scans 1000 rows and awaits a 10 s-deadline POST on each therefore wrote
 *      leases that had already lapsed: the row read as due again while it was still being
 *      delivered, so the customer's endpoint received the same event twice and `attempts` was
 *      incremented twice per attempt — which walks a healthy endpoint into the auto-pause.
 *      services/sequences.ts had this exact bug fixed for the mailer; this is the twin.
 *   2. NOTHING STOPPED A JOB OVERLAPPING ITSELF. The 60 s interval fired its jobs with `void`
 *      and never awaited them.
 *   3. NOTIFICATION DEDUP WAS CHECK-THEN-ACT. findUnique → `if (exists) continue` → create.
 *      The loser's P2002 escaped dispatchNotification and cut off every recipient after it,
 *      permanently: the dedup row now exists, so the retry skips the duplicate and never
 *      reaches the people who were dropped.
 *   4. EVERY DEADLINE WAS SHOWN IN THE WRONG ZONE. 'ru-RU' pins the language; without an
 *      explicit `timeZone` the formatter uses the host's. The box is Etc/UTC, so a task due
 *      at noon Moscow time was announced as "нужно сдать до 09:00" — and a developer's
 *      laptop, already on MSK, renders it correctly and shows nothing.
 *   5. IDEMPOTENCY DOUBLE-EXECUTED ANY OPERATION SLOWER THAN FIVE MINUTES. A reservation with
 *      no response stored was presumed crash-orphaned on AGE alone, deleted, and handed to
 *      the retry — while the first attempt was still running.
 *
 * The Prisma double below is small but it honours the things these fixes rest on: a
 * conditional `updateMany` only touches rows that still match its `where` (that is the
 * compare-and-set every claim is), and the unique key on NotificationSent / IdempotencyKey is
 * enforced at insert time. A mock that always answered `{ count: 1 }` could not tell a valid
 * claim from a stolen one.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// §4 is about the host's zone not deciding what a Russian user reads, so the host's zone is
// pinned here to the one production actually runs in. Node re-reads TZ on assignment, and
// vitest isolates each test file in its own process, so this cannot leak into another suite.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'UTC';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY ?? 're_test_key';
process.env.RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? 'CRM <crm@example.ru>';
process.env.PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? 'https://crm.example.ru';

// ─── The fake database ────────────────────────────────────────────────────────

type Row = Record<string, any>;

const harness = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {
    webhookDelivery: [],
    webhookEndpoint: [],
    task: [],
    taskReminder: [],
    user: [],
    notification: [],
    notificationSent: [],
    idempotencyKey: [],
  };

  /** Every webhook lease the tick wrote, with the wall-clock instant it was written at. */
  const claims: { writtenAt: number; leaseUntil: number }[] = [];

  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}-${(sequence += 1)}`;

  function compare(value: unknown, operand: unknown): number | null {
    if (value instanceof Date && operand instanceof Date) return value.getTime() - operand.getTime();
    if (typeof value === 'number' && typeof operand === 'number') return value - operand;
    return null;
  }

  function matches(row: Row, where: any): boolean {
    if (!where) return true;

    for (const [field, condition] of Object.entries(where)) {
      if (field === 'OR') {
        if (!(condition as any[]).some((clause) => matches(row, clause))) return false;
        continue;
      }
      if (field === 'AND') {
        if (!(condition as any[]).every((clause) => matches(row, clause))) return false;
        continue;
      }

      const value = row[field];

      if (
        condition !== null &&
        typeof condition === 'object' &&
        !Array.isArray(condition) &&
        !(condition instanceof Date)
      ) {
        const operators = condition as Record<string, unknown>;
        if ('not' in operators) {
          const target = operators.not;
          if (target === null ? value === null || value === undefined : value === target) return false;
        }
        if ('in' in operators && !(operators.in as unknown[]).includes(value)) return false;
        if ('notIn' in operators && (operators.notIn as unknown[]).includes(value)) return false;
        for (const [operator, bound] of Object.entries(operators)) {
          if (!['lte', 'lt', 'gte', 'gt'].includes(operator)) continue;
          const delta = compare(value, bound);
          if (delta === null) return false;
          if (operator === 'lte' && !(delta <= 0)) return false;
          if (operator === 'lt' && !(delta < 0)) return false;
          if (operator === 'gte' && !(delta >= 0)) return false;
          if (operator === 'gt' && !(delta > 0)) return false;
        }
        continue;
      }

      if (value instanceof Date && condition instanceof Date) {
        if (value.getTime() !== condition.getTime()) return false;
        continue;
      }

      if (value !== condition) return false;
    }

    return true;
  }

  function applyData(row: Row, data: Row): void {
    for (const [field, value] of Object.entries(data)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !(value instanceof Date) &&
        'increment' in (value as Row)
      ) {
        row[field] = (row[field] ?? 0) + (value as Row).increment;
        continue;
      }
      row[field] = value;
    }
  }

  function table(name: string, uniqueKey?: (row: Row) => string, defaults: Row = {}) {
    const rows = (): Row[] => tables[name];

    const collides = (candidate: Row): boolean =>
      uniqueKey !== undefined && rows().some((row) => uniqueKey(row) === uniqueKey(candidate));

    // `defaults` matters more than it looks: a nullable column that is absent instead of null
    // is not the same row to a `where` clause, and the liveness heartbeat is addressed by
    // `status_code: null`. A double that leaves the column undefined would silently make the
    // heartbeat a no-op and report a fix as broken.
    const insert = (data: Row): Row => {
      const row = { id: nextId(name), created_at: new Date(), ...defaults, ...data };
      rows().push(row);
      return row;
    };

    return {
      findMany: vi.fn(async ({ where, take }: any = {}) =>
        rows()
          .filter((row) => matches(row, where))
          .slice(0, take)
          .map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        const found = rows().find((row) => matches(row, where));
        return found ? { ...found } : null;
      }),
      // Indistinguishable from findFirst here — the double has no unique indexes to look up
      // by, only the collision test above. notificationSent deliberately replaces this with a
      // read that always loses; see the note where it is assembled.
      findUnique: vi.fn(async ({ where }: any = {}) => {
        const found = rows().find((row) => matches(row, where));
        return found ? { ...found } : null;
      }),
      count: vi.fn(async ({ where }: any = {}) => rows().filter((row) => matches(row, where)).length),
      create: vi.fn(async ({ data }: any) => {
        if (collides(data)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        return { ...insert(data) };
      }),
      // The real INSERT ... ON CONFLICT DO NOTHING: it reports what it actually inserted.
      createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
        const incoming: Row[] = Array.isArray(data) ? data : [data];
        let count = 0;
        for (const candidate of incoming) {
          if (collides(candidate)) {
            if (skipDuplicates) continue;
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          insert(candidate);
          count += 1;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const targets = rows().filter((row) => matches(row, where));
        for (const row of targets) applyData(row, data);
        return { count: targets.length };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const target = rows().find((row) => matches(row, where));
        if (!target) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        applyData(target, data);
        return { ...target };
      }),
      deleteMany: vi.fn(async ({ where }: any = {}) => {
        const doomed = rows().filter((row) => matches(row, where));
        for (const row of doomed) rows().splice(rows().indexOf(row), 1);
        return { count: doomed.length };
      }),
    };
  }

  const webhookDelivery = table('webhookDelivery');
  // A claim is the only delivery update that is conditional on the row still being due; the
  // final "delivered / retry / failed" write is addressed by id alone.
  const claimAware = webhookDelivery.updateMany;
  webhookDelivery.updateMany = vi.fn(async (args: any) => {
    const result = await claimAware(args);
    if (result.count > 0 && args?.where?.next_attempt_at !== undefined && args?.data?.next_attempt_at instanceof Date) {
      claims.push({ writtenAt: Date.now(), leaseUntil: args.data.next_attempt_at.getTime() });
    }
    return result;
  }) as typeof claimAware;

  const notificationSent = table(
    'notificationSent',
    (row) => `${row.event_type} ${row.entity_id} ${row.recipient_id}`,
  );

  /**
   * TaskReminder is the one table here the scheduler reaches THROUGH: it filters on the
   * parent task's status and reads the task's title off the joined row. A double that ignored
   * the relation would let a reminder on a cancelled task look deliverable, which is exactly
   * the thing the reminder job is now responsible for not doing.
   *
   * The relation filter is resolved the way the database resolves it — to the set of task ids
   * that satisfy it — so `matches` needs no new operator.
   */
  const taskReminderRows = table('taskReminder');
  const joinTask = (row: Row): Row => ({
    ...row,
    task: tables.task.find((candidate) => candidate.id === row.task_id) ?? null,
  });
  const resolveTaskRelation = (where: any): any => {
    if (!where || !where.task) return where;
    const { task: taskWhere, ...rest } = where;
    return {
      ...rest,
      task_id: { in: tables.task.filter((row) => matches(row, taskWhere)).map((row) => row.id) },
    };
  };
  const taskReminder = {
    ...taskReminderRows,
    findMany: vi.fn(async ({ where, take }: any = {}) =>
      (await taskReminderRows.findMany({ where: resolveTaskRelation(where), take })).map(joinTask),
    ),
    updateMany: vi.fn(async ({ where, data }: any) =>
      taskReminderRows.updateMany({ where: resolveTaskRelation(where), data }),
    ),
  };

  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    webhookDelivery,
    webhookEndpoint: table('webhookEndpoint'),
    task: table('task'),
    taskReminder,
    user: table('user'),
    notification: table('notification'),
    notificationSent: {
      ...notificationSent,
      /**
       * The read that loses the race, every time.
       *
       * The dedup check that used to guard notification delivery was findUnique → create, and
       * a read cannot see an insert that has not committed yet. Answering `null` unconditionally
       * is that losing read made deterministic: the row is really there (the unique key above
       * enforces it at insert time), and the check-then-act simply cannot know. The fixed code
       * never calls this, which is the point.
       */
      findUnique: vi.fn(async () => null),
    },
    idempotencyKey: table('idempotencyKey', (row) => `${row.organization_id} ${row.key}`, {
      status_code: null,
      response_body: null,
    }),
  };

  return {
    db,
    tables,
    claims,
    matches,
    reset(): void {
      for (const name of Object.keys(tables)) tables[name] = [];
      claims.length = 0;
      sequence = 0;
    },
  };
});

const push = vi.hoisted(() => ({
  sendPush: vi.fn(async () => ({ ok: true })),
  sendPushToUser: vi.fn(async () => ({
    user_id: 'user',
    attempted: 1,
    sent: 1,
    failed: 0,
    pruned: 0,
    skipped: 0,
    devices: [{
      device_id: 'device',
      token: 'token',
      provider: 'expo',
      platform: 'ios',
      result: { ok: true },
      pruned: false,
    }],
  })),
}));

/** Stands in for the network: it burns clock and then reports the endpoint unreachable. */
const mockResolveSafeWebhookUrl = vi.hoisted(() => vi.fn());

vi.mock('../../../backend/services/db', () => ({ db: harness.db }));
vi.mock('../../../backend/services/push', () => push);
vi.mock('../../../backend/services/encryption', () => ({
  encryptField: (value: string) => value,
  decryptField: (value: string) => value,
}));
vi.mock('../../../backend/services/webhook-ssrf', () => ({
  resolveSafeWebhookUrl: mockResolveSafeWebhookUrl,
  assertSafeWebhookUrl: vi.fn(async (url: string) => url),
  UnsafeWebhookUrlError: class extends Error {},
}));
// services/sequences.ts is pulled in by the scheduler's import graph and instantiates the
// mail client at module scope.
vi.mock('resend', () => ({
  Resend: class {
    readonly emails = { send: vi.fn(async () => ({ data: { id: 'msg-1' }, error: null })) };
  },
}));

import { WEBHOOK_LEASE_MS, runWebhookDeliveryTick } from '../../../backend/services/webhooks';
import { runExclusively, runRecurrence, runReminders } from '../../../backend/services/scheduler';
import { REMINDER_CATCHUP_MAX_AGE_MS } from '../../../backend/services/reminders';
import { DISPLAY_TIME_ZONE, dispatchNotification } from '../../../backend/services/notificationEngine';
import {
  IDEMPOTENCY_HEARTBEAT_INTERVAL_MS,
  IDEMPOTENCY_IN_PROGRESS_TTL_MS,
  IDEMPOTENCY_TTL_MS,
  reapIdempotencyKeys,
  runIdempotent,
} from '../../../backend/services/idempotency';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-1111-1111-111111111111';
const ASSIGNEE = '22222222-2222-2222-2222-222222222222';
const ASSIGNER = '33333333-3333-3333-3333-333333333333';
const TASK_ID = '44444444-4444-4444-4444-444444444444';
const T0 = new Date('2026-07-25T12:00:00Z');

// The jobs report skips and failures on the console by design; captured rather than restored
// wholesale, because vi.restoreAllMocks() would also strip the fake database's behaviour.
let warned: ReturnType<typeof vi.spyOn>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  harness.reset();
  push.sendPush.mockResolvedValue({ ok: true });
  push.sendPushToUser.mockResolvedValue({
    user_id: ASSIGNEE,
    attempted: 1,
    sent: 1,
    failed: 0,
    pruned: 0,
    skipped: 0,
    devices: [{
      device_id: 'device',
      token: 'token',
      provider: 'expo',
      platform: 'ios',
      result: { ok: true },
      pruned: false,
    }],
  });
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  warned.mockRestore();
  logged.mockRestore();
});

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

// ─── 1. The webhook lease is stamped when the row is claimed ──────────────────

/**
 * Twenty due deliveries, sent five at a time (WEBHOOK_SEND_CONCURRENCY), each round trip
 * burning SEND_DURATION_MS of clock: four waves, 600 s of tick, twice the 5-minute lease.
 * That is a conservative model of a real tick — the scan is 1000 rows wide, each POST has a
 * 10 s deadline, and dead endpoints hit it every time.
 */
const SEND_DURATION_MS = 30_000;
const DUE_DELIVERIES = 20;

function seedDeliveries(count: number): void {
  for (let i = 1; i <= count; i += 1) {
    harness.tables.webhookEndpoint.push({
      id: `ep-${i}`,
      organization_id: ORG,
      status: 'active',
      // One endpoint per delivery, so the resolver below can tell which row is on the wire.
      url: `https://hooks.example.com/${i}`,
      secret: 'whsec_test',
      failure_count: 0,
    });
    harness.tables.webhookDelivery.push({
      id: `del-${i}`,
      organization_id: ORG,
      endpoint_id: `ep-${i}`,
      event_type: 'deal.won',
      payload: { event: 'deal.won' },
      status: 'pending',
      attempts: 0,
      next_attempt_at: T0,
      delivered_at: null,
      response_status: null,
      error_message: null,
    });
  }
}

/** A second worker — another tick, or another instance — trying to claim a row right now. */
function rivalWorkerClaims(deliveryId: string): boolean {
  const now = new Date();
  const targets = harness.tables.webhookDelivery.filter((row) =>
    harness.matches(row, {
      id: deliveryId,
      organization_id: ORG,
      status: 'pending',
      next_attempt_at: { lte: now },
    }),
  );
  for (const row of targets) {
    row.attempts += 1;
    row.next_attempt_at = new Date(now.getTime() + WEBHOOK_LEASE_MS);
  }
  return targets.length > 0;
}

describe('the webhook delivery lease is measured from the claim, not from the tick', () => {
  beforeEach(() => {
    seedDeliveries(DUE_DELIVERIES);
    mockResolveSafeWebhookUrl.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + SEND_DURATION_MS));
      throw new Error('receiver unreachable');
    });
  });

  it('never writes a lease that has already expired', async () => {
    await runWebhookDeliveryTick(T0);

    // The tick outran the lease, which is the only interesting case.
    expect(Date.now() - T0.getTime()).toBeGreaterThan(WEBHOOK_LEASE_MS);
    expect(harness.claims).toHaveLength(DUE_DELIVERIES);

    for (const claim of harness.claims) {
      expect(claim.leaseUntil - claim.writtenAt).toBe(WEBHOOK_LEASE_MS);
      expect(claim.leaseUntil).toBeGreaterThan(claim.writtenAt);
    }
  });

  it('refuses a second worker that tries to claim a delivery this tick is still sending', async () => {
    const stolen: boolean[] = [];
    mockResolveSafeWebhookUrl.mockImplementation(async (url: string) => {
      vi.setSystemTime(new Date(Date.now() + SEND_DURATION_MS));
      // The POST is on the wire and this row is still ours.
      stolen.push(rivalWorkerClaims(`del-${url.slice(url.lastIndexOf('/') + 1)}`));
      throw new Error('receiver unreachable');
    });

    await runWebhookDeliveryTick(T0);

    expect(stolen).toHaveLength(DUE_DELIVERIES);
    expect(stolen.filter(Boolean)).toEqual([]);
  });

  it('counts one attempt per delivery, so a slow tick cannot walk an endpoint into auto-pause', async () => {
    mockResolveSafeWebhookUrl.mockImplementation(async (url: string) => {
      vi.setSystemTime(new Date(Date.now() + SEND_DURATION_MS));
      rivalWorkerClaims(`del-${url.slice(url.lastIndexOf('/') + 1)}`);
      throw new Error('receiver unreachable');
    });

    await runWebhookDeliveryTick(T0);

    const attempts = harness.tables.webhookDelivery.map((row) => row.attempts);
    expect(attempts).toEqual(Array.from({ length: DUE_DELIVERIES }, () => 1));
  });
});

// ─── 2. A scheduled job cannot overlap itself ─────────────────────────────────

describe('runExclusively', () => {
  it('refuses a second run while the first is in flight, and says so', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = vi.fn(async () => {
      await gate;
    });

    const first = runExclusively('slow-job', job);
    await runExclusively('slow-job', job);

    expect(job).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('slow-job skipped'));

    release?.();
    await first;

    // And once it has finished, the next run is allowed through.
    await runExclusively('slow-job', job);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the job throws, instead of wedging it forever', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connection reset');
    });

    await expect(runExclusively('flaky-job', failing)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('flaky-job failed'), expect.any(Error));

    await runExclusively('flaky-job', failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('guards each job separately — a slow one does not hold up the others', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await gate;
    });
    const quick = vi.fn(async () => undefined);

    const pending = runExclusively('slow-job', slow);
    await runExclusively('quick-job', quick);

    expect(quick).toHaveBeenCalledTimes(1);
    release?.();
    await pending;
  });
});

describe('recurring tasks spawn one successor, not one per tick', () => {
  // DTSTART is spelled out so the occurrence the rule yields is fixed rather than anchored to
  // whatever "now" happens to be when rrule parses a bare RRULE line.
  function seedCompletedRecurringTask(dueDate: Date): void {
    const stamp = dueDate.toISOString().replace(/[-:]|\.\d{3}/g, '');
    harness.tables.task.push({
      id: TASK_ID,
      organization_id: ORG,
      title: 'Еженедельный отчёт',
      description: null,
      contact_id: null,
      deal_id: null,
      assigned_to: ASSIGNEE,
      priority: 'medium',
      status: 'done',
      is_recurring: true,
      recurrence_rule: `DTSTART:${stamp}\nRRULE:FREQ=WEEKLY`,
      due_date: dueDate,
      reminder_at: null,
    });
  }

  it('does not re-spawn while the successor it already created is still open', async () => {
    // A task completed long after it was due: its next occurrence by the rule is ALSO in the
    // past, so the sibling test could never see it and the job re-created it every 60 s.
    seedCompletedRecurringTask(new Date('2026-01-05T09:00:00Z'));

    await runRecurrence();
    await runRecurrence();
    await runRecurrence();

    const created = harness.tables.task.filter((row) => row.id !== TASK_ID);
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe('pending');
    expect(created[0]?.organization_id).toBe(ORG);
  });

  it('still spawns the next occurrence when the chain has nothing open', async () => {
    seedCompletedRecurringTask(new Date('2026-07-24T09:00:00Z'));

    await runRecurrence();

    const created = harness.tables.task.filter((row) => row.id !== TASK_ID);
    expect(created).toHaveLength(1);
    expect(created[0]?.due_date?.getTime()).toBe(new Date('2026-07-31T09:00:00Z').getTime());
  });

  it('rebases active reminder rules onto the successor in the same task create', async () => {
    const dueDate = new Date('2026-07-24T09:00:00Z');
    seedCompletedRecurringTask(dueDate);
    harness.tables.taskReminder.push({
      id: 'reminder-parent',
      task_id: TASK_ID,
      organization_id: ORG,
      recipient_id: ASSIGNEE,
      frequency: 'daily',
      time_of_day: '12:00',
      days_of_week: [],
      recurrence_rule: null,
      timezone: 'Europe/Moscow',
      starts_at: new Date('2026-07-24T09:00:00Z'),
      expires_at: new Date('2026-08-24T09:00:00Z'),
      next_fire_at: new Date('2026-07-24T09:00:00Z'),
      is_active: true,
    });

    await runRecurrence();

    const createArg = harness.db.task.create.mock.calls[0]?.[0] as Row;
    const cloned = createArg.data.reminders.create[0];
    expect(cloned.starts_at).toEqual(new Date('2026-07-31T09:00:00Z'));
    expect(cloned.expires_at).toEqual(new Date('2026-08-31T09:00:00Z'));
    expect(cloned.next_fire_at).toEqual(new Date('2026-07-31T09:00:00Z'));
    expect(cloned.recipient_id).toBe(ASSIGNEE);
    expect(cloned.is_active).toBe(true);
  });
});

/**
 * §2b. A REMINDER THAT NOBODY WAS RUNNING FOR USED TO BE DESTROYED, NOT DELAYED.
 *
 * runReminders scanned Task.reminder_at inside a ±30 s window around the current minute, so
 * delivery was conditional on this process being awake for one particular tick. A deploy, a
 * restart, or the overlap guard above skipping a slow tick did not postpone that reminder —
 * the window moved past it and nothing ever looked at it again. The scan is now an index seek
 * on TaskReminder(is_active, next_fire_at) for everything already past its time, so a missed
 * tick is caught up on the next one.
 *
 * The claim survives the rewrite unchanged and is still keyed per INSTANT, now with the
 * reminder row's id alongside it: one task can carry several schedules, and two of them can
 * land on the same minute without being the same reminder.
 */
describe('a task reminder is pushed once per occurrence, and a missed tick is caught up', () => {
  const REMINDER_ID = '55555555-5555-5555-5555-555555555555';

  function seedReminder(overrides: Row = {}): Row {
    const reminder = {
      id: REMINDER_ID,
      task_id: TASK_ID,
      organization_id: ORG,
      recipient_id: ASSIGNEE,
      frequency: 'daily',
      time_of_day: '15:00', // 12:00Z — T0 — in Europe/Moscow
      days_of_week: [],
      recurrence_rule: null,
      timezone: 'Europe/Moscow',
      starts_at: new Date(T0.getTime() - 86_400_000),
      expires_at: null,
      next_fire_at: T0,
      last_fired_at: null,
      fire_count: 0,
      is_active: true,
      ...overrides,
    };
    harness.tables.taskReminder.push(reminder);
    return reminder;
  }

  beforeEach(() => {
    harness.tables.user.push({ id: ASSIGNEE, push_token: 'ExponentPushToken[abc]' });
    harness.tables.task.push({
      id: TASK_ID,
      organization_id: ORG,
      title: 'Позвонить клиенту',
      status: 'pending',
      is_recurring: false,
      assigned_to: ASSIGNEE,
      reminder_at: T0,
    });
  });

  it('claims the occurrence before sending, so consecutive ticks do not buzz twice', async () => {
    seedReminder();

    await runReminders();
    await runReminders();

    expect(push.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(harness.tables.notificationSent).toHaveLength(1);

    // Delivered, counted, and moved on to tomorrow rather than left sitting in the past.
    const stored = harness.tables.taskReminder[0];
    expect(stored.fire_count).toBe(1);
    expect(stored.last_fired_at).toEqual(T0);
    expect(stored.next_fire_at?.getTime()).toBe(T0.getTime() + 86_400_000);
  });

  it('fires again when the reminder is moved, because that is a different occurrence', async () => {
    const reminder = seedReminder();

    await runReminders();

    reminder.next_fire_at = new Date(T0.getTime() + 3_600_000);
    vi.setSystemTime(reminder.next_fire_at);

    await runReminders();

    expect(push.sendPushToUser).toHaveBeenCalledTimes(2);
    expect(harness.tables.notificationSent).toHaveLength(2);
  });

  it('gives the claim back when the provider fails, so the occurrence is not lost', async () => {
    const reminder = seedReminder();
    push.sendPushToUser.mockResolvedValueOnce({
      user_id: ASSIGNEE,
      attempted: 1,
      sent: 0,
      failed: 1,
      pruned: 0,
      skipped: 0,
      devices: [{
        device_id: 'device',
        token: 'token',
        provider: 'expo',
        platform: 'ios',
        result: { ok: false, code: 'SEND_FAILED', message: 'timeout' },
        pruned: false,
      }],
    } as never);

    await runReminders();
    expect(harness.tables.notificationSent).toHaveLength(0);
    // And the schedule did NOT advance, so the next tick has something to retry.
    expect(reminder.next_fire_at).toEqual(T0);

    await runReminders();
    expect(push.sendPushToUser).toHaveBeenCalledTimes(2);
    expect(harness.tables.notificationSent).toHaveLength(1);
  });

  it('delivers an occurrence the process was not running for', async () => {
    // Nothing ran at 12:00. Two hours later — inside the catch-up window — it still arrives.
    // Under the ±30 s window this reminder was gone for good.
    seedReminder();
    vi.setSystemTime(new Date(T0.getTime() + 2 * 3600_000));

    await runReminders();

    expect(push.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(harness.tables.taskReminder[0].fire_count).toBe(1);
  });

  it('skips an occurrence that is too stale to be worth delivering, and rolls it forward', async () => {
    // Catch-up is capped at REMINDER_CATCHUP_MAX_AGE. A 12:00 "call the client" surfacing the
    // next morning is not a reminder, it is noise — but the SCHEDULE has to survive the gap.
    seedReminder();
    const nextMorning = new Date(T0.getTime() + 20 * 3600_000);
    vi.setSystemTime(nextMorning);

    await runReminders();

    expect(push.sendPushToUser).not.toHaveBeenCalled();
    const stored = harness.tables.taskReminder[0];
    expect(stored.fire_count).toBe(0);
    expect(stored.is_active).toBe(true);
    expect(stored.next_fire_at?.getTime()).toBeGreaterThan(nextMorning.getTime() - REMINDER_CATCHUP_MAX_AGE_MS);
  });

  it('retires a reminder whose task has been completed', async () => {
    seedReminder();
    harness.tables.task[0].status = 'done';

    await runReminders();

    expect(push.sendPushToUser).not.toHaveBeenCalled();
    const stored = harness.tables.taskReminder[0];
    expect(stored.is_active).toBe(false);
    expect(stored.next_fire_at).toBeNull();
  });

  it('retires a reminder whose horizon has passed with nothing left to fire', async () => {
    // The shape a run-out rule leaves behind: still active, so the expiry sweep can see it,
    // but with no occurrence pending.
    seedReminder({ next_fire_at: null, expires_at: new Date(T0.getTime() - 1000) });

    await runReminders();

    expect(push.sendPushToUser).not.toHaveBeenCalled();
    const stored = harness.tables.taskReminder[0];
    expect(stored.is_active).toBe(false);
    expect(stored.next_fire_at).toBeNull();
  });

  it('still delivers a final occurrence that lands exactly on the horizon', async () => {
    // "Valuable until 15:00" includes that 15:00. The expiry sweep runs before the delivery
    // pass, so without its `next_fire_at: null` guard it would retire this row seconds after
    // the last occurrence came due and swallow the most urgent buzz of the lot.
    seedReminder({ expires_at: T0 });

    await runReminders();

    expect(push.sendPushToUser).toHaveBeenCalledTimes(1);
    const stored = harness.tables.taskReminder[0];
    expect(stored.fire_count).toBe(1);
    expect(stored.next_fire_at).toBeNull();
    // Retirement, and the task.expired notification with it, happens on the following tick.
    expect(stored.is_active).toBe(true);

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await runReminders();

    expect(push.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(stored.is_active).toBe(false);
  });

  it('keeps a run-out rule alive until its horizon, so the expiry is not silent', async () => {
    // T0 is Saturday 25 July 2026. Mondays only, expiring on the Sunday: this occurrence is
    // the last one the rule can ever produce, because the next Monday is past the horizon.
    // The window the operator asked for has NOT closed yet, though, and retiring the row here
    // would put it beyond the reach of the expiry sweep for good.
    seedReminder({
      frequency: 'weekly',
      days_of_week: [1],
      next_fire_at: T0,
      expires_at: new Date(T0.getTime() + 86_400_000),
    });

    await runReminders();

    const stored = harness.tables.taskReminder[0];
    expect(stored.next_fire_at).toBeNull();
    expect(stored.is_active).toBe(true);
  });
});

// ─── 3. Notification dedup is decided by the unique key, not by a read ────────

function deadlineContext(dueDate: Date) {
  return {
    eventType: 'task.deadline_2h' as const,
    orgId: ORG,
    task: {
      id: TASK_ID,
      title: 'Сдать отчёт',
      due_date: dueDate,
      assignee: { id: ASSIGNEE, name: 'Иван', push_token: 'ExponentPushToken[abc]' },
      assigner: { id: ASSIGNER, name: 'Пётр', push_token: null },
    },
  };
}

describe('a duplicate scheduled notification is skipped, not thrown', () => {
  it('still delivers to the other recipients when one is already claimed', async () => {
    // Another pass has already notified the assignee. The old check-then-act read (see the
    // findUnique above) cannot see it, so it tried to insert and took a P2002 — which escaped
    // dispatchNotification and cut the assigner off entirely.
    harness.tables.notificationSent.push({
      id: 'sent-1',
      event_type: 'task.deadline_2h',
      entity_id: TASK_ID,
      recipient_id: ASSIGNEE,
    });

    await expect(dispatchNotification(deadlineContext(T0))).resolves.toBeUndefined();

    const recipients = harness.tables.notification.map((row) => row.recipient_id);
    expect(recipients).toEqual([ASSIGNER]);
    expect(push.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('notifies each recipient exactly once across repeated dispatches', async () => {
    await dispatchNotification(deadlineContext(T0));
    await dispatchNotification(deadlineContext(T0));

    expect(harness.tables.notification.map((row) => row.recipient_id)).toEqual([ASSIGNEE, ASSIGNER]);
    expect(harness.tables.notificationSent).toHaveLength(2);
  });

  it('releases the claim when the notification write fails, so a later tick retries', async () => {
    harness.db.notification.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(dispatchNotification(deadlineContext(T0))).resolves.toBeUndefined();

    // The assignee's write failed, so nothing is left claiming to have notified them, and the
    // assigner — who comes after them in the loop — was still delivered to.
    expect(harness.tables.notification.map((row) => row.recipient_id)).toEqual([ASSIGNER]);
    expect(harness.tables.notificationSent.map((row) => row.recipient_id)).toEqual([ASSIGNER]);

    await dispatchNotification(deadlineContext(T0));
    expect(harness.tables.notification.map((row) => row.recipient_id)).toEqual([ASSIGNER, ASSIGNEE]);
  });

  it('does not deduplicate an event that is emitted by a domain write', async () => {
    // task.assigned fires once, from the request that assigned it. Claiming it would mean a
    // task reassigned back to the same person the next day is silently never announced.
    await dispatchNotification({
      ...deadlineContext(T0),
      eventType: 'task.assigned',
    });
    await dispatchNotification({
      ...deadlineContext(T0),
      eventType: 'task.assigned',
    });

    expect(harness.tables.notification).toHaveLength(4);
    expect(harness.tables.notificationSent).toHaveLength(0);
  });
});

// ─── 4. Deadlines are rendered in the market's zone, not the box's ────────────

describe('a deadline is shown in Moscow time whatever the server is set to', () => {
  it('renders the hour in MSK, not in the host zone', async () => {
    // 21:00 UTC is midnight in Moscow. On the production box, unpinned, this printed 21:00 —
    // three hours early, on the notification whose entire purpose is "you have two hours".
    await dispatchNotification(deadlineContext(new Date('2026-07-30T21:00:00Z')));

    const [first] = harness.tables.notification;
    expect(first?.body).toContain('до 00:00');
    expect(first?.body).not.toContain('21:00');
  });

  it('renders the date in MSK too, which can be the next day', async () => {
    await dispatchNotification({
      ...deadlineContext(new Date('2026-07-31T21:30:00Z')),
      eventType: 'task.deadline_24h',
    });

    const [first] = harness.tables.notification;
    expect(first?.body).toContain('1 августа');
    expect(first?.body).not.toContain('31 июля');
  });

  it('agrees with an explicitly Moscow-pinned formatter', () => {
    const due = new Date('2026-07-30T21:00:00Z');
    const expected = due.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Moscow',
    });

    expect(DISPLAY_TIME_ZONE).toBe('Europe/Moscow');
    expect(expected).toBe('00:00');
  });
});

// ─── 5. Idempotency: a slow operation keeps its key ───────────────────────────

describe('an in-flight idempotent operation holds its key for as long as it runs', () => {
  const input = (operation: () => Promise<unknown>) => ({
    rawKey: 'import-4711',
    organizationId: ORG,
    endpoint: 'POST /public/v1/contacts',
    requestBody: { first_name: 'Анна' },
    statusCode: 201,
    operation,
  });

  it('refuses the retry of an operation that has been running longer than the lease', async () => {
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Only the first execution is held open. A second one — which is precisely what must not
    // happen — returns straight away, so a regression reports itself as "the retry executed"
    // rather than as a test that hangs.
    const operation = async (): Promise<unknown> => {
      executions += 1;
      if (executions === 1) await gate;
      return { id: 'contact-1' };
    };

    const first = runIdempotent(input(operation));
    // A bulk import that legitimately runs well past the in-progress TTL. The heartbeat has
    // fired several times by now; the reservation is not orphaned, it is working.
    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_IN_PROGRESS_TTL_MS + IDEMPOTENCY_HEARTBEAT_INTERVAL_MS);

    await expect(runIdempotent(input(operation))).rejects.toMatchObject({
      httpStatus: 409,
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
    expect(executions).toBe(1);

    release?.();
    await expect(first).resolves.toMatchObject({ statusCode: 201, replayed: false });
  });

  it('pushes the lease forward while it works, and hands over the replay window when it finishes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runIdempotent(input(async () => {
      await gate;
      return { id: 'contact-1' };
    }));

    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_HEARTBEAT_INTERVAL_MS * 3);
    const inFlight = harness.tables.idempotencyKey[0];
    expect(inFlight?.status_code).toBeNull();
    expect(inFlight?.expires_at.getTime()).toBe(Date.now() + IDEMPOTENCY_IN_PROGRESS_TTL_MS);

    release?.();
    await first;

    const completed = harness.tables.idempotencyKey[0];
    expect(completed?.status_code).toBe(201);
    expect(completed?.expires_at.getTime()).toBe(Date.now() + IDEMPOTENCY_TTL_MS);
  });

  it('stops beating once the operation is done, so nothing renews a completed record', async () => {
    await runIdempotent(input(async () => ({ id: 'contact-1' })));

    const settled = harness.tables.idempotencyKey[0]?.expires_at.getTime();
    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_HEARTBEAT_INTERVAL_MS * 5);

    expect(harness.tables.idempotencyKey[0]?.expires_at.getTime()).toBe(settled);
  });

  it('still reclaims a reservation whose holder stopped beating', async () => {
    // What a crashed request leaves behind: a reservation with a lapsed lease and no response.
    harness.tables.idempotencyKey.push({
      id: 'idem-orphan',
      organization_id: ORG,
      key: 'import-4711',
      endpoint: 'POST /public/v1/contacts',
      request_hash: 'whatever',
      status_code: null,
      response_body: null,
      created_at: new Date(Date.now() - IDEMPOTENCY_IN_PROGRESS_TTL_MS * 2),
      expires_at: new Date(Date.now() - 1),
    });

    const result = await runIdempotent(input(async () => ({ id: 'contact-1' })));

    expect(result).toMatchObject({ statusCode: 201, replayed: false });
    expect(harness.tables.idempotencyKey).toHaveLength(1);
    expect(harness.tables.idempotencyKey[0]?.status_code).toBe(201);
  });

  it('replays the stored response for a retry that arrives after the operation finished', async () => {
    let executions = 0;
    const operation = async (): Promise<unknown> => {
      executions += 1;
      return { id: 'contact-1' };
    };

    const first = await runIdempotent(input(operation));
    const second = await runIdempotent(input(operation));

    expect(executions).toBe(1);
    expect(second).toEqual({ statusCode: 201, body: first.body, replayed: true });
  });

  it('sweeps lapsed reservations but leaves a live one alone', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = runIdempotent(input(async () => {
      await gate;
      return { id: 'contact-1' };
    }));

    harness.tables.idempotencyKey.push({
      id: 'idem-orphan',
      organization_id: ORG,
      key: 'other-key',
      endpoint: 'POST /public/v1/contacts',
      request_hash: 'whatever',
      status_code: null,
      response_body: null,
      created_at: new Date(Date.now() - IDEMPOTENCY_IN_PROGRESS_TTL_MS * 2),
      expires_at: new Date(Date.now() - 1),
    });

    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_HEARTBEAT_INTERVAL_MS * 8);

    const swept = await reapIdempotencyKeys();

    expect(swept.reclaimed).toBe(1);
    expect(harness.tables.idempotencyKey.map((row) => row.key)).toEqual(['import-4711']);

    release?.();
    await live;
  });
});
