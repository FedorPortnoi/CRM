import type { FastifyInstance } from 'fastify';
import { authenticate } from '../preHandlers';
import { listActivities } from '../controllers/activities';

export async function activitiesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/activities', { preHandler: [authenticate] }, listActivities);
}
