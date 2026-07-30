import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../services/db';
import { paginate } from '../../services/db-paginate';
import { generateUploadUrl, deleteFile, deriveOrgScopedKey, isAllowedUploadMimeType } from '../../services/storage';
import { getContactForUser, ContactNotFoundError } from '../../services/contact-domain';
import { getDealForUser, DealDomainError } from '../../services/deal-domain';
import { getTaskForUser } from '../../services/task-domain';
import { getAccessibleUserIds } from '../../services/visibility';

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

// Mirrors UploadUrlSchema's caps. This route records the metadata for a file
// the upload route already gated, so anything the upload route refuses must be
// refused here too — otherwise the caps are bypassable by calling POST
// /attachments directly with a fabricated filename or MIME type.
const CreateAttachmentSchema = z.object({
  entity_type: z.enum(['contact', 'deal', 'task', 'calendar_event']),
  entity_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  file_url: z.string().url().refine(isSafePublicUrl, { message: 'file_url must be a public http/https URL' }),
  mime_type: z.string().min(1).refine(isAllowedUploadMimeType, { message: 'File type is not allowed' }).optional(),
  size: z.number().int().positive().optional(),
});

// --- Types -------------------------------------------------------------------

type ListQuery = {
  entity_type?: string;
  entity_id?: string;
};

type IdParams = { id: string };

const ATTACHMENT_ENTITY_TYPES = ['contact', 'deal', 'task', 'calendar_event'] as const;

// --- Visibility --------------------------------------------------------------

/**
 * Whether the caller may see the parent entity an attachment hangs off of.
 * Resolves each entity through its cone-enforcing accessor so a member/viewer
 * cannot list, attach, or detach files on an entity outside their org-chart
 * cone (org membership alone is not enough). Owner/admin are unrestricted.
 */
async function canSeeEntity(
  request: FastifyRequest,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const orgId = request.user.org_id;

  switch (entityType) {
    case 'contact':
      try {
        await getContactForUser(entityId, orgId, request.user);
        return true;
      } catch (err) {
        if (err instanceof ContactNotFoundError) return false;
        throw err;
      }
    case 'deal':
      try {
        await getDealForUser(entityId, orgId, request.user);
        return true;
      } catch (err) {
        if (err instanceof DealDomainError) return false;
        throw err;
      }
    case 'task':
      return (await getTaskForUser(entityId, orgId, request.user)) !== null;
    case 'calendar_event': {
      const visibleIds = await getAccessibleUserIds(request.user);
      const event = await db.calendarEvent.findFirst({
        where: {
          id: entityId,
          organization_id: orgId,
          ...(visibleIds !== null && { created_by: { in: visibleIds } }),
        },
        select: { id: true },
      });
      return event !== null;
    }
    default:
      return false;
  }
}

// --- Handlers ----------------------------------------------------------------

export async function getUploadUrl(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = UploadUrlSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' },
    });
    return;
  }

  const { entity_type, entity_id, filename, mime_type, size } = parsed.data;

  if (!isAllowedUploadMimeType(mime_type)) {
    reply.status(400).send({
      error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'File type is not allowed' },
    });
    return;
  }

  const maxBytes = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? '10', 10) * 1024 * 1024;

  if (size > maxBytes) {
    reply.status(413).send({
      error: { code: 'FILE_TOO_LARGE', message: `File exceeds ${process.env.MAX_UPLOAD_SIZE_MB ?? 10} MB limit` },
    });
    return;
  }

  // Same gate the other three handlers apply: a valid uuid is not permission.
  // Without this, a member could mint a presigned upload for an entity outside
  // their cone (or outside their org) and learn it exists from the 200. Same
  // ENTITY_NOT_FOUND/404 as listAttachments so the response is not an oracle.
  if (!(await canSeeEntity(request, entity_type, entity_id))) {
    reply.status(404).send({
      error: { code: 'ENTITY_NOT_FOUND', message: 'Entity not found' },
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
  const { entity_type, entity_id } = request.query as ListQuery;

  // A bare org-wide listing would leak attachments across the visibility cone,
  // so a specific parent entity is required.
  if (!entity_type || !entity_id) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'entity_type and entity_id are required' },
    });
    return;
  }

  if (!(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(entity_type)) {
    reply.status(400).send({
      error: { code: 'INVALID_ENTITY_TYPE', message: 'Unsupported entity type' },
    });
    return;
  }

  if (!(await canSeeEntity(request, entity_type, entity_id))) {
    reply.status(404).send({
      error: { code: 'ENTITY_NOT_FOUND', message: 'Entity not found' },
    });
    return;
  }

  const where = {
    organization_id: request.user.org_id,
    entity_type,
    entity_id,
  };

  const { data: attachments, total } = await paginate(
    () => db.attachment.count({ where }),
    () => db.attachment.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 200,
    }),
  );

  reply.send({ data: attachments, meta: { total } });
}

export async function createAttachment(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = CreateAttachmentSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid input' },
    });
    return;
  }

  const body = parsed.data;

  // file_url must point at THIS org's own uploaded object. Rejects URLs that
  // reference another tenant's object or an arbitrary external host (stored
  // phishing/malware link + fabricated metadata). isSafePublicUrl (schema
  // refine) still guards SSRF; this binds the object to the caller's org.
  if (deriveOrgScopedKey(body.file_url, request.user.org_id) === null) {
    reply.status(400).send({
      error: { code: 'INVALID_FILE_URL', message: 'file_url must reference an object uploaded by your organization' },
    });
    return;
  }

  // The caller must be able to SEE the parent entity (org + visibility cone) to
  // attach a file to it — not merely share its organization.
  if (!(await canSeeEntity(request, body.entity_type, body.entity_id))) {
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

  // A member must be able to see the parent entity to detach its files. Return
  // the same NOT_FOUND so an out-of-cone attachment is indistinguishable from a
  // nonexistent one.
  if (!(await canSeeEntity(request, attachment.entity_type, attachment.entity_id))) {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Attachment not found' },
    });
    return;
  }

  await db.attachment.delete({ where: { id } });

  // Best-effort S3 cleanup — only delete the object when the stored file_url
  // resolves to an object under THIS org's prefix. Belt-and-suspenders against
  // deleting another tenant's object; if the key is not org-scoped we simply
  // skip the S3 delete (treat the object as not ours).
  try {
    const key = deriveOrgScopedKey(attachment.file_url, request.user.org_id);
    if (key !== null) {
      await deleteFile(key);
    }
  } catch {
    // S3 delete failure must not block the DB record deletion response
  }

  reply.status(204).send();
}
