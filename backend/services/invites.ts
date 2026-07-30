import crypto from 'node:crypto';

/**
 * The secrets behind a co-worker invite link, and the rules for spending them.
 *
 * Pure functions only — no database, no Fastify. Everything here is decidable
 * from its arguments, which is what lets the security properties be tested
 * directly instead of inferred from an integration test that happened to pass.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE SECRETS AND NOT ONE
 * ---------------------------------------------------------------------------
 * One link has to survive three different journeys, and they leak in different
 * places. Using a single token for all three would mean the weakest journey sets
 * the security of the strongest.
 *
 *   LINK TOKEN — 32 bytes. Travels in the URL FRAGMENT (`/i#<token>`), which is
 *     never sent to a server. That keeps it out of nginx access logs, out of
 *     `Referer` headers, and out of the reach of the link-preview crawlers that
 *     fetch every URL the moment it is posted into Telegram or WhatsApp.
 *
 *   HANDOFF TOKEN — 16 bytes, minted only when the landing page opens. This one
 *     rides through the store install: as `?referrerId=` on the RuStore URL, or
 *     through the clipboard on iOS. It is deliberately NOT the link token,
 *     because a query parameter to rustore.ru lands in somebody else's logs and
 *     must not be the credential that also opens the invite from scratch.
 *
 *   CLAIM CODE — 6 characters a human can retype when every automatic path has
 *     failed. Short means low entropy, so it gets the shortest life and the
 *     tightest rate limit of the three. It is the floor, not the mechanism.
 *
 *   ACCEPT TOKEN — 16 bytes, minted ONLY by a successful `lookup` and stored in
 *     its own column. This separation is the correction to a real flaw: the
 *     first version resolved `accept` against the HANDOFF hash, which made the
 *     string sitting in RuStore's access logs and on the iOS clipboard a
 *     complete account-creation credential. A comment claimed rotation made it
 *     dead; rotation happened at `lookup`, i.e. after the install, so it did
 *     not. The handoff can now only be traded for a lookup, and a lookup is what
 *     mints the thing `accept` will take.
 *
 * DELIBERATELY ABSENT: device fingerprinting. An earlier draft matched a
 * landing-page visit to a first app launch on IP + platform to recover the
 * invite after an iOS install, guarded by "only match if exactly one candidate".
 * Behind nginx every request arrives from 127.0.0.1 unless TRUSTED_PROXY is set,
 * so the IP half agreed universally and "exactly one candidate" degraded to
 * "only one invite open anywhere", which for a small tenant is the normal case
 * rather than the rare one — an unauthenticated stranger could poll for an
 * invite and take the account. It was removed rather than repaired: it was the
 * weakest of the four paths and the only one that guessed, and the clipboard
 * plus the typed code already cover iOS.
 *
 * ---------------------------------------------------------------------------
 * ONE-WAY AT REST
 * ---------------------------------------------------------------------------
 * All three are stored as SHA-256, never in plaintext, so reading the Invite
 * table yields nothing redeemable. SHA-256 rather than bcrypt for the same
 * reason api-keys.ts gives: these are full-entropy random strings, not
 * human-chosen passwords, so there is no dictionary to slow down and a fast hash
 * is correct. The claim code is the one that is NOT full entropy, which is
 * exactly why its defence is a 15-minute life and a call budget rather than the
 * hash cost.
 */

/** 32 bytes. The link. */
const LINK_TOKEN_BYTES = 32;
/** 16 bytes. Survives the store install. */
const HANDOFF_TOKEN_BYTES = 16;

/**
 * Unambiguous when read aloud or retyped: no O/0, no I/1/l. A person copying
 * this off one phone onto another is the whole reason it exists.
 */
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CLAIM_CODE_LENGTH = 6;

/** How long the emailed/messaged link stays redeemable. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The claim code's life starts when the landing page is opened, not when the
 * invite is minted: it exists to cover the walk from the browser to the freshly
 * installed app, which is minutes.
 */
export const CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * The accept token's life. Minted by `lookup`, spent by `accept` — the invitee
 * is looking at the form in between, so this is minutes, not hours.
 */
export const ACCEPT_TTL_MS = 30 * 60 * 1000;

export function generateLinkToken(): string {
  return crypto.randomBytes(LINK_TOKEN_BYTES).toString('base64url');
}

export function generateHandoffToken(): string {
  return crypto.randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
}

/**
 * Rejection sampling, not `% alphabet.length`.
 *
 * 256 is not a multiple of 32 for a general alphabet length, and the modulo
 * shortcut skews the distribution toward the first characters. Here the alphabet
 * happens to be exactly 32 so modulo would be uniform — but the alphabet is a
 * constant somebody will edit, and a bias introduced by adding one character to
 * a string is not a bug anyone would catch by reading.
 */
export function generateClaimCode(): string {
  const max = 256 - (256 % CLAIM_ALPHABET.length);
  let out = '';
  while (out.length < CLAIM_CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CLAIM_CODE_LENGTH)) {
      if (byte >= max) continue;
      out += CLAIM_ALPHABET[byte % CLAIM_ALPHABET.length];
      if (out.length === CLAIM_CODE_LENGTH) break;
    }
  }
  return out;
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Constant-time compare over the HASHES.
 *
 * Lookups go through the hash column, so this covers the case where a caller
 * already holds both digests. Comparing raw secrets with `===` would leak length
 * and prefix through timing; comparing digests keeps both operands fixed-length,
 * which is what makes timingSafeEqual usable at all.
 */
export function secretMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Normalised so «k7f3» pasted with a trailing space still redeems. */
export function normalizeClaimCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

// ---------------------------------------------------------------------------
// Redeemability
// ---------------------------------------------------------------------------

export type InviteState = {
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
};

export type InviteRejection =
  | 'expired'
  | 'already_used'
  | 'revoked';

/**
 * The single predicate every entry point asks before doing anything.
 *
 * Returns a REASON rather than a boolean because the caller needs it for the
 * audit log — but see the note in the controller: the reason is written to the
 * audit trail and NOT to the response. A caller who can distinguish "expired"
 * from "never existed" has an oracle for probing which tokens are real.
 */
export function inviteRejection(invite: InviteState, now: Date = new Date()): InviteRejection | null {
  if (invite.revoked_at) return 'revoked';
  if (invite.consumed_at) return 'already_used';
  if (invite.expires_at <= now) return 'expired';
  return null;
}

export function isRedeemable(invite: InviteState, now: Date = new Date()): boolean {
  return inviteRejection(invite, now) === null;
}

// ---------------------------------------------------------------------------
// Link construction
// ---------------------------------------------------------------------------

/**
 * The token goes after `#`, and that placement is the single most important
 * decision in this file.
 *
 * A fragment is never transmitted to the server. Put the token in the path or
 * the query and it is written to nginx's access log in plaintext, attached to
 * outbound `Referer` headers, and handed to every messenger's link-preview
 * crawler. In the fragment, the landing page reads it in JavaScript and POSTs it
 * in a request body, where none of that happens.
 */
export function buildInviteUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/i#${token}`;
}

/**
 * RuStore carries this through the install and hands it back via
 * getInstallReferrer(). It is a query parameter on somebody else's domain, which
 * is exactly why it is the handoff token and not the link token.
 */
export function buildRuStoreUrl(packageName: string, handoff: string): string {
  return `https://www.rustore.ru/catalog/app/${packageName}?referrerId=${encodeURIComponent(handoff)}`;
}

export function buildAppStoreUrl(ascAppId: string): string {
  return `https://apps.apple.com/ru/app/id${ascAppId}`;
}
