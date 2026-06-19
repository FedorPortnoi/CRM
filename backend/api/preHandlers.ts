import { FastifyRequest, FastifyReply } from 'fastify';

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await request.jwtVerify();
}
