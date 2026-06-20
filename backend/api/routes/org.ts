import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticate } from '../preHandlers';
import { OrgController } from '../controllers/org';

const orgRoutes: FastifyPluginAsyncZod = async (server) => {
  server.get('/', { preHandler: [authenticate] }, OrgController.getOrgSettings);

  server.patch('/settings', {
    preHandler: [authenticate],
    schema: {
      body: z.object({
        monthly_revenue_target: z.number().positive().nullable().optional(),
      }),
    },
  }, OrgController.updateOrgSettings);
};

export default orgRoutes;
