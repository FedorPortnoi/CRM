import type { FastifyInstance } from 'fastify';
import { listAttachments, createAttachment, deleteAttachment, getUploadUrl } from '../controllers/attachments';

export async function attachmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/attachments/upload-url', getUploadUrl);
  fastify.get('/attachments', listAttachments);
  fastify.post('/attachments', createAttachment);
  fastify.delete('/attachments/:id', deleteAttachment);
}
