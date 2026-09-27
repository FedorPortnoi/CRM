import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { db } from '../../services/db';
import {
  getPublicUrl,
  isLocalStorage,
  isValidLocalKey,
  localPathForKey,
  verifyUploadPolicy,
} from '../../services/storage';

// Local-disk storage (services/storage.ts, LOCAL_STORAGE_DIR). Mounted at /api/files
// — deliberately outside /api/v1, whose global session gate would refuse both
// routes: the upload is authorised by the signed policy that upload-url minted
// (the S3 presigned-POST shape the app already speaks), and a download is by
// unguessable URL, which is exactly what the public-read S3 bucket offered.

function maxUploadBytes(): number {
  return parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? '10', 10) * 1024 * 1024;
}

function fieldValue(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const v = fields?.[name] as { value?: unknown } | undefined;
  return typeof v?.value === 'string' ? v.value : undefined;
}

async function upload(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.isMultipart()) {
    reply.status(415).send({ error: { code: 'VALIDATION_ERROR', message: 'Expected multipart/form-data' } });
    return;
  }
  const file = await request.file();
  if (!file) {
    reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'No file in request' } });
    return;
  }
  // The app appends the policy fields before the file, so they arrive with it.
  const fields = (file as { fields?: Record<string, unknown> }).fields;
  const policy = verifyUploadPolicy(fieldValue(fields, 'policy') ?? '');
  const key = fieldValue(fields, 'key');
  const contentType = fieldValue(fields, 'Content-Type');
  if (!policy || policy.key !== key || policy.mime !== contentType) {
    file.file.resume();
    reply.status(403).send({ error: { code: 'INVALID_UPLOAD_POLICY', message: 'Upload policy is invalid or expired' } });
    return;
  }

  const target = localPathForKey(policy.key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  let bytes = 0;
  file.file.on('data', (chunk: Buffer) => { bytes += chunk.length; });
  try {
    await pipeline(file.file, fs.createWriteStream(partial, { flags: 'wx' }));
  } catch (err) {
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  if (file.file.truncated || bytes > policy.max || bytes === 0) {
    await fs.promises.rm(partial, { force: true });
    reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'File is empty or exceeds the upload limit' } });
    return;
  }
  // A key is minted once per upload-url; never let a second POST replace the file.
  try {
    await fs.promises.link(partial, target);
  } finally {
    await fs.promises.rm(partial, { force: true });
  }
  reply.status(204).send();
}

async function download(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = `uploads/${(request.params as { '*': string })['*']}`;
  if (!isValidLocalKey(key)) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    return;
  }
  // Only files something references are served — an upload whose metadata was
  // never saved stays dark.
  // The key's second segment is the owning org (buildKey), so the row must be that org's too.
  const attachment = await db.attachment.findFirst({
    where: { organization_id: key.split('/')[1], file_url: getPublicUrl(key) },
    select: { filename: true, mime_type: true, size: true },
  });
  const full = localPathForKey(key);
  const stat = attachment ? await fs.promises.stat(full).catch(() => null) : null;
  if (!attachment || !stat?.isFile()) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    return;
  }
  reply
    .header('Content-Type', attachment.mime_type || 'application/octet-stream')
    .header('Content-Length', String(stat.size))
    // Same stored-XSS stance as the S3 uploads: never render inline.
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(full));
}

export async function filesRoutes(fastify: FastifyInstance): Promise<void> {
  if (!isLocalStorage()) return;
  await fastify.register(multipart, {
    limits: { files: 1, fileSize: maxUploadBytes(), fields: 4, parts: 5 },
  });
  fastify.post('/upload', upload);
  fastify.get('/uploads/*', download);
}
