/**
 * Compliance surface for the email sequence engine (ФЗ-38 «О рекламе»).
 *
 * The fines are per message, so the assertions that matter most are the negative ones:
 * that nothing goes out without a live consent record, and that a withdrawal takes effect
 * immediately and everywhere.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);

const mockDb = vi.hoisted(() => ({
  contact: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  sequence: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  sequenceStep: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  sequenceEnrollment: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  emailSend: {
    create: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  emailTemplate: {
    findFirst: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));

const mockSendEmail = vi.hoisted(() => vi.fn());

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));
vi.mock('../../../backend/services/email', () => ({
  sendEmail: mockSendEmail,
  isEmailSendingEnabled: () => true,
  getFromEmail: () => 'CRM <crm@example.ru>',
}));

import { EmailSendStatus, SequenceEnrollmentStatus, SequenceStatus } from '@prisma/client';
import {
  ConsentContactNotFoundError,
  InvalidUnsubscribeTokenError,
  buildUnsubscribeUrl,
  canSendMarketingEmail,
  generateUnsubscribeToken,
  getConsentState,
  isWellFormedUnsubscribeToken,
  marketingRecipientWhere,
  recordMarketingConsent,
  unsubscribeByToken,
  validateUnsubscribeToken,
  withdrawMarketingConsent,
} from '../../../backend/services/consent';
import {
  AlreadyEnrolledError,
  ContactUnsubscribedError,
  InvalidSequenceStepError,
  MarketingConsentRequiredError,
  SequenceHasNoStepsError,
  SequenceNotEnrollableError,
  SequenceNotFoundError,
  addStep,
  archiveSequence,
  enrollContact,
  enrollContacts,
  listEnrollments,
  renderTemplate,
  resolveStepContent,
  runSequenceTick,
  unenrollContact,
  withUnsubscribeFooter,
} from '../../../backend/services/sequences';
import { SequencesController, denySequenceAdmin } from '../../../backend/api/controllers/sequences';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
const SEQ = 'seq-1';
const CONTACT = 'contact-1';
const TOKEN = 'unsub_token_aaaaaaaaaaaaaaaaaaaaaaaa';

type ContactFixture = {
  id: string;
  organization_id: string;
  email: string | null;
  first_name: string;
  last_name: string | null;
  company: string | null;
  marketing_consent: boolean;
  unsubscribed_at: Date | null;
  unsubscribe_token: string | null;
};

function contactFixture(overrides: Partial<ContactFixture> = {}): ContactFixture {
  return {
    id: CONTACT,
    organization_id: ORG,
    email: 'ivan@example.ru',
    first_name: 'Иван',
    last_name: 'Петров',
    company: 'ООО «Ромашка»',
    marketing_consent: true,
    unsubscribed_at: null,
    unsubscribe_token: TOKEN,
    ...overrides,
  };
}

type StepFixture = {
  id: string;
  position: number;
  delay_days: number;
  template_id: string | null;
  subject: string | null;
  body: string | null;
  template: { id: string; subject: string; body: string } | null;
};

function stepFixture(overrides: Partial<StepFixture> = {}): StepFixture {
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

type DueEnrollmentFixture = {
  id: string;
  organization_id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
};

function dueEnrollment(overrides: Partial<DueEnrollmentFixture> = {}): DueEnrollmentFixture {
  return {
    id: 'enr-1',
    organization_id: ORG,
    sequence_id: SEQ,
    contact_id: CONTACT,
    current_step: 0,
    ...overrides,
  };
}

type WhereArg = { where?: Record<string, unknown>; data?: Record<string, unknown> };

/**
 * Wire the enrollment findMany calls the tick makes: the first is the cross-org scan, the
 * per-org ones are keyed by organization_id.
 */
function primeTick(candidatesByOrg: Record<string, DueEnrollmentFixture[]>): void {
  mockDb.sequenceEnrollment.findMany.mockImplementation(async (args: WhereArg) => {
    const orgId = args.where?.organization_id as string | undefined;
    if (!orgId) {
      return Object.entries(candidatesByOrg).flatMap(([organization_id, rows]) =>
        rows.map(() => ({ organization_id })),
      );
    }
    return candidatesByOrg[orgId] ?? [];
  });
}

