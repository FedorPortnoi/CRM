/**
 * sequences.ts — the email sequence engine.
 *
 * A Sequence is an ordered list of SequenceSteps. A contact is enrolled into a sequence and
 * the scheduler walks them through the steps, waiting `delay_days` between each. Every
 * attempt — success or failure — is written to the EmailSend ledger.
 *
 * COMPLIANCE (ФЗ-38 «О рекламе»), non-negotiable and enforced here:
 *   • Enrollment REFUSES a contact without consent, loudly, with a specific error code.
 *     Silently skipping would leave the operator believing the mailing went out.
 *   • Consent is re-checked immediately before EVERY individual send, not just at
 *     enrollment. Weeks can pass between step 1 and step 5 and the contact may have
 *     unsubscribed in the meantime; the enrollment-time check is worthless by then.
 *   • Every message carries a working one-click unsubscribe link (art. 18). If the body
 *     does not place one itself, a footer is appended.
 *   • An unsubscribe is org-wide and cascades to every active enrollment — see
 *     services/consent.ts, which owns that transaction.
 *
 * The tick is driven by the existing 60 s loop in services/scheduler.ts. There is no timer
 * in this file.
 */

import { EmailSendStatus, Prisma, SequenceEnrollmentStatus, SequenceStatus } from '@prisma/client';
import { db } from './db';
import { decryptField } from './encryption';
import { sendEmail } from './email';
// The token minted here is the same token the public pixel endpoint validates, so both
// sides come from ONE generator. A second local copy could drift in length or alphabet and
// silently make every open unrecordable.
import { buildTrackingPixelUrl, generateOpenToken } from './open-tracking';
import {
  buildUnsubscribeUrl,
  canSendMarketingEmail,
  ensureUnsubscribeToken,
  type MarketingRecipient,
} from './consent';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_STEPS_PER_SEQUENCE = 25;
export const MAX_BULK_ENROLL = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many organizations' worth of due enrollments one tick looks at. */
export const SEQUENCE_TICK_SCAN_SIZE = 1000;
/** Per-organization cap per tick, so no single org starves the others. */
export const SEQUENCE_TICK_BATCH_SIZE = 100;
/**
 * A claimed enrollment has next_send_at pushed this far out before the send is attempted.
 * The claim is the atomic compare-and-set; a worker that dies mid-send releases the row
 * when the lease expires instead of stranding it.
 */
export const SEQUENCE_SEND_LEASE_MS = 5 * 60_000;
/** Backoff before retrying the SAME step after a provider failure. */
export const SEQUENCE_SEND_RETRY_DELAY_MS = 15 * 60_000;
/** After this many failed sends of one step the enrollment is given up on. */
export const MAX_SEND_ATTEMPTS_PER_STEP = 3;

const ERROR_MAX_LENGTH = 500;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class SequenceNotFoundError extends Error {
  readonly code = 'SEQUENCE_NOT_FOUND';
  constructor(message = 'Sequence not found') {
    super(message);
    this.name = 'SequenceNotFoundError';
  }
}

export class SequenceStepNotFoundError extends Error {
  readonly code = 'SEQUENCE_STEP_NOT_FOUND';
  constructor(message = 'Sequence step not found') {
    super(message);
    this.name = 'SequenceStepNotFoundError';
  }
}

export class EnrollmentNotFoundError extends Error {
  readonly code = 'ENROLLMENT_NOT_FOUND';
  constructor(message = 'Enrollment not found') {
    super(message);
    this.name = 'EnrollmentNotFoundError';
  }
}

export class EmailTemplateNotFoundError extends Error {
  readonly code = 'EMAIL_TEMPLATE_NOT_FOUND';
  constructor(message = 'Email template not found') {
    super(message);
    this.name = 'EmailTemplateNotFoundError';
  }
}

export class SequenceContactNotFoundError extends Error {
  readonly code = 'CONTACT_NOT_FOUND';
  constructor(message = 'Contact not found') {
    super(message);
    this.name = 'SequenceContactNotFoundError';
  }
}

/** ФЗ-38: enrolling a contact who never consented is refused, never silently skipped. */
export class MarketingConsentRequiredError extends Error {
  readonly code = 'MARKETING_CONSENT_REQUIRED';
  constructor(
    message = 'Contact has not given consent to receive advertising email (ФЗ-38) and cannot be enrolled',
  ) {
    super(message);
    this.name = 'MarketingConsentRequiredError';
  }
}

export class ContactUnsubscribedError extends Error {
  readonly code = 'CONTACT_UNSUBSCRIBED';
  constructor(message = 'Contact has unsubscribed from marketing email and cannot be enrolled') {
    super(message);
    this.name = 'ContactUnsubscribedError';
  }
}

export class ContactHasNoEmailError extends Error {
  readonly code = 'CONTACT_NO_EMAIL';
  constructor(message = 'Contact has no email address') {
    super(message);
    this.name = 'ContactHasNoEmailError';
  }
}

