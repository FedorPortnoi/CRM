import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../services/db';
import { auditLog } from '../services/audit';
import { validateAuthSession } from '../services/sessions';

type AuthenticatedRole = 'owner' | 'admin' | 'member' | 'viewer';
type AdminRoutePolicy = {
  action: string;
  reason: string;
};

function isReadOnlyMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

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

  if (method === 'GET' && path === '/api/v1/ws') {
    return true;
  }

  if (method === 'GET' && path === '/api/v1/calendar/sync/yandex/callback') {
    return true;
  }

  if (method === 'POST' && path === '/api/v1/calendar/webhooks/yandex') {
    return true;
  }

  return false;
}

function isAdminRole(role: AuthenticatedRole): boolean {
  return role === 'owner' || role === 'admin';
}

function adminRoutePolicy(request: FastifyRequest): AdminRoutePolicy | null {
  const path = apiPath(request);
  const method = request.method.toUpperCase();

  if (method === 'GET' && path === '/api/v1/auth/audit') {
    return { action: 'audit.read', reason: 'audit access requires owner or admin' };
  }

  if (
    (method === 'POST' && path === '/api/v1/analytics/export') ||
    (method === 'GET' && path.startsWith('/api/v1/analytics/export/')) ||
    (method === 'GET' && path.startsWith('/api/v1/export/'))
  ) {
    return { action: 'data.export', reason: 'exports require owner or admin' };
  }

  if (
    method === 'POST' &&
    (
      path === '/api/v1/contacts/import' ||
      path === '/api/v1/contacts/import-csv' ||
      path === '/api/v1/contacts/import/phone' ||
      path === '/api/v1/contacts/bulk-assign' ||
      path === '/api/v1/contacts/bulk-archive' ||
      path.endsWith('/merge')
    )
  ) {
    return { action: 'contacts.bulk_admin', reason: 'bulk contact operations require owner or admin' };
  }

  if (
    path.startsWith('/api/v1/deals/pipelines') &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE')
  ) {
    return { action: 'deals.pipeline_admin', reason: 'pipeline administration requires owner or admin' };
  }

  if (
    path.startsWith('/api/v1/deals/stages') &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE')
  ) {
    return { action: 'deals.stage_admin', reason: 'stage administration requires owner or admin' };
  }

  if (
    path.startsWith('/api/v1/workflows') &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE')
  ) {
    return { action: 'workflows.admin', reason: 'workflow administration requires owner or admin' };
  }

  if (method === 'DELETE' && path === '/api/v1/onboarding/example-data') {
    return { action: 'onboarding.clear_example_data', reason: 'clearing org example data requires owner or admin' };
  }

  return null;
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
  if (!tokenUser.sub || !tokenUser.org_id || !tokenUser.sid) {
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

  const activeSession = await validateAuthSession({
    sessionId: tokenUser.sid,
    userId: tokenUser.sub,
    organizationId: tokenUser.org_id,
  });

  if (!activeSession) {
    await auditLog({
      action: 'auth.session_rejected',
      outcome: 'failure',
      request,
      organizationId: tokenUser.org_id,
      userId: tokenUser.sub,
      metadata: { reason: 'revoked_or_expired_session' },
    });
    reply.status(401).send({
      error: { code: 'SESSION_REVOKED', message: 'Authentication session has expired or was revoked' },
    });
    return;
  }

  request.user = {
    ...tokenUser,
    role: activeUser.role as AuthenticatedRole,
  };

  const adminPolicy = adminRoutePolicy(request);
  if (adminPolicy && !isAdminRole(activeUser.role as AuthenticatedRole)) {
    await auditLog({
      action: adminPolicy.action,
      outcome: 'denied',
      request,
      organizationId: tokenUser.org_id,
      userId: tokenUser.sub,
      metadata: {
        method: request.method.toUpperCase(),
        path: apiPath(request),
        reason: adminPolicy.reason,
        role: activeUser.role,
      },
    });
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: adminPolicy.reason },
    });
    return;
  }

  if (activeUser.role === 'viewer' && !isReadOnlyMethod(request.method.toUpperCase())) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Viewer users have read-only access' },
    });
    return;
  }
}
