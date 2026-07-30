/**
 * consent.ts — the ФЗ-38 «О рекламе» marketing-consent ledger.
 *
 * Russian advertising law requires PRIOR consent for an advertising mailing, the fine is
 * assessed PER MESSAGE, and the stored consent record (value + timestamp + how it was
 * obtained) is the operator's only evidence that the mailing was lawful. Article 18 also
 * requires that the recipient can refuse further messages at any moment, which is what the
 * unsubscribe token exists for.
 *
 * `canSendMarketingEmail()` is the single choke point. Every path that puts a marketing
 * message on the wire calls it — at enrollment AND again immediately before each individual
 * send, because weeks can pass between step 1 and step 5 and the contact may have
 * unsubscribed in between. Nothing in this codebase should read `marketing_consent` and
 * decide for itself.
 *
 * Consent lives on the Contact and is org-wide: an unsubscribe stops every sequence in the
 * organization, not just the one whose message triggered it.
 *
 * The two directions are NOT symmetric. Granting is capability-gated
 * (GRANT_CONSENT_CAPABILITY) because it is the act that reverses a refusal; withdrawing is
 * ungated and must stay that way. Opting out is never made harder than opting in.
 */

import crypto from 'node:crypto';
import { SequenceEnrollmentStatus } from '@prisma/client';
import { can, type Capability } from './capabilities';
import { db } from './db';
import { decryptField } from './encryption';
import { ownerVisibilityWhere } from './visibility';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How consent was obtained. Stored verbatim as the evidence trail. */
export const CONSENT_SOURCES = [
  'form',
  'website',
  'import',
  'verbal',
  'contract',
  'event',
  'other',
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const UNSUBSCRIBE_TOKEN_ENTROPY_BYTES = 32;

/**
 * The capability required to GRANT marketing consent — i.e. to write the record that makes
 * a mailing lawful, and, on a contact who previously opted out, to clear `unsubscribed_at`
 * and put them back in scope.
 *
 * Why `sequences.manage` and not `contacts.write` (which is what used to guard this by
 * accident): granting consent is not contact bookkeeping, it is an act on the marketing
 * surface with a per-message fine attached. `contacts.write` is held by member (менеджер),
 * head (РОП) and support — roles whose job never involves a mailing, and any one of whom
 * could reverse a recipient's legal refusal by POSTing a free-text `source`.
 * `sequences.manage` is held by owner, admin and marketer: exactly the roles that may
 * create and run the sequences this consent authorises.
 *
 * Why not `org.manage` (owner + admin only, and narrower still): that capability means
 * "organisation settings, join code, plan" — a different axis entirely. Using it would lock
 * out marketer, the one role whose actual job is collecting consent at a form or an event
 * and recording it, leaving a role that may send the mailing but not record the evidence
 * that legalises it. `sequences.manage` is the narrowest capability whose MEANING is this
 * surface.
 *
 * WITHDRAWAL IS DELIBERATELY NOT GATED. ФЗ-38 art. 18 requires refusal to be immediate and
 * effortless; opting out must never be harder than opting in, so `withdrawMarketingConsent`
 * and the public token link stay open to everyone who can reach them.
 */
export const GRANT_CONSENT_CAPABILITY: Capability = 'sequences.manage';

/** base64url alphabet, length-bounded — cheap rejection before the token reaches the DB. */
const UNSUBSCRIBE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ConsentContactNotFoundError extends Error {
  readonly code = 'CONTACT_NOT_FOUND';

  constructor(message = 'Contact not found') {
    super(message);
    this.name = 'ConsentContactNotFoundError';
  }
}

export class InvalidUnsubscribeTokenError extends Error {
  readonly code = 'INVALID_UNSUBSCRIBE_TOKEN';

  constructor(message = 'Unsubscribe link is invalid or has expired') {
    super(message);
    this.name = 'InvalidUnsubscribeTokenError';
  }
}

/** Raised when a role without GRANT_CONSENT_CAPABILITY tries to record consent. */
export class ConsentGrantForbiddenError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(
    message = 'Recording marketing consent requires a role that manages email sequences',
  ) {
    super(message);
    this.name = 'ConsentGrantForbiddenError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConsentDenialReason =
  | 'CONTACT_NOT_FOUND'
  | 'MARKETING_CONSENT_MISSING'
  | 'CONTACT_UNSUBSCRIBED'
  | 'CONTACT_NO_EMAIL';

/** A contact cleared for marketing mail, with the plaintext address to send to. */
export type MarketingRecipient = {
  id: string;
  organization_id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  unsubscribe_token: string | null;
};

export type ConsentDecision =
  | { allowed: true; contact: MarketingRecipient }
  | { allowed: false; reason: ConsentDenialReason; message: string };

export type ConsentState = {
  contact_id: string;
  marketing_consent: boolean;
  marketing_consent_at: Date | null;
  marketing_consent_source: string | null;
  unsubscribed_at: Date | null;
  /** True when a message may be sent right now (mirrors canSendMarketingEmail). */
  can_send_marketing: boolean;
};

export type ConsentAccessOptions = {
  /**
   * Visibility cone from services/visibility.ts. `null`/omitted means unrestricted
   * (owner/admin); an array restricts the lookup to contacts assigned to or created by
   * those users, so a member cannot touch consent outside their branch.
   */
  accessibleUserIds?: string[] | null;
};

const CONSENT_SELECT = {
  id: true,
  organization_id: true,
  marketing_consent: true,
  marketing_consent_at: true,
  marketing_consent_source: true,
  unsubscribed_at: true,
} as const;

// ─── Tokens ───────────────────────────────────────────────────────────────────

/**
 * Unguessable one-click unsubscribe token. The column has no DB default, so the
 * application generates it; 32 random bytes is far past the point where guessing a live
 * token is meaningful.
 */
export function generateUnsubscribeToken(
  randomSource: (size: number) => Buffer = crypto.randomBytes,
): string {
  return randomSource(UNSUBSCRIBE_TOKEN_ENTROPY_BYTES).toString('base64url');
}

/** Shape check only — says nothing about whether the token exists. */
export function isWellFormedUnsubscribeToken(token: unknown): token is string {
  return typeof token === 'string' && UNSUBSCRIBE_TOKEN_PATTERN.test(token);
}

/**
 * Resolve a token to its contact. Returns null for a malformed or unknown token so the
 * caller can answer identically in both cases and leak nothing.
 *
 * Deliberately NOT org-scoped: the token arrives from an unauthenticated email link and
 * carries no organization. It is globally unique and the organization is read off the row
 * that it resolves to; everything downstream is then scoped to that organization.
 */
export async function validateUnsubscribeToken(token: unknown): Promise<{
  id: string;
  organization_id: string;
  unsubscribed_at: Date | null;
} | null> {
  if (!isWellFormedUnsubscribeToken(token)) {
    return null;
  }

  const contact = await db.contact.findFirst({
    where: { unsubscribe_token: token },
    select: { id: true, organization_id: true, unsubscribed_at: true },
  });

  return contact ?? null;
}

/**
 * Return the contact's unsubscribe token, minting and persisting one if the row predates
 * the consent columns. Every marketing message must carry a working opt-out link, so the
 * send path calls this rather than assuming the token is there.
 */
export async function ensureUnsubscribeToken(
  contactId: string,
  organizationId: string,
  existingToken?: string | null,
): Promise<string> {
  if (existingToken) {
    return existingToken;
  }

  const token = generateUnsubscribeToken();
  await db.contact.updateMany({
    where: { id: contactId, organization_id: organizationId, unsubscribe_token: null },
    data: { unsubscribe_token: token },
  });

  // A concurrent writer may have won the race — re-read so the link we embed is the one
  // that is actually stored.
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: organizationId },
    select: { unsubscribe_token: true },
  });

  return contact?.unsubscribe_token ?? token;
}