export class AlreadyEnrolledError extends Error {
  readonly code = 'ALREADY_ENROLLED';
  constructor(message = 'Contact is already enrolled in this sequence') {
    super(message);
    this.name = 'AlreadyEnrolledError';
  }
}

export class SequenceNotEnrollableError extends Error {
  readonly code = 'SEQUENCE_NOT_ENROLLABLE';
  constructor(message = 'Archived sequences cannot accept new enrollments') {
    super(message);
    this.name = 'SequenceNotEnrollableError';
  }
}

export class SequenceHasNoStepsError extends Error {
  readonly code = 'SEQUENCE_HAS_NO_STEPS';
  constructor(message = 'Add at least one step before enrolling contacts') {
    super(message);
    this.name = 'SequenceHasNoStepsError';
  }
}

export class InvalidSequenceStepError extends Error {
  readonly code = 'INVALID_SEQUENCE_STEP';
  constructor(message = 'A step needs either a template_id or both subject and body') {
    super(message);
    this.name = 'InvalidSequenceStepError';
  }
}

export class SequenceStepLimitError extends Error {
  readonly code = 'SEQUENCE_STEP_LIMIT_REACHED';
  constructor(message = `A sequence can hold at most ${MAX_STEPS_PER_SEQUENCE} steps`) {
    super(message);
    this.name = 'SequenceStepLimitError';
  }
}

export class InvalidStepOrderError extends Error {
  readonly code = 'INVALID_STEP_ORDER';
  constructor(message = 'The reorder list must contain every step of this sequence exactly once') {
    super(message);
    this.name = 'InvalidStepOrderError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type SequenceStepInput = {
  delay_days?: number;
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
};

export type SequenceStepPatch = SequenceStepInput;

export type CreateSequenceInput = {
  organizationId: string;
  createdBy?: string | null;
  name: string;
  description?: string | null;
  status?: SequenceStatus;
  steps?: SequenceStepInput[];
};

export type UpdateSequenceInput = {
  name?: string;
  description?: string | null;
  status?: SequenceStatus;
};

export type EnrollmentRefusal = {
  contact_id: string;
  code: string;
  message: string;
};

export type SequenceTickSummary = {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  unsubscribed: number;
  completed: number;
};

type EnrollmentOutcome = 'sent' | 'failed' | 'skipped' | 'unsubscribed' | 'completed';

type DueEnrollment = {
  id: string;
  organization_id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
};

type StepRow = {
  id: string;
  position: number;
  delay_days: number;
  template_id: string | null;
  subject: string | null;
  body: string | null;
  template: { id: string; subject: string; body: string } | null;
};

const SEQUENCE_SELECT = {
  id: true,
  organization_id: true,
  name: true,
  description: true,
  status: true,
  created_by: true,
  created_at: true,
  updated_at: true,
} as const;

const STEP_SELECT = {
  id: true,
  sequence_id: true,
  organization_id: true,
  position: true,
  delay_days: true,
  template_id: true,
  subject: true,
  body: true,
  created_at: true,
  updated_at: true,
} as const;

const STEP_SEND_SELECT = {
  id: true,
  position: true,
  delay_days: true,
  template_id: true,
  subject: true,
  body: true,
  template: { select: { id: true, subject: true, body: true } },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + Math.max(0, days) * DAY_MS);
}

function truncateError(message: string): string {
  return message.length > ERROR_MAX_LENGTH ? `${message.slice(0, ERROR_MAX_LENGTH - 1)}…` : message;
}

/**
 * Substitute `{{placeholder}}` tokens. Unknown placeholders collapse to an empty string —
 * a recipient should never see raw `{{first_name}}` in their inbox.
 */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? '');
}

export function buildTemplateVars(
  contact: MarketingRecipient,
  unsubscribeUrl: string,
): Record<string, string> {
  return {
    first_name: contact.first_name,
    last_name: contact.last_name ?? '',
    company: contact.company ?? '',
    email: contact.email,
    unsubscribe_url: unsubscribeUrl,
  };
}

/**
 * ФЗ-38 art. 18 — the recipient must be able to refuse further messages. If the body did
 * not place the link itself, append it. No marketing message leaves without one.
 */
