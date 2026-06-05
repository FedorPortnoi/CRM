import { FastifyRequest, FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotificationsController } from '../controllers/notifications';

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

const notificationsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/register',
    { preHandler: [authenticate], schema: { body: z.object({ token: z.string().min(1) }) } },
    NotificationsController.registerToken,
  );

  fastify.post(
    '/send',
    {
      preHandler: [authenticate],
      schema: { body: z.object({ user_id: z.string().uuid(), title: z.string().min(1).max(200), body: z.string().min(1).max(1000) }) },
    },
    NotificationsController.sendNotification,
  );

  fastify.get(
    '/',
    {
      preHandler: [authenticate],
      schema: { querystring: z.object({ page: z.coerce.number().int().positive().default(1), per_page: z.coerce.number().int().positive().max(100).default(30) }) },
    },
    NotificationsController.list,
  );

  fastify.patch(
    '/:id/read',
    { preHandler: [authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    NotificationsController.markRead,
  );

  fastify.patch(
    '/read-all',
    { preHandler: [authenticate] },
    NotificationsController.markAllRead,
  );

  fastify.get(
    '/unread-count',
    { preHandler: [authenticate] },
    NotificationsController.unreadCount,
  );
};

export default notificationsRoutes;
