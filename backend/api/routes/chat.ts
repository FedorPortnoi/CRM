import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ChatController } from '../controllers/chat';
import { authenticate } from '../preHandlers';

const SendMessageSchema = z.object({
  channel: z.string().min(1).max(200),
  body: z.string().min(1).max(2000).transform((s) => s.trim()),
});

const MarkReadSchema = z.object({
  channel: z.string().min(1).max(200),
});

const GetMessagesSchema = z.object({
  channel: z.string().min(1).max(200),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get('/channels', { preHandler: [authenticate] }, ChatController.getChannels);
  fastify.get('/messages', {
    preHandler: [authenticate],
    schema: { querystring: GetMessagesSchema },
  }, ChatController.getMessages);
  fastify.post('/messages', {
    preHandler: [authenticate],
    schema: { body: SendMessageSchema },
  }, ChatController.sendMessage);
  fastify.post('/read', {
    preHandler: [authenticate],
    schema: { body: MarkReadSchema },
  }, ChatController.markRead);
};

export default chatRoutes;
