/**
 * Sequence sending, the safety half.
 *
 * sequences.test.ts covers WHO may be mailed (ФЗ-38 consent). This file covers what happens
 * to the message on the way out, and every case here was a live defect:
 *
 *   1. DUPLICATE SENDS. The send lease was stamped from the timestamp captured when the tick
 *      STARTED, not from the moment the row was claimed. A tick walks up to 100 enrollments
 *      per organization and awaits a provider round-trip on each, so a long tick wrote
 *      leases that were already expired — the row read as due again while it was still being
 *      sent, and the recipient got the same advertising message twice. Twice is a fine per
 *      recipient under ФЗ-38, not an annoyance.
 *   2. TWO TICKS AT ONCE. The scheduler re-fires every 60 s without waiting for the previous
 *      pass, so a slow tick ran alongside its own successor over the same due rows.
 *   3. NO REQUEST TIMEOUT. `fetch` has no deadline of its own; one hung socket outlived the
 *      lease and produced (1) all by itself.
 *   4. HEADER INJECTION ON THE SUBJECT. The subject is rendered from contact data and lands
 *      in a mail header; a CR/LF in a first_name forges one.
 *   5. RFC 8058 ONE-CLICK WAS NEVER ADVERTISED. The endpoint honours the POST, but no
 *      message told a provider to offer the button.
 *
 * The provider client is mocked at the `resend` boundary rather than at services/email.ts,
 * so these tests read the payload that would actually go on the wire — headers included.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);
process.env.RESEND_API_KEY = 're_test_key';
process.env.RESEND_FROM_EMAIL = 'CRM <crm@example.ru>';
process.env.PUBLIC_APP_URL = 'https://crm.example.ru';

// ─── The fake database ────────────────────────────────────────────────────────

type EnrollmentRow = {
  id: string;
  organization_id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
  status: string;
  next_send_at: Date | null;
};

type Where = Record<string, unknown>;
type Data = Record<string, unknown>;
type QueryArgs = { where?: Where; data?: Data };

/**
 * Enough of Prisma to make the CLAIM real: `updateMany` only touches rows that still match
 * `next_send_at <= x`, which is the compare-and-set the whole lease design rests on. A mock
 * that always returned `{ count: 1 }` could not tell a valid claim from a stolen one.
 */
