import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blindIndex, normalizeBlindIndexValue } from '../../../backend/services/encryption';

const tokenEncryptionKey = 'b'.repeat(32);

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.TOKEN_ENCRYPTION_KEY = tokenEncryptionKey;
});

afterEach(() => {
  process.env = savedEnv;
});

describe('normalizeBlindIndexValue', () => {
  it('lowercases and trims emails', () => {
    expect(normalizeBlindIndexValue('  Ivan.Petrov@Example.RU ', 'email')).toBe('ivan.petrov@example.ru');
  });

  it('folds the Russian +7 / 8 / bare forms onto one canonical string', () => {
    expect(normalizeBlindIndexValue('+7 (999) 123-45-67', 'phone')).toBe('79991234567');
    expect(normalizeBlindIndexValue('8 999 123 45 67', 'phone')).toBe('79991234567');
    expect(normalizeBlindIndexValue('9991234567', 'phone')).toBe('79991234567');
  });

  it('leaves numbers outside the Russian plan as bare digits', () => {
    // 11 digits with a non-RU country code, and an internal extension.
    expect(normalizeBlindIndexValue('+1 (415) 555-0100', 'mobile')).toBe('14155550100');
    expect(normalizeBlindIndexValue('4567', 'phone')).toBe('4567');
  });

  it('returns null for empty, whitespace-only and non-string input', () => {
    expect(normalizeBlindIndexValue('', 'email')).toBeNull();
    expect(normalizeBlindIndexValue('   ', 'email')).toBeNull();
    expect(normalizeBlindIndexValue(null, 'email')).toBeNull();
    expect(normalizeBlindIndexValue(undefined, 'phone')).toBeNull();
    // No digits at all.
    expect(normalizeBlindIndexValue('нет телефона', 'phone')).toBeNull();
  });
});

describe('blindIndex', () => {
  it('produces the same index for +7 and 8 forms of one number', () => {
    const plus7 = blindIndex('+7 999 123-45-67', 'phone');
    const leading8 = blindIndex('8 (999) 123 45 67', 'phone');
    const bare = blindIndex('9991234567', 'phone');

    expect(plus7).toBeTruthy();
    expect(leading8).toBe(plus7);
    expect(bare).toBe(plus7);
  });

  it('ignores punctuation and spacing in phone numbers', () => {
    expect(blindIndex('+7(999)123-45-67', 'mobile')).toBe(blindIndex('+7 999 123 45 67', 'mobile'));
  });

  it('is case-insensitive and whitespace-insensitive for emails', () => {
    const canonical = blindIndex('ivan@example.ru', 'email');

    expect(canonical).toBeTruthy();
    expect(blindIndex('IVAN@EXAMPLE.RU', 'email')).toBe(canonical);
    expect(blindIndex('  Ivan@Example.Ru  ', 'email')).toBe(canonical);
  });

  it('returns a 64-character lowercase hex digest', () => {
    expect(blindIndex('ivan@example.ru', 'email')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null for empty, whitespace-only and non-string input', () => {
    expect(blindIndex('', 'email')).toBeNull();
    expect(blindIndex('   ', 'email')).toBeNull();
    expect(blindIndex(null, 'phone')).toBeNull();
    expect(blindIndex(undefined, 'mobile')).toBeNull();
  });

  it('separates the key per kind, so one number indexes differently per column', () => {
    const asPhone = blindIndex('+79991234567', 'phone');
    const asMobile = blindIndex('+79991234567', 'mobile');

    expect(asPhone).toBeTruthy();
    expect(asMobile).toBeTruthy();
    expect(asMobile).not.toBe(asPhone);
  });

  it('produces different indexes for different values', () => {
    expect(blindIndex('ivan@example.ru', 'email')).not.toBe(blindIndex('petr@example.ru', 'email'));
    expect(blindIndex('+79991234567', 'phone')).not.toBe(blindIndex('+79991234568', 'phone'));
  });

  it('gives two organizations the same index for the same phone number', () => {
    // Expected and by design: the index is deterministic deployment-wide. Tenant
    // isolation comes from the organization_id filter on every query that reads
    // these columns, never from the index value itself.
    const orgAContactPhone = '+7 (999) 123-45-67';
    const orgBContactPhone = '8 999 123 45 67';

    expect(blindIndex(orgBContactPhone, 'phone')).toBe(blindIndex(orgAContactPhone, 'phone'));
  });

  it('changes with the server secret', () => {
    const withFirstKey = blindIndex('+79991234567', 'phone');

    process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(32);
    expect(blindIndex('+79991234567', 'phone')).not.toBe(withFirstKey);
  });

  it('returns null instead of throwing when no server secret is configured', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.JWT_SECRET;

    expect(blindIndex('ivan@example.ru', 'email')).toBeNull();
    expect(blindIndex('+79991234567', 'phone')).toBeNull();
  });
});
