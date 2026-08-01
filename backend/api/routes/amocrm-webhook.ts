/**
 * Public amoCRM webhook endpoint.
 *
 *   POST /api/v1/integrations/amocrm/webhook
 *
 * ─── THIS ROUTE MUST BE ON THE PUBLIC ALLOWLIST ──────────────────────────────
 *
 * amoCRM's servers hold no JWT, no cookie and no session of ours, so
 * `enforceAuthenticatedApiRequest` has to let this path through or every delivery comes back
 * 401, amoCRM retries three times and then DISABLES the subscription. The exact entry to add
 * to isPublicApiRoute() in backend/api/authenticate.ts, next to the Yandex calendar webhook
 * at line 102:
 *
 *     if (method === 'POST' && path === '/api/v1/integrations/amocrm/webhook') {
 *       return true;
 *     }
 *
 * It cannot over-match: the comparison is an exact string against a path that has already had
 * its query string and trailing slashes stripped, the method check keeps every other verb on
 * the authenticated path, and this plugin registers exactly one route.
 *
 * The endpoint is NOT unauthenticated, it is authenticated differently. The subscribed
 * destination carries a per-organization HMAC token derived from that integration's encrypted
 * client secret. The handler verifies it before accepting the account named by the body. A
 * legacy signature header is also accepted when present. See services/amocrm/webhook.ts.
 *
 * ─── REGISTRATION (backend/index.ts, beside the other route plugins) ─────────
 *
 *     import amocrmWebhookRoutes from './api/routes/amocrm-webhook';
 *     await server.register(amocrmWebhookRoutes, { prefix: '/api/v1/integrations/amocrm' });
 */

import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AMO_WEBHOOK_MAX_BODY_BYTES,
  AMO_WEBHOOK_TOKEN_QUERY,
  handleAmoWebhook,
} from '../../services/amocrm/webhook';

/**
 * The raw request body, per request.
 *
 * A WeakMap rather than `declare module 'fastify'` + decorateRequest: seven agents are editing
 * this tree at once, and a global type augmentation is a shared name that two of them can
 * collide on. The entry dies with the request object.
 */
const rawBodies = new WeakMap<FastifyRequest, string>();

type OversizeError = Error & { statusCode: number };

function readPositiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A ceiling, not a throttle.
 *
 * Rate limiting a webhook receiver is dangerous in a way it is not elsewhere: a 429 is not a
 * 2xx, so amoCRM treats it as a failed delivery, retries, and eventually disables the
 * subscription — a rate limit that trips during a bulk import in the customer's account would
 * silently switch the sync off. The number is therefore set well above any plausible legitimate
 * burst and exists only to stop a stranger hammering an unauthenticated path.
 */
export function amoWebhookRateLimit(
  env: NodeJS.ProcessEnv = process.env,
): { max: number; timeWindow: string } {
  return {
    max: env.NODE_ENV === 'test'
      ? 10_000
      : readPositiveIntEnv('AMO_WEBHOOK_RATE_LIMIT_MAX', 1200, env),
    timeWindow: '1 minute',
  };
}

/**
 * Capture the exact bytes before anything parses them.
 *
 * The legacy signature fallback is over the raw body. Re-serializing what @fastify/formbody
 * produced would reorder keys and re-encode characters, and the HMAC of THAT is a different
 * value. A `preParsing` hook is the documented seam for this and,
 * unlike replacing the content-type parser, does not fight with the global formbody
 * registration in backend/index.ts:208.
 *
 * Hooks added inside a plugin apply only to that plugin's routes, so this buffers nothing for
 * the rest of the API.
 */
async function captureRawBody(
  request: FastifyRequest,
  _reply: FastifyReply,
  payload: Readable,
): Promise<Readable> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;

    if (size > AMO_WEBHOOK_MAX_BODY_BYTES) {
      payload.destroy();
      const error = new Error('amoCRM webhook body is too large') as OversizeError;
      error.statusCode = 413;
      throw error;
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks);
  rawBodies.set(request, raw.toString('utf8'));

  // The stream has been consumed, so hand the body parser a replay of it.
  // `receivedEncodedLength` is what Fastify's content-length check reads; without it a
  // perfectly valid request fails as truncated.
  const replay = Readable.from([raw]) as Readable & { receivedEncodedLength?: number };
  replay.receivedEncodedLength = raw.length;
  return replay;
}

/**
 * Verify, enqueue, answer. amoCRM expects a 100–299 within two seconds and disables a
 * subscription that keeps failing, so nothing slower than an INSERT happens here — see the
 * header of services/amocrm/webhook.ts.
 */
async function receiveAmoWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const rawBody = rawBodies.get(request) ?? '';
  rawBodies.delete(request);

  try {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const webhookToken = typeof query[AMO_WEBHOOK_TOKEN_QUERY] === 'string'
      ? query[AMO_WEBHOOK_TOKEN_QUERY] as string
      : null;
    const result = await handleAmoWebhook({
      rawBody,
      headers: request.headers as Record<string, string | string[] | undefined>,
      // Only consulted when the raw body is empty, and a request with no raw body can never
      // pass signature verification — so this cannot widen the trust boundary.
      parsedBody: request.body,
      webhookToken,
    });

    return reply.status(result.status).send(result.body);
  } catch (error) {
    // A 500 is the right answer to an internal failure: amoCRM will retry, and retrying is
    // what we want when the failure is ours. Never echo the error to the caller — the body
    // and the account it names are a stranger's until the signature says otherwise.
    request.log.error({ err: error }, '[amocrm] webhook handler failed');
    return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR' });
  }
}

export default async function amocrmWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preParsing', captureRawBody);

  fastify.post('/webhook', {
    config: { rateLimit: amoWebhookRateLimit() },
    bodyLimit: AMO_WEBHOOK_MAX_BODY_BYTES,
  }, receiveAmoWebhook);
}

export const AmocrmWebhookRouteHandlers = { captureRawBody, receiveAmoWebhook };
