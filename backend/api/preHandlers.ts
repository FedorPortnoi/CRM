import { FastifyRequest, FastifyReply } from 'fastify';

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.user && request.user.sub) return;
  await request.jwtVerify();
}
