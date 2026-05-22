import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ExportController } from '../controllers/export';

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function exportRoutes(fastify: FastifyInstance) {
  fastify.get('/contacts/pdf', {
    preHandler: [authenticate],
  }, ExportController.contactsPdf);

  fastify.get('/deals/pdf', {
    preHandler: [authenticate],
  }, ExportController.dealsPdf);
}
