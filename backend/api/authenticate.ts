import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../services/db';
import { auditLog } from '../services/audit';
import { validateAuthSession } from '../services/sessions';
import { TRACKING_OPEN_PATH_PREFIX } from '../services/open-tracking';
import { UPDATES_ASSETS_PATH_PREFIX, UPDATES_MANIFEST_PATH } from '../services/updates-store';
import { can, hasAnyWriteCapability, type Capability } from '../services/capabilities';
import { requiresEmailVerification } from '../config/security';
import { declaredRouteCapability } from './route-gates';

// One-click opt-out from a marketing email. Kept next to the tracking prefix so both
// public prefixes are visible in one place. The trailing slash is load-bearing: it makes
// the match cover only `/api/v1/consent/unsubscribe/<token>` and never the authenticated
// `/api/v1/consent/contacts/:contactId` routes registered by the same plugin.
const CONSENT_UNSUBSCRIBE_PATH_PREFIX = '/api/v1/consent/unsubscribe/';

type AdminRoutePolicy = {
  action: string;
  reason: string;
  /**
   * Set only by the declared table in api/route-gates.ts, which names its
   * capability directly instead of going through ACTION_CAPABILITY. Everything
   * else still resolves through that table so the whole authorization surface
   * stays legible in one screen.
   */
  capability?: Capability;
};

/** Audit action for a denial that came from the declared route-gate table. */
const DECLARED_CAPABILITY_ACTION = 'route.declared_capability';

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
  'integrations.leadinbox_manage': 'integrations.manage',
  // Owner, admin AND marketer. Mapped explicitly because the unmapped fallback
  // below is `org.manage`, which marketer does NOT hold — registering the route
  // without this line would 403 every marketer on the entire marketing surface
  // that is their job. Mirrors denySequenceAdmin in controllers/sequences.ts,
  // which asks the identical question.
  'sequences.manage_admin': 'sequences.manage',
  // Minting an invite link IS adding a member — the account it creates is real
  // the moment the link is redeemed. Gated identically to the rest of team
  // administration so the link route cannot become a softer door into the org
  // than the button beside it.
  'team.invite': 'team.manage',
  // Team administration. These six routes were the last authorization decisions
  // in the product made ENTIRELY outside this layer: adminRoutePolicy had no
  // branch for /auth/users or /auth/company-code, so requiredCapability was
  // undefined, the capability check was skipped, and a raw `role !== 'owner' &&
  // role !== 'admin'` inside the controller was the only gate — which meant the
  // denial was never audited either. Mapped here so both are true again.
  //
  // 'team.read', explicitly. GET /api/v1/auth/users is called by every role from
  // the assignee picker, the DM composer and the API-keys screen, and the
  // unmapped fallback below is `org.manage`: omitting this line 403s every
  // head/member/support/marketer/accountant/viewer on shipped 1.1.6 builds.
  'team.read_members': 'team.read',
  'team.admin': 'team.manage',
  // Owner-only, matching the literal it replaces. NOT team.manage — that would
  // hand re-roling to every admin.
  'team.role_change': 'team.manage_admins',
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
 * must still be able to sign out, rotate its own password, set the timezone
 * used to interpret reminders, and choose how long its own session lasts.
 *
 * The four authenticated /auth/2fa/* routes belong in this list for the same
 * reason /me/password does: 2FA is opt-in PER USER, not gated by role, and
 * every one of them only ever reads or changes request.user.sub's own account
 * (see the controllers — none accepts a target id). Leaving them out would
 * mean a viewer or accountant — the two roles this codebase already trusts
 * with their own password — could never turn on the second factor meant to
 * protect that very account.
 */
