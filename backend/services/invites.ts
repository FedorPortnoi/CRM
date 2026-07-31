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
 *     failed. Short means low entropy, so it gets a short life and the tightest
 *     rate limit of the three. It is the floor, not the mechanism.
 *
 *     It is also the RECOVERY credential, and that is a role the other two
 *     cannot fill. See the TTL arithmetic below and the re-mint rule in
 *     controllers/invites.ts: the claim code is the only one of the four that
 *     has never left the invitee's own screen, so it is the only one whose
 *     presentation is evidence that the SAME PERSON is asking again rather than
 *     that a second holder has appeared.
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
 * exactly why its defence is a bounded life and a call budget rather than the
 * hash cost.
 *
 * All four hash columns are also UNIQUE. For the three full-entropy ones that is
 * bookkeeping; for claim_hash it is load-bearing, because the claim-code lookup
 * is unauthenticated and therefore has no organization_id to narrow on. The
 * ONLY thing that ties a typed code to one tenant is that no other tenant holds
 * the same code — so that has to be a constraint the database enforces, not a
 * probability the reader is asked to accept. See the note on the claim branch of
 * `lookup` for what happens if it is ever violated anyway.
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
 * The accept token's life. Minted by `lookup`, spent by `accept` — the invitee
 * is looking at the form in between, so this is minutes, not hours.
 */
export const ACCEPT_TTL_MS = 30 * 60 * 1000;

/**
 * The longest walk from "tapped the link in a messenger" to "the app is open
 * and has called lookup": read the landing page, cross to RuStore or the App
 * Store, download, install, launch, grant whatever the OS asks for. On a phone
 * on mobile data this is the part of the flow that takes real time.
 */
export const INSTALL_BUDGET_MS = 15 * 60 * 1000;

/**
 * ─── THE CLAIM CODE'S LIFE IS DERIVED, AND THE DERIVATION IS THE FIX ────────
 *
 * The claim code's clock starts when the LANDING PAGE OPENS; the accept token's
 * clock starts at LOOKUP, which is always later. Written as two independent
 * constants — 15 minutes and 30 minutes — those two facts silently made the
 * documented recovery path unreachable, and nobody did this arithmetic:
 *
 *   open at t = 0, lookup at t = I (the install, 0 ≤ I ≤ INSTALL_BUDGET)
 *     claim code alive on  [0, CLAIM_TTL)
 *     accept token alive on [I, I + ACCEPT_TTL]
 *
 *   With CLAIM_TTL = 15 and ACCEPT_TTL = 30 the accept token outlives the claim
 *   code for every I ≥ 0. Retype inside 15 minutes and the invite still holds a
 *   live accept token, so the mint is refused (409); wait for that token to
 *   lapse and the code needed to ask again died 15+ minutes earlier (404). The
 *   window was EMPTY, not merely narrow, and no test noticed because no test
 *   ever asked what happens at t = I + ε.
 *
 * Deriving it fixes the arithmetic by construction:
 *
 *   CLAIM_TTL = INSTALL_BUDGET + ACCEPT_TTL = 45 min
 *   ⇒ I + ACCEPT_TTL ≤ INSTALL_BUDGET + ACCEPT_TTL = CLAIM_TTL for all I in
 *     the budget
 *   ⇒ the accept token's ENTIRE life [I, I + ACCEPT_TTL] lies inside the claim
 *     code's life [0, CLAIM_TTL), with CLAIM_TTL − (I + ACCEPT_TTL) = 15 − I
 *     minutes of slack left over after the form has already expired.
 *
 * So at every instant at which an invitee could be sitting in front of a form
 * they can no longer submit, the code that buys them a new one is still alive.
 * That is the whole claim, and it is now an inequality rather than a hope. The
 * second half — that presenting the code is actually ALLOWED to mint again — is
 * the re-mint rule in controllers/invites.ts; either half alone leaves the
 * window empty.
 *
 * COST, stated rather than assumed. Tripling the window triples the number of
 * live 6-character codes in existence at any instant, and a guess is a hit with
 * probability (live codes)/32⁶ = (live codes)/2³⁰ per attempt. The lookup route
 * allows 20 attempts per 15 minutes per IP, so one IP gets 60 attempts across a
 * whole code lifetime: for a tenant population producing ~30 live codes at once
 * that is ~2·10⁻⁶ per IP per window, against ~2·10⁻⁷ before. The defence was
 * never the window — it is the call budget, and now also the UNIQUE constraint
 * on claim_hash, without which "live codes/2³⁰" was not even the right
 * expression because two invites could share one code.
 *
 * An invitee who runs past 45 minutes is not stranded either: the LINK is good
 * for 24 hours, and re-opening the landing page mints a fresh code with a fresh
 * 45 minutes. The claim code is the convenient recovery path, not the only one.
 */
export const CLAIM_TTL_MS = INSTALL_BUDGET_MS + ACCEPT_TTL_MS;

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
