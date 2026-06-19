import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MessagesController } from '../controllers/messages';
import { authenticate } from '../preHandlers';

const SendInAppSchema = z.object({
  contact_id: z.string().uuid(),
  body: z.string().min(1).max(5000),
});

const LogCallSchema = z.object({
  contact_id: z.string().uuid(),
  direction: z.enum(['inbound', 'outbound']),
  duration_seconds: z.number().int().nonnegative().optional(),
  notes: z.string().max(5000).optional(),
  occurred_at: z.string().datetime().optional(),
});

export default async function messagesRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/conversation/:contact_id', { preHandler: [authenticate] }, MessagesController.getConversation);

  f.post('/in-app', {
    preHandler: [authenticate],
    schema: { body: SendInAppSchema },
  }, MessagesController.sendInApp);

  f.post('/call', {
    preHandler: [authenticate],
    schema: { body: LogCallSchema },
  }, MessagesController.logCall);

  f.post('/:id/read', { preHandler: [authenticate] }, MessagesController.markRead);
}
