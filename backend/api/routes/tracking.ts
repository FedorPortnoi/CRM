/**
 * Public open-tracking endpoint.
 *
 *   GET /api/v1/tracking/open/:token       -> 200 image/gif (1x1 transparent)
 *   GET /api/v1/tracking/open/:token.gif   -> same route; the extension is part
 *                                             of the :token segment and stripped
 *
 * THIS ROUTE MUST BE ON THE PUBLIC ALLOWLIST. A mail client fetches it with no
 * cookie, no bearer token and no session, so `enforceAuthenticatedApiRequest`
 * has to let it through. The exact prefix to allowlist is exported as
 * TRACKING_OPEN_PATH_PREFIX from backend/services/open-tracking.ts:
 *   method === 'GET' && path.startsWith('/api/v1/tracking/open/')
 * Until that entry exists every open comes back as a 401 and nothing is ever
 * recorded.
 *
 * The handler answers 200 with the pixel for EVERY request, valid token or not.
 * A 404 for an unknown token would turn this into an oracle that tells a
 * stranger which tokens exist; a 500 would show a stack trace inside somebody's
 * inbox. Recording the open is best-effort and never changes the response.
 *
 * ФЗ-152: serving this pixel processes personal data. See the header comment in
 * backend/services/open-tracking.ts — it must be disclosed in the privacy
 * policy before the feature ships to customers.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  TRACKING_PIXEL_CONTENT_TYPE,
  TRACKING_PIXEL_GIF,
  recordEmailOpen,
  stripPixelExtension,
} from '../../services/open-tracking';

type OpenParams = { token?: string };

function readPositiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Unauthenticated endpoints get their own, tighter bucket. Keyed by IP (the
 * plugin default) because there is no account to key on; a shared corporate
 * mail gateway is the reason the ceiling is not lower than this.
 */
/**
 * `env` is a parameter, not a read of the ambient process, so a test can
 * exercise the PRODUCTION branch. That matters here more than almost anywhere:
 * this is the only unauthenticated, un-allowlisted endpoint in the API, and its
 * one test used to assert `max > 0` against the 10_000 that
 * `NODE_ENV === 'test'` substitutes — i.e. it asserted `10000 > 0` and passed
 * with the real 120 ceiling deleted entirely. Same shape as the helpers in
 * config/security.ts, and for the same reason.
 */
export function openTrackingRateLimit(
  env: NodeJS.ProcessEnv = process.env,
): { max: number; timeWindow: string } {
  return {
    max:
      env.NODE_ENV === 'test'
        ? 10_000
        : readPositiveIntEnv('TRACKING_PIXEL_RATE_LIMIT_MAX', 120, env),
    timeWindow: '1 minute',
  };
}

async function openPixel(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { token } = request.params as OpenParams;

  // Best effort, and intentionally awaited: the write is a single indexed
  // updateMany, and awaiting it keeps the request from finishing before the
  // open is durable. Nothing it returns changes the response.
  await recordEmailOpen(stripPixelExtension(token), { logger: request.log });

  return reply
    .status(200)
    .header('Content-Type', TRACKING_PIXEL_CONTENT_TYPE)
    .header('Content-Length', String(TRACKING_PIXEL_GIF.byteLength))
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    .header('Pragma', 'no-cache')
    .header('Expires', '0')
    .header('Content-Disposition', 'inline')
    // The pixel is not a document; make sure nothing tries to sniff it into one.
    .header('X-Content-Type-Options', 'nosniff')
    .send(TRACKING_PIXEL_GIF);
}

export default async function trackingRoutes(fastify: FastifyInstance): Promise<void> {
  // One parametric route rather than a `/:token.gif` static-suffix route, so
  // both the bare token and the .gif form land here.
  fastify.get('/open/:token', {
    config: { rateLimit: openTrackingRateLimit() },
  }, openPixel);
}

export const TrackingRouteHandlers = { openPixel };