/** Current step lookup uses `position: { gte }`, the advance lookup uses `position: { gt }`. */
function primeSteps(current: StepFixture | null, next: { position: number; delay_days: number } | null): void {
  mockDb.sequenceStep.findFirst.mockImplementation(async (args: WhereArg) => {
    const position = args.where?.position as { gte?: number; gt?: number } | undefined;
    if (position && position.gt !== undefined) {
      return next;
    }
    return current;
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mockDb.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockDb) => Promise<unknown>)(mockDb);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  mockDb.contact.updateMany.mockResolvedValue({ count: 1 });
  mockDb.sequence.updateMany.mockResolvedValue({ count: 1 });
  mockDb.sequenceStep.updateMany.mockResolvedValue({ count: 0 });
  mockDb.sequenceStep.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 });
  mockDb.emailSend.updateMany.mockResolvedValue({ count: 1 });
  mockDb.emailSend.count.mockResolvedValue(1);
  mockDb.emailSend.create.mockResolvedValue({ id: 'send-1' });
  mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
});

// ─── The consent choke point ──────────────────────────────────────────────────

describe('canSendMarketingEmail — the single ФЗ-38 gate', () => {
  it('allows a consented contact and hands back the plaintext address', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());

    const decision = await canSendMarketingEmail(CONTACT, ORG);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.contact.email).toBe('ivan@example.ru');
      expect(decision.contact.first_name).toBe('Иван');
    }
  });

  it('is org-scoped — the lookup always carries organization_id', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());

    await canSendMarketingEmail(CONTACT, ORG);

    expect(mockDb.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CONTACT, organization_id: ORG } }),
    );
  });

  it('refuses a contact that belongs to another organization', async () => {
    mockDb.contact.findFirst.mockResolvedValue(null);

    const decision = await canSendMarketingEmail(CONTACT, OTHER_ORG);

    expect(decision).toMatchObject({ allowed: false, reason: 'CONTACT_NOT_FOUND' });
  });

  it('refuses when consent was never given', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture({ marketing_consent: false }));

    const decision = await canSendMarketingEmail(CONTACT, ORG);

    expect(decision).toMatchObject({ allowed: false, reason: 'MARKETING_CONSENT_MISSING' });
  });

  it('refuses an unsubscribed contact even when the consent flag is still true', async () => {
    mockDb.contact.findFirst.mockResolvedValue(
      contactFixture({ marketing_consent: true, unsubscribed_at: new Date('2026-07-01T00:00:00Z') }),
    );

    const decision = await canSendMarketingEmail(CONTACT, ORG);

    expect(decision).toMatchObject({ allowed: false, reason: 'CONTACT_UNSUBSCRIBED' });
  });

  it('refuses a contact with no address', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture({ email: null }));

    const decision = await canSendMarketingEmail(CONTACT, ORG);

    expect(decision).toMatchObject({ allowed: false, reason: 'CONTACT_NO_EMAIL' });
  });

  it('exposes the mandatory bulk filter', () => {
    expect(marketingRecipientWhere(ORG)).toEqual({
      organization_id: ORG,
      marketing_consent: true,
      unsubscribed_at: null,
    });
  });
});

// ─── Consent records and tokens ───────────────────────────────────────────────

