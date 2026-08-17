import './config/env';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { getCorsOrigin, getJwtSecret, validateProductionConfig } from './config/security';
import { enforceAuthenticatedApiRequest } from './api/authenticate';
import { auditSensitiveApiRequest } from './services/audit';
import { HybridRateLimitStore, RateLimitStoreError } from './services/rate-limit-store';
import authRoutes from './api/routes/auth';
import contactsRoutes from './api/routes/contacts';
import dealsRoutes from './api/routes/deals';
import tasksRoutes from './api/routes/tasks';
import messagesRoutes from './api/routes/messages';
import calendarRoutes from './api/routes/calendar';
import analyticsRoutes from './api/routes/analytics';
import notificationsRoutes from './api/routes/notifications';
import workflowsRoutes from './api/routes/workflows';
import syncRoutes from './api/routes/sync';
import capturesRoutes from './api/routes/captures';
import onboardingRoutes from './api/routes/onboarding';
import exportRoutes from './api/routes/export';
import { activitiesRoutes } from './api/routes/activities';
import { attachmentsRoutes } from './api/routes/attachments';
import chatRoutes from './api/routes/chat';
import importsRoutes from './api/routes/imports';
import amocrmRoutes from './api/routes/amocrm';
import amocrmWebhookRoutes from './api/routes/amocrm-webhook';
import leadInboxRoutes from './api/routes/lead-inbox';
import orgRoutes from './api/routes/org';
import reportingRoutes from './api/routes/reporting';
import webhooksRoutes from './api/routes/webhooks';
import assistantRoutes from './api/routes/assistant';
import contactAiRoutes from './api/routes/contact-ai';
import sequencesRoutes, { consentRoutes } from './api/routes/sequences';
import emailTemplatesRoutes from './api/routes/email-templates';
import trackingRoutes from './api/routes/tracking';
import updatesRoutes from './api/routes/updates';
import publicApiRoutes, { apiKeysRoutes } from './api/routes/public-api';
import { wsRoutes } from './api/routes/ws';
import debugLogRoutes from './api/routes/debug-log';
import { startScheduler } from './services/scheduler';

// The version this endpoint advertises drives the "update available" alert in
// src/app/_layout.tsx, which compares versionCode against the installed build. It is read
// from app.json rather than repeated as a literal here: the literal drifted, and the
// endpoint spent several releases reporting 1.0.2 / 5 while the shipped app was far ahead,
// which silently disabled the prompt. app.json sits above backend/ rootDir, so it cannot be
// imported — resolve it at runtime instead, from cwd first (how pm2 and tsx both start).
function readAppVersion(): { version: string; versionCode: number } {
  const candidates = [process.cwd(), resolve(__dirname, '..'), resolve(__dirname, '../..')];
  for (const dir of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')) as {
        expo?: { version?: string; android?: { versionCode?: number } };
      };
      if (parsed.expo?.version) {
        return {
          version: parsed.expo.version,
          versionCode: parsed.expo.android?.versionCode ?? 0,
        };
      }
    } catch {
      // Not here, or unreadable — try the next candidate.
    }
  }
  // versionCode 0 never satisfies `body.versionCode > currentVersionCode`, so an unreadable
  // app.json disables the prompt rather than nagging every client.
  return { version: '0.0.0', versionCode: 0 };
}

const APP_VERSION = readAppVersion();

type ApiError = Error & {
  code?: string;
  statusCode?: number;
  validation?: unknown;
};

function toApiError(err: unknown): ApiError {
  if (err instanceof Error) {
    return err as ApiError;
  }

  return new Error('Unknown server error') as ApiError;
}

