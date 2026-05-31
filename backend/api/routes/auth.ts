import { FastifyReply, FastifyRequest } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthController } from '../controllers/auth';

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(100)
    .regex(/[a-z]/, 'Password must include a lowercase letter')
    .regex(/[A-Z]/, 'Password must include an uppercase letter')
    .regex(/[0-9]/, 'Password must include a number')
    .regex(/[^A-Za-z0-9]/, 'Password must include a symbol'),
  name: z.string().min(1).max(100),
  org_name: z.string().min(1).max(200),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const OnboardingSchema = z.object({
  completed: z.boolean().default(false),
  dismissed_steps: z.array(z.string().max(100)).max(20).optional(),
});

const AuditQuerySchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  user_id: z.string().uuid().optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

function authRateLimit(max: number, timeWindow: string) {
  return {
    max: process.env.NODE_ENV === 'test' ? 10_000 : max,
    timeWindow,
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest): string => {
      const body = request.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown';
      return `${request.ip}:${email}`;
    },
  };
}

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post('/', {
    config: { rateLimit: authRateLimit(5, '15 minutes') },
    schema: { body: RegisterSchema },
  }, AuthController.register);
  fastify.post('/login', {
    config: { rateLimit: authRateLimit(5, '15 minutes') },
    schema: { body: LoginSchema },
  }, AuthController.login);
  fastify.post('/logout', { preHandler: [authenticate] }, AuthController.logout);
  fastify.post('/logout-all', { preHandler: [authenticate] }, AuthController.logoutAll);
  fastify.get('/sessions', { preHandler: [authenticate] }, AuthController.listSessions);
  fastify.get('/audit', {
    preHandler: [authenticate],
    schema: { querystring: AuditQuerySchema },
  }, AuthController.listAuditEvents);
  fastify.get('/users', { preHandler: [authenticate] }, AuthController.listUsers);
  fastify.post('/users/invite', { preHandler: [authenticate] }, AuthController.inviteUser);
  fastify.patch('/users/:id/deactivate', { preHandler: [authenticate] }, AuthController.deactivateUser);
  fastify.patch('/users/:id/role', { preHandler: [authenticate] }, AuthController.changeUserRole);
  fastify.get('/onboarding', { preHandler: [authenticate] }, AuthController.getOnboarding);
  fastify.patch('/onboarding', {
    preHandler: [authenticate],
    schema: { body: OnboardingSchema },
  }, AuthController.updateOnboarding);
};

export default authRoutes;
