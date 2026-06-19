import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OnboardingController } from '../controllers/onboarding';
import { authenticate } from '../preHandlers';

const UpdateStateSchema = z.object({
  completed_steps: z.array(z.string()).optional(),
  dismissed_tooltips: z.array(z.string()).optional(),
  completed_at: z.string().nullable().optional(),
});

export default async function onboardingRoutes(fastify: FastifyInstance): Promise<void> {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', { preHandler: [authenticate] }, OnboardingController.getState);

  f.patch('/', {
    preHandler: [authenticate],
    schema: { body: UpdateStateSchema },
  }, OnboardingController.updateState);
}
