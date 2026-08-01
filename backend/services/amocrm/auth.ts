/**
 * amoCRM OAuth 2.0 — authorisation, and the rotation-safe token refresh.
 *
 * =============================================================================
 * THE ONE FACT THAT DECIDES WHETHER THIS INTEGRATION SURVIVES
 * =============================================================================
 * amoCRM ROTATES THE REFRESH TOKEN ON EVERY REFRESH.
 *
 *   «Refresh token можно обменять только один раз. После отправки его в метод и
 *    получения новой пары access token/refresh token старый refresh token
 *    становится не актуальным.»
 *   — https://www.amocrm.ru/developers/content/oauth/step-by-step
 *
 * So a refresh is not an idempotent read. It CONSUMES a credential. Two requests
 * that both present the stored refresh token produce one winner and one response
 * that is worthless — and, because the winner's new token may be overwritten by
 * the loser's write, an account that no longer has a usable refresh token at
 * all. There is no automatic recovery from that: a human must re-authorise.
 *
 * Three rules follow, and every one of them is load-bearing:
 *
 *   1. A refresh happens inside ONE Postgres transaction that first takes
 *      `pg_advisory_xact_lock` keyed on organization_id. The lock is released by
 *      the commit, so a crash mid-refresh cannot leave it held.
 *   2. Inside the lock the row is RE-READ. If someone else already rotated the
 *      token while we queued, we use theirs and make no HTTP call at all. This
 *      is what turns N concurrent callers into exactly one refresh.
 *   3. A terminal refresh failure sets status = needs_reauth and STOPS. It is
 *      never retried. amoCRM blocks integrations that keep hammering a rejected
 *      grant, and a blocked integration is a support ticket, not a backoff.
 *
 * -----------------------------------------------------------------------------
 * WHAT "TERMINAL" MEANS HERE, AND WHY IT IS NOT `invalid_grant`
 * -----------------------------------------------------------------------------
 * The brief called for treating `invalid_grant` as terminal. The documentation
 * does not support detecting it: amoCRM's token endpoint answers EVERY bad
 * request — expired code, reused refresh token, wrong secret — with an
 * undifferentiated **HTTP 400**, and no published page documents an RFC 6749
 * `error` field or the value `invalid_grant` at all. The 400 body that has been
 * observed in the wild carries `hint`/`title`/`detail` instead, and no doc page
 * documents that either (see `// VERIFY:` below).
 *
 * Detecting the string alone would therefore mean retrying every real terminal
 * failure forever, which is the exact behaviour that earns the ban. So the rule
 * is inverted to fail safe: **any 4xx from the token endpoint on a refresh is
 * terminal**, and the RFC 6749 strings are additionally honoured if they ever
 * appear. Transient conditions (429, 5xx, network) are the explicit exception
 * and are the ONLY things retried.
 */

import crypto from 'node:crypto';
import type { AmoIntegration, Prisma } from '@prisma/client';
import { db } from '../db';
import { decryptField, encryptField } from '../encryption';
import { ConfigurationError, getJwtSecret } from '../../config/security';
import { acquireAmoSlot, backOffOrg, parseRetryAfterMs, releaseThrottle } from './throttle';
import type {
  AmoCollection,
  AmoOAuthErrorResponse,
  AmoTokenResponse,
  AmoWebhook,
} from './types';
import { amoWebhookDestination } from './webhook';

// ─── Hosts and subdomains (SSRF boundary) ─────────────────────────────────────

/**
 * The consent screen lives on the PLATFORM host, not the account's. This trips
 * up every first implementation: authorisation is at www.amocrm.ru, but the
 * token exchange is at <subdomain>.amocrm.ru, and the subdomain is not known
 * until the callback delivers it in `referer`.
 * CONFIRMED: https://www.amocrm.ru/developers/content/oauth/step-by-step
 */
const AMO_PLATFORM_ORIGIN = 'https://www.amocrm.ru';
const AMO_AUTHORIZE_PATH = '/oauth';

/**
 * Account hosts we will talk to. `amocrm.ru` is the Russian platform;
 * `amocrm.com` is the same product's international host, kept because an
 * existing customer account may live there. `kommo.com` is the rebranded
 * international platform — accepted so a migrated account keeps working, since
 * the API surface is identical.
 *
 * This regex IS the SSRF boundary. `subdomain` arrives from an OAuth callback
 * query parameter under an attacker's partial control, and it is interpolated
 * into every outbound URL. A single-label, alphanumeric-with-hyphens check is
 * what stops `evil.com/#` or `169.254.169.254` from becoming a request target.
 */
const AMO_ACCOUNT_HOST = /^(amocrm\.ru|amocrm\.com|kommo\.com)$/i;
const AMO_SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;

export class AmoSubdomainError extends Error {
  readonly code = 'AMO_INVALID_SUBDOMAIN';

