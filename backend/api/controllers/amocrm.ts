import { FastifyReply, FastifyRequest } from 'fastify';
import { auditLog } from '../../services/audit';
import { can } from '../../services/capabilities';
import { getDeploymentSafeUrl } from '../../config/security';
import { db } from '../../services/db';
import {
  AMO_STATE_TTL_MS,
  AmoConfigurationError,
  AmoNotConnectedError,
  AmoOAuthError,
  AmoPausedError,
  AmoReauthRequiredError,
  AmoSubdomainError,
  amoConfigured,
  buildAuthorizeUrl,
  disconnect,
  exchangeCode,
  getIntegration,
  normalizeAmoSubdomain,
  recordAmoError,
  signAmoState,
  verifyAmoState,
} from '../../services/amocrm/auth';
import {
  configuredAmoWebhookDestination,
  subscribeAmoWebhooks,
} from '../../services/amocrm/webhook';
import { reconcileOrganization } from '../../services/amocrm/reconcile';
import { syncPipelinesFromAmo } from '../../services/amocrm/mapping';

/**
 * amoCRM connect / disconnect / status.
 *
 * -----------------------------------------------------------------------------
 * WHY THE CAPABILITY CHECK IS HERE AND NOT ONLY IN authenticate.ts
 * -----------------------------------------------------------------------------
 * The request gate in api/authenticate.ts is the right place for the policy, and
 * the entry for these routes is listed in this feature's hand-off notes. But it
 * lives in a file eight agents share, so this controller does NOT depend on that
 * edit having landed: `requireIntegrationsManage` re-asks the same question
 * locally.
 *
 * The coarse gate that IS already global — "read-only roles may not POST" —
 * stops `viewer` but not `support` or `accountant`, and handing an amoCRM
 * connection to a support operator means handing them the whole customer base of
 * a second system. Both doors, or neither.
 */

type AmoConnectQuery = { redirect?: string };

type AmoCallbackQuery = {
  code?: string;
  state?: string;
  referer?: string;
  client_id?: string;
  from_widget?: string;
  platform?: string;
  error?: string;
  error_description?: string;
};

function requireIntegrationsManage(request: FastifyRequest, reply: FastifyReply): boolean {
  if (can(request.user?.role, 'integrations.manage')) {
    return true;
  }

  reply.status(403).send({
    error: {
      code: 'FORBIDDEN',
      message: 'Managing the amoCRM connection requires owner or admin',
    },
  });
  return false;
}

function requireConfigured(reply: FastifyReply): boolean {
  if (amoConfigured()) {
    return true;
  }

  reply.status(501).send({
    error: {
      code: 'AMO_NOT_CONFIGURED',
      message:
        'amoCRM integration is not configured on this server. Set AMOCRM_CLIENT_ID, AMOCRM_CLIENT_SECRET and AMOCRM_REDIRECT_URI.',
    },
  });
  return false;
}

/**
 * Where the browser lands after the callback. Validated through the same
 * deployment-safe URL check the Yandex flow uses, so a misconfigured deployment
 * cannot turn the callback into an open redirect. `crm:` is allowed because the
 * mobile app is the usual destination.
 */
function successUrl(): string | null {
  return (
    getDeploymentSafeUrl('AMOCRM_SUCCESS_URL', { allowedProtocols: ['https:', 'crm:'] }) ?? null
  );
}

async function syncAmoPipelines(organizationId: string, userId: string): Promise<void> {
  const client = await import('../../services/amocrm/client');
  await syncPipelinesFromAmo(
    {
      amoRequest: (orgId, method, path, body) =>
        client.amoRequest<unknown>(orgId, method as never, path, body),
      paginate: (orgId, path, params) =>
        client.paginate<unknown>(orgId, path, params as never) as AsyncGenerator<unknown[]>,
    },
    organizationId,
    userId,
  );
}

async function status(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;
  const view = await getIntegration(request.user.org_id);
  const [pending, processing, failed, conflicts] = view.connected
    ? await Promise.all([
        db.amoSyncJob.count({ where: { organization_id: request.user.org_id, status: 'pending' } }),
        db.amoSyncJob.count({ where: { organization_id: request.user.org_id, status: 'processing' } }),
        db.amoSyncJob.count({ where: { organization_id: request.user.org_id, status: 'failed' } }),
        db.amoSyncConflict.count({ where: { organization_id: request.user.org_id } }),
      ])
    : [0, 0, 0, 0];
  reply.send({
    data: {
      ...view,
      configured: amoConfigured(),
      sync: { pending, processing, failed, conflicts },
    },
    meta: {},
  });
}

