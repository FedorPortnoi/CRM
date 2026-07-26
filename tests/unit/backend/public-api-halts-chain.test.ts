/**
 * Regression test for an unauthenticated remote crash.
 *
 * The public-API preHandlers used to call `reply.status(401).send(...)` and then
 * resolve to `undefined`. Fastify does not treat that as "the request is handled":
 * the hook chain continued into the route handler, which sent a second response,
 * which threw ERR_HTTP_HEADERS_SENT off the reply lifecycle where nothing catches
 * it — taking the whole process down. Any request to /public/v1/* with a bad API
 * key could kill the API.
 *
 * The unit suite missed it because it tested the auth helpers in isolation rather
 * than through a real Fastify lifecycle. These tests assert the contract that
 * actually matters: a rejecting preHandler must RESOLVE TO THE REPLY, because that
 * is what halts the chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../backend/services/db', () => ({
  db: {
    apiKey: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
    user: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import {
  authenticatePublicApiKey,
  requirePublicApiScope,
} from '../../../backend/services/public-api-auth';

/** Minimal stand-in for FastifyReply that records what was sent. */
function makeReply() {
  const reply: Record<string, unknown> = {};
  reply.statusCode = undefined;
  reply.payload = undefined;
  reply.header = vi.fn(() => reply);
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((body: unknown) => {
    reply.payload = body;
    return reply;
  });
  return reply;
}

function makeRequest(headers: Record<string, string> = {}) {
  return { headers, url: '/public/v1/contacts', method: 'GET' } as never;
}

describe('public API preHandlers halt the hook chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the reply when the Authorization header is absent', async () => {
    const reply = makeReply();
    const result = await authenticatePublicApiKey(makeRequest(), reply as never);

    expect(reply.statusCode).toBe(401);
    // The assertion that matters: resolving to undefined would let the route
    // handler run and send a second response, crashing the process.
    expect(result).toBe(reply);
  });

  it('returns the reply when the bearer token is malformed', async () => {
    const reply = makeReply();
    const result = await authenticatePublicApiKey(
      makeRequest({ authorization: 'Bearer not-a-real-key' }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe(reply);
  });

  it('returns the reply when the key is well formed but unknown', async () => {
    const reply = makeReply();
    const result = await authenticatePublicApiKey(
      makeRequest({ authorization: `Bearer kub_live_${'a'.repeat(32)}` }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(result).toBe(reply);
  });

  it('returns the reply when the key lacks the required scope', async () => {
    const reply = makeReply();
    const request = makeRequest();
    (request as unknown as Record<string, unknown>).publicApi = {
      key_id: 'k',
      org_id: 'o',
      scopes: ['contacts:read'],
      actor_user_id: null,
    };

    const enforce = requirePublicApiScope('contacts:write');
    const result = await enforce(request, reply as never);

    expect(reply.statusCode).toBe(403);
    expect(result).toBe(reply);
  });

  it('returns the reply when no public-API context was established', async () => {
    const reply = makeReply();
    const enforce = requirePublicApiScope('contacts:read');
    const result = await enforce(makeRequest(), reply as never);

    expect(reply.statusCode).toBe(401);
    expect(result).toBe(reply);
  });
});
