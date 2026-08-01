import { FastifyInstance } from 'fastify';
import { AmocrmController } from '../controllers/amocrm';
import { authenticate } from '../preHandlers';

/**
 * Registered at prefix '/api/v1/amocrm' from backend/index.ts.
 *
 * NOTE ON THE CALLBACK: `GET /api/v1/amocrm/callback` deliberately carries NO
 * `authenticate` preHandler — the browser arrives from amoCRM's consent screen
 * with no token. It also needs an entry in `isPublicApiRoute()` in
 * api/authenticate.ts, because the global preHandler 401s every /api/v1 route
 * that is not listed there. Without that entry the connection can be started but
 * never completed, which fails silently from the user's side: they authorise on
 * amoCRM, get bounced, and the integration simply never appears.
 *
 * The connect and disconnect routes re-check `integrations.manage` inside the
 * controller, so they are correctly gated even before the matching
 * adminRoutePolicy entry lands in api/authenticate.ts.
 */
export default async function amocrmRoutes(fastify: FastifyInstance) {
  fastify.get('/status', { preHandler: [authenticate] }, AmocrmController.status);

  fastify.get('/connect', { preHandler: [authenticate] }, AmocrmController.connect);

  // OAuth redirect — no JWT. Rate-limited on its own because it is public and
  // every hit costs a signature verification.
  fastify.get(
    '/callback',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    AmocrmController.callback,
  );

  fastify.post('/disconnect', { preHandler: [authenticate] }, AmocrmController.disconnect);

  fastify.post(
    '/webhooks/subscribe',
    { preHandler: [authenticate] },
    AmocrmController.subscribeWebhooks,
  );

  fastify.post('/reconcile', { preHandler: [authenticate] }, AmocrmController.reconcileNow);

  fastify.get('/conflicts', { preHandler: [authenticate] }, AmocrmController.conflicts);
}