describe('consent records', () => {
  it('records value, timestamp and source, and clears a previous unsubscribe', async () => {
    const consentedAt = new Date('2026-07-20T10:00:00Z');
    mockDb.contact.findFirst
      .mockResolvedValueOnce({
        id: CONTACT,
        organization_id: ORG,
        marketing_consent: false,
        marketing_consent_at: null,
        marketing_consent_source: null,
        unsubscribed_at: new Date('2026-05-01T00:00:00Z'),
      })
      .mockResolvedValue({ unsubscribe_token: TOKEN });

    const state = await recordMarketingConsent({
      contactId: CONTACT,
      organizationId: ORG,
      source: 'form',
      consentedAt,
    });

    expect(state).toMatchObject({
      marketing_consent: true,
      marketing_consent_source: 'form',
      marketing_consent_at: consentedAt,
      unsubscribed_at: null,
      can_send_marketing: true,
    });
    expect(mockDb.contact.updateMany).toHaveBeenCalledWith({
      where: { id: CONTACT, organization_id: ORG },
      data: {
        marketing_consent: true,
        marketing_consent_at: consentedAt,
        marketing_consent_source: 'form',
        unsubscribed_at: null,
      },
    });
  });

  it('refuses to touch a contact outside the organization', async () => {
    mockDb.contact.findFirst.mockResolvedValue(null);

    await expect(
      recordMarketingConsent({ contactId: CONTACT, organizationId: OTHER_ORG, source: 'form' }),
    ).rejects.toBeInstanceOf(ConsentContactNotFoundError);
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
  });

  it('reports the current state without mutating anything', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      marketing_consent: true,
      marketing_consent_at: new Date('2026-06-01T00:00:00Z'),
      marketing_consent_source: 'contract',
      unsubscribed_at: null,
    });

    const state = await getConsentState(CONTACT, ORG);

    expect(state.can_send_marketing).toBe(true);
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
  });

  it('restricts the lookup to the visibility cone when one is supplied', async () => {
    mockDb.contact.findFirst.mockResolvedValue(null);

    await expect(
      getConsentState(CONTACT, ORG, { accessibleUserIds: ['user-1'] }),
    ).rejects.toBeInstanceOf(ConsentContactNotFoundError);

    expect(mockDb.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: CONTACT,
          organization_id: ORG,
          OR: [{ assigned_to: { in: ['user-1'] } }, { created_by: { in: ['user-1'] } }],
        }),
      }),
    );
  });
});

describe('unsubscribe tokens', () => {
  it('mints unguessable, distinct tokens', () => {
    const a = generateUnsubscribeToken();
    const b = generateUnsubscribeToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(isWellFormedUnsubscribeToken(a)).toBe(true);
  });

  it('rejects malformed tokens without touching the database', async () => {
    for (const bad of ['', 'short', 'has spaces in it and is long enough', null, 42]) {
      expect(isWellFormedUnsubscribeToken(bad)).toBe(false);
      await expect(validateUnsubscribeToken(bad)).resolves.toBeNull();
    }

    expect(mockDb.contact.findFirst).not.toHaveBeenCalled();
  });

  it('builds an absolute unsubscribe url', () => {
    expect(buildUnsubscribeUrl(TOKEN)).toContain(`/api/v1/consent/unsubscribe/${TOKEN}`);
    expect(buildUnsubscribeUrl(TOKEN)).toMatch(/^https?:\/\//);
  });
});

// ─── Unsubscribe cascade ──────────────────────────────────────────────────────

describe('unsubscribe cascades org-wide', () => {
  it('stamps the contact and moves every ACTIVE enrollment to unsubscribed', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      marketing_consent: true,
      marketing_consent_at: new Date(),
      marketing_consent_source: 'form',
      unsubscribed_at: null,
    });
    mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 3 });

    const result = await withdrawMarketingConsent({ contactId: CONTACT, organizationId: ORG });

    expect(result.can_send_marketing).toBe(false);
    expect(result.stopped_enrollments).toBe(3);

    expect(mockDb.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONTACT, organization_id: ORG },
        data: expect.objectContaining({ marketing_consent: false }),
      }),
    );

    // Every active enrollment of that contact, in every sequence of the org — not just the
    // one whose message prompted the click.
    const cascade = mockDb.sequenceEnrollment.updateMany.mock.calls[0][0] as WhereArg;
    expect(cascade.where).toEqual({
      organization_id: ORG,
      contact_id: CONTACT,
      status: SequenceEnrollmentStatus.active,
    });
    expect(cascade.data).toMatchObject({
      status: SequenceEnrollmentStatus.unsubscribed,
      next_send_at: null,
    });
  });

  it('unsubscribes by token and reports how many enrollments it stopped', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: null,
    });
    mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 2 });

    const result = await unsubscribeByToken(TOKEN);

    expect(result).toMatchObject({
      contact_id: CONTACT,
      organization_id: ORG,
      already_unsubscribed: false,
      stopped_enrollments: 2,
    });
  });

  it('is idempotent — a second click writes nothing', async () => {
    mockDb.contact.findFirst.mockResolvedValue({
      id: CONTACT,
      organization_id: ORG,
      unsubscribed_at: new Date('2026-07-01T00:00:00Z'),
    });

    const result = await unsubscribeByToken(TOKEN);

    expect(result.already_unsubscribed).toBe(true);
    expect(mockDb.contact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.sequenceEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    mockDb.contact.findFirst.mockResolvedValue(null);

    await expect(unsubscribeByToken(TOKEN)).rejects.toBeInstanceOf(InvalidUnsubscribeTokenError);
  });
});

