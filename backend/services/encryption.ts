import crypto from 'node:crypto';
import { getTokenEncryptionSecret } from '../config/security';

export const ENCRYPTED_FIELD_PREFIX = 'enc:v1:';

// Blind-index kinds map 1:1 onto the Contact columns they index
// (email -> email_bidx, phone -> phone_bidx, mobile -> mobile_bidx).
export type BlindIndexKind = 'email' | 'phone' | 'mobile';

function getFieldEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(getTokenEncryptionSecret()).digest();
}

// Domain-separated key per index kind, derived from the same server secret that
// protects the ciphertext. Separate keys mean a database-read attacker cannot
// correlate one contact's mobile with another contact's phone: the same number
// hashes to different values in phone_bidx and mobile_bidx.
function getBlindIndexKey(kind: BlindIndexKind): Buffer {
  return crypto
    .createHash('sha256')
    .update(getTokenEncryptionSecret())
    .update(`:blind-index:v1:${kind}`)
    .digest();
}

/**
 * Canonical form of a value before it is hashed into a blind index.
 *
 * email  — trimmed and lowercased, so Ivan@Example.RU and ivan@example.ru match.
 * phone/mobile — digits only, then folded onto the Russian numbering plan so the
 * three ways the same number gets typed all collapse to one string:
 *   +7 999 123-45-67 -> 79991234567
 *   8 (999) 123-45-67 -> 79991234567
 *   999 123-45-67     -> 79991234567
 * Anything that does not look like a Russian number (a foreign number with its
 * own country code, an internal extension, …) is left as its bare digits. That
 * is still deterministic, so storage and lookup agree either way.
 *
 * Returns null for a non-string or an input with nothing left after normalizing.
 */
export function normalizeBlindIndexValue(
  value: string | null | undefined,
  kind: BlindIndexKind,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (kind === 'email') {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) {
    return null;
  }

  if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
    return `7${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `7${digits}`;
  }

  return digits;
}

/**
 * Keyed HMAC-SHA256 of a normalized value — the searchable stand-in for a field
 * that is encrypted at rest. Equality lookups (`where: { email_bidx: … }`) work
 * against it; substring search does not, by construction.
 *
 * The index is deterministic across the whole deployment: the same phone number
 * in two different organizations produces the same hash. That is intentional —
 * the tenant boundary is the `organization_id` filter on the query, never the
 * index value. Every read that uses these columns must still be org-scoped.
 *
 * Fail-safe like decryptField: never throws. A missing/unreadable server secret
 * or malformed input yields null, which callers treat as "no index".
 */
export function blindIndex(value: string | null | undefined, kind: BlindIndexKind): string | null {
  try {
    const normalized = normalizeBlindIndexValue(value, kind);
    if (!normalized) {
      return null;
    }

    return crypto.createHmac('sha256', getBlindIndexKey(kind)).update(normalized).digest('hex');
  } catch {
    return null;
  }
}

export function encryptField(value: string): string;
export function encryptField(value: null): null;
export function encryptField(value: undefined): undefined;
export function encryptField(value: string | null | undefined): string | null | undefined;
export function encryptField(value: string | null | undefined): string | null | undefined {
  if (!value || value.startsWith(ENCRYPTED_FIELD_PREFIX)) {
    return value;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getFieldEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_FIELD_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptField(value: string): string;
export function decryptField(value: null): null;
export function decryptField(value: undefined): undefined;
export function decryptField(value: string | null | undefined): string | null | undefined;
export function decryptField(value: string | null | undefined): string | null | undefined {
  if (!value || !value.startsWith(ENCRYPTED_FIELD_PREFIX)) {
    return value;
  }

  try {
    const [ivValue, tagValue, encryptedValue] = value.slice(ENCRYPTED_FIELD_PREFIX.length).split('.');
    if (!ivValue || !tagValue || !encryptedValue) {
      throw new Error('Invalid encrypted field payload');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getFieldEncryptionKey(),
      Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // The prefix is attacker-influenced (e.g. a contact field literally starting with
    // "enc:v1:…", or a bad import) or the encryption key rotated/mismatched. Decryption
    // failure here (bad auth tag, malformed payload, wrong key) must not throw and 500
    // the whole read path — fall back to returning the raw stored value unchanged.
    return value;
  }
}
