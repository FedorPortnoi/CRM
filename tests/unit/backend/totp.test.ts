import { describe, expect, it } from 'vitest';
import {
  generateTotpSecret,
  buildOtpauthUrl,
  generateQrCodeDataUrl,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCode,
} from '../../../backend/services/totp';
import { authenticator } from 'otplib';

describe('generateTotpSecret', () => {
  it('returns a base32 string', () => {
    const secret = generateTotpSecret();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(0);
    // otplib's base32 alphabet: A-Z2-7, no padding.
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('is different on every call', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });
});

describe('buildOtpauthUrl', () => {
  it('embeds the secret, account label and issuer', () => {
    const secret = generateTotpSecret();
    const url = buildOtpauthUrl(secret, 'ivan@example.com');

    expect(url.startsWith('otpauth://totp/')).toBe(true);
    expect(url).toContain(`secret=${secret}`);
    // The label and issuer are Cyrillic/percent-encoded — decode before asserting.
    expect(decodeURIComponent(url)).toContain('ivan@example.com');
    expect(decodeURIComponent(url)).toContain('4КУБ CRM');
  });
});

describe('generateQrCodeDataUrl', () => {
  it('returns a PNG data: URL', async () => {
    const secret = generateTotpSecret();
    const otpauthUrl = buildOtpauthUrl(secret, 'ivan@example.com');
    const dataUrl = await generateQrCodeDataUrl(otpauthUrl);

    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // Non-trivial payload, not an empty/placeholder image.
    expect(dataUrl.length).toBeGreaterThan(200);
  });
});

describe('verifyTotpToken', () => {
  it('accepts a currently-valid code', () => {
    const secret = generateTotpSecret();
    const token = authenticator.generate(secret);
    expect(verifyTotpToken(secret, token)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret();
    const validToken = authenticator.generate(secret);
    // Flip the code so it cannot coincidentally equal the valid one.
    const lastDigit = Number(validToken[validToken.length - 1]);
    const wrongToken = `${validToken.slice(0, -1)}${(lastDigit + 1) % 10}`;
    expect(verifyTotpToken(secret, wrongToken)).toBe(false);
  });

  it('rejects a code generated from a different secret', () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const tokenFromB = authenticator.generate(secretB);
    expect(verifyTotpToken(secretA, tokenFromB)).toBe(false);
  });

  it('does not throw on malformed input', () => {
    const secret = generateTotpSecret();
    expect(() => verifyTotpToken(secret, 'not-a-code')).not.toThrow();
    expect(verifyTotpToken(secret, 'not-a-code')).toBe(false);
    expect(verifyTotpToken(secret, '')).toBe(false);
  });
});

describe('generateBackupCodes', () => {
  it('produces the requested count', () => {
    expect(generateBackupCodes(10)).toHaveLength(10);
    expect(generateBackupCodes(3)).toHaveLength(3);
  });

  it('defaults to 10 codes', () => {
    expect(generateBackupCodes()).toHaveLength(10);
  });

  it('formats every code as XXXX-XXXX from the unambiguous alphabet', () => {
    const codes = generateBackupCodes(50);
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      // Never contains the ambiguous characters explicitly excluded.
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it('produces no collisions across a large sample', () => {
    const codes = generateBackupCodes(2000);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe('hashBackupCode', () => {
  it('is deterministic', () => {
    const code = generateBackupCodes(1)[0];
    expect(hashBackupCode(code)).toBe(hashBackupCode(code));
  });

  it('produces a 64-char hex sha256 digest', () => {
    const code = generateBackupCodes(1)[0];
    expect(hashBackupCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes case and whitespace so re-typed input still matches', () => {
    const code = generateBackupCodes(1)[0];
    const messy = `  ${code.toLowerCase()}  `;
    expect(hashBackupCode(messy)).toBe(hashBackupCode(code));
  });

  it('hashes different codes to different digests', () => {
    const [a, b] = generateBackupCodes(2);
    expect(hashBackupCode(a)).not.toBe(hashBackupCode(b));
  });
});
