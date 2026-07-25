/**
 * contact-search.ts
 *
 * Search helpers for Contact rows whose email/phone/mobile are encrypted at
 * rest (AES-256-GCM).  Ciphertext cannot be matched with LIKE/contains, so an
 * exact lookup goes through the blind-index columns instead: the search term is
 * normalized and HMAC'd exactly the way the stored value was on write, and the
 * resulting hash is compared for equality.
 *
 * Every helper here returns a *fragment* of a Prisma where-clause.  It is the
 * caller's job to AND it with `organization_id` and with the visibility cone —
 * these fragments carry no tenant scope of their own.
 *
 * NOTE: contacts written before the blind-index columns existed have NULL
 * indexes and will not be found by these helpers until the next time they are
 * updated.  There is deliberately no backfill script; re-indexing production
 * rows is an operations task, not something this service does on its own.
 */

import { Prisma } from '@prisma/client';
import { blindIndex } from './encryption';

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const out = value.trim();
  return out.length > 0 ? out : null;
}

/** True when the term is shaped like a full email address, e.g. "ivan@example.ru". */
export function isEmailSearchTerm(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * True when the term is shaped like a phone number: only digits and the usual
 * separators, with enough digits to be a real number rather than a house number
 * or a year that happens to appear in a name search.
 */
export function isPhoneSearchTerm(value: string): boolean {
  const term = value.trim();
  if (!/^[+\d\s().-]+$/.test(term)) {
    return false;
  }

  return term.replace(/\D/g, '').length >= 7;
}

/**
 * Candidate blind-index clauses for a free-text search term.
 *
 * An email-shaped term yields one clause (email_bidx); a phone-shaped term
 * yields two, because phone_bidx and mobile_bidx are keyed separately and the
 * same number therefore hashes differently in each column.  A term that looks
 * like neither yields an empty array, and the caller falls back to plain text
 * search over the unencrypted name/company columns.
 */
export function contactBlindIndexClauses(q: string | null | undefined): Prisma.ContactWhereInput[] {
  const term = trimmed(q);
  if (!term) {
    return [];
  }

  const clauses: Prisma.ContactWhereInput[] = [];

  if (isEmailSearchTerm(term)) {
    const emailBidx = blindIndex(term, 'email');
    if (emailBidx) {
      clauses.push({ email_bidx: emailBidx });
    }
  }

  if (isPhoneSearchTerm(term)) {
    const phoneBidx = blindIndex(term, 'phone');
    if (phoneBidx) {
      clauses.push({ phone_bidx: phoneBidx });
    }

    const mobileBidx = blindIndex(term, 'mobile');
    if (mobileBidx) {
      clauses.push({ mobile_bidx: mobileBidx });
    }
  }

  return clauses;
}

/**
 * Same as contactBlindIndexClauses, collapsed into a single OR fragment.
 * Returns null when the term does not look like an email or a phone number.
 */
export function buildContactBlindIndexWhere(q: string | null | undefined): Prisma.ContactWhereInput | null {
  const clauses = contactBlindIndexClauses(q);
  return clauses.length > 0 ? { OR: clauses } : null;
}

/**
 * Where-fragment for the dedicated `?phone=` filter: match the number against
 * both the phone and the mobile index.  Unlike the free-text path this does not
 * require the term to look like a phone number — the caller already said it is
 * one — but it still returns null when there is no digit to hash.
 */
export function buildContactPhoneSearchWhere(phone: string | null | undefined): Prisma.ContactWhereInput | null {
  const term = trimmed(phone);
  if (!term) {
    return null;
  }

  const clauses: Prisma.ContactWhereInput[] = [];

  const phoneBidx = blindIndex(term, 'phone');
  if (phoneBidx) {
    clauses.push({ phone_bidx: phoneBidx });
  }

  const mobileBidx = blindIndex(term, 'mobile');
  if (mobileBidx) {
    clauses.push({ mobile_bidx: mobileBidx });
  }

  return clauses.length > 0 ? { OR: clauses } : null;
}

/**
 * Where-fragment for an exact email lookup (dedupe checks, import matching).
 * Returns null when the value has no usable normalized form.
 */
export function buildContactEmailSearchWhere(email: string | null | undefined): Prisma.ContactWhereInput | null {
  const emailBidx = blindIndex(trimmed(email), 'email');
  return emailBidx ? { email_bidx: emailBidx } : null;
}
