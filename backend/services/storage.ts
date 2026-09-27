import fs from 'fs';
import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const UPLOAD_EXPIRES_IN = 300; // 5 minutes

// ─── Local-disk driver ──────────────────────────────────────────────────────
//
// LOCAL_STORAGE_DIR set ⇒ files live on the API host's disk instead of S3 and are
// served by routes/files.ts under `<PUBLIC_APP_URL>/api/files/<key>`. The client
// contract is unchanged: upload-url still returns {upload_url, fields, file_url},
// the app still POSTs a multipart form with those fields ahead of the file, and
// still opens file_url directly. `fields.policy` plays the part of the S3 presigned
// policy — an HMAC over key, type, size cap and expiry, checked by the upload route.

export function isLocalStorage(): boolean {
  return !!process.env.LOCAL_STORAGE_DIR?.trim();
}

function localPublicBase(): string {
  const base = (process.env.PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('LOCAL_STORAGE_DIR needs PUBLIC_APP_URL to build file URLs');
  return `${base}/api/files/`;
}

/** The URL prefix every stored file_url starts with, for whichever driver is active. */
function storagePrefix(): string {
  if (isLocalStorage()) return localPublicBase();
  const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
  return `${endpoint}/${getBucket()}/`;
}

// Exactly the shape buildKey mints. Anything else — traversal, another layout,
// stray characters — is refused before it is ever joined onto a disk path.
const LOCAL_KEY_RE =
  /^uploads\/[0-9a-f-]{36}\/(contact|deal|task|calendar_event)\/[0-9a-f-]{36}-[A-Za-z0-9._-]{0,300}$/;

export function isValidLocalKey(key: string): boolean {
  return LOCAL_KEY_RE.test(key) && !hasTraversalSegment(key);
}

export function localPathForKey(key: string): string {
  if (!isValidLocalKey(key)) throw new Error('invalid storage key');
  const root = path.resolve(process.env.LOCAL_STORAGE_DIR!.trim());
  const full = path.resolve(root, ...key.split('/'));
  if (!full.startsWith(root + path.sep)) throw new Error('invalid storage key');
  return full;
}

function policySecret(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required to sign upload policies');
  // Derived, so an upload policy can never be replayed as anything JWT-shaped.
  return createHmac('sha256', secret).update('4kub-local-upload-policy').digest();
}

export interface UploadPolicy {
  key: string;
  mime: string;
  max: number;
  exp: number; // epoch seconds
}

export function signUploadPolicy(p: UploadPolicy): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  const sig = createHmac('sha256', policySecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The policy when the signature is ours and it has not expired; null otherwise. */
export function verifyUploadPolicy(token: string, now = Date.now()): UploadPolicy | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', policySecret()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadPolicy;
    if (typeof p.key !== 'string' || typeof p.mime !== 'string' || typeof p.max !== 'number' || typeof p.exp !== 'number') {
      return null;
    }
    if (p.exp * 1000 < now || !isValidLocalKey(p.key)) return null;
    return p;
  } catch {
    return null;
  }
}

// Server-side upload MIME allowlist. Anything not listed is rejected so an
// attacker cannot upload active content (e.g. text/html or image/svg+xml, both
// deliberately excluded) that could render inline as stored XSS if the bucket is
// ever public-read. Covers what the client actually uploads: images + video from
// the gallery/camera picker, and documents from the document picker.
export const ALLOWED_UPLOAD_MIME_TYPES = new Set<string>([
  // Images (svg intentionally excluded — SVG can carry <script>)
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  // Video (gallery picker allows videos)
  'video/mp4',
  'video/quicktime',
  'video/webm',
  // Documents
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Generic binary — document picker fallback when the MIME is undetectable.
  // Safe here because uploads are stored with Content-Disposition: attachment.
  'application/octet-stream',
]);

export function isAllowedUploadMimeType(mimeType: string): boolean {
  return ALLOWED_UPLOAD_MIME_TYPES.has(mimeType);
}

const client = new S3Client({
  region: process.env.S3_REGION ?? 'ru-central1',
  endpoint: process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

function getBucket(): string {
  return process.env.S3_BUCKET ?? 'crm-uploads-users';
}

export function getPublicUrl(key: string): string {
  // SECURITY TODO: these are unsigned public-read URLs. A fuller fix is to keep
  // the bucket private and serve attachments via short-TTL presigned GET URLs
  // generated per-request. Deferred because it changes the client contract
  // (the app currently opens file_url directly). The local driver has the same
  // exposure: whoever holds the URL (two random uuids) can fetch the file.
  return `${storagePrefix()}${key}`;
}

/**
 * Fully percent-decode a key, or null if it cannot be decoded.
 *
 * Decoding is repeated until it reaches a fixed point so a double-encoded
 * traversal (`%252e%252e`) cannot survive a single pass, and a malformed escape
 * is treated as invalid rather than ignored — buildKey never emits `%`, so a key
 * we minted always decodes to itself.
 */
function fullyDecodeKey(key: string): string | null {
  let current = key;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null; // malformed percent-escape — never a key we minted
    }
    if (next === current) return current;
    current = next;
  }
  return null; // pathologically nested encoding — not a key we minted
}

