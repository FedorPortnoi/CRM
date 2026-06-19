import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AnalyticsController } from '../controllers/analytics';
import { authenticate } from '../preHandlers';

export default async function analyticsRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/dashboard', { preHandler: [authenticate] }, AnalyticsController.dashboard);
}
