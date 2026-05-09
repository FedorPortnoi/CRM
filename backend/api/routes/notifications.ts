import { FastifyRequest, FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotificationsController } from '../controllers/notifications';

const RegisterTokenSchema = z.object({
  token: z.string().min(1),
});

const SendNotificationSchema = z.object({
  user_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

const notificationsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/register',
    {
      preHandler: [authenticate],
      schema: { body: RegisterTokenSchema },
    },
    NotificationsController.registerToken,
  );

  fastify.post(
    '/send',
    {
      preHandler: [authenticate],
      schema: { body: SendNotificationSchema },
    },
    NotificationsController.sendNotification,
  );
};

export default notificationsRoutes;
