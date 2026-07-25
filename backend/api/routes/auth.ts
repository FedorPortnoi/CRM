import { FastifyRequest } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthController } from '../controllers/auth';

const PasswordSchema = z.string().min(8).max(100)
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number')
  .regex(/[^A-Za-z0-9]/, 'Password must include a symbol');

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: PasswordSchema,
  name: z.string().min(1).max(100),
  org_name: z.string().min(1).max(200),
  phone: z.string().min(10).max(20),
});

const VerifyOtpSchema = z.object({
  user_id: z.string().uuid(),
  code: z.string().length(6).regex(/^\d{6}$/),
});

const ResendVerificationSchema = z.object({
  user_id: z.string().uuid(),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const JoinSchema = z.object({
  company_code: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(201),
  password: z.string().min(1),
});

const InviteSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member', 'viewer']),
});

const SetCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  new_password: PasswordSchema,
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(100),
  new_password: PasswordSchema,
});

const SetManagerSchema = z.object({
  manager_id: z.string().uuid().nullable(),
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

function authRateLimit(max: number, timeWindow: string, includeEmail = false) {
  return {
    max: process.env.NODE_ENV === 'test' ? 10_000 : max,
    timeWindow,
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest): string => {
      if (!includeEmail) {
        return request.ip;
      }

      const body = request.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown';
      return `${request.ip}:${email}`;
    },
  };
}

const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post('/', {
    config: { rateLimit: authRateLimit(5, '15 minutes') },
    schema: { body: RegisterSchema },
  }, AuthController.register);
  fastify.post('/login', {
    config: { rateLimit: authRateLimit(5, '15 minutes', true) },
    schema: { body: LoginSchema },
  }, AuthController.login);
  fastify.post('/join', {
    config: { rateLimit: authRateLimit(5, '15 minutes') },
    schema: { body: JoinSchema },
  }, AuthController.join);
  fastify.post('/logout', AuthController.logout);
  fastify.post('/logout-all', AuthController.logoutAll);
  fastify.get('/sessions', AuthController.listSessions);
  fastify.get('/audit', {
    schema: { querystring: AuditQuerySchema },
  }, AuthController.listAuditEvents);
  fastify.get('/users', AuthController.listUsers);
  fastify.post('/users/invite', {
    schema: { body: InviteSchema },
  }, AuthController.inviteUser);
  fastify.patch('/users/:id/deactivate', AuthController.deactivateUser);
  fastify.patch('/users/:id/role', {
    schema: { body: z.object({ role: z.enum(['admin', 'member', 'viewer']) }) },
  }, AuthController.changeUserRole);
  fastify.patch('/users/:id/manager', {
    schema: { body: SetManagerSchema },
  }, AuthController.setUserManager);
  fastify.get('/company-code', AuthController.getCompanyCode);
  fastify.post('/company-code/rotate', AuthController.rotateCompanyCode);
  fastify.patch('/me/password', {
    schema: { body: ChangePasswordSchema },
  }, AuthController.changePassword);
  fastify.patch('/me/credentials', {
    schema: { body: SetCredentialsSchema },
  }, AuthController.setCredentials);
  fastify.post('/verify', {
    config: { rateLimit: authRateLimit(10, '15 minutes') },
    schema: { body: VerifyOtpSchema },
  }, AuthController.verifyOtp);
  fastify.post('/verify/resend', {
    config: { rateLimit: authRateLimit(3, '5 minutes') },
    schema: { body: ResendVerificationSchema },
  }, AuthController.resendVerification);
};

export default authRoutes;
