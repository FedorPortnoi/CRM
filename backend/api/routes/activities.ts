import type { FastifyInstance } from 'fastify';
import { listActivities } from '../controllers/activities';

export async function activitiesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/activities', listActivities);
}