/**
 * Where the one-click unsubscribe link points. Falls back to the API base so a
 * misconfigured deployment still produces a link rather than an empty string — a message
 * without a working opt-out is the thing ФЗ-38 fines you for.
 */
export function getUnsubscribeBaseUrl(): string {
  const configured = process.env.PUBLIC_APP_URL?.trim() || process.env.EXPO_PUBLIC_API_URL?.trim();
  return (configured || 'http://localhost:3001')
    .replace(/\/+$/, '')
    // The EXPO_PUBLIC_API_URL fallback already ends in /api/v1 (that is what the mobile
    // client talks to), and buildUnsubscribeUrl appends /api/v1/... itself — which produced
    // /api/v1/api/v1/consent/unsubscribe/<token> and a 404 on every opt-out link. Strip a
    // trailing API prefix so the fallback yields a working URL instead of a dead one; a
    // message whose opt-out 404s is exactly what ФЗ-38 penalises.
    .replace(/\/api\/v\d+$/i, '');
}

export function buildUnsubscribeUrl(token: string): string {
  return `${getUnsubscribeBaseUrl()}/api/v1/consent/unsubscribe/${encodeURIComponent(token)}`;
}

// ─── The choke point ──────────────────────────────────────────────────────────

/**
 * The mandatory `where` fragment for any query that selects marketing recipients in bulk.
 * Mirrors the index `@@index([organization_id, marketing_consent, unsubscribed_at])`.
 */
