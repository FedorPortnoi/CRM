import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPT_TTL_MS,
  CLAIM_CODE_LENGTH,
  CLAIM_TTL_MS,
  INSTALL_BUDGET_MS,
  INVITE_TTL_MS,
  buildInviteUrl,
  buildRuStoreUrl,
  generateClaimCode,
  generateHandoffToken,
  generateLinkToken,
  hashSecret,
  inviteRejection,
  isRedeemable,
  normalizeClaimCode,
  secretMatches,
} from '../../../backend/services/invites';

// ---------------------------------------------------------------------------
// An invite link is a bearer secret whose entire job is to be copied into a
// messenger. These tests pin the properties that decide what a copy is worth:
// where it can be read from, how long it lives, and how many times it works.
//
// An earlier draft also matched a device fingerprint to recover the invite after
// an iOS install. It was removed, not weakened: behind nginx every request
// arrives from the same address unless TRUSTED_PROXY is set, which made its
// "only match if exactly one candidate" guard degrade to "only one invite open
// anywhere" — the normal case for a small tenant, not the rare one.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-30T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invite secrets', () => {
  it('mints link tokens with real entropy and no collisions', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateLinkToken()));
    expect(tokens.size).toBe(500);
    // 32 bytes base64url — 43 chars, no padding, URL-safe.
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('mints claim codes from an unambiguous alphabet', () => {
    for (let i = 0; i < 300; i += 1) {
      const code = generateClaimCode();
      expect(code).toHaveLength(CLAIM_CODE_LENGTH);
      // The point is that a human retypes this off another screen without
      // having to ask which character it is. What creates that problem is a
      // confusable PAIR, so the alphabet drops one of each: O/0 and I/1 are
      // gone. L stays — with 1 absent there is nothing left for it to be
      // mistaken for — which also keeps the alphabet at exactly 32 characters,
      // matching contact-alias.ts.
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
      expect(code).not.toMatch(/[OI01]/);
    }
  });

  it('distributes claim-code characters without modulo bias', () => {
    // 32-character alphabet, 3000 draws: every character should appear. A modulo
    // shortcut over a non-power-of-two alphabet skews toward the front, which
    // this would catch as missing tail characters.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      for (const ch of generateClaimCode()) seen.add(ch);
    }
    expect(seen.size).toBe(32);
  });

  it('stores SHA-256, not a reversible encoding dressed up as one', () => {
    // The shape assertions this test used to make — 64 lowercase hex characters
    // that do not contain the token — are satisfied by ANY 32-byte-wide
    // encoding, including `Buffer.from(secret).toString('hex').padEnd(64,'0')`,
    // which is fully reversible and would leave every invite in the table
    // redeemable by whoever can read it. Only a known-answer vector can tell a
    // one-way function from a codec, so pin the published FIPS 180-4 digests.
    expect(hashSecret('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashSecret('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );

    const token = generateLinkToken();
    const stored = hashSecret(token);

    // Recomputed independently of the module under test.
    expect(stored).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token);

    // Deterministic, and one bit of input changes roughly half the output — an
    // encoding of a 43-character token would instead keep a shared prefix.
    expect(hashSecret(token)).toBe(stored);
    const neighbour = hashSecret(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
    expect(neighbour).not.toBe(stored);
    const sharedPrefix = [...stored].findIndex((ch, i) => ch !== neighbour[i]);
    expect(sharedPrefix).toBeLessThan(8);

    // Fixed width regardless of input length — a codec's output grows with it.
    expect(hashSecret('a')).toHaveLength(64);
    expect(hashSecret('a'.repeat(4096))).toHaveLength(64);
  });

  it('matches through crypto.timingSafeEqual over the digests, never ===', () => {
    // Honest limitation: a wall-clock timing assertion is not reliable on a
    // shared CI box — a JIT warm-up or one GC pause swamps the nanoseconds
    // being measured, and a flaky test is worse than no test. What IS decidable
    // is that the production path calls the constant-time primitive, with the
    // right operands, so a swap to `===` (or to Buffer.equals, or to a
    // short-circuiting loop) turns this red.
    const compare = vi.spyOn(crypto, 'timingSafeEqual');

    const token = generateLinkToken();
    const stored = hashSecret(token);

    expect(secretMatches(token, stored)).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);

    // Both operands are the 32-byte DIGESTS, not the raw secrets: timingSafeEqual
    // throws on unequal lengths, so comparing variable-length plaintext is what
    // forces callers back to `===`.
    const [a, b] = compare.mock.calls[0] as [Buffer, Buffer];
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.toString('hex')).toBe(stored);
    expect(a.toString('hex')).not.toContain(token);

    // A miss goes through the same call — no early return on the first differing
    // byte, which is the leak the primitive exists to close.
    compare.mockClear();
    expect(secretMatches(generateLinkToken(), stored)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);

    // …and the length guard runs BEFORE it, so a malformed stored value is a
    // miss rather than a throw out of timingSafeEqual.
    compare.mockClear();
    expect(secretMatches(token, 'deadbeef')).toBe(false);
    expect(secretMatches(token, '')).toBe(false);
    expect(secretMatches(token, 'not hex at all')).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });

  it('normalises a claim code the way a human will paste it', () => {
    expect(normalizeClaimCode('  k7f3-ab ')).toBe('K7F3AB');
    expect(normalizeClaimCode('K7F3AB')).toBe('K7F3AB');
  });

  it('keeps the handoff token distinct from the link token', () => {
    // Comparing one draw against another (`generateHandoffToken() !==
    // generateLinkToken()`) is two independent CSPRNG samples and cannot fail —
    // it would stay green with both functions returning the identical
    // implementation. What is actually load-bearing is that they are built
    // differently: 16 bytes versus 32, so the string that travels in a query
    // parameter to rustore.ru and lands in their access logs is structurally
    // incapable of being the one that opens the invite from scratch.
    const handoffs = Array.from({ length: 500 }, () => generateHandoffToken());
    const links = Array.from({ length: 500 }, () => generateLinkToken());

    for (const handoff of handoffs) {
      expect(handoff).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(handoff, 'base64url')).toHaveLength(16);
    }
    for (const link of links) {
      expect(link).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(link, 'base64url')).toHaveLength(32);
    }

    // Full entropy on both sides, and no value drawn from one population ever
    // appears in the other.
    expect(new Set(handoffs).size).toBe(500);
    expect(new Set(links).size).toBe(500);
    const linkSet = new Set(links);
    expect(handoffs.filter((handoff) => linkSet.has(handoff))).toEqual([]);
  });

  it('pins how long each secret lives, which is half of what a copy is worth', () => {
    // The header of this file claims these tests decide "how long it lives".
    // Nothing imported the constants, so every one of them survived being
    // widened to a month.
    const MINUTE = 60 * 1000;

    expect(INVITE_TTL_MS).toBe(24 * 60 * MINUTE);
    expect(ACCEPT_TTL_MS).toBe(30 * MINUTE);
    expect(INSTALL_BUDGET_MS).toBe(15 * MINUTE);
    expect(CLAIM_TTL_MS).toBe(45 * MINUTE);

    // Ceilings, so a "just make it a bit longer" edit has to come past a test.
    expect(INVITE_TTL_MS).toBeLessThanOrEqual(24 * 60 * MINUTE);
    expect(CLAIM_TTL_MS).toBeLessThanOrEqual(60 * MINUTE);
    expect(ACCEPT_TTL_MS).toBeLessThanOrEqual(60 * MINUTE);
    expect(INSTALL_BUDGET_MS).toBeLessThanOrEqual(30 * MINUTE);
  });

  it('keeps the accept token’s whole life inside the claim code’s, for every install time', () => {
    // The derivation CLAIM_TTL = INSTALL_BUDGET + ACCEPT_TTL exists to make one
    // inequality true by construction, and asserting the three numbers alone
    // does not state it. The claim code's clock starts when the landing page
    // opens; the accept token's starts at lookup, which is later by the install
    // time I. If the accept token can outlive the claim code, an invitee sits in
    // front of a form they cannot submit holding a code that cannot buy them a
    // new one.
    expect(CLAIM_TTL_MS).toBe(INSTALL_BUDGET_MS + ACCEPT_TTL_MS);

    for (const install of [0, 1, 60_000, INSTALL_BUDGET_MS / 2, INSTALL_BUDGET_MS - 1, INSTALL_BUDGET_MS]) {
      // The form dies at install + ACCEPT_TTL; the recovery code must still be
      // alive then, with slack to spare.
      expect(install + ACCEPT_TTL_MS).toBeLessThanOrEqual(CLAIM_TTL_MS);
    }

    // And the link outlives all of it, so a blown 45 minutes is recoverable by
    // re-opening the landing page rather than by asking for a new invite.
    expect(INVITE_TTL_MS).toBeGreaterThan(CLAIM_TTL_MS);
  });

  it('expires each secret at its own boundary, not a moment after', () => {
    const issued = NOW.getTime();
    const invite = (ttl: number) => ({
      expires_at: new Date(issued + ttl),
      consumed_at: null,
      revoked_at: null,
    });

    for (const ttl of [INVITE_TTL_MS, CLAIM_TTL_MS, ACCEPT_TTL_MS]) {
      expect(isRedeemable(invite(ttl), new Date(issued + ttl - 1))).toBe(true);
      expect(inviteRejection(invite(ttl), new Date(issued + ttl))).toBe('expired');
    }
  });
});

