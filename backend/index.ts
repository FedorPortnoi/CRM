import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import authRoutes from './api/routes/auth';
import contactsRoutes from './api/routes/contacts';
import dealsRoutes from './api/routes/deals';
import tasksRoutes from './api/routes/tasks';
import messagesRoutes from './api/routes/messages';
import calendarRoutes from './api/routes/calendar';
import analyticsRoutes from './api/routes/analytics';

async function start() {
  const useMcp = process.env.ENABLE_MCP === 'true';
  const server = Fastify({
    logger: useMcp ? { stream: process.stderr } : true,
  });

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  await server.register(cors, { origin: true });
  await server.register(jwt, { secret: process.env.JWT_SECRET ?? '' });

  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(contactsRoutes, { prefix: '/api/v1/contacts' });
  await server.register(dealsRoutes, { prefix: '/api/v1/deals' });
  await server.register(tasksRoutes, { prefix: '/api/v1/tasks' });
  await server.register(messagesRoutes, { prefix: '/api/v1/messages' });
  await server.register(calendarRoutes, { prefix: '/api/v1/calendar' });
  await server.register(analyticsRoutes, { prefix: '/api/v1/analytics' });

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
