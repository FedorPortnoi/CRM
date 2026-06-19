import { FastifyInstance } from 'fastify';
import { ExportController } from '../controllers/export';
import { authenticate } from '../preHandlers';

export default async function exportRoutes(fastify: FastifyInstance) {
  fastify.get('/contacts/pdf', {
    preHandler: [authenticate],
  }, ExportController.contactsPdf);

  fastify.get('/deals/pdf', {
    preHandler: [authenticate],
  }, ExportController.dealsPdf);
}