/** True if any `/`- or `\`-separated segment of the key is a `..` traversal. */
function hasTraversalSegment(key: string): boolean {
  return key.split(/[/\\]/).includes('..');
}

/**
 * Derive the S3 object key from a stored file_url and verify it belongs to the
 * given org. Returns the key ONLY when the URL points at this app's own storage
 * endpoint + bucket AND the key lives under this org's prefix
 * (`uploads/<orgId>/...` — the prefix buildKey produces). Returns null for any
 * URL that fails these checks: an external/arbitrary host, a different bucket,
 * or another tenant's object. Used to reject cross-tenant / external file_url
 * values on create and to gate cross-tenant S3 deletes.
 *
 * The prefix test alone is not enough: `uploads/<myOrg>/../<victimOrg>/x`
 * starts with this org's prefix but resolves out of it once any consumer
 * normalises the path per RFC 3986 (and `%2e%2e` behaves identically). Such a
 * key is rejected outright rather than sanitised — buildKey cannot produce a
 * `..` segment, so a key containing one is never legitimate.
 */
export function deriveOrgScopedKey(fileUrl: string, orgId: string): string | null {
  const prefix = storagePrefix();
  if (!fileUrl.startsWith(prefix)) return null;
  const key = fileUrl.slice(prefix.length);

  const decoded = fullyDecodeKey(key);
  if (decoded === null) return null;
  if (hasTraversalSegment(key) || hasTraversalSegment(decoded)) return null;

  // Both forms must sit under the org prefix, so an escape hidden in the
  // encoding cannot pass the check in one form and resolve in the other.
  const orgPrefix = `uploads/${orgId}/`;
  if (!key.startsWith(orgPrefix) || !decoded.startsWith(orgPrefix)) return null;
  return key;
}

export function buildKey(orgId: string, entityType: string, filename: string): string {
  const rawExt = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  // The extension gets the same charset filter as the base name. Untouched it
  // could carry a `%` (a filename like `Q3 margin 12.5%` has extension `.5%`),
  // which deriveOrgScopedKey reads as a malformed percent-escape and rejects —
  // a key we minted ourselves must always survive that check.
  const ext = rawExt.replace(/[^a-zA-Z0-9._-]/g, '_');
  const baseName = filename.slice(0, filename.lastIndexOf('.') > -1 ? filename.lastIndexOf('.') : filename.length);
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const uuid = crypto.randomUUID();
  return `uploads/${orgId}/${entityType}/${uuid}-${safeName}${ext}`;
}

export async function generateUploadUrl(
  orgId: string,
  entityType: string,
  filename: string,
  mimeType: string,
  maxSizeBytes: number,
): Promise<{ uploadUrl: string; fields: Record<string, string>; fileUrl: string; key: string }> {
  // Defense in depth — callers (getUploadUrl) validate first and return 400,
  // but never mint a presigned POST for a type outside the allowlist.
  if (!isAllowedUploadMimeType(mimeType)) {
    throw new Error(`Disallowed upload MIME type: ${mimeType}`);
  }

  const key = buildKey(orgId, entityType, filename);

  if (isLocalStorage()) {
    const policy = signUploadPolicy({
      key,
      mime: mimeType,
      max: maxSizeBytes,
      exp: Math.floor(Date.now() / 1000) + UPLOAD_EXPIRES_IN,
    });
    return {
      uploadUrl: `${localPublicBase()}upload`,
      fields: { key, 'Content-Type': mimeType, policy },
      fileUrl: getPublicUrl(key),
      key,
    };
  }

  const { url, fields } = await createPresignedPost(client, {
    Bucket: getBucket(),
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxSizeBytes],
      ['eq', '$Content-Type', mimeType],
      // Force download instead of inline rendering (stored-XSS mitigation).
      ['eq', '$Content-Disposition', 'attachment'],
    ],
    Fields: {
      'Content-Type': mimeType,
      'Content-Disposition': 'attachment',
    },
    Expires: UPLOAD_EXPIRES_IN,
  });

  return {
    uploadUrl: url,
    fields,
    fileUrl: getPublicUrl(key),
    key,
  };
}

export async function deleteFile(key: string): Promise<void> {
  if (isLocalStorage()) {
    await fs.promises.rm(localPathForKey(key), { force: true });
    return;
  }
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}
