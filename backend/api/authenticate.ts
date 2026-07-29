import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../services/db';
import { auditLog } from '../services/audit';
import { validateAuthSession } from '../services/sessions';
import { TRACKING_OPEN_PATH_PREFIX } from '../services/open-tracking';
import { can, hasAnyWriteCapability, type Capability } from '../services/capabilities';

// One-click opt-out from a marketing email. Kept next to the tracking prefix so both
// public prefixes are visible in one place. The trailing slash is load-bearing: it makes
// the match cover only `/api/v1/consent/unsubscribe/<token>` and never the authenticated
// `/api/v1/consent/contacts/:contactId` routes registered by the same plugin.
const CONSENT_UNSUBSCRIBE_PATH_PREFIX = '/api/v1/consent/unsubscribe/';

type AdminRoutePolicy = {
  action: string;
  reason: string;
};

/**
 * Which capability each guarded route actually requires.
 *
 * Kept as one table rather than a `capability` field on every policy return, so
 * the full authorization surface is legible in a single screen — and so a new
 * guarded route that forgets its mapping FAILS CLOSED (see the lookup below)
 * instead of silently becoming public.
 *
 * The mappings preserve today's behaviour exactly for owner/admin/member/viewer:
 * every capability here is held by owner and admin and by no legacy role. The
 * one deliberate widening is `data.export`, which accountant now also holds —
 * reading and exporting the org's numbers is the job.
 */
const ACTION_CAPABILITY: Record<string, Capability> = {
  'audit.read': 'audit.read',
  'data.export': 'data.export',
  // Held by owner, admin, head, member, accountant and marketer — everyone whose
  // job involves money. Excludes support and viewer, matching the MCP gate on the
  // six analytics tools so both surfaces answer the same question.
  'analytics.read_revenue': 'revenue.view',
  // owner, admin, head, member — the roles that work the pipeline. Excludes
  // marketer, support, accountant and viewer, matching the MCP gate on
  // create_deal / update_deal / move_deal_to_stage.
  'deals.mutate': 'deals.write',
  'contacts.bulk_admin': 'contacts.bulk',
  // Pipelines, stages, workflows and example-data resets are organisation
  // configuration rather than day-to-day sales work — deliberately NOT
  // 'deals.write', which would hand them to every sales manager.
  'deals.pipeline_admin': 'org.manage',
  'deals.stage_admin': 'org.manage',
  'workflows.admin': 'org.manage',
  'onboarding.clear_example_data': 'org.manage',
  'org.update_settings': 'org.manage',
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

function adminRoutePolicy(request: FastifyRequest): AdminRoutePolicy | null {
  const path = apiPath(request);
  const method = request.method.toUpperCase();

  if (method === 'GET' && path === '/api/v1/auth/audit') {
    return { action: 'audit.read', reason: 'audit access requires owner or admin' };
  }

  // Revenue analytics. Added after an adversarial review found the assistant
  // refusing `support` the org's revenue (MCP gates these tools on revenue.view)
  // while REST handed the same user the same numbers over HTTP — the assistant
  // was stricter than the API behind it. Gating here is what makes
  // "the assistant is exactly as powerful as the user" true of the live surface
  // rather than only of the capability table.
  //
  // /analytics/export is matched by the data.export branch below and keeps that
  // stronger gate; this covers the read paths.
  if (
    method === 'GET' &&
    (path === '/api/v1/analytics/dashboard' || path.startsWith('/api/v1/reports/'))
  ) {
    return { action: 'analytics.read_revenue', reason: 'revenue analytics require a role that may see money' };
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

  // Deal mutation. MUST stay below the /deals/pipelines and /deals/stages
  // branches above, which carry the stronger org.manage gate — this one is the
  // catch-all for the deals themselves.
  //
  // Added alongside the analytics gate: MCP already refused create_deal to
  // marketer and support (deals.write), while POST /api/v1/deals let them
  // through on the strength of the coarse any-write check. A support operator
  // could tap + -> Сделка and succeed, then be refused the identical action by
  // the assistant. Now both surfaces ask deals.write.
  if (
    path.startsWith('/api/v1/deals') &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE')
  ) {
    return { action: 'deals.mutate', reason: 'creating or changing deals requires a sales role' };
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
    role: activeUser.role,
  };

  const adminPolicy = adminRoutePolicy(request);
  // An unmapped guarded action falls back to `org.manage`, the narrowest gate
  // that only owner and admin hold — so forgetting to add a mapping locks a
  // route down rather than opening it up.
  const requiredCapability: Capability | undefined = adminPolicy
    ? ACTION_CAPABILITY[adminPolicy.action] ?? 'org.manage'
    : undefined;

  if (adminPolicy && requiredCapability && !can(activeUser.role, requiredCapability)) {
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

  // Asks "may this role write?" rather than "is this role viewer?". The old form
  // was a deny-list of one, so every role added later defaulted to writable —
  // `accountant` would have walked straight through it. Read-only roles are now
  // whatever holds no write capability, which the capability tests pin.
  if (
    !hasAnyWriteCapability(activeUser.role) &&
    !isReadOnlyMethod(request.method.toUpperCase())
  ) {
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'This role has read-only access' },
    });
  }
}
