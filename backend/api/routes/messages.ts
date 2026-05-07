import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MessagesController } from '../controllers/messages';

const SendSmsSchema = z.object({
  contact_id: z.string().uuid(),
  body: z.string().min(1).max(1600),
});

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

const MessageFilterSchema = z.object({
  contact_id: z.string().uuid().optional(),
  channel: z.enum(['sms', 'in_app', 'email']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
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

  f.get('/conversation/:contact_id', { preHandler: [authenticate] }, MessagesController.getConversation);

  f.post('/sms', {
    preHandler: [authenticate],
    schema: { body: SendSmsSchema },
  }, MessagesController.sendSms);

  f.post('/in-app', {
    preHandler: [authenticate],
    schema: { body: SendInAppSchema },
  }, MessagesController.sendInApp);

  f.post('/call', {
    preHandler: [authenticate],
    schema: { body: LogCallSchema },
  }, MessagesController.logCall);

  f.post('/:id/read', { preHandler: [authenticate] }, MessagesController.markRead);

  // Twilio webhooks — no JWT auth; validated via X-Twilio-Signature HMAC in the controller
  f.post('/webhooks/twilio/inbound', MessagesController.twilioInboundWebhook);
  f.post('/webhooks/twilio/status', MessagesController.twilioStatusWebhook);
}
