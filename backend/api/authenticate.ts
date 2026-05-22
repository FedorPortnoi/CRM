import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../services/db';

type AuthenticatedRole = 'owner' | 'admin' | 'member' | 'viewer';

function apiPath(request: FastifyRequest): string {
  const path = request.url.split('?')[0]?.replace(/\/+$/, '');
  return path && path.length > 0 ? path : '/';
}

function isPublicApiRoute(request: FastifyRequest): boolean {
  const path = apiPath(request);
  const method = request.method.toUpperCase();

  if (method === 'POST' && (path === '/api/v1/auth' || path === '/api/v1/auth/login')) {
    return true;
  }

  if (method === 'GET' && path === '/api/v1/calendar/sync/yandex/callback') {
    return true;
  }

  if (method === 'POST' && path === '/api/v1/calendar/webhooks/yandex') {
    return true;
  }

  return (
    method === 'POST' &&
    (path === '/api/v1/messages/webhooks/sms/inbound' ||
      path === '/api/v1/messages/webhooks/sms/status')
  );
}

export async function enforceAuthenticatedApiRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.url.startsWith('/api/v1/') || isPublicApiRoute(request)) {
    return;
  }

  await request.jwtVerify();

  const tokenUser = request.user;
  if (!tokenUser.sub || !tokenUser.org_id) {
    reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token' },
    });
    return;
  }

  const activeUser = await db.user.findFirst({
    where: {
      id: tokenUser.sub,
      organization_id: tokenUser.org_id,
      is_active: true,
    },
    select: { id: true, organization_id: true, role: true },
  });

  if (!activeUser) {
    reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'User is inactive or no longer belongs to this organization' },
    });
    return;
  }

  request.user = {
    ...tokenUser,
    role: activeUser.role as AuthenticatedRole,
  };
}
