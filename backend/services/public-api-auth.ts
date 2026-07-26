/**
 * public-api-auth.ts
 *
 * Bearer-token authentication for the public REST API (`/public/v1`).
 *
 * ── Why this is not the normal auth path ────────────────────────────────────
 * Every other route in this backend runs behind `enforceAuthenticatedApiRequest`
 * and therefore has a *user*: `request.user.sub` identifies a person, and
 * member/viewer reads are narrowed further by the visibility cone in
 * services/visibility.ts.  An API key has no user session, so there is no "who
 * is asking" to build a cone from.
 *
 * ── The decision, stated explicitly ─────────────────────────────────────────
 * An API key is ORG-LEVEL access.  It sees every record in
 * `ApiKey.organization_id` and nothing outside it.  The visibility cone is NOT
 * applied to public-API requests, because there is no requesting user to centre
 * it on and silently substituting one would either under-serve the integration
 * (records vanish depending on which admin happened to mint the key) or
 * over-serve it (a member's key quietly gaining org-wide reach).  Concretely,
 * requests are executed with `role: 'admin'`, which makes
 * `getVisibleUserIds` / `getAccessibleUserIds` return `null` — "no per-user
 * restriction" — while `organization_id` scoping, the actual tenant boundary,
 * still applies to every single query.
 *
 * The consequences that follow from that decision, and how they are contained:
 *   • Keys are minted by owners/admins only (see the api-keys routes), so
 *     granting one is already an org-level act.
 *   • Reach is narrowed by SCOPE instead of by hierarchy — `contacts:read` etc.
 *     A read-only key cannot write; a contacts key cannot touch deals.
 *   • Every public request is rate-limited per key, independently of the global
 *     IP limiter, so one integration cannot exhaust the org's budget.
 *   • `last_used_at` is stamped on every accepted request so an unused or
 *     leaked key is visible in the UI.
 *
 * ── The one query that is not org-scoped ────────────────────────────────────
 * The credential lookup itself (`findUnique` on `key_hash`) cannot be
 * org-scoped: the key IS what establishes which organization is asking.  It is
 * a lookup on a unique 256-bit secret, and every query after it — including the
 * `last_used_at` touch — carries `organization_id`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { db } from './db';
import {
  hashApiKey,
  isApiKeyUsable,
  looksLikeApiKey,
  parseApiKeyScopes,
  type ApiKeyScope,
} from './api-keys';

export type PublicApiContext = {
  key_id: string;
  org_id: string;
  scopes: ApiKeyScope[];
  /**
   * The user records created through this key are attributed to.  Resolved from
   * the key's creator, falling back to an active owner/admin if that account was
   * deactivated or deleted.  `null` only when the org has no active
   * owner/admin — reads still work, writes are refused.
   */
  actor_user_id: string | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    publicApi?: PublicApiContext | null;
  }
}

// ─── Per-key rate limiting ────────────────────────────────────────────────────
//
// The global @fastify/rate-limit plugin buckets by IP, which is the wrong axis
// for machine traffic: a single integration host would spend the whole org's
// budget, and several orgs behind one NAT would collide.  This is a second,
// independent bucket keyed by API key id.

type RateBucket = { count: number; reset_at: number };

const rateBuckets = new Map<string, RateBucket>();
let nextSweepAt = 0;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPublicApiRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  if (env.NODE_ENV === 'test') {
    return 10_000;
  }

  return positiveInt(env.PUBLIC_API_RATE_LIMIT_MAX_REQUESTS, 60);
}

export function getPublicApiRateLimitWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.PUBLIC_API_RATE_LIMIT_WINDOW_MS, 60_000);
}

/** Test seam — drops all buckets. */
export function resetPublicApiRateLimits(): void {
  rateBuckets.clear();
  nextSweepAt = 0;
}

export type RateLimitDecision =
  | { allowed: true; remaining: number; reset_at: number }
  | { allowed: false; retry_after_ms: number; reset_at: number };

export function consumePublicApiRateLimit(
  keyId: string,
  nowMs: number = Date.now(),
  max: number = getPublicApiRateLimitMax(),
  windowMs: number = getPublicApiRateLimitWindowMs(),
): RateLimitDecision {
  // Buckets are only reclaimed once per window so the sweep cost stays amortised.
  if (nowMs >= nextSweepAt) {
    for (const [id, bucket] of rateBuckets) {
      if (bucket.reset_at <= nowMs) {
        rateBuckets.delete(id);
      }
    }
    nextSweepAt = nowMs + windowMs;
  }

  const current = rateBuckets.get(keyId);
  const bucket = !current || current.reset_at <= nowMs
    ? { count: 0, reset_at: nowMs + windowMs }
    : current;

  if (bucket.count >= max) {
    return {
      allowed: false,
      retry_after_ms: Math.max(1, bucket.reset_at - nowMs),
      reset_at: bucket.reset_at,
    };
  }

  bucket.count += 1;
  rateBuckets.set(keyId, bucket);

  return { allowed: true, remaining: Math.max(0, max - bucket.count), reset_at: bucket.reset_at };
}

