import crypto from 'node:crypto';
import { getTokenEncryptionSecret } from '../config/security';

export const ENCRYPTED_FIELD_PREFIX = 'enc:v1:';

function getFieldEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(getTokenEncryptionSecret()).digest();
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
}
