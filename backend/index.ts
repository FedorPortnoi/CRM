import './config/env';
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
import orgRoutes from './api/routes/org';
import { wsRoutes } from './api/routes/ws';
import { startScheduler } from './services/scheduler';

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
  const server = Fastify({
    bodyLimit: readPositiveIntEnv('REQUEST_BODY_LIMIT_BYTES', 16 * 1024 * 1024),
    logger: useMcp ? { stream: process.stderr } : true,
    trustProxy: true,
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
  await server.register(rateLimit, {
    max: getRateLimitMax(),
    timeWindow: getRateLimitWindowMs(),
  });

  await server.register(websocket);
  await server.register(wsRoutes, { prefix: '/api/v1' });

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
  await server.register(orgRoutes, { prefix: '/api/v1/org' });

  server.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  server.get('/version', async () => {
    return {
      version: process.env.APP_VERSION ?? '1.0.2',
      versionCode: parseInt(process.env.APP_VERSION_CODE ?? '5', 10),
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
    await server.listen({ port, host: '0.0.0.0' });
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