export function marketingRecipientWhere(organizationId: string): {
  organization_id: string;
  marketing_consent: true;
  unsubscribed_at: null;
} {
  return { organization_id: organizationId, marketing_consent: true, unsubscribed_at: null };
}

/**
 * MAY WE SEND MARKETING MAIL TO THIS CONTACT RIGHT NOW?
 *
 * The one function every send path must call — at enrollment and again immediately before
 * each individual send. Answers "no" unless the contact exists inside this organization,
 * holds consent, has not unsubscribed, and has an address to send to.
 */
export async function canSendMarketingEmail(
  contactId: string,
  organizationId: string,
): Promise<ConsentDecision> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: organizationId },
    select: {
      id: true,
      organization_id: true,
      email: true,
      first_name: true,
      last_name: true,
      company: true,
      marketing_consent: true,
      unsubscribed_at: true,
      unsubscribe_token: true,
    },
  });

  if (!contact) {
    return {
      allowed: false,
      reason: 'CONTACT_NOT_FOUND',
      message: 'Contact not found in this organization',
    };
  }

  // Unsubscribe is checked before consent: a withdrawal outranks a stale consent flag.
  if (contact.unsubscribed_at) {
    return {
      allowed: false,
      reason: 'CONTACT_UNSUBSCRIBED',
      message: 'Contact has unsubscribed from marketing email',
    };
  }

  if (!contact.marketing_consent) {
    return {
      allowed: false,
      reason: 'MARKETING_CONSENT_MISSING',
      message: 'Contact has not given consent to receive advertising email (ФЗ-38)',
    };
  }

  const email = decryptField(contact.email ?? undefined)?.trim();
  if (!email) {
    return {
      allowed: false,
      reason: 'CONTACT_NO_EMAIL',
      message: 'Contact has no email address',
    };
  }

  return {
    allowed: true,
    contact: {
      id: contact.id,
      organization_id: contact.organization_id,
      email,
      first_name: contact.first_name,
      last_name: contact.last_name,
      company: contact.company,
      unsubscribe_token: contact.unsubscribe_token,
    },
  };
}

// ─── Reading and writing the record ───────────────────────────────────────────

async function loadContactForConsent(
  contactId: string,
  organizationId: string,
  options: ConsentAccessOptions = {},
): Promise<{
  id: string;
  organization_id: string;
  marketing_consent: boolean;
  marketing_consent_at: Date | null;
  marketing_consent_source: string | null;
  unsubscribed_at: Date | null;
}> {
  const visibility = ownerVisibilityWhere(options.accessibleUserIds ?? null);

  const contact = await db.contact.findFirst({
    where: {
      id: contactId,
      organization_id: organizationId,
      ...(visibility ?? {}),
    },
    select: CONSENT_SELECT,
  });

  if (!contact) {
    throw new ConsentContactNotFoundError();
  }

  return contact;
}

function toConsentState(contact: {
  id: string;
  marketing_consent: boolean;
  marketing_consent_at: Date | null;
  marketing_consent_source: string | null;
  unsubscribed_at: Date | null;
}): ConsentState {
  return {
    contact_id: contact.id,
    marketing_consent: contact.marketing_consent,
    marketing_consent_at: contact.marketing_consent_at,
    marketing_consent_source: contact.marketing_consent_source,
    unsubscribed_at: contact.unsubscribed_at,
    can_send_marketing: contact.marketing_consent && contact.unsubscribed_at === null,
  };
}

export async function getConsentState(
  contactId: string,
  organizationId: string,
  options: ConsentAccessOptions = {},
): Promise<ConsentState> {
  const contact = await loadContactForConsent(contactId, organizationId, options);
  return toConsentState(contact);
}

/**
 * May this role record consent? The GRANTING direction only — see
 * GRANT_CONSENT_CAPABILITY for why it is gated and why withdrawal is not.
 *
 * Lives here rather than in the controller so the capability choice sits with the ledger it
 * protects, and so both the HTTP gate and the service check ask one question.
 */
export function canGrantMarketingConsent(role: string | null | undefined): boolean {
  return can(role, GRANT_CONSENT_CAPABILITY);
}

/**
 * Record consent. `source` and `consentedAt` ARE the legal evidence — they are stored
 * verbatim and never inferred.
 *
 * Recording consent for a contact who previously unsubscribed clears `unsubscribed_at`:
 * this call represents a fresh, later act of consent, and the new timestamp/source is what
 * evidences it. The caller is responsible for only doing that on a real re-opt-in — which
 * is exactly why `actorRole` is checked here as well as at the route.
 *
 * `actorRole` is checked whenever the KEY IS PRESENT, including when it is explicitly
 * `undefined`: a request-driven caller that forgets to read the role off `request.user`
 * then fails closed rather than granting. Omitting the key entirely marks a call that has
 * no acting user at all (seeds, migrations) and skips the check.
 */