export function withUnsubscribeFooter(body: string, unsubscribeUrl: string): string {
  if (body.includes(unsubscribeUrl)) {
    return body;
  }

  return `${body}\n\n---\nВы получили это письмо, так как дали согласие на получение рассылки.\nОтказаться от рассылки: ${unsubscribeUrl}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * The HTML alternative part of a sequence message — the ONLY place a tracking pixel can
 * live.
 *
 * EmailTemplate.body and SequenceStep.body are plain text by schema contract ("Plain-text
 * body; supports {{placeholders}} rendered at send time"), and services/email.ts puts them
 * in the text/plain part. An `<img>` means nothing there: the recipient would literally
 * read `<img src="…">` in their inbox. So the pixel goes here instead, and the text/plain
 * part still goes out unchanged — a text-only client sees exactly what it saw before open
 * tracking existed.
 *
 * The body is ESCAPED rather than passed through: it is plain text, so a `<` or an `&` in
 * it is content, not markup. The unsubscribe URL is the one thing turned back into real
 * markup — ФЗ-38 art. 18 wants a working opt-out in the message the recipient actually
 * reads, and a bare URL is not clickable in every HTML client.
 *
 * ФЗ-152 «О персональных данных» — an open event IS processing of personal data: it ties a
 * named contact to a timestamp and hands our server their IP and mail-client user agent at
 * fetch time. It must be disclosed in docs/privacy-policy-ru.md and
 * docs/privacy-policy-en.md (data processed + purpose) BEFORE the first tracked message
 * goes out, and it rides on the same consent record as the mailing itself (ФЗ-38 art. 18),
 * which processEnrollment re-checks immediately before every send — so a contact who never
 * consented never receives a message carrying this pixel. Only EmailSend.opened_at is
 * stored; services/open-tracking.ts owns that write and the rest of that reasoning.
 */
export function buildTrackedHtmlBody(
  body: string,
  unsubscribeUrl: string,
  pixelUrl: string,
): string {
  const anchor = `<a href="${escapeHtml(unsubscribeUrl)}">${escapeHtml(unsubscribeUrl)}</a>`;
  const rendered = (unsubscribeUrl === '' ? [body] : body.split(unsubscribeUrl))
    .map((part) => escapeHtml(part).replace(/\r\n|\r|\n/g, '<br />\n'))
    .join(anchor);

  // 1x1, empty alt, no dimensions to guess at: the pixel must never draw a broken-image
  // icon or announce itself to a screen reader.
  const pixel = `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;

  return `<!doctype html>\n<html><head><meta charset="utf-8" /></head><body>${rendered}${pixel}</body></html>`;
}

/** A step's content comes either from its template or from its inline subject/body pair. */
export function resolveStepContent(step: {
  subject: string | null;
  body: string | null;
  template: { subject: string; body: string } | null;
}): { subject: string; body: string } | null {
  if (step.template) {
    return { subject: step.template.subject, body: step.template.body };
  }

  if (step.subject && step.body) {
    return { subject: step.subject, body: step.body };
  }

  return null;
}

function assertStepContent(input: SequenceStepInput): void {
  const hasTemplate = Boolean(input.template_id);
  const hasInline = Boolean(input.subject && input.body);
  if (!hasTemplate && !hasInline) {
    throw new InvalidSequenceStepError();
  }
}

async function assertTemplateInOrg(templateId: string, organizationId: string): Promise<void> {
  const template = await db.emailTemplate.findFirst({
    where: { id: templateId, organization_id: organizationId },
    select: { id: true },
  });

  if (!template) {
    throw new EmailTemplateNotFoundError();
  }
}

async function loadSequence(
  sequenceId: string,
  organizationId: string,
): Promise<{ id: string; status: SequenceStatus }> {
  const sequence = await db.sequence.findFirst({
    where: { id: sequenceId, organization_id: organizationId },
    select: { id: true, status: true },
  });

  if (!sequence) {
    throw new SequenceNotFoundError();
  }

  return sequence;
}

// ─── Sequence CRUD ────────────────────────────────────────────────────────────

