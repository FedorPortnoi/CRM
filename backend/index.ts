import './config/env';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { getCorsOrigin, getJwtSecret } from './config/security';
import { enforceAuthenticatedApiRequest } from './api/authenticate';
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
  const useMcp = process.env.ENABLE_MCP === 'true';
  const server = Fastify({
    logger: useMcp ? { stream: process.stderr } : true,
  });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  server.setErrorHandler((err, request, reply) => {
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

  await server.register(cors, { origin: getCorsOrigin() });
  await server.register(formbody);
  await server.register(jwt, { secret: getJwtSecret() });
  await server.register(rateLimit, {
    max: getRateLimitMax(),
    timeWindow: getRateLimitWindowMs(),
  });

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

  server.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  const port = parseInt(process.env.PORT ?? '3000', 10);

  try {
    await server.listen({ port, host: '0.0.0.0' });

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
