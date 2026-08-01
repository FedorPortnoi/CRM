import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotificationsController } from '../controllers/notifications';
import { authenticate } from '../preHandlers';

const notificationsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/register',
    {
      preHandler: [authenticate],
      schema: {
        body: z.object({
          token: z.string().trim().min(16).max(4096),
          provider: z.enum(['rustore', 'apns', 'expo', 'fcm']).optional(),
          platform: z.enum(['android', 'ios', 'web']).optional(),
          app_version: z.string().trim().min(1).max(64).optional(),
          device_name: z.string().trim().min(1).max(200).optional(),
        }),
      },
    },
    NotificationsController.registerToken,
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