export async function listSequences(
  organizationId: string,
  options: { status?: SequenceStatus; page?: number; perPage?: number } = {},
): Promise<{ data: unknown[]; total: number }> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 25;

  const where: Prisma.SequenceWhereInput = {
    organization_id: organizationId,
    ...(options.status ? { status: options.status } : {}),
  };

  const [data, total] = await Promise.all([
    db.sequence.findMany({
      where,
      select: SEQUENCE_SELECT,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.sequence.count({ where }),
  ]);

  return { data, total };
}

export async function getSequence(sequenceId: string, organizationId: string): Promise<unknown> {
  const sequence = await db.sequence.findFirst({
    where: { id: sequenceId, organization_id: organizationId },
    select: SEQUENCE_SELECT,
  });

  if (!sequence) {
    throw new SequenceNotFoundError();
  }

  // Steps carry their own organization_id — filter on it directly rather than trusting the
  // parent join. A nested `where` on the relation is not the tenant boundary.
  const [steps, activeEnrollments] = await Promise.all([
    db.sequenceStep.findMany({
      where: { organization_id: organizationId, sequence_id: sequenceId },
      select: STEP_SELECT,
      orderBy: { position: 'asc' },
    }),
    db.sequenceEnrollment.count({
      where: {
        organization_id: organizationId,
        sequence_id: sequenceId,
        status: SequenceEnrollmentStatus.active,
      },
    }),
  ]);

  return { ...sequence, steps, active_enrollments: activeEnrollments };
}

export async function createSequence(input: CreateSequenceInput): Promise<unknown> {
  const steps = input.steps ?? [];

  if (steps.length > MAX_STEPS_PER_SEQUENCE) {
    throw new SequenceStepLimitError();
  }

  for (const step of steps) {
    assertStepContent(step);
  }

  for (const step of steps) {
    if (step.template_id) {
      await assertTemplateInOrg(step.template_id, input.organizationId);
    }
  }

  const sequence = await db.sequence.create({
    data: {
      organization_id: input.organizationId,
      created_by: input.createdBy ?? undefined,
      name: input.name,
      description: input.description ?? undefined,
      status: input.status ?? SequenceStatus.draft,
    },
    select: SEQUENCE_SELECT,
  });

  if (steps.length > 0) {
    await db.sequenceStep.createMany({
      data: steps.map((step, index) => ({
        sequence_id: sequence.id,
        organization_id: input.organizationId,
        position: index,
        delay_days: step.delay_days ?? 0,
        template_id: step.template_id ?? null,
        subject: step.subject ?? null,
        body: step.body ?? null,
      })),
    });
  }

  return getSequence(sequence.id, input.organizationId);
}

export async function updateSequence(
  sequenceId: string,
  organizationId: string,
  patch: UpdateSequenceInput,
): Promise<unknown> {
  await loadSequence(sequenceId, organizationId);

  const data: Prisma.SequenceUpdateManyMutationInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.status !== undefined) data.status = patch.status;

  await db.sequence.updateMany({
    where: { id: sequenceId, organization_id: organizationId },
    data,
  });

  return getSequence(sequenceId, organizationId);
}

/**
 * DELETE is an archive, matching how contacts behave in this codebase. A sequence is the
 * parent of an EmailSend ledger that has to survive for the consent audit trail, so it is
 * never actually removed. Archiving also cancels the enrollments still in flight — they
 * would otherwise sit active forever behind a sequence the tick refuses to process.
 */
