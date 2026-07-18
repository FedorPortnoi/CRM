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
 * Derive the S3 object key from a stored file_url and verify it belongs to the
 * given org. Returns the key ONLY when the URL points at this app's own storage
 * endpoint + bucket AND the key lives under this org's prefix
 * (`uploads/<orgId>/...` — the prefix buildKey produces). Returns null for any
 * URL that fails these checks: an external/arbitrary host, a different bucket,
 * or another tenant's object. Used to reject cross-tenant / external file_url
 * values on create and to gate cross-tenant S3 deletes.
 */
export function deriveOrgScopedKey(fileUrl: string, orgId: string): string | null {
  const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
  const prefix = `${endpoint}/${getBucket()}/`;
  if (!fileUrl.startsWith(prefix)) return null;
  const key = fileUrl.slice(prefix.length);
  if (!key.startsWith(`uploads/${orgId}/`)) return null;
  return key;
}

export function buildKey(orgId: string, entityType: string, filename: string): string {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
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