describe('invite link construction', () => {
  it('puts the token in the FRAGMENT, never the path or query', () => {
    // The single most important line in this feature. A fragment is never sent
    // to a server: not to nginx's access log, not in a Referer header, and not
    // to the link-preview crawler that fetches every URL posted to Telegram.
    const url = buildInviteUrl('https://4kub.ru', 'TOKEN123');

    expect(url).toBe('https://4kub.ru/i#TOKEN123');
    const [beforeHash, afterHash] = url.split('#');
    expect(beforeHash).not.toContain('TOKEN123');
    expect(afterHash).toBe('TOKEN123');
    expect(beforeHash).not.toContain('?');
  });

  it('tolerates a base URL with a trailing slash', () => {
    expect(buildInviteUrl('https://4kub.ru/', 'T')).toBe('https://4kub.ru/i#T');
  });

  it('passes the HANDOFF, not the link token, to RuStore', () => {
    const url = buildRuStoreUrl('com.fedorportnoi.crm', 'HAND+OFF/1');
    expect(url).toContain('referrerId=HAND%2BOFF%2F1');
    expect(url).toContain('/catalog/app/com.fedorportnoi.crm');
  });
});

describe('redeemability', () => {
  const base = { expires_at: new Date(NOW.getTime() + 60_000), consumed_at: null, revoked_at: null };

  it('accepts a fresh invite', () => {
    expect(inviteRejection(base, NOW)).toBeNull();
    expect(isRedeemable(base, NOW)).toBe(true);
  });

  it('refuses an expired, consumed or revoked invite', () => {
    expect(inviteRejection({ ...base, expires_at: ago(1) }, NOW)).toBe('expired');
    expect(inviteRejection({ ...base, consumed_at: ago(1) }, NOW)).toBe('already_used');
    expect(inviteRejection({ ...base, revoked_at: ago(1) }, NOW)).toBe('revoked');
  });

  it('treats revocation as decisive even for an otherwise valid invite', () => {
    // Order matters: an owner who revokes wants it dead now, whatever else is
    // true of the row.
    expect(inviteRejection({ ...base, revoked_at: ago(1), consumed_at: null }, NOW)).toBe('revoked');
  });

  it('expires exactly at the boundary, not a moment after', () => {
    expect(inviteRejection({ ...base, expires_at: NOW }, NOW)).toBe('expired');
  });
});