const harness = vi.hoisted(() => {
  const enrollments: EnrollmentRow[] = [];
  /** Every lease the tick wrote, with the wall-clock instant it was written at. */
  const claims: { writtenAt: number; leaseUntil: number }[] = [];

  function matches(row: EnrollmentRow, where: Where): boolean {
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (typeof where.organization_id === 'string' && row.organization_id !== where.organization_id) {
      return false;
    }
    if (typeof where.status === 'string' && row.status !== where.status) return false;

    const bound = where.next_send_at as { lte?: Date } | undefined;
    if (bound?.lte) {
      if (row.next_send_at === null) return false;
      if (row.next_send_at.getTime() > bound.lte.getTime()) return false;
    }

    return true;
  }

  function applyUpdate(where: Where, data: Data): number {
    const hit = enrollments.filter((row) => matches(row, where));
    for (const row of hit) {
      if ('status' in data) row.status = data.status as string;
      if ('current_step' in data) row.current_step = data.current_step as number;
      if ('next_send_at' in data) row.next_send_at = data.next_send_at as Date | null;
    }
    return hit.length;
  }

  const db = {
    sequenceEnrollment: {
      findMany: vi.fn(async (args: QueryArgs) => {
        const where = args.where ?? {};
        return enrollments
          .filter((row) => matches(row, where))
          .map((row) => ({ ...row }));
      }),
      updateMany: vi.fn(async (args: QueryArgs) => {
        const where = args.where ?? {};
        const data = args.data ?? {};
        const count = applyUpdate(where, data);
        // A claim is the only update that is conditional on the row still being due.
        if (count > 0 && where.next_send_at !== undefined && data.next_send_at instanceof Date) {
          claims.push({ writtenAt: Date.now(), leaseUntil: data.next_send_at.getTime() });
        }
        return { count };
      }),
    },
    contact: {
      findFirst: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    sequenceStep: {
      findFirst: vi.fn(),
    },
    emailSend: {
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
  };

  return { db, enrollments, claims, applyUpdate };
});

const mockResendSend = vi.hoisted(() => vi.fn());

vi.mock('../../../backend/services/db', () => ({ db: harness.db }));
// services/email.ts is REAL here. Mocking it would hide the two things under test on that
// side: the AbortSignal and the custom headers actually reaching the provider call.
vi.mock('resend', () => ({
  Resend: class {
    readonly emails = { send: mockResendSend };
  },
}));

import { buildUnsubscribeUrl } from '../../../backend/services/consent';
import { EMAIL_SEND_TIMEOUT_MS, sendEmail } from '../../../backend/services/email';
import {
  SEQUENCE_SEND_LEASE_MS,
  buildListUnsubscribeHeaders,
  runSequenceTick,
} from '../../../backend/services/sequences';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-1111-1111-111111111111';
const T0 = new Date('2026-07-25T12:00:00Z');
const UNSUB_TOKEN = 'unsub_token_aaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * One send takes long enough that three of them outlast the lease, while no single one does.
 * That is the real shape of the bug: the request timeout keeps any one send far below the
 * lease, and stamping the lease at claim time is what keeps a LONG TICK from writing an
 * expired one.
 */
const SEND_DURATION_MS = 200_000;

type ResendPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};

type ResendRequestOptions = { signal?: AbortSignal };

function contactFor(id: string, overrides: Record<string, unknown> = {}) {
  const index = id.slice(-1);
  return {
    id,
    organization_id: ORG,
    email: `ivan${index}@example.ru`,
    first_name: 'Иван',
    last_name: 'Петров',
    company: 'ООО «Ромашка»',
    marketing_consent: true,
    unsubscribed_at: null,
    unsubscribe_token: `${UNSUB_TOKEN}${index}`,
    ...overrides,
  };
}

function stepFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    position: 0,
    delay_days: 0,
    template_id: null,
    subject: 'Здравствуйте, {{first_name}}',
    body: 'Предложение для {{company}}.',
    template: null,
    ...overrides,
  };
}

function seedEnrollments(count: number): void {
  harness.enrollments.length = 0;
  for (let i = 1; i <= count; i += 1) {
    harness.enrollments.push({
      id: `enr-${i}`,
      organization_id: ORG,
      sequence_id: 'seq-1',
      contact_id: `contact-${i}`,
      current_step: 0,
      status: 'active',
      next_send_at: T0,
    });
  }
}

function primeStep(step: Record<string, unknown> | null): void {
  harness.db.sequenceStep.findFirst.mockImplementation(async (args: QueryArgs) => {
    const position = args.where?.position as { gt?: number; gte?: number } | undefined;
    // `gt` is the lookahead for the NEXT step: there is only one, so the enrollment completes.
    return position?.gt !== undefined ? null : step;
  });
}

/** A second backend instance trying to claim the same row, at this instant. */
function rivalWorkerClaims(enrollmentId: string): boolean {
  const now = new Date();
  return (
    harness.applyUpdate(
      { id: enrollmentId, organization_id: ORG, status: 'active', next_send_at: { lte: now } },
      { next_send_at: new Date(now.getTime() + SEQUENCE_SEND_LEASE_MS) },
    ) > 0
  );
}

function payloads(): ResendPayload[] {
  return mockResendSend.mock.calls.map((call) => call[0] as ResendPayload);
}

function ledgerRows(): Record<string, unknown>[] {
  return harness.db.emailSend.create.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);

  harness.enrollments.length = 0;
  harness.claims.length = 0;

  process.env.PUBLIC_APP_URL = 'https://crm.example.ru';

  harness.db.contact.findFirst.mockImplementation(async (args: QueryArgs) =>
    contactFor(args.where?.id as string),
  );
  harness.db.contact.updateMany.mockResolvedValue({ count: 1 });
  harness.db.emailSend.updateMany.mockResolvedValue({ count: 1 });
  harness.db.emailSend.count.mockResolvedValue(0);

  let sendSeq = 0;
  harness.db.emailSend.create.mockImplementation(async () => {
    sendSeq += 1;
    return { id: `send-${sendSeq}` };
  });

  mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  primeStep(stepFixture());
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. A long tick never writes an expired claim ─────────────────────────────

