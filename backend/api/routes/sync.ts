import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SyncController } from '../controllers/sync';

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

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
