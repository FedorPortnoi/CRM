/**
 * The client half of the password policy.
 *
 * This file exists because the rule was previously written out three times —
 * website/register.html, src/screens/InviteScreen.tsx and src/app/set-password.tsx —
 * and the third copy had drifted to a bare length check, so every invited
 * employee who chose a weak password was rejected by the server instead and
 * shown a raw English zod string inside a Russian UI.
 *
 * It must stay in step with PasswordSchema in backend/api/routes/auth.ts. The
 * server is still the authority; this only decides what we can reject without a
 * round trip, and what message the user reads when we do.
 */

export const PASSWORD_MIN_LENGTH = 8;

/** bcrypt's Blowfish key schedule reads exactly 72 bytes and ignores the rest. */
export const PASSWORD_MAX_BYTES = 72;

/**
 * UTF-8 byte length without Buffer or TextEncoder.
 *
 * React Native has no Node Buffer and this project ships no polyfill — calling
 * Buffer.byteLength here throws ReferenceError on device. TextEncoder is absent
 * on older Hermes too, so neither is safe. Counting the code points directly is,
 * and it is what actually matters here: Cyrillic is two bytes per character, so
 * a Russian passphrase reaches bcrypt's limit at ~36 characters rather than 72.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Lead of a surrogate pair (emoji, rare CJK): 4 bytes for the pair, and
      // skip its trail so it is not counted twice.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export type PasswordProblem = 'weak' | 'tooLong' | null;

/** Returns null when the password satisfies every rule the server enforces. */
export function checkPassword(password: string): PasswordProblem {
  const strong =
    password.length >= PASSWORD_MIN_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password);

  if (!strong) return 'weak';
  if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) return 'tooLong';
  return null;
}
