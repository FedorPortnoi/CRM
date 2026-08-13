import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { AssistantController } from '../controllers/assistant';
import { authenticate } from '../preHandlers';
import { MAX_USER_MESSAGE_CHARS } from '../../services/assistant';
import { MAX_VOICE_MESSAGE_BYTES } from '../../services/transcription';

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

  // Scoped to this plugin: the voice-message upload is the only multipart
  // ingress in the API. One file, hard-capped at the service's own limit so an
  // oversized recording is refused while streaming in, not after buffering.
  await f.register(multipart, {
    limits: { files: 1, fileSize: MAX_VOICE_MESSAGE_BYTES, fields: 4, parts: 8 },
  });

  f.get('/status', { preHandler: [authenticate] }, AssistantController.status);

  f.post('/transcribe', { preHandler: [authenticate] }, AssistantController.transcribe);

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