// ─── Token extraction ─────────────────────────────────────────────────────────

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1] || !looksLikeApiKey(match[1])) {
    return null;
  }

  return match[1];
}

function unauthorized(reply: FastifyReply): FastifyReply {
  // One message for every failure mode (absent / malformed / unknown / revoked /
  // expired) so probing cannot distinguish "no such key" from "revoked key".
  //
  // MUST be returned by the caller, not just called. A Fastify preHandler that
  // sends a reply but resolves to undefined does not halt the hook chain — the
  // route handler then runs and sends a second response, which throws
  // ERR_HTTP_HEADERS_SENT off the reply lifecycle and takes the process down.
  // An unauthenticated request could therefore kill the server.
  reply.header('WWW-Authenticate', 'Bearer realm="4kub-public-api"');
  return reply.status(401).send({
    error: { code: 'UNAUTHORIZED', message: 'Invalid, revoked, or expired API key' },
  });
}

// ─── Actor resolution ─────────────────────────────────────────────────────────

/**
 * Pick the user that records created through this key are attributed to.  The
 * key's creator is preferred; when that account is gone or deactivated we fall
 * back to an active owner (then admin) so a departing admin does not silently
 * break a working integration.  Both lookups are org-scoped.
 */
async function resolveActorUserId(orgId: string, createdBy: string | null): Promise<string | null> {
  if (createdBy) {
    const creator = await db.user.findFirst({
      where: { id: createdBy, organization_id: orgId, is_active: true },
      select: { id: true },
    });

    if (creator) {
      return creator.id;
    }
  }

  const fallback = await db.user.findFirst({
    where: {
      organization_id: orgId,
      is_active: true,
      role: { in: [UserRole.owner, UserRole.admin] },
    },
    // UserRole is declared owner → admin → member → viewer, so ascending order
    // prefers the owner.
    orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
    select: { id: true },
  });

  return fallback?.id ?? null;
}

// ─── preHandlers ──────────────────────────────────────────────────────────────

/**
 * Resolve `Authorization: Bearer <api key>` into a `PublicApiContext` and hang
 * it off the request.  Sends 401/429 itself and leaves `request.publicApi`
 * unset when it does, so downstream preHandlers must never assume it is there.
 */
export async function authenticatePublicApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const token = extractBearerToken(request);
  if (!token) {
    return unauthorized(reply);
  }

  // Authentication bootstrap — see the file header. The credential is what
  // establishes organization_id, so this single lookup cannot be org-scoped.
  const apiKey = await db.apiKey.findUnique({
    where: { key_hash: hashApiKey(token) },
    select: {
      id: true,
      organization_id: true,
      created_by: true,
      scopes: true,
      revoked_at: true,
      expires_at: true,
    },
  });

  if (!apiKey || !isApiKeyUsable(apiKey)) {
    return unauthorized(reply);
  }

  const rate = consumePublicApiRateLimit(apiKey.id);
  if (!rate.allowed) {
    reply.header('Retry-After', String(Math.ceil(rate.retry_after_ms / 1000)));
    return reply.status(429).send({
      error: { code: 'RATE_LIMITED', message: 'Public API rate limit exceeded' },
    });
    return;
  }

  const touched = await db.apiKey.updateMany({
    where: { id: apiKey.id, organization_id: apiKey.organization_id, revoked_at: null },
    data: { last_used_at: new Date() },
  });

  // A revocation racing this request between the lookup and the touch must win.
  if (touched.count !== 1) {
    return unauthorized(reply);
  }

  request.publicApi = {
    key_id: apiKey.id,
    org_id: apiKey.organization_id,
    scopes: parseApiKeyScopes(apiKey.scopes),
    actor_user_id: await resolveActorUserId(apiKey.organization_id, apiKey.created_by),
  };
}

/**
 * Build a preHandler that rejects the request unless the key carries `scope`.
 * Always chained after `authenticatePublicApiKey`.
 */
export function requirePublicApiScope(scope: ApiKeyScope) {
  return async function enforceScope(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    const context = request.publicApi;
    if (!context) {
      return unauthorized(reply);
    }

    if (!context.scopes.includes(scope)) {
      return reply.status(403).send({
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: `This API key is missing the "${scope}" scope`,
        },
      });
    }
  };
}
