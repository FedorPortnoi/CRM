import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../services/db';
import { paginate } from '../../services/db-paginate';
import { generateUploadUrl, deleteFile } from '../../services/storage';

// --- Validation --------------------------------------------------------------

function isSafePublicUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const h = hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (/^169\.254\./.test(h)) return false;
    if (/^10\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (/^192\.168\./.test(h)) return false;
    return true;
  } catch { return false; }
}

const UploadUrlSchema = z.object({
  entity_type: z.enum(['contact', 'deal', 'task', 'calendar_event']),
  entity_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1),
  size: z.number().int().positive(),
});

const CreateAttachmentSchema = z.object({
  entity_type: z.enum(['contact', 'deal', 'task', 'calendar_event']),
  entity_id: z.string().uuid(),
  filename: z.string().min(1),
  file_url: z.string().url().refine(isSafePublicUrl, { message: 'file_url must be a public http/https URL' }),
  mime_type: z.string().optional(),
  size: z.number().int().positive().optional(),
});

// --- Types -------------------------------------------------------------------

type ListQuery = {
  entity_type?: string;
  entity_id?: string;
};

type IdParams = { id: string };

// --- Handlers ----------------------------------------------------------------

export async function getUploadUrl(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await request.jwtVerify();

  const parsed = UploadUrlSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' },
    });
    return;
  }

  const { entity_type, entity_id, filename, mime_type, size } = parsed.data;
  const maxBytes = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? '10', 10) * 1024 * 1024;

  if (size > maxBytes) {
    reply.status(413).send({
      error: { code: 'FILE_TOO_LARGE', message: `File exceeds ${process.env.MAX_UPLOAD_SIZE_MB ?? 10} MB limit` },
    });
    return;
  }

  const result = await generateUploadUrl(
    request.user.org_id,
    entity_type,
    filename,
    mime_type,
    maxBytes,
  );

  reply.send({
    data: {
      upload_url: result.uploadUrl,
      fields: result.fields,
      file_url: result.fileUrl,
      key: result.key,
      entity_type,
      entity_id,
    },
    meta: {},
  });
}

export async function listAttachments(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await request.jwtVerify();

  const { entity_type, entity_id } = request.query as ListQuery;

  const where = {
    organization_id: request.user.org_id,
    ...(entity_type && { entity_type }),
    ...(entity_id && { entity_id }),
  };

  const { data: attachments, total } = await paginate(
    () => db.attachment.count({ where }),
    () => db.attachment.findMany({
      where,
      orderBy: { created_at: 'desc' },
    }),
  );

  reply.send({ data: attachments, meta: { total } });
}

export async function createAttachment(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await request.jwtVerify();

  const parsed = CreateAttachmentSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' },
    });
    return;
  }

  const body = parsed.data;

  const entityLookup: Record<string, () => Promise<{ id: string } | null>> = {
    contact: () => db.contact.findFirst({ where: { id: body.entity_id, organization_id: request.user.org_id }, select: { id: true } }),
    deal: () => db.deal.findFirst({ where: { id: body.entity_id, organization_id: request.user.org_id }, select: { id: true } }),
    task: () => db.task.findFirst({ where: { id: body.entity_id, organization_id: request.user.org_id }, select: { id: true } }),
    calendar_event: () => db.calendarEvent.findFirst({ where: { id: body.entity_id, organization_id: request.user.org_id }, select: { id: true } }),
  };

  const lookup = entityLookup[body.entity_type];
  if (!lookup) {
    reply.status(400).send({ error: { code: 'INVALID_ENTITY_TYPE', message: 'Unsupported entity type' } });
    return;
  }

  const entityExists = await lookup();
  if (!entityExists) {
    reply.status(403).send({ error: { code: 'ENTITY_NOT_FOUND', message: 'Entity not found in your organization' } });
    return;
  }

  const attachment = await db.attachment.create({
    data: {
      organization_id: request.user.org_id,
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      filename: body.filename,
      file_url: body.file_url,
      mime_type: body.mime_type,
      size: body.size,
      uploaded_by: request.user.sub,
    },
  });

  reply.status(201).send({ data: attachment, meta: {} });
}

export async function deleteAttachment(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await request.jwtVerify();

  const { id } = request.params as IdParams;

  const attachment = await db.attachment.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!attachment) {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Attachment not found' },
    });
    return;
  }

  await db.attachment.delete({ where: { id } });

  // Best-effort S3 cleanup — extract key from file_url
  try {
    const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
    const bucket = process.env.S3_BUCKET ?? 'crm-uploads-users';
    const prefix = `${endpoint}/${bucket}/`;
    if (attachment.file_url.startsWith(prefix)) {
      const key = attachment.file_url.slice(prefix.length);
      await deleteFile(key);
    }
  } catch {
    // S3 delete failure must not block the DB record deletion response
  }

  reply.status(204).send();
}
