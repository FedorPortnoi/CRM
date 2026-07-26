import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AssistantController } from '../controllers/assistant';
import { authenticate } from '../preHandlers';
import { MAX_USER_MESSAGE_CHARS } from '../../services/assistant';

const SendMessageSchema = z.object({
  message: z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARS),
  conversation_id: z.string().uuid().optional(),
});

const ListConversationsSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
});

const ConversationIdParamsSchema = z.object({
  id: z.string().uuid(),
});

// Mounted by the wiring agent at /api/v1/assistant. Every route here is
// session-authenticated: none of them belong on the public allowlist.
export default async function assistantRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/status', { preHandler: [authenticate] }, AssistantController.status);

  f.post('/messages', {
    preHandler: [authenticate],
    schema: { body: SendMessageSchema },
  }, AssistantController.send);

  f.get('/conversations', {
    preHandler: [authenticate],
    schema: { querystring: ListConversationsSchema },
  }, AssistantController.listConversations);

  f.get('/conversations/:id', {
    preHandler: [authenticate],
    schema: { params: ConversationIdParamsSchema },
  }, AssistantController.getConversation);
}