export async function archiveSequence(
  sequenceId: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<{ id: string; status: SequenceStatus; cancelled_enrollments: number }> {
  await loadSequence(sequenceId, organizationId);

  const cancelled = await db.$transaction(async (tx) => {
    await tx.sequence.updateMany({
      where: { id: sequenceId, organization_id: organizationId },
      data: { status: SequenceStatus.archived },
    });

    const result = await tx.sequenceEnrollment.updateMany({
      where: {
        organization_id: organizationId,
        sequence_id: sequenceId,
        status: SequenceEnrollmentStatus.active,
      },
      data: {
        status: SequenceEnrollmentStatus.cancelled,
        next_send_at: null,
        completed_at: now,
      },
    });

    return result.count;
  });

  return { id: sequenceId, status: SequenceStatus.archived, cancelled_enrollments: cancelled };
}

// ─── Step CRUD ────────────────────────────────────────────────────────────────

export async function listSteps(sequenceId: string, organizationId: string): Promise<unknown[]> {
  await loadSequence(sequenceId, organizationId);

  return db.sequenceStep.findMany({
    where: { organization_id: organizationId, sequence_id: sequenceId },
    select: STEP_SELECT,
    orderBy: { position: 'asc' },
  });
}

export async function addStep(
  sequenceId: string,
  organizationId: string,
  input: SequenceStepInput,
): Promise<unknown> {
  await loadSequence(sequenceId, organizationId);
  assertStepContent(input);

  if (input.template_id) {
    await assertTemplateInOrg(input.template_id, organizationId);
  }

  const existing = await db.sequenceStep.count({
    where: { organization_id: organizationId, sequence_id: sequenceId },
  });

  if (existing >= MAX_STEPS_PER_SEQUENCE) {
    throw new SequenceStepLimitError();
  }

  const last = await db.sequenceStep.findFirst({
    where: { organization_id: organizationId, sequence_id: sequenceId },
    select: { position: true },
    orderBy: { position: 'desc' },
  });

  return db.sequenceStep.create({
    data: {
      sequence_id: sequenceId,
      organization_id: organizationId,
      position: last ? last.position + 1 : 0,
      delay_days: input.delay_days ?? 0,
      template_id: input.template_id ?? null,
      subject: input.subject ?? null,
      body: input.body ?? null,
    },
    select: STEP_SELECT,
  });
}

export async function updateStep(
  stepId: string,
  organizationId: string,
  patch: SequenceStepPatch,
): Promise<unknown> {
  const step = await db.sequenceStep.findFirst({
    where: { id: stepId, organization_id: organizationId },
    select: { id: true, template_id: true, subject: true, body: true },
  });

  if (!step) {
    throw new SequenceStepNotFoundError();
  }

  const merged: SequenceStepInput = {
    template_id: patch.template_id !== undefined ? patch.template_id : step.template_id,
    subject: patch.subject !== undefined ? patch.subject : step.subject,
    body: patch.body !== undefined ? patch.body : step.body,
  };
  assertStepContent(merged);

  if (patch.template_id) {
    await assertTemplateInOrg(patch.template_id, organizationId);
  }

  // Unchecked variant: `template_id` is a relation scalar and is absent from the checked
  // UpdateManyMutationInput.
  const data: Prisma.SequenceStepUncheckedUpdateManyInput = {};
  if (patch.delay_days !== undefined) data.delay_days = patch.delay_days;
  if (patch.template_id !== undefined) data.template_id = patch.template_id;
  if (patch.subject !== undefined) data.subject = patch.subject;
  if (patch.body !== undefined) data.body = patch.body;

  await db.sequenceStep.updateMany({
    where: { id: stepId, organization_id: organizationId },
    data,
  });

  return db.sequenceStep.findFirst({
    where: { id: stepId, organization_id: organizationId },
    select: STEP_SELECT,
  });
}

/**
 * Delete a step and close the gap it leaves, so positions stay contiguous. Enrollments
 * already past the deleted position keep walking forward from wherever they are — the send
 * loop looks for "the first step at or after current_step", so a shifted numbering cannot
 * strand anyone.
 */
export async function deleteStep(stepId: string, organizationId: string): Promise<{ id: string }> {
  const step = await db.sequenceStep.findFirst({
    where: { id: stepId, organization_id: organizationId },
    select: { id: true, sequence_id: true, position: true },
  });

  if (!step) {
    throw new SequenceStepNotFoundError();
  }

  await db.$transaction(async (tx) => {
    await tx.sequenceStep.deleteMany({
      where: { id: stepId, organization_id: organizationId },
    });

    await tx.sequenceStep.updateMany({
      where: {
        organization_id: organizationId,
        sequence_id: step.sequence_id,
        position: { gt: step.position },
      },
      data: { position: { decrement: 1 } },
    });
  });

  return { id: stepId };
}

/**
 * Reorder by listing every step id in its new order. `position` is deliberately not unique
 * in the schema, so this needs no temporary-position dance.
 */
export async function reorderSteps(
  sequenceId: string,
  organizationId: string,
  orderedStepIds: string[],
): Promise<unknown[]> {
  await loadSequence(sequenceId, organizationId);

  const steps = await db.sequenceStep.findMany({
    where: { organization_id: organizationId, sequence_id: sequenceId },
    select: { id: true },
  });

  const existing = new Set(steps.map((step) => step.id));
  const requested = new Set(orderedStepIds);

  if (
    requested.size !== orderedStepIds.length ||
    existing.size !== requested.size ||
    orderedStepIds.some((id) => !existing.has(id))
  ) {
    throw new InvalidStepOrderError();
  }

  await db.$transaction(async (tx) => {
    for (const [index, stepId] of orderedStepIds.entries()) {
      await tx.sequenceStep.updateMany({
        where: { id: stepId, organization_id: organizationId, sequence_id: sequenceId },
        data: { position: index },
      });
    }
  });

  return listSteps(sequenceId, organizationId);
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

/** Turn a consent refusal into the typed error the API surfaces. */
function consentRefusalToError(reason: string, message: string): Error {
  switch (reason) {
    case 'CONTACT_NOT_FOUND':
      return new SequenceContactNotFoundError(message);
    case 'CONTACT_UNSUBSCRIBED':
      return new ContactUnsubscribedError(message);
    case 'CONTACT_NO_EMAIL':
      return new ContactHasNoEmailError(message);
    default:
      return new MarketingConsentRequiredError(message);
  }
}

/**
 * Enroll one contact.
 *
 * Refuses — never silently skips — a contact who has not consented or who has
 * unsubscribed. The operator has to know why nothing was mailed, and "consent missing" is
 * the answer they need in order to go and obtain it.
 */
export async function enrollContact(input: {
  sequenceId: string;
  contactId: string;
  organizationId: string;
  enrolledBy?: string | null;
  now?: Date;
}): Promise<unknown> {
  const now = input.now ?? new Date();
  const sequence = await loadSequence(input.sequenceId, input.organizationId);

  if (sequence.status === SequenceStatus.archived) {
    throw new SequenceNotEnrollableError();
  }

  // ФЗ-38 gate #1 of 2. The second is in the send path, because this answer expires.
  const decision = await canSendMarketingEmail(input.contactId, input.organizationId);
  if (!decision.allowed) {
    throw consentRefusalToError(decision.reason, decision.message);
  }

  const firstStep = await db.sequenceStep.findFirst({
    where: { organization_id: input.organizationId, sequence_id: input.sequenceId },
    select: { position: true, delay_days: true },
    orderBy: { position: 'asc' },
  });

  if (!firstStep) {
    throw new SequenceHasNoStepsError();
  }

  const enrollmentData = {
    status: SequenceEnrollmentStatus.active,
    current_step: firstStep.position,
    next_send_at: addDays(now, firstStep.delay_days),
    completed_at: null,
  };

  try {
    return await db.sequenceEnrollment.create({
      data: {
        sequence_id: input.sequenceId,
        contact_id: input.contactId,
        organization_id: input.organizationId,
        enrolled_by: input.enrolledBy ?? undefined,
        ...enrollmentData,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    // @@unique([sequence_id, contact_id]) — a row already exists for this pair.
    const existing = await db.sequenceEnrollment.findFirst({
      where: {
        organization_id: input.organizationId,
        sequence_id: input.sequenceId,
        contact_id: input.contactId,
      },
      select: { id: true, status: true },
    });

    if (!existing || existing.status === SequenceEnrollmentStatus.active) {
      throw new AlreadyEnrolledError();
    }

    // The previous run ended (completed / cancelled / unsubscribed / failed) and consent
    // has since been re-established — the check above just passed — so restart them.
    await db.sequenceEnrollment.updateMany({
      where: { id: existing.id, organization_id: input.organizationId },
      data: { ...enrollmentData, enrolled_by: input.enrolledBy ?? undefined, enrolled_at: now },
    });

    return db.sequenceEnrollment.findFirst({
      where: { id: existing.id, organization_id: input.organizationId },
    });
  }
}

/**
 * Bulk enroll. Every contact is decided independently and refusals come back itemised, so
 * the operator sees exactly which contacts need consent collected.
 */
export async function enrollContacts(input: {
  sequenceId: string;
  contactIds: string[];
  organizationId: string;
  enrolledBy?: string | null;
  now?: Date;
}): Promise<{ enrolled: unknown[]; refused: EnrollmentRefusal[] }> {
  const enrolled: unknown[] = [];
  const refused: EnrollmentRefusal[] = [];

  for (const contactId of input.contactIds.slice(0, MAX_BULK_ENROLL)) {
    try {
      enrolled.push(
        await enrollContact({
          sequenceId: input.sequenceId,
          contactId,
          organizationId: input.organizationId,
          enrolledBy: input.enrolledBy,
          now: input.now,
        }),
      );
    } catch (error) {
      // A missing sequence is not a per-contact problem — it fails the whole call.
      if (error instanceof SequenceNotFoundError || error instanceof SequenceNotEnrollableError) {
        throw error;
      }

      const code = (error as { code?: string }).code ?? 'ENROLLMENT_FAILED';
      const message = error instanceof Error ? error.message : 'Enrollment failed';
      refused.push({ contact_id: contactId, code, message });
    }
  }

  return { enrolled, refused };
}

/** Stop an in-flight enrollment. Idempotent — a terminal enrollment is returned unchanged. */
export async function unenrollContact(
  enrollmentId: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<unknown> {
  const enrollment = await db.sequenceEnrollment.findFirst({
    where: { id: enrollmentId, organization_id: organizationId },
    select: { id: true, status: true },
  });

  if (!enrollment) {
    throw new EnrollmentNotFoundError();
  }

  if (enrollment.status !== SequenceEnrollmentStatus.active) {
    return db.sequenceEnrollment.findFirst({
      where: { id: enrollmentId, organization_id: organizationId },
    });
  }

  await db.sequenceEnrollment.updateMany({
    where: {
      id: enrollmentId,
      organization_id: organizationId,
      status: SequenceEnrollmentStatus.active,
    },
    data: {
      status: SequenceEnrollmentStatus.cancelled,
      next_send_at: null,
      completed_at: now,
    },
  });

  return db.sequenceEnrollment.findFirst({
    where: { id: enrollmentId, organization_id: organizationId },
  });
}

export async function listEnrollments(
  sequenceId: string,
  organizationId: string,
  options: { status?: SequenceEnrollmentStatus; page?: number; perPage?: number } = {},
): Promise<{ data: unknown[]; total: number }> {
  await loadSequence(sequenceId, organizationId);

  const page = options.page ?? 1;
  const perPage = options.perPage ?? 50;

  const where: Prisma.SequenceEnrollmentWhereInput = {
    organization_id: organizationId,
    sequence_id: sequenceId,
    ...(options.status ? { status: options.status } : {}),
  };

  const [rows, total] = await Promise.all([
    db.sequenceEnrollment.findMany({
      where,
      select: {
        id: true,
        sequence_id: true,
        contact_id: true,
        organization_id: true,
        status: true,
        current_step: true,
        next_send_at: true,
        enrolled_by: true,
        enrolled_at: true,
        completed_at: true,
        updated_at: true,
        contact: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            company: true,
            email: true,
            marketing_consent: true,
            unsubscribed_at: true,
          },
        },
      },
      orderBy: { enrolled_at: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.sequenceEnrollment.count({ where }),
  ]);

  const data = rows.map((row) => ({
    ...row,
    contact: row.contact
      ? { ...row.contact, email: decryptField(row.contact.email ?? undefined) ?? null }
      : null,
  }));

  return { data, total };
}

// ─── The scheduler tick ───────────────────────────────────────────────────────

/**
 * One pass over everything that is due. Called from the existing 60 s loop in
 * services/scheduler.ts — this file installs no timer of its own.
 *
 * Each enrollment is processed inside its own try/catch: one contact's bad address, dead
 * provider or malformed step must never stop the rest of the mailing.
 */
export async function runSequenceTick(now: Date = new Date()): Promise<SequenceTickSummary> {
  const summary: SequenceTickSummary = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    unsubscribed: 0,
    completed: 0,
  };

  const dueWhere: Prisma.SequenceEnrollmentWhereInput = {
    status: SequenceEnrollmentStatus.active,
    next_send_at: { lte: now },
    // Only active sequences mail. Paused ones hold their enrollments in place.
    sequence: { status: SequenceStatus.active },
  };

  const dueRows = await db.sequenceEnrollment.findMany({
    where: dueWhere,
    select: { organization_id: true },
    orderBy: { next_send_at: 'asc' },
    take: SEQUENCE_TICK_SCAN_SIZE,
  });

  const organizationIds = [...new Set(dueRows.map((row) => row.organization_id))];

  for (const organizationId of organizationIds) {
    const candidates: DueEnrollment[] = await db.sequenceEnrollment.findMany({
      where: { ...dueWhere, organization_id: organizationId },
      select: {
        id: true,
        organization_id: true,
        sequence_id: true,
        contact_id: true,
        current_step: true,
      },
      orderBy: { next_send_at: 'asc' },
      take: SEQUENCE_TICK_BATCH_SIZE,
    });

    for (const candidate of candidates) {
      summary.processed += 1;
      try {
        const outcome = await processEnrollment(candidate, now);
        summary[outcome] += 1;
      } catch (error) {
        // Isolation is the point: the next contact still gets their message.
        summary.failed += 1;
        console.error('[sequences] enrollment tick failed', error);
      }
    }
  }

  return summary;
}

async function processEnrollment(
  candidate: DueEnrollment,
  now: Date,
): Promise<EnrollmentOutcome> {
  // Atomic claim: whoever flips next_send_at owns this enrollment for the lease window.
  const claim = await db.sequenceEnrollment.updateMany({
    where: {
      id: candidate.id,
      organization_id: candidate.organization_id,
      status: SequenceEnrollmentStatus.active,
      next_send_at: { lte: now },
    },
    data: { next_send_at: new Date(now.getTime() + SEQUENCE_SEND_LEASE_MS) },
  });

  if (claim.count === 0) {
    return 'skipped';
  }

  // ФЗ-38 gate #2 of 2, and the one that matters most: consent is re-read from the
  // database immediately before THIS message goes out. The contact may have unsubscribed
  // any time since enrollment.
  const decision = await canSendMarketingEmail(candidate.contact_id, candidate.organization_id);
  if (!decision.allowed) {
    const status =
      decision.reason === 'CONTACT_UNSUBSCRIBED' || decision.reason === 'MARKETING_CONSENT_MISSING'
        ? SequenceEnrollmentStatus.unsubscribed
        : SequenceEnrollmentStatus.failed;

    await db.sequenceEnrollment.updateMany({
      where: { id: candidate.id, organization_id: candidate.organization_id },
      data: { status, next_send_at: null, completed_at: now },
    });

    return status === SequenceEnrollmentStatus.unsubscribed ? 'unsubscribed' : 'failed';
  }

  // "First step at or after current_step" — tolerates gaps left by an edited sequence.
  const step = (await db.sequenceStep.findFirst({
    where: {
      organization_id: candidate.organization_id,
      sequence_id: candidate.sequence_id,
      position: { gte: candidate.current_step },
    },
    select: STEP_SEND_SELECT,
    orderBy: { position: 'asc' },
  })) as StepRow | null;

  if (!step) {
    await db.sequenceEnrollment.updateMany({
      where: { id: candidate.id, organization_id: candidate.organization_id },
      data: {
        status: SequenceEnrollmentStatus.completed,
        next_send_at: null,
        completed_at: now,
      },
    });
    return 'completed';
  }

  const content = resolveStepContent(step);
  if (!content) {
    // Misconfigured step. Record it in the ledger anyway so the failure is visible.
    await db.emailSend.create({
      data: {
        organization_id: candidate.organization_id,
        enrollment_id: candidate.id,
        step_id: step.id,
        contact_id: candidate.contact_id,
        template_id: step.template_id ?? undefined,
        subject: step.subject ?? '(no subject)',
        status: EmailSendStatus.failed,
        error_message: 'Step has neither a template nor an inline subject/body pair',
        open_token: generateOpenToken(),
      },
    });

    await db.sequenceEnrollment.updateMany({
      where: { id: candidate.id, organization_id: candidate.organization_id },
      data: { status: SequenceEnrollmentStatus.failed, next_send_at: null, completed_at: now },
    });

    return 'failed';
  }

  const token = await ensureUnsubscribeToken(
    decision.contact.id,
    candidate.organization_id,
    decision.contact.unsubscribe_token,
  );
  const unsubscribeUrl = buildUnsubscribeUrl(token);
  const vars = buildTemplateVars(decision.contact, unsubscribeUrl);
  const subject = renderTemplate(content.subject, vars);
  const body = withUnsubscribeFooter(renderTemplate(content.body, vars), unsubscribeUrl);

  // Minted once, here: the token stored on the ledger row and the token embedded in the
  // pixel URL have to be the same string, or the endpoint validates a token no message ever
  // carried and opened_at stays unreachable.
  const openToken = generateOpenToken();

  // The ledger row is written BEFORE the provider call, so an attempt that dies in flight
  // still leaves evidence of what was tried.
  const send = await db.emailSend.create({
    data: {
      organization_id: candidate.organization_id,
      enrollment_id: candidate.id,
      step_id: step.id,
      contact_id: candidate.contact_id,
      template_id: step.template_id ?? undefined,
      subject,
      status: EmailSendStatus.queued,
      open_token: openToken,
    },
    select: { id: true },
  });

  // Open tracking is best-effort and NEVER load-bearing. No public base URL configured, a
  // malformed one, anything at all going wrong building the markup — the message still goes
  // out, just without the pixel. Losing a customer's email to save an open statistic would
  // be the far worse trade. See buildTrackedHtmlBody for the ФЗ-152 disclosure obligation.
  let html: string | undefined;
  try {
    const pixelUrl = buildTrackingPixelUrl(openToken);
    if (pixelUrl) {
      html = buildTrackedHtmlBody(body, unsubscribeUrl, pixelUrl);
    }
  } catch (error) {
    html = undefined;
    console.warn('[sequences] open tracking pixel skipped', error);
  }

  const result = await sendEmail(decision.contact.email, subject, body, html);

  if (result.success) {
    await db.emailSend.updateMany({
      where: { id: send.id, organization_id: candidate.organization_id },
      data: {
        status: EmailSendStatus.sent,
        provider_message_id: result.messageId ?? null,
        sent_at: new Date(),
      },
    });

    await advanceEnrollment(candidate, step, now);
    return 'sent';
  }

  await db.emailSend.updateMany({
    where: { id: send.id, organization_id: candidate.organization_id },
    data: {
      status: EmailSendStatus.failed,
      error_message: truncateError(result.errorCode ?? 'SEND_FAILED'),
    },
  });

  // Retry the same step on a backoff; give up on this enrollment after the cap. The
  // enrollment never advances past a step it did not actually deliver.
  const failures = await db.emailSend.count({
    where: {
      organization_id: candidate.organization_id,
      enrollment_id: candidate.id,
      step_id: step.id,
      status: EmailSendStatus.failed,
    },
  });

  if (failures >= MAX_SEND_ATTEMPTS_PER_STEP) {
    await db.sequenceEnrollment.updateMany({
      where: { id: candidate.id, organization_id: candidate.organization_id },
      data: { status: SequenceEnrollmentStatus.failed, next_send_at: null, completed_at: now },
    });
  } else {
    await db.sequenceEnrollment.updateMany({
      where: { id: candidate.id, organization_id: candidate.organization_id },
      data: {
        current_step: step.position,
        next_send_at: new Date(now.getTime() + SEQUENCE_SEND_RETRY_DELAY_MS),
      },
    });
  }

  return 'failed';
}

async function advanceEnrollment(
  candidate: DueEnrollment,
  step: { id: string; position: number },
  now: Date,
): Promise<void> {
  const nextStep = await db.sequenceStep.findFirst({
    where: {
      organization_id: candidate.organization_id,
      sequence_id: candidate.sequence_id,
      position: { gt: step.position },
    },
    select: { position: true, delay_days: true },
    orderBy: { position: 'asc' },
  });

  if (!nextStep) {
    await db.sequenceEnrollment.updateMany({
      where: { id: candidate.id, organization_id: candidate.organization_id },
      data: {
        current_step: step.position + 1,
        status: SequenceEnrollmentStatus.completed,
        next_send_at: null,
        completed_at: now,
      },
    });
    return;
  }

  await db.sequenceEnrollment.updateMany({
    where: { id: candidate.id, organization_id: candidate.organization_id },
    data: {
      current_step: nextStep.position,
      next_send_at: addDays(now, nextStep.delay_days),
    },
  });
}
