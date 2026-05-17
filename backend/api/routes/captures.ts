import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CapturesController } from '../controllers/captures';

const ListCapturesSchema = z.object({
  status: z.enum(['pending', 'matched', 'dismissed', 'all']).optional(),
});

const MatchCaptureSchema = z.object({
  contact_id: z.string().uuid(),
});

const CaptureIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

const CreateCaptureSchema = z.object({
  type: z.enum(['call', 'sms', 'email']),
  raw_data: z.record(z.unknown()),
  phone_number: z.string().optional(),
});

export default async function capturesRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateCaptureSchema },
  }, CapturesController.create);

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: ListCapturesSchema },
  }, CapturesController.list);

  f.post('/:id/match', {
    preHandler: [authenticate],
    schema: { params: CaptureIdParamsSchema, body: MatchCaptureSchema },
  }, CapturesController.match);

  f.post('/:id/dismiss', {
    preHandler: [authenticate],
    schema: { params: CaptureIdParamsSchema },
  }, CapturesController.dismiss);

  f.post('/:id/create-contact', {
    preHandler: [authenticate],
    schema: { params: CaptureIdParamsSchema },
  }, CapturesController.createContact);
}
