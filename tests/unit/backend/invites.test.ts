import { describe, expect, it } from 'vitest';
import {
  CLAIM_CODE_LENGTH,
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

  it('stores only hashes, and matches them in constant time', () => {
    const token = generateLinkToken();
    const stored = hashSecret(token);

    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token);
    expect(secretMatches(token, stored)).toBe(true);
    expect(secretMatches(generateLinkToken(), stored)).toBe(false);
    // A malformed stored value must be a miss, not a throw from timingSafeEqual.
    expect(secretMatches(token, 'deadbeef')).toBe(false);
  });

  it('normalises a claim code the way a human will paste it', () => {
    expect(normalizeClaimCode('  k7f3-ab ')).toBe('K7F3AB');
    expect(normalizeClaimCode('K7F3AB')).toBe('K7F3AB');
  });

  it('keeps the handoff token distinct from the link token', () => {
    // Different secrets by construction: the handoff travels in a query string
    // to rustore.ru and lands in their logs, so it must not be the string that
    // also opens the invite from scratch.
    expect(generateHandoffToken()).not.toBe(generateLinkToken());
    expect(generateHandoffToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
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
