import { FastifyReply, FastifyRequest } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthController } from '../controllers/auth';

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  name: z.string().min(1).max(100),
  org_name: z.string().min(1).max(200),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post('/', { schema: { body: RegisterSchema } }, AuthController.register);
  fastify.post('/login', { schema: { body: LoginSchema } }, AuthController.login);
  fastify.get('/users', { preHandler: [authenticate] }, AuthController.listUsers);
};

export default authRoutes;
