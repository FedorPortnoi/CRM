import { FastifyInstance } from 'fastify';
import { ExportController } from '../controllers/export';
import { authenticate } from '../preHandlers';

export default async function exportRoutes(fastify: FastifyInstance) {
  fastify.get('/contacts/pdf', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, ExportController.contactsPdf);

  fastify.get('/deals/pdf', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, ExportController.dealsPdf);
}