/**
 * Start the consent flow.
 *
 * Answers a 302 by default so a browser can follow it directly. `?redirect=false`
 * returns the URL as JSON instead, which is what the mobile app needs: it opens
 * the URL in a system browser rather than following a redirect inside an XHR.
 */
async function connect(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;
  if (!requireConfigured(reply)) return;

  const { redirect } = request.query as AmoConnectQuery;

  const state = signAmoState({
    sub: request.user.sub,
    org_id: request.user.org_id,
    exp: Date.now() + AMO_STATE_TTL_MS,
  });

  let url: string;
  try {
    url = await buildAuthorizeUrl(request.user.org_id, state);
  } catch (err) {
    if (err instanceof AmoConfigurationError) {
      reply.status(501).send({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }

  await auditLog({
    action: 'amocrm.oauth_start',
    outcome: 'success',
    request,
    organizationId: request.user.org_id,
    userId: request.user.sub,
  });

  if (redirect === 'false' || redirect === '0') {
    reply.send({ data: { auth_url: url }, meta: {} });
    return;
  }

  reply.redirect(url, 302);
}

/**
 * The OAuth redirect target.
 *
 * UNAUTHENTICATED BY NECESSITY — the browser arrives from amoCRM's consent
 * screen with no Authorization header and, on mobile, no session cookie either.
 * The signed `state` is what identifies the organisation, and it is the only
 * thing trusted here: it is HMAC'd with a key domain-separated from every other
 * state in the codebase and expires after ten minutes.
 *
 * `referer` carries the account's own address. It is the ONLY source of the
 * subdomain — the token endpoint lives on the account's host, so a callback
 * without it cannot be completed. It is attacker-influenced, so it goes through
 * normalizeAmoSubdomain() before it is ever interpolated into a URL.
 */
async function callback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = request.query as AmoCallbackQuery;

  if (query.error) {
    reply.status(400).send({
      error: {
        code: 'AMO_OAUTH_DENIED',
        message: query.error_description ?? query.error,
      },
    });
    return;
  }

  if (!query.code || !query.state) {
    reply.status(400).send({
      error: { code: 'AMO_OAUTH_INVALID_CALLBACK', message: 'Missing code or state' },
    });
    return;
  }

  const state = verifyAmoState(query.state);
  if (!state) {
    reply.status(400).send({
      error: { code: 'AMO_OAUTH_INVALID_STATE', message: 'Invalid or expired OAuth state' },
    });
    return;
  }

  // State identifies who STARTED the flow; it does not freeze their authority for ten
  // minutes. Re-check the live row so a removed/deactivated/demoted user cannot complete a
  // connection from an old browser tab.
  const connector = await db.user.findFirst({
    where: { id: state.sub, organization_id: state.org_id, is_active: true },
    select: { role: true },
  });
  if (!connector || !can(connector.role, 'integrations.manage')) {
    reply.status(403).send({
      error: { code: 'AMO_OAUTH_FORBIDDEN', message: 'The user who started this connection no longer has permission' },
    });
    return;
  }

  let subdomain: string;
  try {
    subdomain = normalizeAmoSubdomain(query.referer);
  } catch {
    reply.status(400).send({
      error: {
        code: 'AMO_OAUTH_INVALID_REFERER',
        message: 'amoCRM did not return a usable account address',
      },
    });
    return;
  }

  if (!requireConfigured(reply)) return;

  try {
    const view = await exchangeCode(state.org_id, query.code, subdomain, {
      connectedBy: state.sub,
    });

    // The OAuth grant is already durable at this point. A webhook subscription failure must
    // not tell the user to repeat the single-use code exchange; record the degraded state and
    // expose a retry endpoint instead.
    try {
      // Webhook jobs translate amo status ids through these mappings. Build them before
      // subscribing so live inbound sync works immediately, even if the user does not run the
      // optional historical import.
      await syncAmoPipelines(state.org_id, state.sub);
      const destination = await configuredAmoWebhookDestination(state.org_id);
      await subscribeAmoWebhooks(state.org_id, destination);
    } catch (subscriptionError) {
      await recordAmoError(
        state.org_id,
        `Connected, but webhook subscription failed: ${subscriptionError instanceof Error ? subscriptionError.message : String(subscriptionError)}`,
      );
    }

    await auditLog({
      action: 'amocrm.oauth_connect',
      outcome: 'success',
      request,
      organizationId: state.org_id,
      userId: state.sub,
      metadata: { subdomain },
    });

    const destination = successUrl();
    if (destination) {
      reply.redirect(destination, 302);
      return;
    }

    reply
      .type('text/html; charset=utf-8')
      .send(
        '<html lang="ru"><head><meta charset="utf-8"><title>amoCRM</title></head>' +
          '<body>amoCRM подключён. Это окно можно закрыть.</body></html>',
      );
    void view;
  } catch (err) {
    await auditLog({
      action: 'amocrm.oauth_connect',
      outcome: 'failure',
      request,
      organizationId: state.org_id,
      userId: state.sub,
      metadata: {
        subdomain,
        reason: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      },
    });

    // The authorization code is single-use and expires in 20 minutes. There is
    // no retry to offer — the only recovery is to start the consent flow again.
    if (err instanceof AmoOAuthError) {
      reply.status(400).send({
        error: {
          code: 'AMO_OAUTH_EXCHANGE_FAILED',
          message: 'amoCRM rejected the authorization code. Start the connection again.',
        },
      });
      return;
    }

    if (err instanceof AmoSubdomainError) {
      reply.status(400).send({
        error: { code: 'AMO_OAUTH_INVALID_REFERER', message: err.message },
      });
      return;
    }

    if (err instanceof AmoConfigurationError) {
      reply.status(501).send({ error: { code: err.code, message: err.message } });
      return;
    }

    throw err;
  }
}

async function subscribeWebhooks(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;
  try {
    await syncAmoPipelines(request.user.org_id, request.user.sub);
    const destination = await configuredAmoWebhookDestination(request.user.org_id);
    const ids = await subscribeAmoWebhooks(request.user.org_id, destination);
    reply.send({ data: { subscribed: true, webhook_count: ids.length }, meta: {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAmoError(request.user.org_id, message);
    reply.status(502).send({ error: { code: 'AMO_WEBHOOK_SUBSCRIBE_FAILED', message } });
  }
}

async function reconcileNow(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;
  const view = await getIntegration(request.user.org_id);
  if (!view.connected || view.status !== 'active') {
    reply.status(409).send({
      error: { code: 'AMO_NOT_ACTIVE', message: 'amoCRM must be connected and active before reconciliation' },
    });
    return;
  }
  try {
    const result = await reconcileOrganization(request.user.org_id, view.last_sync_at, new Date());
    reply.send({ data: result, meta: {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAmoError(request.user.org_id, message);
    reply.status(502).send({ error: { code: 'AMO_RECONCILE_FAILED', message } });
  }
}

async function conflicts(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;
  const query = request.query as { limit?: string; cursor?: string };
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  const rows = await db.amoSyncConflict.findMany({
    where: { organization_id: request.user.org_id },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  reply.send({
    data,
    meta: { next_cursor: hasMore ? data[data.length - 1]?.id ?? null : null },
  });
}

async function disconnectIntegration(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;

  try {
    const result = await disconnect(request.user.org_id);

    await auditLog({
      action: 'amocrm.disconnect',
      outcome: 'success',
      request,
      organizationId: request.user.org_id,
      userId: request.user.sub,
      metadata: {
        webhooks_removed: result.webhooks_removed,
        webhooks_failed: result.webhooks_failed,
      },
    });

    reply.send({ data: result, meta: {} });
  } catch (err) {
    if (err instanceof AmoNotConnectedError) {
      reply.status(404).send({
        error: { code: err.code, message: err.message },
      });
      return;
    }
    if (err instanceof AmoReauthRequiredError || err instanceof AmoPausedError) {
      // Neither should escape disconnect (teardown is best-effort), but if the
      // account is in one of those states the local credentials still went away.
      reply.send({ data: { disconnected: true, webhooks_removed: 0, webhooks_failed: 0 }, meta: {} });
      return;
    }
    throw err;
  }
}

export const AmocrmController = {
  status,
  connect,
  callback,
  disconnect: disconnectIntegration,
  subscribeWebhooks,
  reconcileNow,
  conflicts,
};
