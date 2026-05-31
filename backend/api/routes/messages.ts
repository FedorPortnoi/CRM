import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MessagesController } from '../controllers/messages';

const SendEmailSchema = z.object({
  contact_id: z.string().uuid(),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000),
});

const SendInAppSchema = z.object({
  contact_id: z.string().uuid(),
  body: z.string().min(1).max(5000),
});

const CreateMessageSchema = z.object({
  contact_id: z.string().uuid(),
  channel: z.enum(['sms', 'in_app', 'email', 'call']),
  direction: z.enum(['inbound', 'outbound']).optional(),
  body: z.string().min(1).max(5000),
});

const LogCallSchema = z.object({
  contact_id: z.string().uuid(),
  direction: z.enum(['inbound', 'outbound']),
  duration_seconds: z.number().int().nonnegative().optional(),
  notes: z.string().max(5000).optional(),
  occurred_at: z.string().datetime().optional(),
});

export const MessageFilterSchema = z.object({
  contact_id: z.string().uuid().optional(),
  channel: z.enum(['sms', 'in_app', 'email', 'call']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.enum(['pending', 'sent', 'delivered', 'read', 'failed']).optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function messagesRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: MessageFilterSchema },
  }, MessagesController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateMessageSchema },
  }, MessagesController.create);

  f.get('/conversation/:contact_id', { preHandler: [authenticate] }, MessagesController.getConversation);

  f.get('/:id', { preHandler: [authenticate] }, MessagesController.getById);

  f.post('/email', {
    preHandler: [authenticate],
    schema: { body: SendEmailSchema },
  }, MessagesController.sendEmail);

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
