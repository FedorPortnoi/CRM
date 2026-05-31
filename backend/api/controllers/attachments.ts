import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../services/db';

// --- Validation --------------------------------------------------------------

const CreateAttachmentSchema = z.object({
  entity_type: z.string().min(1),
  entity_id: z.string().uuid(),
  filename: z.string().min(1),
  file_url: z.string().url(),
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

  const [attachments, total] = await Promise.all([
    db.attachment.findMany({
      where,
      orderBy: { created_at: 'desc' },
    }),
    db.attachment.count({ where }),
  ]);

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

  reply.status(204).send();
}
