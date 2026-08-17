/**
 * Client-reported debug log intake.
 *
 *   POST /debug/log
 *
 * Deliberately mounted outside /api/v1 (see the note on
 * enforceAuthenticatedApiRequest in backend/index.ts) — this must accept a
 * report of a login failure or a crash before login, so it cannot require a
 * session. There is nothing here for an attacker to gain by spamming it
 * beyond noise in the logs, which the per-IP rate limit and size caps below
 * bound.
 *
 * Entries land in the same structured logger as backend/services/logger.ts,
 * tagged 'mobile' (or the client-supplied tag), so `scripts/debug-tail.js`
 * shows them interleaved with backend logs in one stream — that's the point
 * of a *central* debugging system: one place to look, not two.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { log } from '../../services/logger';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONTEXT_BYTES = 8 * 1024;
const MAX_CONTEXT_DEPTH = 5;

const PII_KEYS = new Set([
  'email', 'phone', 'mobile', 'password', 'token', 'secret',
  'access_token', 'refresh_token', 'push_token', 'device_token',
  'authorization', 'cookie',
]);

function stripPii(value: unknown, depth = 0): unknown {
  if (depth > MAX_CONTEXT_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripPii(entry, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = PII_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : stripPii(entry, depth + 1);
  }
  return result;
}

type DebugLogBody = {
  level?: unknown;
  message?: unknown;
  tag?: unknown;
  context?: unknown;
};

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function handleDebugLog(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const body = (request.body ?? {}) as DebugLogBody;

  const message = typeof body.message === 'string' ? body.message.slice(0, MAX_MESSAGE_LENGTH) : '';
  if (!message) {
    return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'message is required' } });
  }

  const level = typeof body.level === 'string' && LEVELS.has(body.level) ? body.level : 'error';
  const tag = typeof body.tag === 'string' && body.tag.trim() ? body.tag.trim().slice(0, 40) : 'mobile';

  let context: unknown;
  if (body.context && typeof body.context === 'object') {
    const cleaned = stripPii(body.context);
    if (Buffer.byteLength(JSON.stringify(cleaned)) <= MAX_CONTEXT_BYTES) {
      context = cleaned;
    } else {
      context = { truncated: true };
    }
  }

  log[level as 'debug' | 'info' | 'warn' | 'error'](tag, message, {
    source: 'client',
    ip: request.ip,
    context,
  });

  return reply.status(204).send();
}

export default async function debugLogRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/log', {
    config: {
      rateLimit: {
        max: readPositiveIntEnv('DEBUG_LOG_RATE_LIMIT_MAX', 30),
        timeWindow: '1 minute',
      },
    },
  }, handleDebugLog);
}
