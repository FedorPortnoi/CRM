import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const UPLOAD_EXPIRES_IN = 300; // 5 minutes

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
  const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
  const bucket = getBucket();
  return `${endpoint}/${bucket}/${key}`;
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
  const key = buildKey(orgId, entityType, filename);

  const { url, fields } = await createPresignedPost(client, {
    Bucket: getBucket(),
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxSizeBytes],
      ['eq', '$Content-Type', mimeType],
    ],
    Fields: { 'Content-Type': mimeType },
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
