/**
 * Password policy — the byte cap in particular.
 *
 * This exists because invite-controller-authz.test.ts has a case named
 * "refuses a password longer than the bcrypt-safe cap" that submits a 204-char
 * string. That is caught by the length limit and never exercises the byte rule,
 * so the test asserted a guarantee the code did not provide: PasswordSchema
 * allowed 100 CHARACTERS while bcrypt's Blowfish key schedule reads exactly 72
 * BYTES and silently ignores the rest.
 *
 * The consequence was worst in the product's own language. UTF-8 Cyrillic is two
 * bytes per character, so a Russian passphrase was being truncated at ~36
 * characters — inside a plausible one, and far under the 100 the UI advertised.
 * Two passwords sharing a 72-byte prefix authenticated interchangeably.
 */

import { describe, expect, it } from 'vitest';
import { PasswordSchema } from '../../../backend/api/routes/auth';
import {
  blocklistSize,
  isBlockedPassword,
  normalizeCandidates,
} from '../../../backend/services/password-blocklist';

const BCRYPT_KEY_BYTES = 72;

describe('PasswordSchema', () => {
  it('accepts a password that satisfies every character class', () => {
    // WAS 'Passw0rd!', which normalizes to "password" and is now refused. The
    // fixture was never testing strength — it needed a string that parsed — so
    // it is swapped rather than the rule being weakened. Deliberately not
    // 'Sekretnyj1!' either: "sekretnyj" is exactly the kind of transliteration
    // the Russian half of the list invites, and the day someone adds it, every
    // fixture using it flips red at once and the fix looks broken.
    expect(PasswordSchema.safeParse('Mgla7#kvartira').success).toBe(true);
  });

  it.each([
    ['no lowercase', 'PASSW0RD!'],
    ['no uppercase', 'passw0rd!'],
    ['no digit', 'Password!'],
    ['no symbol', 'Passw0rdd'],
    ['too short', 'Pw0rd!a'],
  ])('rejects a password with %s', (_label, value) => {
    expect(PasswordSchema.safeParse(value).success).toBe(false);
  });

  it('accepts exactly 72 bytes of ASCII', () => {
    const value = `Aa1!${'x'.repeat(BCRYPT_KEY_BYTES - 4)}`;
    expect(Buffer.byteLength(value, 'utf8')).toBe(BCRYPT_KEY_BYTES);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });

  it('rejects 73 bytes of ASCII rather than letting bcrypt drop the tail', () => {
    const value = `Aa1!${'x'.repeat(BCRYPT_KEY_BYTES - 3)}`;
    expect(Buffer.byteLength(value, 'utf8')).toBe(BCRYPT_KEY_BYTES + 1);
    expect(PasswordSchema.safeParse(value).success).toBe(false);
  });

  it('counts Cyrillic as two bytes, so a 40-char Russian passphrase is refused', () => {
    // 36 Cyrillic chars = 72 bytes, + 4 ASCII = 76. Under the old 100-CHARACTER
    // cap this passed, and bcrypt then ignored everything past byte 72.
    const value = `${'Пароль'.repeat(6)}aB1!`;
    expect(value.length).toBeLessThan(100);
    expect(Buffer.byteLength(value, 'utf8')).toBeGreaterThan(BCRYPT_KEY_BYTES);
    expect(PasswordSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a Cyrillic passphrase that fits inside the key', () => {
    const value = `${'Пароль'.repeat(5)}aB1!`; // 30 chars = 60 bytes, + 4 = 64
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(BCRYPT_KEY_BYTES);
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });
});

/**
 * THE BLOCKLIST.
 *
 * Every string below satisfies the length rule and all four character classes,
 * and every one of them was ACCEPTED by register, invite-accept, set-credentials
 * and change-password before this. `Password1!` is not a hypothetical: both
 * signup screens print the rule that produces it, verbatim, in Russian.
 */
describe('PasswordSchema refuses passwords that are on the list', () => {
  it.each([
    ['the canonical minimum-compliant string', 'Password1!'],
    ['the same with a year', 'Password2024!'],
    ['digit leet', 'Passw0rd!'],
    ['symbol leet as well', 'P@ssw0rd!'],
    ['a keyboard walk', 'Qwerty123!'],
    ['the Russian word for password, transliterated', 'Parol123!'],
    ['the RU keyboard walk', 'Yiukeng1!'],
    ['a Russian first name', 'Natasha1!'],
    ['a single repeated letter', 'Aaaaaaa1!'],
    ['an alphabet run', 'Abcdefg1!'],
    ['this product name', 'Chetyrekub1!'],
  ])('refuses %s even though it satisfies every character class', (_label, value) => {
    // Sanity: the string really does clear every SHAPE rule, so the refusal below
    // can only be coming from the membership test. Without this the suite would
    // pass just as well against a typo that made all eleven too short.
    expect(value.length).toBeGreaterThanOrEqual(8);
    expect(/[a-z]/.test(value) && /[A-Z]/.test(value)).toBe(true);
    expect(/[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)).toBe(true);

    expect(PasswordSchema.safeParse(value).success).toBe(false);
  });

  /**
   * The positive controls. Without these, "reject everything" passes the block
   * above, and a normalizer that collapses strong Russian passphrases to two
   * characters would look like a working fix while locking real users out of the
   * one screen where a 400 is a dead end.
   */
  it.each([
    ['a strong ASCII password', 'Mgla7#kvartira'],
    // Mixed, because PasswordSchema's four character classes are ASCII — a
    // Cyrillic-ONLY password is refused by those rules long before the list is
    // consulted, so it cannot be a control for the list.
    ['a strong mixed passphrase', 'Kvartira7#Мгла'],
    ['another one', 'Dlinnyj2#Ключ'],
    ['one whose SUBSTRING is on the list', 'Zaparolim9$tut'],
  ])('still accepts %s', (_label, value) => {
    expect(PasswordSchema.safeParse(value).success).toBe(true);
  });

  it('has actually loaded a list rather than silently failing open', () => {
    // A blocklist that degrades to an empty Set reintroduces the hole with every
    // test above still passing only if they are asserting something else. This is
    // the assertion that notices.
    expect(blocklistSize()).toBeGreaterThan(200);
  });

  /**
   * THE NORMALIZER ORDERING, pinned directly.
   *
   * Folding digit-leet BEFORE dropping the trailing digit run leaves the strip
   * nothing to remove: `Password1!` becomes "passwordii", which is on no list of
   * real passwords, and the whole feature silently does nothing while every
   * "rejects X" test above would still need to be written to notice. Asserted on
   * the normalized value, not on the verdict, so the failure names the cause.
   */
  it.each([
    ['Password1!', 'password'],
    ['Password123!', 'password'],
    ['PASSWORD2024', 'password'],
    ['Qwerty123!', 'qwerty'],
    ['Пароль12!', 'пароль'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCandidates(input)).toContain(expected);
  });

  it('folds symbol leet, which stripping alone would throw away', () => {
    expect(normalizeCandidates('P@ssw0rd!')).toContain('password');
  });

  it('reaches the Cyrillic entries, which stripping Cyrillic would make dead weight', () => {
    // Asserted against isBlockedPassword rather than PasswordSchema, because the
    // schema's four character classes are ASCII and refuse a Cyrillic-only
    // password one clause earlier. The list entry is still worth having: it is
    // what makes `пароль` unusable if those classes are ever widened, and it is
    // the reason the normalizer must not strip Cyrillic.
    expect(isBlockedPassword('Пароль123!')).toBe(true);
    expect(isBlockedPassword('йцукен')).toBe(true);
  });

  it('does not let a short normalized residue trip the repeated-character rule', () => {
    // `Секретный1Пароль!` would normalize to "ii" if Cyrillic were stripped, and
    // "ii" reads as a repeated character. Keeping Cyrillic AND gating the shape
    // heuristics on a minimum length are both required; this asserts the result.
    expect(isBlockedPassword('Секретный1Пароль!')).toBe(false);
  });
});