describe('the send lease is stamped when the row is claimed', () => {
  beforeEach(() => {
    seedEnrollments(3);
    let call = 0;
    mockResendSend.mockImplementation(async () => {
      call += 1;
      // The provider round-trip: time passes while this tick holds the claim.
      vi.setSystemTime(new Date(Date.now() + SEND_DURATION_MS));
      return { data: { id: `msg-${call}` }, error: null };
    });
  });

  it('never writes a lease that has already expired', async () => {
    const summary = await runSequenceTick(T0);

    expect(summary.sent).toBe(3);
    // Three sends of 200 s: the tick ran 600 s, twice the 300 s lease.
    expect(Date.now() - T0.getTime()).toBeGreaterThan(SEQUENCE_SEND_LEASE_MS);

    expect(harness.claims).toHaveLength(3);
    for (const claim of harness.claims) {
      // Measured from the claim, not from the tick's start — so the last row's lease is as
      // long as the first row's, and no lease is in the past at the instant it is written.
      expect(claim.leaseUntil - claim.writtenAt).toBe(SEQUENCE_SEND_LEASE_MS);
    }
  });

  it('refuses a second worker that tries to claim a row this tick is still sending', async () => {
    const stolen: boolean[] = [];
    let call = 0;
    mockResendSend.mockImplementation(async () => {
      call += 1;
      vi.setSystemTime(new Date(Date.now() + SEND_DURATION_MS));
      // The message is on the wire and this row is still ours. Another instance of the
      // backend, running its own tick, must not be able to take it.
      stolen.push(rivalWorkerClaims(`enr-${call}`));
      return { data: { id: `msg-${call}` }, error: null };
    });

    await runSequenceTick(T0);

    expect(stolen).toEqual([false, false, false]);
  });

  it('sends each contact exactly one message and writes one ledger row per send', async () => {
    await runSequenceTick(T0);

    expect(mockResendSend).toHaveBeenCalledTimes(3);
    const recipients = payloads().map((payload) => payload.to);
    expect(new Set(recipients).size).toBe(3);
    expect(ledgerRows()).toHaveLength(3);
  });

  it('leaves nothing due behind: every row it sent has moved on', async () => {
    await runSequenceTick(T0);

    const stillDue = harness.enrollments.filter(
      (row) => row.status === 'active' && row.next_send_at !== null && row.next_send_at <= new Date(),
    );
    expect(stillDue).toEqual([]);
  });
});

// ─── 2. Two ticks never run at once ───────────────────────────────────────────

describe('a second tick is refused while one is in flight', () => {
  it('does nothing, sends nothing and says so', async () => {
    seedEnrollments(1);

    // Hold the first tick inside the provider call: claim written, message not yet settled.
    // That is precisely the window the 60 s scheduler used to fire a second tick into.
    let release: (() => void) | undefined;
    let sendStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    mockResendSend.mockImplementation(async () => {
      sendStarted?.();
      await gate;
      return { data: { id: 'msg-1' }, error: null };
    });

    const first = runSequenceTick(T0);
    await inFlight;
    const second = await runSequenceTick(T0);

    // Let the first tick finish before asserting, so a failed expectation cannot leave the
    // guard held and take every later test down with it.
    release?.();
    const summary = await first;

    expect(second.overlapped).toBe(true);
    expect(second.processed).toBe(0);
    expect(second.sent).toBe(0);
    // The refused tick never looked for work: one claim, from the tick that was running.
    expect(harness.claims).toHaveLength(1);

    expect(summary.sent).toBe(1);
    expect(summary.overlapped).toBeUndefined();
    expect(mockResendSend).toHaveBeenCalledTimes(1);
  });

  it('runs normally once the previous tick has finished', async () => {
    seedEnrollments(1);
    const first = await runSequenceTick(T0);
    expect(first.sent).toBe(1);

    seedEnrollments(1);
    const second = await runSequenceTick(new Date(Date.now()));

    expect(second.overlapped).toBeUndefined();
    expect(second.sent).toBe(1);
  });

  it('releases the guard when a tick throws, instead of wedging the mailing forever', async () => {
    harness.db.sequenceEnrollment.findMany.mockRejectedValueOnce(new Error('connection reset'));

    await expect(runSequenceTick(T0)).rejects.toThrow('connection reset');

    seedEnrollments(1);
    const recovered = await runSequenceTick(T0);

    expect(recovered.overlapped).toBeUndefined();
    expect(recovered.sent).toBe(1);
  });
});