  constructor(value: string) {
    super(`Not a valid amoCRM account subdomain: ${value.slice(0, 64)}`);
    this.name = 'AmoSubdomainError';
  }
}

/**
 * Reduce whatever the callback gave us to a bare subdomain label.
 *
 * amoCRM's `referer` parameter is documented only in prose as «адрес аккаунта
 * пользователя», and Kommo's example shows `{subdomain}.kommo.com` with no
 * scheme — so the exact form is not contractual. This accepts all three shapes
 * anyone has been seen to send and rejects everything else:
 *   'example'                      -> 'example'
 *   'example.amocrm.ru'            -> 'example'
 *   'https://example.amocrm.ru/'   -> 'example'
 *
 * // VERIFY: the exact format of the `referer` callback parameter (bare host vs
 * // full URL) is UNCONFIRMED — the RU docs describe it only in prose.
 */
export function normalizeAmoSubdomain(raw: string | null | undefined): string {
  if (typeof raw !== 'string') {
    throw new AmoSubdomainError(String(raw));
  }

  let value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 255) {
    throw new AmoSubdomainError(raw);
  }

  if (value.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AmoSubdomainError(raw);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AmoSubdomainError(raw);
    }
    value = parsed.hostname;
  }

  // Strip a known account host suffix if one is present.
  const dot = value.indexOf('.');
  if (dot !== -1) {
    const label = value.slice(0, dot);
    const rest = value.slice(dot + 1);
    if (!AMO_ACCOUNT_HOST.test(rest)) {
      throw new AmoSubdomainError(raw);
    }
    value = label;
  }

  if (!AMO_SUBDOMAIN.test(value)) {
    throw new AmoSubdomainError(raw);
  }

  return value;
}

/**
 * Which platform host an account's subdomain belongs to. Defaults to amocrm.ru,
 * the only one 4КУБ targets; AMOCRM_ACCOUNT_HOST exists so an account on
 * amocrm.com or kommo.com can be reached without a code change.
 */
export function amoAccountHost(): string {
  const configured = (process.env.AMOCRM_ACCOUNT_HOST ?? '').trim().toLowerCase();
  if (configured && AMO_ACCOUNT_HOST.test(configured)) {
    return configured;
  }
  return 'amocrm.ru';
}

/** `https://<subdomain>.amocrm.ru` — the only origin outbound calls may target. */
export function amoBaseUrl(subdomain: string): string {
  return `https://${normalizeAmoSubdomain(subdomain)}.${amoAccountHost()}`;
}

/**
 * Build an absolute amoCRM URL from a path, refusing anything that would leave
 * the account's own origin. Used for both our own paths and the `_links.next`
 * hrefs amoCRM hands back during pagination — a redirect-follower that trusts a
 * server-supplied absolute URL is an SSRF primitive, even when the server is one
 * we chose to talk to.
 */
