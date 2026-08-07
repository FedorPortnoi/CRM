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

const BCRYPT_KEY_BYTES = 72;

describe('PasswordSchema', () => {
  it('accepts a password that satisfies every character class', () => {
    expect(PasswordSchema.safeParse('Passw0rd!').success).toBe(true);
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
