import type { FastifyInstance } from 'fastify';
import { authenticate } from '../preHandlers';
import { listAttachments, createAttachment, deleteAttachment, getUploadUrl } from '../controllers/attachments';

export async function attachmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/attachments/upload-url', { preHandler: [authenticate] }, getUploadUrl);
  fastify.get('/attachments', { preHandler: [authenticate] }, listAttachments);
  fastify.post('/attachments', { preHandler: [authenticate] }, createAttachment);
  fastify.delete('/attachments/:id', { preHandler: [authenticate] }, deleteAttachment);
}
