import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AnalyticsController } from '../controllers/analytics';

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function analyticsRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/dashboard', { preHandler: [authenticate] }, AnalyticsController.dashboard);
}