export function amoUrl(
  subdomain: string,
  pathOrHref: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): URL {
  const base = amoBaseUrl(subdomain);
  const url = pathOrHref.includes('://')
    ? new URL(pathOrHref)
    : new URL(pathOrHref.startsWith('/') ? pathOrHref : `/${pathOrHref}`, base);

  if (url.origin !== base) {
    throw new AmoSubdomainError(url.origin);
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AmoConfigurationError extends Error {
  readonly code = 'AMO_NOT_CONFIGURED';
  readonly statusCode = 501;

  constructor(message: string) {
    super(message);
    this.name = 'AmoConfigurationError';
  }
}

export class AmoNotConnectedError extends Error {
  readonly code = 'AMO_NOT_CONNECTED';
  readonly statusCode = 404;

  constructor(orgId: string) {
    super('amoCRM is not connected for this organization');
    this.name = 'AmoNotConnectedError';
    this.organizationId = orgId;
  }

  readonly organizationId: string;
}

/**
 * Terminal. The integration cannot recover without a human re-authorising, and
 * NOTHING may retry after seeing this — that is the whole point of the class.
 */
export class AmoReauthRequiredError extends Error {
  readonly code = 'AMO_NEEDS_REAUTH';
  readonly statusCode = 409;
  readonly terminal = true;

  constructor(orgId: string, reason?: string | null) {
    super(
      reason
        ? `amoCRM authorization is no longer valid and must be renewed by hand: ${reason}`
        : 'amoCRM authorization is no longer valid and must be renewed by hand',
    );
    this.name = 'AmoReauthRequiredError';
    this.organizationId = orgId;
  }

  readonly organizationId: string;
}

export class AmoPausedError extends Error {
  readonly code = 'AMO_PAUSED';
  readonly statusCode = 409;

  constructor(orgId: string) {
    super('amoCRM integration is paused for this organization');
    this.name = 'AmoPausedError';
    this.organizationId = orgId;
  }

  readonly organizationId: string;
}

/** A non-2xx from the OAuth token endpoint. `terminal` decides retry policy. */
export class AmoOAuthError extends Error {
  readonly code = 'AMO_OAUTH_FAILED';
  readonly statusCode = 502;

  constructor(
    message: string,
    readonly status: number,
    readonly terminal: boolean,
    readonly body?: AmoOAuthErrorResponse,
  ) {
    super(message);
    this.name = 'AmoOAuthError';
  }
}

// ─── Credentials ──────────────────────────────────────────────────────────────

export interface AmoCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * Must be byte-identical to the Redirect URI registered in the amoCRM
   * integration settings. It is NOT a parameter of the consent URL (amoCRM
   * takes it from the integration), but it IS required in the body of BOTH
   * grant types — including refresh_token, which is the detail most
   * implementations miss.
   * CONFIRMED: https://developers.kommo.com/reference/get-token
   */
  redirectUri: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True when the deployment has amoCRM OAuth credentials at all. */
export function amoConfigured(): boolean {
  return Boolean(
    readEnv('AMOCRM_CLIENT_ID') &&
      readEnv('AMOCRM_CLIENT_SECRET') &&
      readEnv('AMOCRM_REDIRECT_URI'),
  );
}

function envCredentials(): AmoCredentials {
  const clientId = readEnv('AMOCRM_CLIENT_ID');
  const clientSecret = readEnv('AMOCRM_CLIENT_SECRET');
  const redirectUri = readEnv('AMOCRM_REDIRECT_URI');

  if (!clientId || !clientSecret || !redirectUri) {
    throw new AmoConfigurationError(
      'amoCRM integration requires AMOCRM_CLIENT_ID, AMOCRM_CLIENT_SECRET and AMOCRM_REDIRECT_URI',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new AmoConfigurationError('AMOCRM_REDIRECT_URI must be an absolute URL');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new AmoConfigurationError('AMOCRM_REDIRECT_URI must use https in production');
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Credentials for an existing integration.
 *
 * The row's own client_id/secret win over the environment, so an org that
 * registered its OWN private amoCRM integration keeps working after the
 * deployment-wide credentials are rotated — and so a rotation cannot silently
 * re-point one tenant's tokens at another tenant's application.
 */
function credentialsFor(row: AmoIntegration): AmoCredentials {
  const storedSecret = row.client_secret_enc ? decryptField(row.client_secret_enc) : null;
  if (row.client_id && storedSecret) {
    return {
      clientId: row.client_id,
      clientSecret: storedSecret,
      redirectUri: row.redirect_uri || envCredentials().redirectUri,
    };
  }
  return envCredentials();
}

// ─── OAuth state ──────────────────────────────────────────────────────────────

export interface AmoOAuthState {
  /** User who started the flow. */
  sub: string;
  org_id: string;
  /** Millisecond epoch after which the state is refused. */
  exp: number;
  /** Random, so an identical (user, org, minute) does not produce a reusable string. */
  nonce: string;
}

/**
 * Domain-separated from every other HMAC in the codebase. Without the
 * ':amocrm-oauth-state:v1' label, a signed Yandex Calendar state — same shape,
 * same secret — would verify here, and a callback for one integration could
 * drive another.
 */
function stateKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(getJwtSecret())
    .update(':amocrm-oauth-state:v1')
    .digest();
}

export function signAmoState(payload: Omit<AmoOAuthState, 'nonce'> & { nonce?: string }): string {
  const full: AmoOAuthState = {
    sub: payload.sub,
    org_id: payload.org_id,
    exp: payload.exp,
    nonce: payload.nonce ?? crypto.randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(full)).toString('base64url');
  const signature = crypto.createHmac('sha256', stateKey()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyAmoState(state: string | null | undefined): AmoOAuthState | null {
  if (typeof state !== 'string') return null;

  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = crypto.createHmac('sha256', stateKey()).update(encoded).digest('base64url');
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AmoOAuthState;
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.org_id !== 'string' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** How long a consent round-trip may take before its state is refused. */
export const AMO_STATE_TTL_MS = 10 * 60_000;

// ─── 1. Authorize ─────────────────────────────────────────────────────────────

/**
 * The consent URL.
 *
 * Note what is NOT here: `redirect_uri`, `response_type` and `scope`. amoCRM
 * takes the redirect URI from the integration's own settings and has no scope
 * parameter — the permissions are fixed when the integration is registered.
 * Sending extras is not an error, but it is not the documented call either.
 * CONFIRMED: https://www.amocrm.ru/developers/content/oauth/step-by-step
 *
 * `mode` is `popup` by default because /amocrm/connect answers with a 302 in the
 * main window: `popup` means «переход на Redirect URI будет выполнен в основном
 * окне». `post_message` is for an integration that opened a child window and is
 * listening for a postMessage — set AMOCRM_OAUTH_MODE=post_message if the client
 * does that instead.
 *
 * Async because it prefers an already-connected org's client_id: re-authorising
 * must go back to the SAME application that minted the existing tokens.
 */
export async function buildAuthorizeUrl(orgId: string, state: string): Promise<string> {
  let clientId: string | undefined;
  try {
    const row = await db.amoIntegration.findUnique({
      where: { organization_id: orgId },
      select: { client_id: true },
    });
    clientId = row?.client_id || undefined;
  } catch {
    // A read failure must not block a first-time connect; fall through to env.
  }

  if (!clientId) {
    clientId = envCredentials().clientId;
  }

  const mode = readEnv('AMOCRM_OAUTH_MODE') === 'post_message' ? 'post_message' : 'popup';
  const origin = readEnv('AMOCRM_PLATFORM_ORIGIN') ?? AMO_PLATFORM_ORIGIN;

  const url = new URL(AMO_AUTHORIZE_PATH, origin);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('state', state);
  url.searchParams.set('mode', mode);
  return url.toString();
}

// ─── The token endpoint ───────────────────────────────────────────────────────

const TOKEN_PATH = '/oauth2/access_token';
const TOKEN_TIMEOUT_MS = 15_000;

type TokenGrant =
  | { grant_type: 'authorization_code'; code: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

function describeOAuthFailure(status: number, body: AmoOAuthErrorResponse | null): string {
  const parts = [
    body?.error_description,
    body?.hint,
    body?.detail,
    body?.title,
    body?.message,
    body?.error,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length > 0
    ? `amoCRM token endpoint returned ${status}: ${parts[0]}`
    : `amoCRM token endpoint returned ${status}`;
}

/**
 * Is this failure terminal — i.e. must we STOP rather than retry?
 *
 * Fails safe toward "terminal". See the header comment: amoCRM publishes no
 * machine-readable code for a spent refresh token, so a 4xx is the strongest
 * signal available, and the cost of mislabelling a terminal error as transient
 * (a ban) is far worse than the cost of the reverse (one avoidable re-auth).
 *
 * // VERIFY: amoCRM documents only "HTTP 400 — переданы некорректные данные"
 * // for token failures; no page documents an `error`/`invalid_grant` field or
 * // the `hint`/OAuthProblemJson envelope. The string checks below are
 * // best-effort over shapes observed in community reports, NOT contract.
 */
function isTerminalOAuthFailure(status: number, body: AmoOAuthErrorResponse | null): boolean {
  if (status === 429) return false;
  if (status >= 500) return false;

  const marker = `${body?.error ?? ''} ${body?.hint ?? ''} ${body?.type ?? ''}`.toLowerCase();
  if (
    marker.includes('invalid_grant') ||
    marker.includes('invalid_client') ||
    marker.includes('unauthorized_client')
  ) {
    return true;
  }

  // Every remaining 4xx: bad/expired/reused code, spent refresh token, wrong
  // secret, revoked integration (401), rate-blocked account (403).
  return status >= 400 && status < 500;
}

/**
 * One POST to `https://<subdomain>.amocrm.ru/oauth2/access_token`.
 *
 * The body is JSON. amoCRM rejects `application/x-www-form-urlencoded` with a
 * 401 that reads like a credential problem, which is the single most common way
 * an amoCRM integration fails on its first day.
 * CONFIRMED: https://www.amocrm.ru/developers/content/oauth/step-by-step
 */
async function requestToken(
  orgId: string,
  subdomain: string,
  credentials: AmoCredentials,
  grant: TokenGrant,
): Promise<AmoTokenResponse> {
  const url = amoUrl(subdomain, TOKEN_PATH);

  const payload = {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: credentials.redirectUri,
    ...grant,
  };

  // The token endpoint shares the account's host and its rate budget.
  await acquireAmoSlot(orgId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // amoCRM asks integrations to identify themselves.
        'User-Agent': readEnv('AMOCRM_USER_AGENT') ?? '4KUB-CRM/1.0',
      },
      body: JSON.stringify(payload),
      // A redirect off this origin would be an SSRF hop with our client_secret
      // in the body. Never follow one.
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = (parsed ?? null) as AmoOAuthErrorResponse | null;

    if (response.status === 429) {
      // Documented as a body field `retry_after`, not the RFC header — but a
      // proxy may add the header, so both are read.
      const bodyRetry = (parsed as { retry_after?: unknown } | null)?.retry_after;
      const delayMs =
        (typeof bodyRetry === 'number' && Number.isFinite(bodyRetry) ? bodyRetry * 1000 : null) ??
        parseRetryAfterMs(response.headers.get('retry-after')) ??
        60_000;
      backOffOrg(orgId, Math.min(delayMs, 5 * 60_000));
    }

    throw new AmoOAuthError(
      describeOAuthFailure(response.status, body),
      response.status,
      isTerminalOAuthFailure(response.status, body),
      body ?? undefined,
    );
  }

  const token = parsed as AmoTokenResponse | null;
  if (!token || typeof token.access_token !== 'string' || token.access_token.length === 0) {
    throw new AmoOAuthError('amoCRM token response contained no access_token', response.status, true);
  }

  // A refresh that comes back WITHOUT a new refresh token has left us with
  // nothing: the one we just sent is already dead on amoCRM's side. Treating
  // that as success would store a corpse and fail at the next renewal, hours
  // later, with no clue as to why.
  if (typeof token.refresh_token !== 'string' || token.refresh_token.length === 0) {
    throw new AmoOAuthError(
      'amoCRM token response contained no refresh_token — the token we sent is already spent',
      response.status,
      true,
    );
  }

  return token;
}

/**
 * Expiry from `expires_in`, measured on OUR clock.
 *
 * amoCRM also returns `server_time`. It is deliberately not used to correct for
 * skew: the token dies at (server_time + expires_in) on amoCRM's clock, which is
 * (our_now + expires_in) on ours for any constant offset — the skew cancels.
 * "Correcting" for it would double-count the offset.
 */
function expiryFrom(token: AmoTokenResponse): Date {
  const seconds = Number.isFinite(token.expires_in) && token.expires_in > 0 ? token.expires_in : 86_400;
  return new Date(Date.now() + seconds * 1000);
}

// ─── The view other modules consume ───────────────────────────────────────────

/**
 * What `getAccessToken` returns. It carries the subdomain as well as the token
 * because the caller needs BOTH to build a request — amoCRM has no fixed API
 * host — and reading them together is one query instead of two.
 */
export interface AmoAccess {
  organization_id: string;
  access_token: string;
  subdomain: string;
  /** `https://<subdomain>.amocrm.ru` — already validated. */
  base_url: string;
  expires_at: Date | null;
}

export interface AmoIntegrationView {
  connected: boolean;
  status: 'active' | 'needs_reauth' | 'paused' | null;
  subdomain: string | null;
  base_url: string | null;
  token_expires_at: Date | null;
  needs_reauth_at: Date | null;
  last_sync_at: Date | null;
  last_error: string | null;
  webhook_count: number;
  connected_by: string | null;
  connected_at: Date | null;
}

function toAccess(row: AmoIntegration, accessToken: string): AmoAccess {
  return {
    organization_id: row.organization_id,
    access_token: accessToken,
    subdomain: row.subdomain,
    base_url: amoBaseUrl(row.subdomain),
    expires_at: row.token_expires_at,
  };
}

export function toIntegrationView(row: AmoIntegration | null): AmoIntegrationView {
  if (!row) {
    return {
      connected: false,
      status: null,
      subdomain: null,
      base_url: null,
      token_expires_at: null,
      needs_reauth_at: null,
      last_sync_at: null,
      last_error: null,
      webhook_count: 0,
      connected_by: null,
      connected_at: null,
    };
  }

  return {
    connected: true,
    status: row.status,
    subdomain: row.subdomain,
    base_url: amoBaseUrl(row.subdomain),
    token_expires_at: row.token_expires_at,
    needs_reauth_at: row.needs_reauth_at,
    last_sync_at: row.last_sync_at,
    last_error: row.last_error,
    webhook_count: row.webhook_ids.length,
    connected_by: row.connected_by,
    connected_at: row.created_at,
  };
}

// ─── The advisory lock ────────────────────────────────────────────────────────

/**
 * Serialise every read-modify-write of one org's token columns.
 *
 * `pg_advisory_xact_lock` and not a row lock so the SAME key also covers the
 * initial INSERT, when there is no row to lock; and transaction-scoped so the
 * commit or rollback always releases it. `hashtextextended` collapses the key
 * into the bigint the lock function takes — a collision between two orgs costs
 * one needless serialisation, never a correctness failure.
 */
async function lockOrgTokens(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const key = `amocrm:token:${orgId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}

/**
 * An interactive transaction that holds an HTTP call. The default 5 s Prisma
 * timeout is too tight for that — a slow amoCRM would abort the transaction
 * AFTER the refresh token was consumed, rolling back the write and permanently
 * losing the account. maxWait covers queueing behind another refresh.
 */
const TOKEN_TX_OPTIONS = { timeout: 30_000, maxWait: 25_000 } as const;

/** Refresh this far ahead of the stated expiry. */
export const AMO_REFRESH_MARGIN_MS = 5 * 60_000;

function needsRefresh(expiresAt: Date | null, marginMs = AMO_REFRESH_MARGIN_MS): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - Date.now() <= marginMs;
}

// ─── 2. Code exchange ─────────────────────────────────────────────────────────

export interface ExchangeCodeOptions {
  /** User id recorded as the connector. */
  connectedBy?: string | null;
  /** Override the redirect URI (must match the one used to obtain the code). */
  redirectUri?: string;
}

/**
 * Swap the one-time authorization code for a token pair and store it encrypted.
 *
 * THE CODE IS SINGLE-USE and expires after 20 minutes. Exchanging it twice is an
 * error, so this never retries: a failure propagates and the user starts the
 * consent flow again. A "helpful" retry here would turn one recoverable mistake
 * into a confusing second failure with a different cause.
 *
 * Runs under the same advisory lock as the refresh, so a double-submitted
 * callback cannot interleave two writes to the token columns.
 */
export async function exchangeCode(
  orgId: string,
  code: string,
  subdomain: string,
  options: ExchangeCodeOptions = {},
): Promise<AmoIntegrationView> {
  const account = normalizeAmoSubdomain(subdomain);
  const env = envCredentials();
  const credentials: AmoCredentials = {
    ...env,
    redirectUri: options.redirectUri ?? env.redirectUri,
  };

  const token = await requestToken(orgId, account, credentials, {
    grant_type: 'authorization_code',
    code,
  });

  const expiresAt = expiryFrom(token);

  const row = await db.$transaction(async (tx) => {
    await lockOrgTokens(tx, orgId);

    const shared = {
      subdomain: account,
      client_id: credentials.clientId,
      client_secret_enc: encryptField(credentials.clientSecret),
      redirect_uri: credentials.redirectUri,
      access_token_enc: encryptField(token.access_token),
      refresh_token_enc: encryptField(token.refresh_token),
      token_expires_at: expiresAt,
      status: 'active' as const,
      // A successful re-authorisation is exactly what clears these.
      needs_reauth_at: null,
      last_error: null,
    };

    return tx.amoIntegration.upsert({
      where: { organization_id: orgId },
      create: {
        organization_id: orgId,
        connected_by: options.connectedBy ?? null,
        webhook_ids: [],
        ...shared,
      },
      update: {
        ...shared,
        ...(options.connectedBy ? { connected_by: options.connectedBy } : {}),
      },
    });
  }, TOKEN_TX_OPTIONS);

  // A reconnect after a rate-limit block should not inherit the old back-off.
  releaseThrottle(orgId, new Error('amoCRM integration reconnected'));

  return toIntegrationView(row);
}

// ─── 3. getAccessToken — the function everyone else calls ─────────────────────

export interface GetAccessTokenOptions {
  /**
   * Refresh even if the stored token still looks fresh. Set by the HTTP client
   * after a 401: amoCRM considers the token dead regardless of what our stored
   * expiry says.
   */
  forceRefresh?: boolean;
  /**
   * The token that just failed. If the stored token has ALREADY moved on from
   * this value, another request refreshed while ours was in flight and we take
   * theirs instead of burning a second refresh token. Without this, N concurrent
   * 401s cause N refreshes and N-1 of them destroy each other's credentials.
   */
  staleAccessToken?: string;
  /** Allow a `paused` integration (the sync worker sets this for teardown work). */
  allowPaused?: boolean;
}

/**
 * A valid access token for the organisation, refreshing under the advisory lock
 * if the stored one is within AMO_REFRESH_MARGIN_MS of expiry.
 *
 * Throws — never returns a half-answer:
 *   AmoNotConnectedError   no integration row.
 *   AmoReauthRequiredError status is needs_reauth, or a refresh just failed
 *                          terminally. DO NOT RETRY on this one.
 *   AmoPausedError         the operator paused the integration.
 *   AmoOAuthError          a transient refresh failure; retrying later is fine.
 */
export async function getAccessToken(
  orgId: string,
  options: GetAccessTokenOptions = {},
): Promise<AmoAccess> {
  const row = await db.amoIntegration.findUnique({ where: { organization_id: orgId } });
  if (!row) {
    throw new AmoNotConnectedError(orgId);
  }

  // Checked BEFORE any HTTP call, so a needs_reauth integration costs amoCRM
  // nothing at all. This is the "never retry" rule, enforced at the entry point
  // rather than trusted to every caller.
  if (row.status === 'needs_reauth') {
    throw new AmoReauthRequiredError(orgId, row.last_error);
  }
  if (row.status === 'paused' && !options.allowPaused) {
    throw new AmoPausedError(orgId);
  }

  const stored = row.access_token_enc ? decryptField(row.access_token_enc) : null;

  if (stored && !needsRefresh(row.token_expires_at)) {
    if (!options.forceRefresh) {
      return toAccess(row, stored);
    }
    // Forced, but the stored token is not the one that failed — somebody else
    // already rotated it. Use theirs.
    if (options.staleAccessToken !== undefined && stored !== options.staleAccessToken) {
      return toAccess(row, stored);
    }
  }

  return refreshAccessToken(orgId, {
    force: options.forceRefresh === true,
    staleAccessToken: options.staleAccessToken ?? stored ?? undefined,
    allowPaused: options.allowPaused === true,
  });
}

interface RefreshOptions {
  force: boolean;
  staleAccessToken?: string;
  allowPaused: boolean;
}

async function refreshAccessToken(orgId: string, options: RefreshOptions): Promise<AmoAccess> {
  // Carried out of the transaction rather than thrown from inside it: throwing
  // would roll back the needs_reauth write, and the next request would repeat
  // the very refresh that is not allowed to be repeated.
  const outcome: { terminal?: Error } = {};

  const access = await db.$transaction(async (tx) => {
    await lockOrgTokens(tx, orgId);

    // RE-READ INSIDE THE LOCK. Everything above this line was decided on a
    // snapshot that may be several seconds stale by the time the lock is ours.
    const row = await tx.amoIntegration.findUnique({ where: { organization_id: orgId } });
    if (!row) {
      outcome.terminal = new AmoNotConnectedError(orgId);
      return null;
    }
    if (row.status === 'needs_reauth') {
      outcome.terminal = new AmoReauthRequiredError(orgId, row.last_error);
      return null;
    }
    if (row.status === 'paused' && !options.allowPaused) {
      outcome.terminal = new AmoPausedError(orgId);
      return null;
    }

    const stored = row.access_token_enc ? decryptField(row.access_token_enc) : null;
    if (stored && !needsRefresh(row.token_expires_at)) {
      const supersededOurs =
        options.staleAccessToken !== undefined && stored !== options.staleAccessToken;
      if (supersededOurs || !options.force) {
        // Another request refreshed while we waited. THIS is the branch that
        // makes concurrent callers cost exactly one refresh.
        return toAccess(row, stored);
      }
    }

    const refreshToken = row.refresh_token_enc ? decryptField(row.refresh_token_enc) : null;
    if (!refreshToken) {
      await markNeedsReauthTx(tx, orgId, 'no refresh token stored');
      outcome.terminal = new AmoReauthRequiredError(orgId, 'no refresh token stored');
      return null;
    }

    let token: AmoTokenResponse;
    try {
      token = await requestToken(orgId, row.subdomain, credentialsFor(row), {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    } catch (err) {
      if (err instanceof AmoOAuthError && err.terminal) {
        await markNeedsReauthTx(tx, orgId, err.message);
        outcome.terminal = new AmoReauthRequiredError(orgId, err.message);
        return null; // Commit the needs_reauth write.
      }
      // Transient: roll back and leave the refresh token untouched so a later
      // attempt can use it. It has NOT been consumed — amoCRM never answered.
      throw err;
    }

    // The new refresh token is written in the SAME transaction that consumed the
    // old one. A crash between the HTTP response and this update would otherwise
    // lose the only credential that exists.
    const updated = await tx.amoIntegration.update({
      where: { organization_id: orgId },
      data: {
        access_token_enc: encryptField(token.access_token),
        refresh_token_enc: encryptField(token.refresh_token),
        token_expires_at: expiryFrom(token),
        status: 'active',
        needs_reauth_at: null,
        last_error: null,
      },
    });

    return toAccess(updated, token.access_token);
  }, TOKEN_TX_OPTIONS);

  if (outcome.terminal) {
    throw outcome.terminal;
  }
  if (!access) {
    throw new AmoNotConnectedError(orgId);
  }
  return access;
}

async function markNeedsReauthTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  reason: string,
): Promise<void> {
  await tx.amoIntegration.update({
    where: { organization_id: orgId },
    data: {
      status: 'needs_reauth',
      needs_reauth_at: new Date(),
      last_error: reason.slice(0, 1000),
      // The refresh token is provably dead — amoCRM rejected it. Keeping it
      // would only invite a retry, and a retry is the thing that earns a ban.
      refresh_token_enc: null,
      access_token_enc: null,
      token_expires_at: null,
    },
  });
}

/**
 * Move an integration to needs_reauth from outside a refresh — the HTTP client
 * calls this when a 401 survives a successful token refresh, which means amoCRM
 * has revoked the integration rather than merely expired the token.
 */
export async function markNeedsReauth(orgId: string, reason: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockOrgTokens(tx, orgId);
    const row = await tx.amoIntegration.findUnique({
      where: { organization_id: orgId },
      select: { id: true },
    });
    if (!row) return;
    await markNeedsReauthTx(tx, orgId, reason);
  }, TOKEN_TX_OPTIONS);

  releaseThrottle(orgId, new AmoReauthRequiredError(orgId, reason));
}

/** Record a non-fatal failure without changing status. */
export async function recordAmoError(orgId: string, message: string): Promise<void> {
  await db.amoIntegration
    .updateMany({
      where: { organization_id: orgId },
      data: { last_error: message.slice(0, 1000) },
    })
    .catch(() => undefined);
}

/** Stamp a successful sync pass and clear the last error. */
export async function markSyncSucceeded(orgId: string): Promise<void> {
  await db.amoIntegration
    .updateMany({
      where: { organization_id: orgId },
      data: { last_sync_at: new Date(), last_error: null },
    })
    .catch(() => undefined);
}

/** The connection as the status endpoint and the UI see it. Never returns secrets. */
export async function getIntegration(orgId: string): Promise<AmoIntegrationView> {
  const row = await db.amoIntegration.findUnique({ where: { organization_id: orgId } });
  return toIntegrationView(row);
}

// ─── 4. Disconnect ────────────────────────────────────────────────────────────

/**
 * The shape of the request function disconnect uses to reach amoCRM. Injected so
 * this module never imports client.ts at load time — client.ts imports THIS
 * module, and a static cycle between them is a class of bug that only shows up
 * under a particular import order in production.
 */
export type AmoRequester = <T>(
  orgId: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T | null>;

async function defaultRequester<T>(
  orgId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  const { amoRequest } = await import('./client');
  return amoRequest<T>(orgId, method as 'GET' | 'DELETE' | 'POST' | 'PATCH', path, body);
}

export interface DisconnectResult {
  disconnected: boolean;
  webhooks_removed: number;
  webhooks_failed: number;
}

export interface DisconnectOptions {
  request?: AmoRequester;
  /** Skip the remote teardown entirely (used when the account is already gone). */
  skipWebhookTeardown?: boolean;
}

/**
 * Tear down webhook subscriptions, then delete the credentials.
 *
 * ORDER MATTERS: the webhooks are removed FIRST, while the token still works.
 * Deleting the row first would leave amoCRM posting to an endpoint we can no
 * longer authenticate against, forever — amoCRM allows only 100 subscriptions
 * per account, so orphans are a real resource leak for the customer.
 *
 * Teardown is best-effort. If the account is unreachable or already
 * needs_reauth, the local credentials are still deleted: refusing to disconnect
 * because a remote cleanup failed would strand the operator with an integration
 * they cannot remove.
 *
 * Unsubscribe is `DELETE /api/v4/webhooks` with a JSON body naming the
 * DESTINATION — not the id, and not a `{"delete": true}` flag (that is API v2
 * and does not apply).
 * CONFIRMED: https://www.amocrm.ru/developers/content/crm_platform/webhooks-api
 */
export async function disconnect(
  orgId: string,
  options: DisconnectOptions = {},
): Promise<DisconnectResult> {
  const row = await db.amoIntegration.findUnique({ where: { organization_id: orgId } });
  if (!row) {
    throw new AmoNotConnectedError(orgId);
  }

  let removed = 0;
  let failed = 0;

  const canReachAccount = row.status === 'active' && Boolean(row.refresh_token_enc);
  if (!options.skipWebhookTeardown && canReachAccount) {
    const request = options.request ?? defaultRequester;
    try {
      const listed = await request<AmoCollection<AmoWebhook>>(orgId, 'GET', '/api/v4/webhooks');
      const hooks = listed?._embedded?.webhooks ?? [];
      const knownIds = new Set(row.webhook_ids.map((id) => String(id)));

      for (const hook of hooks) {
        const isOurs =
          (hook.id !== undefined && knownIds.has(String(hook.id))) ||
          isOwnDestination(hook.destination, row.organization_id, credentialsFor(row).clientSecret);
        if (!isOurs || !hook.destination) continue;

        try {
          await request(orgId, 'DELETE', '/api/v4/webhooks', { destination: hook.destination });
          removed += 1;
        } catch {
          failed += 1;
        }
      }
    } catch {
      // Listing failed (revoked token, network, rate block). Fall through and
      // still remove the local credentials.
      failed += row.webhook_ids.length;
    }
  }

  await db.amoIntegration.deleteMany({ where: { organization_id: orgId } });
  releaseThrottle(orgId, new Error('amoCRM integration disconnected'));

  return { disconnected: true, webhooks_removed: removed, webhooks_failed: failed };
}

/**
 * Does this webhook destination point back at us? Belt-and-braces alongside the
 * stored ids: an id list that drifted (a webhook re-created by hand, a failed
 * write) would otherwise leave an orphan posting at our endpoint forever.
 */
function isOwnDestination(
  destination: string | undefined,
  organizationId: string,
  clientSecret: string,
): boolean {
  if (!destination) return false;
  try {
    return new URL(destination).toString() ===
      new URL(amoWebhookDestination(organizationId, clientSecret)).toString();
  } catch {
    return false;
  }
}

// Re-exported so callers can distinguish a configuration problem from a runtime
// one without importing the security module directly.
export { ConfigurationError };