// ─── Enrollment ───────────────────────────────────────────────────────────────

describe('enrollment refuses non-consenting contacts', () => {
  beforeEach(() => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });
    mockDb.sequenceStep.findFirst.mockResolvedValue({ position: 0, delay_days: 0 });
  });

  it('refuses loudly — no consent means an error code, not a silent skip', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture({ marketing_consent: false }));

    const error = await enrollContact({
      sequenceId: SEQ,
      contactId: CONTACT,
      organizationId: ORG,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MarketingConsentRequiredError);
    expect((error as MarketingConsentRequiredError).code).toBe('MARKETING_CONSENT_REQUIRED');
    expect(mockDb.sequenceEnrollment.create).not.toHaveBeenCalled();
  });

  it('refuses a contact who already unsubscribed', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture({ unsubscribed_at: new Date() }));

    await expect(
      enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG }),
    ).rejects.toBeInstanceOf(ContactUnsubscribedError);
    expect(mockDb.sequenceEnrollment.create).not.toHaveBeenCalled();
  });

  it('enrolls a consented contact and schedules the first step', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    mockDb.sequenceStep.findFirst.mockResolvedValue({ position: 0, delay_days: 2 });
    mockDb.sequenceEnrollment.create.mockResolvedValue({ id: 'enr-1' });

    const now = new Date('2026-07-25T09:00:00Z');
    await enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG, now });

    const created = mockDb.sequenceEnrollment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({
      sequence_id: SEQ,
      contact_id: CONTACT,
      organization_id: ORG,
      status: SequenceEnrollmentStatus.active,
      current_step: 0,
    });
    expect((created.data.next_send_at as Date).toISOString()).toBe('2026-07-27T09:00:00.000Z');
  });

  it('is org-scoped — the sequence lookup carries organization_id', async () => {
    mockDb.sequence.findFirst.mockResolvedValue(null);

    await expect(
      enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: OTHER_ORG }),
    ).rejects.toBeInstanceOf(SequenceNotFoundError);

    expect(mockDb.sequence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SEQ, organization_id: OTHER_ORG } }),
    );
    expect(mockDb.contact.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an archived sequence before it even looks at consent', async () => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.archived });

    await expect(
      enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG }),
    ).rejects.toBeInstanceOf(SequenceNotEnrollableError);
  });

  it('refuses a sequence with no steps', async () => {
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    mockDb.sequenceStep.findFirst.mockResolvedValue(null);

    await expect(
      enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG }),
    ).rejects.toBeInstanceOf(SequenceHasNoStepsError);
  });
});

describe('the unique constraint prevents double enrollment', () => {
  beforeEach(() => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    mockDb.sequenceStep.findFirst.mockResolvedValue({ position: 0, delay_days: 0 });
  });

  it('surfaces ALREADY_ENROLLED when an active enrollment already exists', async () => {
    mockDb.sequenceEnrollment.create.mockRejectedValue({ code: 'P2002' });
    mockDb.sequenceEnrollment.findFirst.mockResolvedValue({
      id: 'enr-1',
      status: SequenceEnrollmentStatus.active,
    });

    const error = await enrollContact({
      sequenceId: SEQ,
      contactId: CONTACT,
      organizationId: ORG,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AlreadyEnrolledError);
    expect((error as AlreadyEnrolledError).code).toBe('ALREADY_ENROLLED');
    expect(mockDb.sequenceEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('restarts a terminal enrollment once consent has been re-established', async () => {
    mockDb.sequenceEnrollment.create.mockRejectedValue({ code: 'P2002' });
    mockDb.sequenceEnrollment.findFirst
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.unsubscribed })
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.active });

    await enrollContact({ sequenceId: SEQ, contactId: CONTACT, organizationId: ORG });

    const update = mockDb.sequenceEnrollment.updateMany.mock.calls[0][0] as WhereArg;
    expect(update.where).toMatchObject({ id: 'enr-1', organization_id: ORG });
    expect(update.data).toMatchObject({ status: SequenceEnrollmentStatus.active, current_step: 0 });
  });
});

