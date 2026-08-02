import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../services/db';
import { auditLog } from '../services/audit';
import { validateAuthSession } from '../services/sessions';
import { TRACKING_OPEN_PATH_PREFIX } from '../services/open-tracking';
import { UPDATES_ASSETS_PATH_PREFIX, UPDATES_MANIFEST_PATH } from '../services/updates-store';
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
  'deals.read': 'deals.read',
  'tasks.reminders_read': 'tasks.read',
  'tasks.reminders_write': 'tasks.write',
  'integrations.amocrm_manage': 'integrations.manage',
  // Minting an invite link IS adding a member — the account it creates is real
  // the moment the link is redeemed. Gated identically to the rest of team
  // administration so the link route cannot become a softer door into the org
  // than the button beside it.
  'team.invite': 'team.manage',
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

/**
 * Account/session maintenance is not business-data mutation. A read-only role
 * must still be able to sign out, rotate its own password and set the timezone
 * used to interpret reminders.
 */
function isSelfServiceWrite(request: FastifyRequest): boolean {
  const path = apiPath(request);
  const method = request.method.toUpperCase();
  return (
    (method === 'POST' && (path === '/api/v1/auth/logout' || path === '/api/v1/auth/logout-all')) ||
    (method === 'PATCH' && (
      path === '/api/v1/auth/me/password' ||
      path === '/api/v1/auth/me/credentials' ||
      path === '/api/v1/auth/me/timezone'
    ))
  );
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
      path === '/api/v1/auth/verify/resend' ||
      // Invite redemption. The person on the other end has no account yet — that
      // is the entire point — so there is no token they could present. Each of
      // these instead requires a single-use secret from the invite itself, and
      // each returns one indistinguishable error so the endpoint cannot be used
      // to probe which tokens exist. See controllers/invites.ts.
      path === '/api/v1/auth/invites/open' ||
      path === '/api/v1/auth/invites/lookup' ||
      path === '/api/v1/auth/invites/accept'
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

  // amoCRM arrives without a 4KUB session on both of these routes. The OAuth
  // callback is authenticated by its short-lived signed state; the webhook is
  // authenticated by the per-organization secret embedded in the subscribed
  // destination URL (and accepts a provider signature as an additional proof).
  if (method === 'GET' && path === '/api/v1/amocrm/callback') {
    return true;
  }

  if (method === 'POST' && path === '/api/v1/integrations/amocrm/webhook') {
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
  // the message stops being lawful to send.
  //
  // BOTH methods stay public, but they no longer do the same thing. GET now renders a
  // confirmation page and writes NOTHING; POST performs the withdrawal. That split exists
  // because enterprise mail scanners (Defender Safe Links, Proofpoint) fetch every link on
  // delivery — under the old GET-mutates design they silently opted out every recipient at
  // a scanner-protected domain, which is a deliverability and consent-record disaster that
  // looks exactly like normal unsubscribes. RFC 8058 one-click still bypasses the page by
  // POSTing `List-Unsubscribe=One-Click`.
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

  // expo-updates fetches the manifest and its assets during NATIVE startup — before any
  // JavaScript runs, and therefore before the app knows whether anyone is logged in. There
  // is no token it could present, so requiring one would mean no install ever receives an
  // update.
  //
  // Both constants are imported from the service that builds the URLs, so the allowlist
  // cannot drift away from the mount point — the same arrangement as the tracking prefix
  // above. Reads only: the manifest names a build, and the asset route serves only files
  // an update explicitly declares, so neither can be used to enumerate the store.
  if (
    method === 'GET' &&
    (path === UPDATES_MANIFEST_PATH || path.startsWith(UPDATES_ASSETS_PATH_PREFIX))
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

  if (/^\/api\/v1\/tasks\/[^/]+\/reminders(?:\/[^/]+)?$/.test(path)) {
    return isReadOnlyMethod(method)
      ? { action: 'tasks.reminders_read', reason: 'reading task reminders requires tasks.read' }
      : { action: 'tasks.reminders_write', reason: 'changing task reminders requires tasks.write' };
  }

  // Status, consent start, webhook subscription, reconciliation, conflict
  // inspection and disconnect all expose or change the organization-wide amoCRM
  // connection. The callback is public and re-checks the initiating user's live
  // role from its signed state inside the controller.
  if (path.startsWith('/api/v1/amocrm') && path !== '/api/v1/amocrm/callback') {
    return {
      action: 'integrations.amocrm_manage',
      reason: 'managing the amoCRM integration requires owner or admin',
    };
  }

  // Invite links. The three public redemption routes below (/invites/open,
  // /invites/lookup, /invites/accept) are NOT matched here — they are
  // unauthenticated by necessity, since the person redeeming has no account yet,
  // and they carry their own single-use secrets instead.
  if (path === '/api/v1/auth/invites' || path.startsWith('/api/v1/auth/invites/')) {
    const isRedemption =
      path === '/api/v1/auth/invites/open' ||
      path === '/api/v1/auth/invites/lookup' ||
      path === '/api/v1/auth/invites/accept';
    if (!isRedemption) {
      return { action: 'team.invite', reason: 'managing invites requires a role that may manage the team' };
    }
  }

  // Reading the pipeline. `deals.read` was declared in capabilities.ts and
  // enforced NOWHERE, which two independent audits found separately — so
  // `support`, whose whole definition is "contact record and activity, no
  // pipeline, no money", could list every deal with its `value` and `currency`.
  //
  // That also silently defeated the `revenue.view` gate below: blocking
  // /analytics/dashboard achieves nothing while the same numbers are readable
  // one route over, a deal at a time. Gating the read here is what makes the
  // capability table describe the system rather than merely document an
  // intention.
  //
  // `deals.read` is held by every role except `support`, so this narrows exactly
  // one role and matches that role's stated design. The MCP twin of this gate
  // lives in mcp/validation.ts — both doors, or neither.
  //
  // `/deals/stages/library` is listed explicitly because it is TWO segments past
  // `/deals`, and every clause above it stops at one: the regex is `[^/]+$`, and the
  // two literals are exact. A read that matches no clause here is authenticated but
  // ungated, which is how `support` — the one role this branch exists to exclude —
  // could read it. Any future `/deals/<a>/<b>` GET has the same hole by default.
  if (
    method === 'GET' &&
    (path === '/api/v1/deals' ||
      path === '/api/v1/deals/pipelines' ||
      path === '/api/v1/deals/stages/library' ||
      /^\/api\/v1\/deals\/[^/]+$/.test(path))
  ) {
    return { action: 'deals.read', reason: 'reading the pipeline requires deals.read' };
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
    !isReadOnlyMethod(request.method.toUpperCase()) &&
    !isSelfServiceWrite(request)
  ) {
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'This role has read-only access' },
    });
  }
}
