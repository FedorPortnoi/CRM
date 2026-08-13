import { FastifyInstance } from 'fastify';
import { LeadInboxController } from '../controllers/lead-inbox';
import { authenticate } from '../preHandlers';

/**
 * Registered at prefix '/api/v1/integrations/lead-inbox' from backend/index.ts.
 *
 * Every route is session-authenticated and admin-gated twice: the
 * adminRoutePolicy branch for this prefix in api/authenticate.ts (which is what
 * audits a denial) and the controller's own `integrations.manage` re-check.
 * Nothing here is public — unlike the amoCRM neighbour there is no OAuth
 * callback and no inbound webhook, because the mail is PULLED from the mailbox.
 */
export default async function leadInboxRoutes(fastify: FastifyInstance) {
  fastify.get('/', { preHandler: [authenticate] }, LeadInboxController.status);

  fastify.put('/', { preHandler: [authenticate] }, LeadInboxController.upsert);

  fastify.delete('/', { preHandler: [authenticate] }, LeadInboxController.remove);

  // An immediate poll of the configured mailbox — the settings screen's
  // "проверить подключение" button. Runs even while the inbox is paused.
  fastify.post('/test', { preHandler: [authenticate] }, LeadInboxController.test);
}
