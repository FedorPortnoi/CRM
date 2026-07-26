import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../services/db';
import { auditLog } from '../services/audit';
import { validateAuthSession } from '../services/sessions';
import { TRACKING_OPEN_PATH_PREFIX } from '../services/open-tracking';

// One-click opt-out from a marketing email. Kept next to the tracking prefix so both
// public prefixes are visible in one place. The trailing slash is load-bearing: it makes
// the match cover only `/api/v1/consent/unsubscribe/<token>` and never the authenticated
// `/api/v1/consent/contacts/:contactId` routes registered by the same plugin.
const CONSENT_UNSUBSCRIBE_PATH_PREFIX = '/api/v1/consent/unsubscribe/';

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

  if (
    method === 'POST' &&
    (
      path === '/api/v1/auth' ||
      path === '/api/v1/auth/login' ||
      path === '/api/v1/auth/join' ||
      path === '/api/v1/auth/verify' ||
      path === '/api/v1/auth/verify/resend'
    )
  ) {
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

  // Open-tracking pixel. A mail client fetches this image with no cookie, no bearer token
  // and no session — there is no way for it to carry a JWT — so the hook has to let it
  // through or every open comes back 401 and nothing is ever recorded.
  //
  // Why this cannot over-match: the prefix ends in a slash and `/api/v1/tracking` hosts
  // exactly one route, GET '/open/:token' (backend/api/routes/tracking.ts). `apiPath()`
  // has already stripped the query string and any trailing slashes, so a bare
  // '/api/v1/tracking/open/' does NOT match and stays authenticated; only a path with a
  // non-empty token segment does. The method check keeps HEAD, POST, PATCH and DELETE on
  // the authenticated path. The prefix constant is imported from the service that builds
  // the URL so the allowlist and the route cannot drift apart.
  if (method === 'GET' && path.startsWith(TRACKING_OPEN_PATH_PREFIX)) {
    return true;
  }

  // One-click unsubscribe (ФЗ-38 «О рекламе» ст. 18). The link is clicked from a mail
  // client, which likewise has no session; without this entry every opt-out click 401s and
  // the message stops being lawful to send. GET performs the unsubscribe as well as POST
  // (RFC 8058 List-Unsubscribe-Post) — see the comment on consentRoutes.
  //
  // Why this cannot over-match: same shape as above. The prefix ends in a slash, so the
  // sibling routes on this plugin ('/api/v1/consent/contacts/:contactId', all three
  // methods) can never match it, and the two methods listed are the only ones the
  // unsubscribe route registers. The handler reads nothing back except whether the
  // supplied 256-bit token was already used; an unknown token is a 404.
  if (
    (method === 'GET' || method === 'POST') &&
    path.startsWith(CONSENT_UNSUBSCRIBE_PATH_PREFIX)
  ) {
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

  if (path.startsWith('/api/v1/import/')) {
    return { action: 'contacts.bulk_admin', reason: 'contact imports require owner or admin' };
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

  if (method === 'PATCH' && path === '/api/v1/org/settings') {
    return { action: 'org.update_settings', reason: 'updating org settings requires owner or admin' };
  }

  return null;
}

/**
 * EVERY REJECTION PATH BELOW MUST `return reply...`, NOT SEND-THEN-RETURN.
 *
 * An async preHandler that resolves to `undefined` does not halt the hook chain: the route
 * handler runs anyway, sends a second response, and the resulting ERR_HTTP_HEADERS_SENT is
 * thrown off the reply lifecycle where no error handler catches it — the process exits. One
 * unauthenticated request to any /api/v1 route is then enough to take the API down for every
 * tenant. Returning the reply object is what tells Fastify the response is already handled.
 *
 * The unit tests assert `resolves.toBe(reply)` on each path for exactly this reason; asserting
 * only that a 401 was sent passes either way and misses the bug.
 */
export async function enforceAuthenticatedApiRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!request.url.startsWith('/api/v1/') || isPublicApiRoute(request)) {
    return;
  }

  await request.jwtVerify();

  const tokenUser = request.user;
  if (!tokenUser.sub || !tokenUser.org_id || !tokenUser.sid) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token' },
    });
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
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'User is inactive or no longer belongs to this organization' },
    });
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
    return reply.status(401).send({
      error: { code: 'SESSION_REVOKED', message: 'Authentication session has expired or was revoked' },
    });
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
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: adminPolicy.reason },
    });
  }

  if (activeUser.role === 'viewer' && !isReadOnlyMethod(request.method.toUpperCase())) {
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Viewer users have read-only access' },
    });
  }
}