function isSelfServiceWrite(request: FastifyRequest): boolean {
  const path = apiPath(request);
  const method = request.method.toUpperCase();
  return (
    (method === 'POST' && (
      path === '/api/v1/auth/logout' ||
      path === '/api/v1/auth/logout-all' ||
      path === '/api/v1/auth/2fa/setup' ||
      path === '/api/v1/auth/2fa/enable' ||
      path === '/api/v1/auth/2fa/disable' ||
      path === '/api/v1/auth/2fa/backup-codes/regenerate'
    )) ||
    (method === 'PATCH' && (
      path === '/api/v1/auth/me/password' ||
      path === '/api/v1/auth/me/credentials' ||
      path === '/api/v1/auth/me/timezone' ||
      path === '/api/v1/auth/me/session-preference'
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
      path === '/api/v1/auth/verify' ||
      path === '/api/v1/auth/verify/resend' ||
      // Step two of login/join after either returns 403 TOTP_REQUIRED. No
      // session exists yet at this point in the flow, so this has to be
      // public exactly like /auth/verify above — and, like that route, it
      // accepts only a body-carried secret (a TOTP code or a backup code)
      // rather than anything read from an authenticated identity. The other
      // four /auth/2fa/* routes (setup, enable, disable, backup-codes/regenerate)
      // are NOT listed here and stay behind the global preHandler on purpose:
      // each one reads or changes request.user.sub's own account.
      path === '/api/v1/auth/2fa/verify' ||
      // Password recovery. Whoever needs these cannot sign in by definition, so
      // requiring a token would make the feature unreachable. Both answer
      // identically whatever the address resolves to — see the controller.
      path === '/api/v1/auth/forgot-password' ||
      path === '/api/v1/auth/reset-password' ||
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

  /**
   * THE DECLARED TABLE, ASKED FIRST — and only ever to ADD a requirement.
   *
   * Keyed on `request.routeOptions.url`, the pattern Fastify actually matched,
   * so it cannot be dodged by encoding and cannot drift from the registration.
   * A route that is absent from the table falls straight through to the ordinary
   * chain below, which is why this is safe to land ahead of the table being
   * complete: it can refuse a route the chain would have allowed, never allow
   * one the chain would have refused. On a 404 there is no matched pattern and
   * `routeOptions.url` is undefined, so a typo stays a 404 rather than becoming
   * a confusing 403.
   */
  const declared = declaredRouteCapability(method, request.routeOptions?.url);
  if (declared) {
    return {
      action: DECLARED_CAPABILITY_ACTION,
      capability: declared,
      reason: declared === 'deals.read'
        ? 'reading the pipeline requires deals.read'
        : 'this route requires a capability your role does not hold',
    };
  }

  // isReadOnlyMethod, not `method === 'GET'`, on every read gate in this function.
  // Fastify auto-registers a HEAD twin for every GET route (exposeHeadRoutes
  // defaults true and index.ts does not disable it), and that twin runs the SAME
  // handler — it only discards the body on the way out. A gate anchored to GET
  // therefore lets HEAD execute the handler and returns content-length, which is
  // an existence-and-size oracle on top of doing the work (HEAD /export/contacts/pdf
  // renders the whole PDF for a caller who does not hold data.export).
  if (isReadOnlyMethod(method) && path === '/api/v1/auth/audit') {
    return { action: 'audit.read', reason: 'audit access requires owner or admin' };
  }

  if (/^\/api\/v1\/tasks\/[^/]+\/reminders(?:\/[^/]+)?$/.test(path)) {
    return isReadOnlyMethod(method)
      ? { action: 'tasks.reminders_read', reason: 'reading task reminders requires tasks.read' }
      : { action: 'tasks.reminders_write', reason: 'changing task reminders requires tasks.write' };
  }

  // The whole lead-inbox surface reads or changes one organization-wide
  // integration (its IMAP credentials among other things), so every method is
  // owner/admin — same shape as the amoCRM branch below, and the controller
  // re-asks the identical capability.
  if (path.startsWith('/api/v1/integrations/lead-inbox')) {
    return {
      action: 'integrations.leadinbox_manage',
      reason: 'managing the lead inbox integration requires owner or admin',
    };
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

  // Email sequences. The controller (denySequenceAdmin, controllers/sequences.ts)
  // already enforces the identical capability on all 14 routes; this entry exists
  // so the DENIAL is AUDITED like every other admin surface. It changes who is
  // permitted by exactly nothing — both doors ask can(role, 'sequences.manage').
  //
  // The reason string is byte-identical to the controller's 403 body on purpose:
  // the preHandler now answers first, and no client should see the message change.
  // It is SEQUENCE_ADMIN_DENIAL_MESSAGE in controllers/sequences.ts; both sides are
  // pinned by tests (authenticate.test.ts and sequences.test.ts) so they cannot drift.
  //
  // Exact match plus trailing-slash prefix, not a bare startsWith: a future
  // '/api/v1/sequences-archive' mount must not be swept in silently.
  //
  // Deliberately NOT extended to '/api/v1/consent' (withdrawal must stay open to
  // every role — ФЗ-38 art. 18) nor to '/api/v1/email-templates' (reads there are
  // open to any org member by design; see controllers/email-templates.ts).
  if (path === '/api/v1/sequences' || path.startsWith('/api/v1/sequences/')) {
    return {
      action: 'sequences.manage_admin',
      reason: 'Only owner or admin can manage email sequences',
    };
  }

  /**
   * Team administration.
   *
   * Exact paths and anchored regexes, never `startsWith('/api/v1/auth')` — that
   * would swallow /auth/me/*, /auth/sessions and /auth/logout and 403 every
   * read-only role out of its own account maintenance.
   *
   * Each `reason` is byte-identical to the controller's 403 body
   * (TEAM_DENIAL_MESSAGES in controllers/auth.ts) because this hook now answers
   * first and src/app/settings/team.tsx renders the message verbatim into an
   * Alert. Both sides are pinned by tests/unit/backend/auth-team-admin-authz.test.ts.
   */
  if (isReadOnlyMethod(method) && path === '/api/v1/auth/users') {
    return { action: 'team.read_members', reason: 'listing members requires team.read' };
  }

  if (/^\/api\/v1\/auth\/users\/[^/]+\/deactivate$/.test(path)) {
    return { action: 'team.admin', reason: 'Only owners and admins can deactivate members' };
  }

  if (/^\/api\/v1\/auth\/users\/[^/]+\/manager$/.test(path)) {
    return { action: 'team.admin', reason: 'Only owners and admins can assign managers' };
  }

  if (/^\/api\/v1\/auth\/users\/[^/]+\/role$/.test(path)) {
    return { action: 'team.role_change', reason: 'Only owners can change user roles' };
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
  // ungated.
  //
  // `/contacts/:id/deals` is the proof that this shape of gate does not hold: it
  // returns full deal rows (deal-domain's dealInclude — value, currency,
  // probability, expected_close) from a path that does not contain the word
  // `deals` where this branch was looking, so `support` read the pipeline through
  // the contact screen while being refused it one route over. The gate keys on the
  // URL; the data does not. THE URL IS NOT THE AUTHORITY ON WHAT A HANDLER READS —
  // before adding a route that returns deal rows, add it here AND to
  // DEAL_READ_ROUTES in api/route-gates.ts, which now exists: it is keyed on the
  // pattern Fastify matched rather than on a hand-written regex, and a drift test
  // fails the build when a registered deal route is missing from it.
  if (
    isReadOnlyMethod(method) &&
    (path === '/api/v1/deals' ||
      path === '/api/v1/deals/pipelines' ||
      path === '/api/v1/deals/stages/library' ||
      /^\/api\/v1\/deals\/[^/]+$/.test(path) ||
      /^\/api\/v1\/contacts\/[^/]+\/deals$/.test(path))
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
    isReadOnlyMethod(method) &&
    (path === '/api/v1/analytics/dashboard' || path.startsWith('/api/v1/reports/'))
  ) {
    return { action: 'analytics.read_revenue', reason: 'revenue analytics require a role that may see money' };
  }

  if (
    (method === 'POST' && path === '/api/v1/analytics/export') ||
    (isReadOnlyMethod(method) && path.startsWith('/api/v1/analytics/export/')) ||
    (isReadOnlyMethod(method) && path.startsWith('/api/v1/export/'))
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
    select: { id: true, organization_id: true, role: true, is_verified: true, created_at: true },
  });

  if (!activeUser) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'User is inactive or no longer belongs to this organization' },
    });
  }

  /**
   * IDENTITY, ASKED ON EVERY REQUEST — not once at the login door.
   *
   * This hook already re-reads is_active, org membership, the live role and the
   * live session, precisely because a token is a claim about the past. Whether
   * the holder ever proved they own the address on the account was the one
   * question it did not re-ask, and invite acceptance was minting seven-day
   * sessions for addresses nobody had proven. A session that outlives the fact
   * it was issued on is the same defect in both cases.
   *
   * It asks `is_verified`, not `email_verified`, so this door and /auth/login
   * (auth.ts) ask the identical question of the identical column —
   * email_verified has never gated anything and was, until this change,
   * written `true` for addresses that had proven nothing.
   *
   * 403 rather than 401: the account is real and the token is valid, so the
   * client must route to the verification step. A 401 sends it to the login
   * screen, where /auth/login refuses the same account for the same reason and
   * the person has nowhere left to go.
   *
   * See VERIFICATION_ENFORCED_SINCE for why accounts older than the cutover are
   * admitted rather than locked out.
   */
  if (requiresEmailVerification(activeUser)) {
    await auditLog({
      action: 'auth.unverified_session_rejected',
      outcome: 'failure',
      request,
      organizationId: tokenUser.org_id,
      userId: tokenUser.sub,
      metadata: { reason: 'email_not_verified' },
    });
    return reply.status(403).send({
      error: { code: 'ACCOUNT_NOT_VERIFIED', message: 'Please verify your account via the code sent to your email.' },
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
    ? adminPolicy.capability ?? ACTION_CAPABILITY[adminPolicy.action] ?? 'org.manage'
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