describe('bulk enrollment itemises every refusal', () => {
  it('enrolls the consented contacts and explains each rejection', async () => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });
    mockDb.sequenceStep.findFirst.mockResolvedValue({ position: 0, delay_days: 0 });
    mockDb.sequenceEnrollment.create.mockResolvedValue({ id: 'enr-ok' });
    mockDb.contact.findFirst.mockImplementation(async (args: WhereArg) => {
      const id = args.where?.id as string;
      if (id === 'ok') return contactFixture({ id: 'ok' });
      if (id === 'no-consent') return contactFixture({ id: 'no-consent', marketing_consent: false });
      return null;
    });

    const result = await enrollContacts({
      sequenceId: SEQ,
      contactIds: ['ok', 'no-consent', 'missing'],
      organizationId: ORG,
    });

    expect(result.enrolled).toHaveLength(1);
    expect(result.refused).toEqual([
      { contact_id: 'no-consent', code: 'MARKETING_CONSENT_REQUIRED', message: expect.any(String) },
      { contact_id: 'missing', code: 'CONTACT_NOT_FOUND', message: expect.any(String) },
    ]);
  });
});

describe('unenroll', () => {
  it('cancels an active enrollment inside the org', async () => {
    mockDb.sequenceEnrollment.findFirst
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.active })
      .mockResolvedValueOnce({ id: 'enr-1', status: SequenceEnrollmentStatus.cancelled });

    await unenrollContact('enr-1', ORG);

    const update = mockDb.sequenceEnrollment.updateMany.mock.calls[0][0] as WhereArg;
    expect(update.where).toMatchObject({ id: 'enr-1', organization_id: ORG });
    expect(update.data).toMatchObject({
      status: SequenceEnrollmentStatus.cancelled,
      next_send_at: null,
    });
  });

  it('leaves an already-terminal enrollment alone', async () => {
    mockDb.sequenceEnrollment.findFirst.mockResolvedValue({
      id: 'enr-1',
      status: SequenceEnrollmentStatus.unsubscribed,
    });

    await unenrollContact('enr-1', ORG);

    expect(mockDb.sequenceEnrollment.updateMany).not.toHaveBeenCalled();
  });
});

// ─── The scheduler tick ───────────────────────────────────────────────────────