function errorCodeFor(statusCode: number, err: ApiError): string {
  if (err.validation || err.code === 'FST_ERR_VALIDATION') {
    return 'VALIDATION_ERROR';
  }

  if (statusCode === 401) {
    return 'UNAUTHORIZED';
  }

  if (statusCode === 404) {
    return 'NOT_FOUND';
  }

  if (statusCode >= 500) {
    return 'INTERNAL_SERVER_ERROR';
  }

  return err.code && !err.code.startsWith('FST_') ? err.code : 'BAD_REQUEST';
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getRateLimitMax(): number {
  if (process.env.NODE_ENV === 'test') {
    return 10_000;
  }

  return readPositiveIntEnv('RATE_LIMIT_MAX_REQUESTS', 100);
}

function getRateLimitWindowMs(): number {
  return readPositiveIntEnv('RATE_LIMIT_WINDOW_MS', 60_000);
}

async function start() {
  validateProductionConfig();

  const useMcp = process.env.ENABLE_MCP === 'true';
  // TRUSTED_PROXY: set this to the trusted reverse proxy's IP/CIDR (or a hop-count
  // integer string) when the app runs behind a proxy/load balancer that sets
  // X-Forwarded-For. Fastify then only honors XFF from that trusted hop. Left unset,
  // trustProxy is false and request.ip is the real socket IP, so a client can't spoof
  // X-Forwarded-For to bypass IP-based rate limits.
  const trustProxy = process.env.TRUSTED_PROXY ? process.env.TRUSTED_PROXY : false;
  const server = Fastify({
    bodyLimit: readPositiveIntEnv('REQUEST_BODY_LIMIT_BYTES', 16 * 1024 * 1024),
    logger: useMcp ? { stream: process.stderr } : true,
    trustProxy,
  });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  server.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }

    return payload;
  });

  server.addHook('onResponse', async (request, reply) => {
    await auditSensitiveApiRequest(request, reply.statusCode);
  });

  server.setErrorHandler((err, request, reply) => {
    // The durable auth rate limiter fails CLOSED — see services/rate-limit-store.ts.
    // Without this branch the refusal surfaces as an opaque 500
    // INTERNAL_SERVER_ERROR that reads like a code bug rather than a dependency
    // being down, and nothing in the logs names the cause.
    if (err instanceof RateLimitStoreError) {
      request.log.error({ err }, '[rate-limit] durable store unavailable — refusing auth request');
      reply.status(503).header('retry-after', '30').send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
      });
      return;
    }

    if (
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2023' ||
      err instanceof Prisma.PrismaClientValidationError && err.message.includes('UUID')
    ) {
      reply.status(400).send({ error: { code: 'INVALID_ID', message: 'Invalid identifier format' } });
      return;
    }

    const apiError = toApiError(err);
    const statusCode = apiError.statusCode && apiError.statusCode >= 400 ? apiError.statusCode : 500;
    const message = statusCode >= 500 ? 'Internal server error' : apiError.message;

    if (!reply.sent && request.url.startsWith('/api/')) {
      reply.status(statusCode).send({
        error: {
          code: errorCodeFor(statusCode, apiError),
          message,
        },
      });
      return;
    }

    reply.send(apiError);
  });

  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
      return;
    }

    reply.status(404).send({ error: 'Not Found', message: 'Route not found', statusCode: 404 });
  });

  await server.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });
  await server.register(cors, { origin: getCorsOrigin() });
  await server.register(formbody);
  await server.register(jwt, { secret: getJwtSecret() });
  // `store` is read ONLY here, once, at plugin registration — never from a route's
  // `config.rateLimit` (@fastify/rate-limit index.js:115-117). Without this line
  // the `store: PostgresRateLimitStore` written on the eight auth routes is inert
  // and every one of their budgets is an in-process LruMap that a restart wipes.
  // HybridRateLimitStore's child() is what honours the route-level declaration;
  // everything else — this global 100/min limiter, the tracking pixel, the OTA
  // manifest and assets, the amoCRM webhook — stays in process on purpose.
  await server.register(rateLimit, {
    max: getRateLimitMax(),
    timeWindow: getRateLimitWindowMs(),
    store: HybridRateLimitStore,
  });

  await server.register(websocket);
  await server.register(wsRoutes, { prefix: '/api/v1' });

  // NOTE ON ORDERING: a preHandler added to the root instance applies to EVERY route,
  // including plugins registered before this line — Fastify resolves route hooks at
  // preReady, not at registration time. Registration order therefore grants no
  // exemption. What decides whether a route is enforced is entirely inside
  // enforceAuthenticatedApiRequest: it returns early unless the URL starts with
  // '/api/v1/', and then again for the paths listed in isPublicApiRoute().
  //   GET /api/v1/ws         -> listed in isPublicApiRoute, exempt; the socket handler
  //                             authenticates the ticket/JWT itself.
  //   GET /api/v1/ws/ticket  -> NOT listed, so it gets the full check (JWT + active user
  //                             + live session + role refresh). Being a GET, the
  //                             viewer read-only rule lets viewers mint tickets.
  //   /public/v1/*           -> not under /api/v1, so the hook returns on its first line
  //                             and the API-key preHandlers in the plugin are the only
  //                             auth. Never move the public API under /api/v1: that would
  //                             demand a JWT session an API key cannot have.
  server.addHook('preHandler', enforceAuthenticatedApiRequest);

  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(contactsRoutes, { prefix: '/api/v1/contacts' });
  await server.register(dealsRoutes, { prefix: '/api/v1/deals' });
  await server.register(tasksRoutes, { prefix: '/api/v1/tasks' });
  await server.register(messagesRoutes, { prefix: '/api/v1/messages' });
  await server.register(calendarRoutes, { prefix: '/api/v1/calendar' });
  await server.register(analyticsRoutes, { prefix: '/api/v1/analytics' });
  await server.register(notificationsRoutes, { prefix: '/api/v1/notifications' });
  await server.register(workflowsRoutes, { prefix: '/api/v1/workflows' });
  await server.register(syncRoutes, { prefix: '/api/v1/sync' });
  await server.register(capturesRoutes, { prefix: '/api/v1/captures' });
  await server.register(onboardingRoutes, { prefix: '/api/v1/onboarding' });
  await server.register(exportRoutes, { prefix: '/api/v1/export' });
  await server.register(activitiesRoutes, { prefix: '/api/v1' });
  await server.register(attachmentsRoutes, { prefix: '/api/v1' });
  await server.register(chatRoutes, { prefix: '/api/v1/chat' });
  await server.register(importsRoutes, { prefix: '/api/v1/import' });
  await server.register(amocrmRoutes, { prefix: '/api/v1/amocrm' });
  await server.register(amocrmWebhookRoutes, { prefix: '/api/v1/integrations/amocrm' });
  await server.register(leadInboxRoutes, { prefix: '/api/v1/integrations/lead-inbox' });
  await server.register(orgRoutes, { prefix: '/api/v1/org' });
  await server.register(reportingRoutes, { prefix: '/api/v1/reports' });
  await server.register(webhooksRoutes, { prefix: '/api/v1/webhooks' });
  await server.register(assistantRoutes, { prefix: '/api/v1/assistant' });
  await server.register(contactAiRoutes, { prefix: '/api/v1/ai' });
  await server.register(sequencesRoutes, { prefix: '/api/v1/sequences' });
  await server.register(consentRoutes, { prefix: '/api/v1/consent' });
  await server.register(emailTemplatesRoutes, { prefix: '/api/v1/email-templates' });
  // Open-tracking pixel. GET /api/v1/tracking/open/:token is the ONLY route in this
  // plugin and the only thing exempted from the auth hook — see isPublicApiRoute().
  // Its own per-IP rate limit is declared on the route, not here.
  await server.register(trackingRoutes, { prefix: '/api/v1/tracking' });
  await server.register(updatesRoutes, { prefix: '/api/v1/updates' });
  // Session-authenticated console for minting/revoking API keys. Must stay under
  // /api/v1 so the global preHandler refreshes request.user.role from the DB before
  // the plugin's own owner/admin check reads it.
  await server.register(apiKeysRoutes, { prefix: '/api/v1/api-keys' });

  // Machine-facing REST API, authenticated by `Authorization: Bearer kub_live_…`.
  // Deliberately mounted outside /api/v1 — see the note on enforceAuthenticatedApiRequest
  // above. The plugin installs its own error/not-found handlers and Cache-Control hook
  // because the ones on this instance only fire for /api/ URLs.
  await server.register(publicApiRoutes, { prefix: '/public/v1' });

  // Client-reported debug log intake — see the header comment in
  // api/routes/debug-log.ts for why this is outside /api/v1 too.
  await server.register(debugLogRoutes, { prefix: '/debug' });

  server.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  server.get('/version', async () => {
    return {
      version: process.env.APP_VERSION ?? APP_VERSION.version,
      versionCode: parseInt(process.env.APP_VERSION_CODE ?? String(APP_VERSION.versionCode), 10),
    };
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  const port = parseInt(process.env.PORT ?? '3000', 10);

  try {
    // BIND_HOST exists because 0.0.0.0 is only safe behind something that is
    // filtering. On the cloud VM that was the security group — only 22/80/443
    // were reachable, so binding every interface cost nothing. Self-hosted on a
    // home network there is no such filter: every phone, TV and IoT device on
    // the same wifi can reach an 0.0.0.0 port directly, which means reaching the
    // API without passing through Cloudflare at all.
    //
    // The default stays 0.0.0.0 so a containerised or cloud deployment behaves
    // exactly as before — those need to accept traffic from outside their own
    // loopback. A self-hosted deployment sets 127.0.0.1, because cloudflared
    // connects from loopback and nothing else has any business connecting.
    const host = process.env.BIND_HOST?.trim() || '0.0.0.0';
    await server.listen({ port, host });
    startScheduler();

    if (process.env.ENABLE_MCP === 'true') {
      const { startMcp } = await import('./mcp/server');
      await startMcp();
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

void start().catch((err) => {
  console.error(err);
  process.exit(1);
});