// ─── 3. The provider call has a deadline ──────────────────────────────────────

describe('an outbound send cannot hang forever', () => {
  it('passes an abort signal to the provider and aborts it on the deadline', async () => {
    let signal: AbortSignal | undefined;
    mockResendSend.mockImplementation(
      (_payload: ResendPayload, options: ResendRequestOptions) =>
        new Promise((resolve) => {
          signal = options.signal;
          // Resend swallows a failed fetch and returns an error object rather than throwing.
          options.signal?.addEventListener('abort', () =>
            resolve({
              data: null,
              error: { name: 'application_error', message: 'Unable to fetch data.' },
            }),
          );
        }),
    );

    const pending = sendEmail('ivan@example.ru', 'Тема', 'Текст');
    await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({ success: false, errorCode: 'SEND_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
    // Comfortably inside the claim, so a timed-out send can never outlive the lease.
    expect(EMAIL_SEND_TIMEOUT_MS).toBeLessThan(SEQUENCE_SEND_LEASE_MS);
  });

  it('reports the timeout even when the client throws the abort', async () => {
    mockResendSend.mockImplementation(
      (_payload: ResendPayload, options: ResendRequestOptions) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );

    const pending = sendEmail('ivan@example.ru', 'Тема', 'Текст');
    await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({ success: false, errorCode: 'SEND_TIMEOUT' });
  });

  it('does not abort a send that answered in time', async () => {
    let signal: AbortSignal | undefined;
    mockResendSend.mockImplementation(async (_payload: ResendPayload, options: ResendRequestOptions) => {
      signal = options.signal;
      return { data: { id: 'msg-1' }, error: null };
    });

    await expect(sendEmail('ivan@example.ru', 'Тема', 'Текст')).resolves.toEqual({
      success: true,
      messageId: 'msg-1',
    });

    // The deadline was cleared, so nothing fires later and no stray abort is left pending.
    await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS * 3);
    expect(signal?.aborted).toBe(false);
  });
});

// ─── 4. Nothing a contact typed can forge a header ────────────────────────────

describe('the subject cannot carry a forged header', () => {
  const INJECTED = 'Иван\r\nBcc: attacker@example.com';

  beforeEach(() => {
    seedEnrollments(1);
  });

  it('folds CRLF out of a contact name before it reaches the Subject', async () => {
    harness.db.contact.findFirst.mockImplementation(async (args: QueryArgs) =>
      contactFor(args.where?.id as string, { first_name: INJECTED }),
    );

    await runSequenceTick(T0);

    const [payload] = payloads();
    expect(payload?.subject).not.toMatch(/[\r\n]/);
    expect(payload?.subject).toBe('Здравствуйте, Иван Bcc: attacker@example.com');
    // The forged field is text inside one header, never a header of its own.
    expect(payload).not.toHaveProperty('bcc');
    expect(payload?.headers?.Bcc).toBeUndefined();
  });

  it('folds the Unicode line separators and C0 controls too', async () => {
    harness.db.contact.findFirst.mockImplementation(async (args: QueryArgs) =>
      contactFor(args.where?.id as string, { first_name: 'Иван   Пётр' }),
    );

    await runSequenceTick(T0);

    const [payload] = payloads();
    expect(payload?.subject).toBe('Здравствуйте, Иван Пётр');
  });

  it('stores the sanitised subject on the EmailSend row, so the ledger matches the message', async () => {
    harness.db.contact.findFirst.mockImplementation(async (args: QueryArgs) =>
      contactFor(args.where?.id as string, { first_name: INJECTED }),
    );

    await runSequenceTick(T0);

    const [row] = ledgerRows();
    expect(row?.subject).toBe(payloads()[0]?.subject);
    expect(row?.subject).not.toMatch(/[\r\n]/);
  });

  it('leaves an ordinary subject exactly as written', async () => {
    await runSequenceTick(T0);

    expect(payloads()[0]?.subject).toBe('Здравствуйте, Иван');
  });

  it('does not sanitise the body — a newline there is content, not a header', async () => {
    primeStep(stepFixture({ body: 'Строка 1\nСтрока 2 для {{company}}.' }));

    await runSequenceTick(T0);

    expect(payloads()[0]?.text).toContain('Строка 1\nСтрока 2');
  });
});

// ─── 5. RFC 8058 one-click, advertised ────────────────────────────────────────

describe('every sequence message advertises one-click unsubscribe', () => {
  beforeEach(() => {
    seedEnrollments(1);
  });

  it('sets List-Unsubscribe and List-Unsubscribe-Post on the outbound message', async () => {
    await runSequenceTick(T0);

    const headers = payloads()[0]?.headers ?? {};
    // The URI is the one the body links to, from the one builder in services/consent.ts.
    expect(headers['List-Unsubscribe']).toBe(`<${buildUnsubscribeUrl(`${UNSUB_TOKEN}1`)}>`);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('points the header at the same endpoint the message body does', async () => {
    await runSequenceTick(T0);

    const payload = payloads()[0];
    const uri = (payload?.headers?.['List-Unsubscribe'] ?? '').slice(1, -1);
    expect(uri).toMatch(/^https:\/\/[^/]+\/api\/v1\/consent\/unsubscribe\//);
    expect(payload?.text).toContain(uri);
  });

  it('emits header values a mail server can parse', async () => {
    await runSequenceTick(T0);

    for (const value of Object.values(payloads()[0]?.headers ?? {})) {
      expect(value).not.toMatch(/[\r\n]/);
      expect(value.trim()).toBe(value);
    }
    expect(payloads()[0]?.headers?.['List-Unsubscribe']).toMatch(/^<https?:\/\/\S+>$/);
  });

  it('withholds the One-Click declaration when the opt-out URI is not https', async () => {
    // RFC 8058 §3 requires https; a provider POSTing the token in the clear would leak it.
    process.env.PUBLIC_APP_URL = 'http://localhost:3001';

    await runSequenceTick(T0);

    const headers = payloads()[0]?.headers ?? {};
    expect(headers['List-Unsubscribe']).toBe('<http://localhost:3001/api/v1/consent/unsubscribe/unsub_token_aaaaaaaaaaaaaaaaaaaaaaaa1>');
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  describe('buildListUnsubscribeHeaders', () => {
    it('wraps the URI in angle brackets per RFC 2369', () => {
      expect(buildListUnsubscribeHeaders('https://crm.example.ru/api/v1/consent/unsubscribe/tok')).toEqual({
        'List-Unsubscribe': '<https://crm.example.ru/api/v1/consent/unsubscribe/tok>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('emits nothing at all rather than a malformed header', () => {
      expect(buildListUnsubscribeHeaders('not a url')).toEqual({});
      expect(buildListUnsubscribeHeaders('')).toEqual({});
      expect(buildListUnsubscribeHeaders('javascript:alert(1)')).toEqual({});
    });

    it('strips a smuggled CRLF instead of passing it into a header', () => {
      const headers = buildListUnsubscribeHeaders(
        'https://crm.example.ru/api/v1/consent/unsubscribe/tok\r\nBcc:%20attacker@example.com',
      );

      expect(headers['List-Unsubscribe']).not.toMatch(/[\r\n]/);
    });
  });
});