describe('the tick re-checks consent before every individual send', () => {
  it('stops the next send when consent was withdrawn mid-sequence', async () => {
    primeTick({ [ORG]: [dueEnrollment()] });
    // Enrolled while consenting; by the time step 2 comes due, they have unsubscribed.
    mockDb.contact.findFirst.mockResolvedValue(
      contactFixture({ marketing_consent: false, unsubscribed_at: new Date() }),
    );
    primeSteps(stepFixture(), null);

    const summary = await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockDb.emailSend.create).not.toHaveBeenCalled();
    expect(summary.unsubscribed).toBe(1);

    // The claim is the first update; the consent verdict is the second.
    const verdict = mockDb.sequenceEnrollment.updateMany.mock.calls[1][0] as WhereArg;
    expect(verdict.where).toMatchObject({ id: 'enr-1', organization_id: ORG });
    expect(verdict.data).toMatchObject({
      status: SequenceEnrollmentStatus.unsubscribed,
      next_send_at: null,
    });
  });

  it('only considers active enrollments of active sequences', async () => {
    primeTick({});

    await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    const scan = mockDb.sequenceEnrollment.findMany.mock.calls[0][0] as WhereArg;
    expect(scan.where).toMatchObject({
      status: SequenceEnrollmentStatus.active,
      sequence: { status: SequenceStatus.active },
    });
  });

  it('skips an enrollment another worker already claimed', async () => {
    primeTick({ [ORG]: [dueEnrollment()] });
    mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 0 });

    const summary = await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    expect(summary.skipped).toBe(1);
    expect(mockDb.contact.findFirst).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('the tick sends and advances', () => {
  it('records the attempt, sends, and schedules the next step', async () => {
    primeTick({ [ORG]: [dueEnrollment()] });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    primeSteps(stepFixture(), { position: 1, delay_days: 3 });

    const now = new Date('2026-07-25T12:00:00Z');
    const summary = await runSequenceTick(now);

    expect(summary.sent).toBe(1);

    // Ledger row is written before the provider call…
    const ledger = mockDb.emailSend.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(ledger.data).toMatchObject({
      organization_id: ORG,
      enrollment_id: 'enr-1',
      step_id: 'step-1',
      contact_id: CONTACT,
      status: EmailSendStatus.queued,
    });
    expect(ledger.data.open_token).toEqual(expect.any(String));

    // …personalised…
    const [to, subject, body] = mockSendEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe('ivan@example.ru');
    expect(subject).toBe('Здравствуйте, Иван');
    expect(body).toContain('ООО «Ромашка»');
    // …and every message carries a working opt-out (ФЗ-38 art. 18).
    expect(body).toContain(`/api/v1/consent/unsubscribe/${TOKEN}`);

    const settled = mockDb.emailSend.updateMany.mock.calls[0][0] as WhereArg;
    expect(settled.where).toMatchObject({ id: 'send-1', organization_id: ORG });
    expect(settled.data).toMatchObject({ status: EmailSendStatus.sent, provider_message_id: 'msg-1' });

    const advance = mockDb.sequenceEnrollment.updateMany.mock.calls[1][0] as WhereArg;
    expect(advance.data).toMatchObject({ current_step: 1 });
    expect((advance.data?.next_send_at as Date).toISOString()).toBe('2026-07-28T12:00:00.000Z');
  });

  it('completes the enrollment after the last step', async () => {
    primeTick({ [ORG]: [dueEnrollment()] });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    primeSteps(stepFixture(), null);

    const summary = await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    expect(summary.sent).toBe(1);
    const advance = mockDb.sequenceEnrollment.updateMany.mock.calls[1][0] as WhereArg;
    expect(advance.data).toMatchObject({
      status: SequenceEnrollmentStatus.completed,
      next_send_at: null,
    });
  });
});

describe('a send failure is recorded and contained', () => {
  it('writes a failed EmailSend row and keeps mailing the other contacts', async () => {
    primeTick({
      [ORG]: [dueEnrollment({ id: 'enr-bad', contact_id: 'contact-bad' }), dueEnrollment({ id: 'enr-ok' })],
    });
    mockDb.contact.findFirst.mockImplementation(async (args: WhereArg) =>
      contactFixture({ id: args.where?.id as string }),
    );
    primeSteps(stepFixture(), null);
    mockDb.emailSend.create
      .mockResolvedValueOnce({ id: 'send-bad' })
      .mockResolvedValueOnce({ id: 'send-ok' });
    mockSendEmail
      .mockResolvedValueOnce({ success: false, errorCode: 'SERVICE_NOT_CONFIGURED' })
      .mockResolvedValueOnce({ success: true, messageId: 'msg-2' });

    const summary = await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    const failure = mockDb.emailSend.updateMany.mock.calls[0][0] as WhereArg;
    expect(failure.where).toMatchObject({ id: 'send-bad', organization_id: ORG });
    expect(failure.data).toMatchObject({
      status: EmailSendStatus.failed,
      error_message: 'SERVICE_NOT_CONFIGURED',
    });

    const success = mockDb.emailSend.updateMany.mock.calls[1][0] as WhereArg;
    expect(success.data).toMatchObject({ status: EmailSendStatus.sent });
  });

  it('retries the same step rather than skipping it', async () => {
    primeTick({ [ORG]: [dueEnrollment()] });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    primeSteps(stepFixture({ position: 2 }), null);
    mockSendEmail.mockResolvedValue({ success: false, errorCode: 'RESEND_ERROR' });
    mockDb.emailSend.count.mockResolvedValue(1);

    const now = new Date('2026-07-25T12:00:00Z');
    await runSequenceTick(now);

    const retry = mockDb.sequenceEnrollment.updateMany.mock.calls[1][0] as WhereArg;
    expect(retry.data).toMatchObject({ current_step: 2 });
    expect((retry.data?.next_send_at as Date).getTime()).toBe(now.getTime() + 15 * 60_000);
  });

  it('gives up on the enrollment after the attempt cap', async () => {
    primeTick({ [ORG]: [dueEnrollment()] });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    primeSteps(stepFixture(), null);
    mockSendEmail.mockResolvedValue({ success: false, errorCode: 'RESEND_ERROR' });
    mockDb.emailSend.count.mockResolvedValue(3);

    await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    const giveUp = mockDb.sequenceEnrollment.updateMany.mock.calls[1][0] as WhereArg;
    expect(giveUp.data).toMatchObject({
      status: SequenceEnrollmentStatus.failed,
      next_send_at: null,
    });
  });

  it('an unexpected throw on one enrollment does not abort the tick', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    primeTick({ [ORG]: [dueEnrollment({ id: 'enr-boom' }), dueEnrollment({ id: 'enr-ok' })] });
    mockDb.sequenceEnrollment.updateMany
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue({ count: 1 });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture());
    primeSteps(stepFixture(), null);

    const summary = await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    expect(summary.processed).toBe(2);
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(1);
    errorSpy.mockRestore();
  });
});

