import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import jwt from '@fastify/jwt';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
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

async function start() {
  const useMcp = process.env.ENABLE_MCP === 'true';
  const server = Fastify({
    logger: useMcp ? { stream: process.stderr } : true,
  });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  await server.register(cors, { origin: true });
  await server.register(formbody);
  await server.register(jwt, { secret: process.env.JWT_SECRET ?? '' });

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

start();
