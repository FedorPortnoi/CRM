import { FastifyRequest } from 'fastify';
import { CalendarEventStatus } from '@prisma/client';
import crypto from 'node:crypto';
import {
  ConfigurationError,
  getDeploymentSafeUrl,
  getJwtSecret,
  getYandexWebhookSecret,
} from '../config/security';
import { encryptField as encryptToken, decryptField as decryptToken } from './encryption';
import { auditLog } from './audit';
import { db } from './db';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OAuthState = {
  sub: string;
  org_id: string;
  exp: number;
};

export type YandexTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

type YandexUserInfo = {
  login: string;
  id: string;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function decryptYandexSync<T extends { access_token: string; refresh_token: string | null }>(sync: T): T {
  return {
    ...sync,
    access_token: decryptToken(sync.access_token),
    refresh_token: sync.refresh_token ? decryptToken(sync.refresh_token) : sync.refresh_token,
  };
}

// ─── State signing ────────────────────────────────────────────────────────────

export function signState(payload: OAuthState): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const secret = getJwtSecret();
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyState(state: string): OAuthState | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = crypto
    .createHmac('sha256', getJwtSecret())
    .update(encoded)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthState;
    if (payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Config guards ────────────────────────────────────────────────────────────

export function yandexConfigured(): boolean {
  return Boolean(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET);
}

// ─── Redirect URI ─────────────────────────────────────────────────────────────

export function resolveYandexRedirectUri(request: FastifyRequest): string {
  const configuredRedirectUri = getDeploymentSafeUrl('YANDEX_REDIRECT_URI', {
    requiredInProduction: true,
    allowedProtocols: ['https:'],
  });
  if (configuredRedirectUri) return configuredRedirectUri;

  const host = request.headers.host ?? `localhost:${process.env.PORT ?? '3000'}`;
  return `${request.protocol}://${host}/api/v1/calendar/sync/yandex/callback`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export async function exchangeYandexToken(params: Record<string, string>): Promise<YandexTokenResponse> {
  const response = await fetch('https://oauth.yandex.ru/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const body = await response.json() as YandexTokenResponse & { error?: string; error_description?: string };

  if (!response.ok) {
    throw new Error(body.error_description ?? body.error ?? `Yandex token exchange failed with ${response.status}`);
  }

  return body;
}

async function getYandexUsername(accessToken: string): Promise<string> {
  const response = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  const body = await response.json() as YandexUserInfo;
  return body.login;
}

// ─── Valid sync record (with auto-refresh) ────────────────────────────────────

export async function getValidYandexSync(userId: string, orgId: string) {
  const syncWhere = { user_id: userId, provider: 'yandex', user: { organization_id: orgId } };
  const sync = await db.userCalendarSync.findFirst({
    where: syncWhere,
  });

  if (!sync) return null;

  const decryptedSync = decryptYandexSync(sync);
  const expiresAt = sync.expires_at?.getTime() ?? 0;
  if (!decryptedSync.refresh_token || expiresAt > Date.now() + 60_000) {
    return decryptedSync;
  }

  const token = await exchangeYandexToken({
    client_id: process.env.YANDEX_CLIENT_ID ?? '',
    client_secret: process.env.YANDEX_CLIENT_SECRET ?? '',
    refresh_token: decryptedSync.refresh_token,
    grant_type: 'refresh_token',
  });

  const result = await db.userCalendarSync.updateMany({
    where: syncWhere,
    data: {
      access_token: encryptToken(token.access_token),
      refresh_token: encryptToken(token.refresh_token ?? decryptedSync.refresh_token),
      expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : sync.expires_at,
    },
  });

  if (result.count !== 1) return null;

  const updated = await db.userCalendarSync.findFirst({
    where: syncWhere,
  });

  return updated ? decryptYandexSync(updated) : null;
}

// ─── iCal builder ─────────────────────────────────────────────────────────────

function buildIcal(event: {
  id: string;
  title: string;
  start_time: Date;
  end_time: Date;
  location?: string | null;
  description?: string | null;
}): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('.000', '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CRM//CRM//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}`,
    `DTSTART:${fmt(event.start_time)}`,
    `DTEND:${fmt(event.end_time)}`,
    `SUMMARY:${event.title}`,
    event.location ? `LOCATION:${event.location}` : '',
    event.description ? `DESCRIPTION:${event.description.replace(/\n/g, '\\n')}` : '',
    `DTSTAMP:${fmt(new Date())}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

// ─── CalDAV sync / delete ─────────────────────────────────────────────────────

export async function syncYandexEventForUser(
  userId: string | null | undefined,
  eventId: string,
  orgId: string,
): Promise<void> {
  if (!userId || !yandexConfigured()) return;

  const sync = await getValidYandexSync(userId, orgId);
  if (!sync) return;

  const event = await db.calendarEvent.findFirst({ where: { id: eventId, organization_id: orgId } });
  if (!event || event.status === CalendarEventStatus.cancelled) return;

  const username = sync.yandex_username;
  const calendarSlug = sync.yandex_calendar_slug ?? 'home';
  if (!username) return;

  const eventUid = event.ext_event_uid ?? event.id;
  const caldavUrl = `https://caldav.yandex.ru/calendars/${username}/${calendarSlug}/${eventUid}.ics`;

  const icalContent = buildIcal(event);

  const response = await fetch(caldavUrl, {
    method: 'PUT',
    headers: {
      Authorization: `OAuth ${sync.access_token}`,
      'Content-Type': 'text/calendar; charset=utf-8',
    },
    body: icalContent,
  });

  if (response.ok && !event.ext_event_uid) {
    const result = await db.calendarEvent.updateMany({
      where: { id: event.id, organization_id: orgId },
      data: { ext_event_uid: eventUid, ext_calendar_uid: `${username}/${calendarSlug}` },
    });
    if (result.count !== 1) {
      throw new Error('Calendar event not found');
    }
  }
}

export async function deleteYandexEventForUser(
  userId: string | null | undefined,
  eventId: string,
  orgId: string,
): Promise<void> {
  if (!userId || !yandexConfigured()) return;

  const event = await db.calendarEvent.findFirst({ where: { id: eventId, organization_id: orgId } });
  if (!event?.ext_event_uid) return;

  const sync = await getValidYandexSync(userId, orgId);
  if (!sync?.yandex_username) return;

  const username = sync.yandex_username;
  const calendarSlug = sync.yandex_calendar_slug ?? 'home';
  const caldavUrl = `https://caldav.yandex.ru/calendars/${username}/${calendarSlug}/${event.ext_event_uid}.ics`;

  await fetch(caldavUrl, {
    method: 'DELETE',
    headers: { Authorization: `OAuth ${sync.access_token}` },
  });
}

// ─── OAuth initiation ─────────────────────────────────────────────────────────

/**
 * Returns { auth_url, redirect_uri } for the OAuth consent screen.
 * redirectUri must be resolved by the controller from the incoming request.
 */
export function buildYandexOAuthUrl(
  userId: string,
  orgId: string,
  redirectUri: string,
): { auth_url: string; redirect_uri: string } {
  const state = signState({
    sub: userId,
    org_id: orgId,
    exp: Date.now() + 5 * 60 * 1000,
  });

  const authUrl = new URL('https://oauth.yandex.ru/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', process.env.YANDEX_CLIENT_ID ?? '');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('force_confirm', 'yes');
  authUrl.searchParams.set('state', state);

  return { auth_url: authUrl.toString(), redirect_uri: redirectUri };
}

// ─── OAuth callback ───────────────────────────────────────────────────────────

/**
 * Exchanges the authorization code, persists tokens, and fires an audit event.
 * Returns the success redirect URL (if configured) or null (controller sends HTML).
 * Throws on any error — controller maps errors to HTTP responses.
 */
export async function handleYandexOAuthCallback(
  code: string,
  state: string,
  redirectUri: string,
  /** Passed through to auditLog for IP/user-agent capture. */
  request: FastifyRequest,
): Promise<{ payload: OAuthState; successUrl: string | null }> {
  const payload = verifyState(state);
  if (!payload) {
    throw Object.assign(new Error('Invalid or expired OAuth state'), { code: 'YANDEX_OAUTH_INVALID_STATE' });
  }

  const token = await exchangeYandexToken({
    code,
    client_id: process.env.YANDEX_CLIENT_ID ?? '',
    client_secret: process.env.YANDEX_CLIENT_SECRET ?? '',
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const yandexLogin = await getYandexUsername(token.access_token);

  const syncWhere = {
    user_id: payload.sub,
    provider: 'yandex',
    user: { organization_id: payload.org_id },
  };
  const existing = await db.userCalendarSync.findFirst({ where: syncWhere });

  const user = await db.user.findFirst({
    where: { id: payload.sub, organization_id: payload.org_id },
    select: { id: true },
  });

  if (!user) {
    throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
  }

  if (existing) {
    const result = await db.userCalendarSync.updateMany({
      where: syncWhere,
      data: {
        access_token: encryptToken(token.access_token),
        refresh_token: encryptToken(token.refresh_token ?? existing.refresh_token),
        expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
        yandex_username: yandexLogin,
      },
    });

    if (result.count !== 1) {
      throw Object.assign(
        new Error('Yandex Calendar is not connected for this user'),
        { code: 'YANDEX_SYNC_NOT_CONNECTED' },
      );
    }
  } else {
    await db.userCalendarSync.create({
      data: {
        user_id: payload.sub,
        provider: 'yandex',
        access_token: encryptToken(token.access_token),
        refresh_token: token.refresh_token ? encryptToken(token.refresh_token) : undefined,
        expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
        yandex_username: yandexLogin,
        yandex_calendar_slug: 'home',
      },
    });
  }

  await auditLog({
    action: 'calendar.oauth_connect',
    outcome: 'success',
    request,
    organizationId: payload.org_id,
    userId: payload.sub,
    metadata: { provider: 'yandex', yandex_username: yandexLogin },
  });

  const successUrl = getDeploymentSafeUrl('YANDEX_CALENDAR_SUCCESS_URL', {
    allowedProtocols: ['https:', 'crm:'],
  });

  return { payload, successUrl: successUrl ?? null };
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

/**
 * Removes the stored Yandex sync record and fires an audit event.
 * Returns true on success; throws a tagged Error if not connected.
 */
export async function disconnectYandexSync(
  userId: string,
  orgId: string,
  /** Passed through to auditLog for IP/user-agent capture. */
  request: FastifyRequest,
): Promise<true> {
  const syncWhere = {
    user_id: userId,
    provider: 'yandex',
    user: { organization_id: orgId },
  };
  const sync = await db.userCalendarSync.findFirst({ where: syncWhere });

  if (!sync) {
    throw Object.assign(
      new Error('Yandex Calendar is not connected for this user'),
      { code: 'YANDEX_SYNC_NOT_CONNECTED' },
    );
  }

  const result = await db.userCalendarSync.deleteMany({ where: syncWhere });

  if (result.count !== 1) {
    throw Object.assign(
      new Error('Yandex Calendar is not connected for this user'),
      { code: 'YANDEX_SYNC_NOT_CONNECTED' },
    );
  }

  await auditLog({
    action: 'calendar.oauth_disconnect',
    outcome: 'success',
    request,
    metadata: { provider: 'yandex' },
  });

  return true;
}

// ─── Sync status ──────────────────────────────────────────────────────────────

export async function getYandexSyncStatus(userId: string, orgId: string) {
  const sync = await db.userCalendarSync.findFirst({
    where: {
      user_id: userId,
      provider: 'yandex',
      user: { organization_id: orgId },
    },
  });

  return {
    connected: sync !== null,
    yandex_username: sync?.yandex_username ?? null,
    yandex_calendar_slug: sync?.yandex_calendar_slug ?? null,
    expires_at: sync?.expires_at ?? null,
  };
}

// ─── Webhook helpers ──────────────────────────────────────────────────────────

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function timingSafeEqualString(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function extractYandexWebhookSecret(request: FastifyRequest): string | undefined {
  const headerSecret = headerValue(request.headers['x-yandex-webhook-secret']);
  if (headerSecret?.trim()) {
    return headerSecret.trim();
  }

  const authorization = headerValue(request.headers.authorization);
  const bearerPrefix = 'bearer ';
  if (authorization?.toLowerCase().startsWith(bearerPrefix)) {
    const bearerSecret = authorization.slice(bearerPrefix.length).trim();
    return bearerSecret.length > 0 ? bearerSecret : undefined;
  }

  return undefined;
}

/**
 * Returns the configured webhook secret, or '' if unconfigured (meaning no
 * authentication is required). Returns null and sends a 503 if the config
 * throws a ConfigurationError — in that case the controller must return early.
 */
export function readConfiguredWebhookSecret(
  reply: { status: (code: number) => { send: (body: unknown) => void } },
): string | null {
  try {
    return getYandexWebhookSecret() ?? '';
  } catch (err: unknown) {
    if (err instanceof ConfigurationError) {
      reply.status(503).send({
        error: { code: 'YANDEX_WEBHOOK_SECRET_NOT_CONFIGURED', message: 'Yandex webhook secret is not configured' },
      });
      return null;
    }
    throw err;
  }
}