describe('org scoping holds across the tick', () => {
  it('batches per organization and carries organization_id on every write', async () => {
    primeTick({
      [ORG]: [dueEnrollment()],
      [OTHER_ORG]: [dueEnrollment({ id: 'enr-2', organization_id: OTHER_ORG, contact_id: 'contact-2' })],
    });
    mockDb.contact.findFirst.mockImplementation(async (args: WhereArg) =>
      contactFixture({
        id: args.where?.id as string,
        organization_id: args.where?.organization_id as string,
      }),
    );
    primeSteps(stepFixture(), null);

    await runSequenceTick(new Date('2026-07-25T12:00:00Z'));

    const perOrgQueries = mockDb.sequenceEnrollment.findMany.mock.calls
      .slice(1)
      .map((call) => (call[0] as WhereArg).where?.organization_id);
    expect(perOrgQueries).toEqual([ORG, OTHER_ORG]);

    // The consent re-check for the second org's contact is scoped to that org, never to a
    // parent join.
    expect(mockDb.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'contact-2', organization_id: OTHER_ORG } }),
    );

    for (const call of mockDb.emailSend.create.mock.calls) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      expect(data.organization_id).toBeDefined();
    }
    for (const call of mockDb.sequenceEnrollment.updateMany.mock.calls) {
      expect((call[0] as WhereArg).where?.organization_id).toBeDefined();
    }
  });

  it('scopes step, enrollment and archive queries to the organization', async () => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });
    mockDb.sequenceStep.count.mockResolvedValue(0);
    mockDb.sequenceStep.findFirst.mockResolvedValue(null);
    mockDb.sequenceStep.create.mockResolvedValue({ id: 'step-1' });
    mockDb.sequenceEnrollment.findMany.mockResolvedValue([]);
    mockDb.sequenceEnrollment.count.mockResolvedValue(0);

    await addStep(SEQ, ORG, { subject: 'Тема', body: 'Текст' });
    expect(mockDb.sequenceStep.count).toHaveBeenCalledWith({
      where: { organization_id: ORG, sequence_id: SEQ },
    });

    await listEnrollments(SEQ, ORG, {});
    expect(mockDb.sequenceEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG, sequence_id: SEQ }),
      }),
    );

    mockDb.sequenceEnrollment.updateMany.mockResolvedValue({ count: 4 });
    const archived = await archiveSequence(SEQ, ORG);
    expect(archived.cancelled_enrollments).toBe(4);
    expect(mockDb.sequence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SEQ, organization_id: ORG } }),
    );
  });

  it('rejects a step that carries neither a template nor inline content', async () => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });

    await expect(addStep(SEQ, ORG, { delay_days: 1 })).rejects.toBeInstanceOf(
      InvalidSequenceStepError,
    );
    expect(mockDb.sequenceStep.create).not.toHaveBeenCalled();
  });
});

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('message rendering', () => {
  it('substitutes known placeholders and blanks unknown ones', () => {
    expect(renderTemplate('Привет, {{first_name}} {{nope}}!', { first_name: 'Иван' })).toBe(
      'Привет, Иван !',
    );
  });

  it('appends the opt-out only when the body does not already carry it', () => {
    const url = 'https://crm.example.ru/api/v1/consent/unsubscribe/tok';
    expect(withUnsubscribeFooter('Текст', url)).toContain(url);
    expect(withUnsubscribeFooter(`Текст ${url}`, url)).toBe(`Текст ${url}`);
  });

  it('prefers the template over inline content and rejects an empty step', () => {
    expect(
      resolveStepContent({ subject: 'a', body: 'b', template: { subject: 't', body: 'tb' } }),
    ).toEqual({ subject: 't', body: 'tb' });
    expect(resolveStepContent({ subject: 'a', body: null, template: null })).toBeNull();
  });
});

