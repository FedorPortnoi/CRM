import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PendingCaptureStatus, PendingCaptureType } from '@prisma/client';

// ---------------------------------------------------------------------------
// «ЗАВТРА В 9» IS A CLAIM ABOUT THE OPERATOR'S WALL CLOCK, NOT THE SERVER'S.
//
// Matching a pending capture staples a follow-up Task onto the contact, due
// "tomorrow at nine". It was computed with `setDate(getDate() + 1)` and
// `setHours(9, 0, 0, 0)` — both LOCAL-time operations — on a box that runs
// Etc/UTC. The operator was promised 09:00 and got 12:00 Moscow: three hours
// into the day, through lunch. Late in the Moscow evening it also picked the
// wrong DAY, because the date being incremented was the UTC date.
//
// Two properties are asserted, and the second is the one that keeps the fix
// alive: the answer must not depend on the process time zone at all. Pinning
// only the offset (+03:00) or only the process TZ would satisfy the first test
// and leave the class open, so every assertion below states the instant in UTC
// AND reads it back as a Moscow wall clock.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({
  pendingCapture: { findFirst: vi.fn(), update: vi.fn() },
  contact: { findFirst: vi.fn() },
  message: { create: vi.fn() },
  task: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));
vi.mock('../../../backend/services/encryption', () => ({
  decryptField: (value: string | null) => value,
}));
vi.mock('../../../backend/services/visibility', () => ({
  // The cone is a different concern, exercised in cone-leaks.test.ts. Here the
  // caller sees everything so the handler reaches the task it creates.
  getAccessibleUserIds: vi.fn(async () => null),
  canSeeUser: () => true,
  ownerVisibilityWhere: () => undefined,
}));

const { CapturesController } = await import('../../../backend/api/controllers/captures');

const ORG = '55555555-5555-4555-8555-000000000001';
const USER = '55555555-5555-4555-8555-00000000000a';
const CAPTURE = '55555555-5555-4555-8555-0000000000c0';
const CONTACT = '55555555-5555-4555-8555-0000000000c1';

const MOSCOW_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function makeRequest(): FastifyRequest {
  return {
    params: { id: CAPTURE },
    body: { contact_id: CONTACT },
    user: { sub: USER, org_id: ORG, role: 'owner' },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply = {
    status() {
      return reply;
    },
    send() {
      return reply;
    },
  };

  return reply as unknown as FastifyReply;
}

/** The due_date the handler asked Prisma to write. */
async function followUpDueDate(): Promise<Date> {
  await CapturesController.match(makeRequest(), makeReply());
  expect(dbMock.task.create).toHaveBeenCalledTimes(1);
  const { data } = dbMock.task.create.mock.calls[0][0] as { data: { due_date: Date } };
  return data.due_date;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  dbMock.pendingCapture.findFirst.mockResolvedValue({
    id: CAPTURE,
    org_id: ORG,
    status: PendingCaptureStatus.pending,
    type: PendingCaptureType.call,
    raw_data: {},
    phone_number: null,
  });
  dbMock.contact.findFirst.mockResolvedValue({
    id: CONTACT,
    first_name: 'Мария',
    last_name: 'Соколова',
    assigned_to: USER,
    created_by: USER,
  });
  dbMock.pendingCapture.update.mockResolvedValue({ id: CAPTURE });
  dbMock.$transaction.mockImplementation(
    async (fn: (tx: typeof dbMock) => Promise<unknown>) => fn(dbMock),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('captures.match — the auto follow-up is 09:00 in the market\'s zone', () => {
  it('lands at 09:00 Moscow for a capture matched during the working day', async () => {
    // 13:00 Moscow on 28 July. Tomorrow morning is 09:00 MSK on the 29th, which
    // is 06:00Z — not the 09:00Z the local-time version produced on a UTC box.
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));

    const due = await followUpDueDate();

    expect(due.toISOString()).toBe('2026-07-29T06:00:00.000Z');
    expect(MOSCOW_TIME.format(due)).toBe('29.07.2026, 09:00');
  });

  it('uses the MOSCOW date, not the UTC one, after 21:00Z', async () => {
    // 02:30 Moscow on 29 July — still 28 July in UTC. "Tomorrow" means the 30th
    // to the operator and the 29th to the server, so this fails on the day as
    // well as on the hour.
    vi.setSystemTime(new Date('2026-07-28T23:30:00.000Z'));

    const due = await followUpDueDate();

    expect(due.toISOString()).toBe('2026-07-30T06:00:00.000Z');
    expect(MOSCOW_TIME.format(due)).toBe('30.07.2026, 09:00');
  });

  it('crosses a month boundary on the Moscow calendar', async () => {
    // 02:00 Moscow on 1 August; UTC is still 31 July.
    vi.setSystemTime(new Date('2026-07-31T23:00:00.000Z'));

    const due = await followUpDueDate();

    expect(due.toISOString()).toBe('2026-08-02T06:00:00.000Z');
    expect(MOSCOW_TIME.format(due)).toBe('02.08.2026, 09:00');
  });

  it('pins an INSTANT, with the sub-hour fields cleared', async () => {
    // Deliberately no assertion on `due.getHours()`. That is the process-local
    // hour, and asserting anything about it would reintroduce the bug into the
    // test: it is 9 on a Moscow developer's laptop and something else on
    // everybody else's, so it would either pass for the wrong reason or fail for
    // no reason. Everything here is stated in UTC or through an explicit zone.
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));

    const due = await followUpDueDate();

    expect(due.getUTCHours()).toBe(6);
    expect(due.getUTCMinutes()).toBe(0);
    expect(due.getUTCSeconds()).toBe(0);
    expect(due.getUTCMilliseconds()).toBe(0);
  });
});
