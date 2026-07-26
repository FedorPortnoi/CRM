import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ContactAiController } from '../controllers/contact-ai';
import { AUTOFILL_MAX_INPUT_CHARS } from '../../services/contact-ai';
import { authenticate } from '../preHandlers';

const ContactIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const AutofillSchema = z.object({
  text: z.string().trim().min(1).max(AUTOFILL_MAX_INPUT_CHARS),
});

/**
 * AI helpers for the contacts resource.
 *
 * BOTH routes are authenticated — there is no public surface here. The summary
 * route reads a tenant's CRM data and the autofill route spends an external
 * model quota, so an unauthenticated caller must never reach either.
 *
 * Not registered by backend/index.ts yet; the wiring agent owns that. Intended
 * mount point is `{ prefix: '/api/v1/ai' }`, giving:
 *   POST /api/v1/ai/contacts/:id/summary
 *   POST /api/v1/ai/contacts/autofill
 */
export default async function contactAiRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.post('/contacts/:id/summary', {
    preHandler: [authenticate],
    schema: { params: ContactIdParamsSchema },
  }, ContactAiController.summary);

  f.post('/contacts/autofill', {
    preHandler: [authenticate],
    schema: { body: AutofillSchema },
  }, ContactAiController.autofill);
}
