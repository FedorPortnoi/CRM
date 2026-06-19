import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SyncController } from '../controllers/sync';
import { authenticate } from '../preHandlers';

const DeltaQuerySchema = z.object({
  since: z.string().datetime().optional(),
});

export default async function syncRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/delta', {
    preHandler: [authenticate],
    schema: { querystring: DeltaQuerySchema },
  }, SyncController.delta);
}
