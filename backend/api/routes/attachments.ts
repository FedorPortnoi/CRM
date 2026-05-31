import type { FastifyInstance } from 'fastify';
import { listAttachments, createAttachment, deleteAttachment } from '../controllers/attachments';

export async function attachmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/attachments', listAttachments);
  fastify.post('/attachments', createAttachment);
  fastify.delete('/attachments/:id', deleteAttachment);
}