export async function recordMarketingConsent(input: {
  contactId: string;
  organizationId: string;
  source: string;
  consentedAt?: Date;
  accessibleUserIds?: string[] | null;
  actorRole?: string | null;
}): Promise<ConsentState> {
  if ('actorRole' in input && !canGrantMarketingConsent(input.actorRole)) {
    throw new ConsentGrantForbiddenError();
  }

  const contact = await loadContactForConsent(input.contactId, input.organizationId, {
    accessibleUserIds: input.accessibleUserIds,
  });

  const consentedAt = input.consentedAt ?? new Date();

  await db.contact.updateMany({
    where: { id: contact.id, organization_id: input.organizationId },
    data: {
      marketing_consent: true,
      marketing_consent_at: consentedAt,
      marketing_consent_source: input.source,
      unsubscribed_at: null,
    },
  });

  // Mint the opt-out token now, so the very first message can carry a working link.
  await ensureUnsubscribeToken(contact.id, input.organizationId);

  return {
    contact_id: contact.id,
    marketing_consent: true,
    marketing_consent_at: consentedAt,
    marketing_consent_source: input.source,
    unsubscribed_at: null,
    can_send_marketing: true,
  };
}

/**
 * Withdraw consent / unsubscribe. Three things happen together and org-wide:
 *   1. `unsubscribed_at` is stamped and `marketing_consent` is cleared,
 *   2. every ACTIVE enrollment for that contact moves to `unsubscribed`,
 *   3. every future send is refused, because canSendMarketingEmail now says no.
 *
 * Step 3 is the one that actually protects us — 1 and 2 stop the scheduler from even
 * looking at the rows. Withdrawal is idempotent: repeating it is a no-op that reports
 * how many enrollments it stopped (0 the second time).
 */
export async function withdrawMarketingConsent(input: {
  contactId: string;
  organizationId: string;
  withdrawnAt?: Date;
  accessibleUserIds?: string[] | null;
}): Promise<ConsentState & { stopped_enrollments: number }> {
  const contact = await loadContactForConsent(input.contactId, input.organizationId, {
    accessibleUserIds: input.accessibleUserIds,
  });

  return withdrawConsentForContact(contact.id, input.organizationId, input.withdrawnAt);
}

/**
 * Internal withdrawal, past the access check. Used by both the authenticated route and the
 * public token link, so the two can never diverge in what they stop.
 */
async function withdrawConsentForContact(
  contactId: string,
  organizationId: string,
  withdrawnAt: Date = new Date(),
): Promise<ConsentState & { stopped_enrollments: number }> {
  const stopped = await db.$transaction(async (tx) => {
    await tx.contact.updateMany({
      where: { id: contactId, organization_id: organizationId },
      data: { marketing_consent: false, unsubscribed_at: withdrawnAt },
    });

    const cascade = await tx.sequenceEnrollment.updateMany({
      where: {
        organization_id: organizationId,
        contact_id: contactId,
        status: SequenceEnrollmentStatus.active,
      },
      data: {
        status: SequenceEnrollmentStatus.unsubscribed,
        next_send_at: null,
        completed_at: withdrawnAt,
      },
    });

    return cascade.count;
  });

  return {
    contact_id: contactId,
    marketing_consent: false,
    marketing_consent_at: null,
    marketing_consent_source: null,
    unsubscribed_at: withdrawnAt,
    can_send_marketing: false,
    stopped_enrollments: stopped,
  };
}

/**
 * One-click unsubscribe from an email link. Unauthenticated by design — ФЗ-38 art. 18
 * requires refusal to be immediate and effortless, so we do not ask the recipient to log
 * in. Possession of the token is the authorization.
 */
export async function unsubscribeByToken(token: unknown): Promise<{
  contact_id: string;
  organization_id: string;
  already_unsubscribed: boolean;
  stopped_enrollments: number;
  unsubscribed_at: Date;
}> {
  const contact = await validateUnsubscribeToken(token);
  if (!contact) {
    throw new InvalidUnsubscribeTokenError();
  }

  if (contact.unsubscribed_at) {
    return {
      contact_id: contact.id,
      organization_id: contact.organization_id,
      already_unsubscribed: true,
      stopped_enrollments: 0,
      unsubscribed_at: contact.unsubscribed_at,
    };
  }

  const withdrawnAt = new Date();
  const result = await withdrawConsentForContact(contact.id, contact.organization_id, withdrawnAt);

  return {
    contact_id: contact.id,
    organization_id: contact.organization_id,
    already_unsubscribed: false,
    stopped_enrollments: result.stopped_enrollments,
    unsubscribed_at: withdrawnAt,
  };
}