// ─── Route guards ─────────────────────────────────────────────────────────────

type FakeReply = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeReply;
  send: (payload: unknown) => FakeReply;
};

function fakeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: 200,
    payload: undefined,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(payload: unknown) {
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

function fakeRequest(role: 'owner' | 'admin' | 'member' | 'viewer', body: unknown = {}): FastifyRequest {
  return {
    user: { sub: 'user-1', org_id: ORG, role, iat: 0, exp: 0 },
    params: { id: SEQ },
    query: {},
    body,
    method: 'POST',
    url: '/api/v1/sequences',
    headers: {},
  } as unknown as FastifyRequest;
}

describe('sequence admin guard', () => {
  it('RESOLVES TO THE REPLY when it denies, so the caller can halt on it', () => {
    const reply = fakeReply();

    const result = denySequenceAdmin(fakeRequest('member'), reply as unknown as FastifyReply);

    // Not undefined: a guard that resolves to undefined lets the handler run on and send a
    // second response.
    expect(result).toBe(reply);
    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('denies viewers too', () => {
    const reply = fakeReply();

    expect(denySequenceAdmin(fakeRequest('viewer'), reply as unknown as FastifyReply)).toBe(reply);
    expect(reply.statusCode).toBe(403);
  });

  it('lets owner and admin through', () => {
    for (const role of ['owner', 'admin'] as const) {
      const reply = fakeReply();
      expect(denySequenceAdmin(fakeRequest(role), reply as unknown as FastifyReply)).toBeNull();
      expect(reply.statusCode).toBe(200);
    }
  });

  it('never reaches the service layer for a member', async () => {
    const reply = fakeReply();

    await SequencesController.enroll(
      fakeRequest('member', { contact_id: CONTACT }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(403);
    expect(mockDb.sequenceEnrollment.create).not.toHaveBeenCalled();
  });
});

describe('enroll endpoint surfaces the consent refusal', () => {
  it('answers 422 MARKETING_CONSENT_REQUIRED rather than pretending it worked', async () => {
    mockDb.sequence.findFirst.mockResolvedValue({ id: SEQ, status: SequenceStatus.active });
    mockDb.contact.findFirst.mockResolvedValue(contactFixture({ marketing_consent: false }));
    const reply = fakeReply();

    await SequencesController.enroll(
      fakeRequest('owner', { contact_id: CONTACT }),
      reply as unknown as FastifyReply,
    );

    expect(reply.statusCode).toBe(422);
    expect(reply.payload).toMatchObject({
      error: { code: 'MARKETING_CONSENT_REQUIRED' },
    });
    expect(mockDb.sequenceEnrollment.create).not.toHaveBeenCalled();
  });
});
