import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const UPLOAD_EXPIRES_IN = 300; // 5 minutes

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
  // (the app currently opens file_url directly).
  const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
  const bucket = getBucket();
  return `${endpoint}/${bucket}/${key}`;
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
  const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
  const prefix = `${endpoint}/${getBucket()}/`;
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
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}
