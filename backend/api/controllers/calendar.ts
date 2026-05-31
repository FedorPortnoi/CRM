import { FastifyRequest, FastifyReply } from 'fastify';
import { CalendarEventStatus, Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import {
  ConfigurationError,
  getDeploymentSafeUrl,
  getJwtSecret,
  getYandexWebhookSecret,
} from '../../config/security';
import { encryptField as encryptToken, decryptField as decryptToken } from '../../services/encryption';
import { auditLog } from '../../services/audit';
import { db } from '../../services/db';

// ─── Local request types ──────────────────────────────────────────────────────

type ListQuery = {
  start?: string;
  end?: string;
  contact_id?: string;
  deal_id?: string;
  attendee_id?: string;
  status?: CalendarEventStatus;
  page: number;
  per_page: number;
};

type CreateBody = {
  title: string;
  description?: string;
  contact_id?: string;
  deal_id?: string;
  attendees?: string[];
  start_time: string;
  end_time: string;
  location?: string;
  meeting_url?: string;
  reminder_minutes: number;
  send_invite: boolean;
  notes?: string;
};

type UpdateBody = Partial<CreateBody>;

type IdParams = { id: string };

type PostMeetingNotesBody = { notes: string };

type AvailabilityQuery = {
  date: string;
  user_ids: string[];
  duration_minutes: number;
};

type YandexCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
};

type OAuthState = {
  sub: string;
  org_id: string;
  exp: number;
};

type YandexTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

type YandexUserInfo = {
  login: string;
  id: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function contactBelongsToOrg(contactId: string, orgId: string): Promise<boolean> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    select: { id: true },
  });
  return contact !== null;
}

async function dealBelongsToOrg(dealId: string, orgId: string): Promise<boolean> {
  const deal = await db.deal.findFirst({
    where: { id: dealId, organization_id: orgId },
    select: { id: true },
  });
  return deal !== null;
}

function hasInvalidEventWindow(startTime: Date, endTime: Date): boolean {
  return endTime.getTime() <= startTime.getTime();
}



function decryptYandexSync<T extends { access_token: string; refresh_token: string | null }>(sync: T): T {
  return {
    ...sync,
    access_token: decryptToken(sync.access_token),
    refresh_token: sync.refresh_token ? decryptToken(sync.refresh_token) : sync.refresh_token,
  };
}

function signState(payload: OAuthState): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const secret = getJwtSecret();
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(state: string): OAuthState | null {
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
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function yandexConfigured(): boolean {
  return Boolean(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function timingSafeEqualString(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function yandexWebhookSecretFromRequest(request: FastifyRequest): string | undefined {
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

function readYandexWebhookSecret(reply: FastifyReply): string | null {
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

function yandexRedirectUri(request: FastifyRequest): string {
  const configuredRedirectUri = getDeploymentSafeUrl('YANDEX_REDIRECT_URI', {
    requiredInProduction: true,
    allowedProtocols: ['https:'],
  });
  if (configuredRedirectUri) return configuredRedirectUri;

  const host = request.headers.host ?? `localhost:${process.env.PORT ?? '3000'}`;
  return `${request.protocol}://${host}/api/v1/calendar/sync/yandex/callback`;
}

async function exchangeYandexToken(params: Record<string, string>): Promise<YandexTokenResponse> {
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

async function getValidYandexSync(userId: string, orgId: string) {
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

async function syncYandexEventForUser(
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

async function deleteYandexEventForUser(
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

// ─── Handlers ────────────────────────────────────────────────────────────────

async function list(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { start, end, contact_id, deal_id, attendee_id, status, page, per_page } =
    request.query as ListQuery;

  const where: Prisma.CalendarEventWhereInput = {
    organization_id: request.user.org_id,
    ...(status ? { status } : { status: { not: CalendarEventStatus.cancelled } }),
    ...(contact_id && { contact_id }),
    ...(deal_id && { deal_id }),
    ...(attendee_id && { attendee_ids: { array_contains: attendee_id } }),
    ...((start || end) && {
      start_time: {
        ...(start && { gte: new Date(start) }),
        ...(end && { lte: new Date(end) }),
      },
    }),
  };

  const skip = (page - 1) * per_page;
  const take = per_page;

  const [events, total] = await Promise.all([
    db.calendarEvent.findMany({
      where,
      skip,
      take,
      orderBy: { start_time: 'asc' },
      include: {
        contact: { select: { id: true, first_name: true, last_name: true } },
        deal: { select: { id: true, title: true } },
      },
    }),
    db.calendarEvent.count({ where }),
  ]);

  reply.send({ data: events, meta: { total, page, per_page } });
}

async function create(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { attendees, start_time, end_time, send_invite: _send_invite, ...rest } =
    request.body as CreateBody;

  if (hasInvalidEventWindow(new Date(start_time), new Date(end_time))) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'end_time must be after start_time' },
    });
    return;
  }

  const [ownsContact, ownsDeal] = await Promise.all([
    rest.contact_id !== undefined
      ? contactBelongsToOrg(rest.contact_id, request.user.org_id)
      : Promise.resolve(true),
    rest.deal_id !== undefined
      ? dealBelongsToOrg(rest.deal_id, request.user.org_id)
      : Promise.resolve(true),
  ]);

  if (!ownsContact) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
    });
    return;
  }

  if (!ownsDeal) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    });
    return;
  }

  const event = await db.calendarEvent.create({
    data: {
      ...rest,
      start_time: new Date(start_time),
      end_time: new Date(end_time),
      attendee_ids: attendees ?? [],
      organization_id: request.user.org_id,
      created_by: request.user.sub,
      status: CalendarEventStatus.scheduled,
    },
  });

  await syncYandexEventForUser(request.user.sub, event.id, request.user.org_id);

  reply.status(201).send({ data: event, meta: {} });
}

async function getById(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: request.user.org_id },
    include: {
      contact: { select: { id: true, first_name: true, last_name: true } },
      deal: { select: { id: true, title: true } },
    },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  reply.send({ data: event, meta: {} });
}

async function update(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { attendees, start_time, end_time, send_invite: _send_invite, ...rest } =
    request.body as UpdateBody;
  const orgId = request.user.org_id;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.cancelled) {
    reply.status(422).send({ error: { code: 'EVENT_CANCELLED', message: 'Cannot update a cancelled event' } });
    return;
  }

  const nextStartTime = start_time !== undefined ? new Date(start_time) : event.start_time;
  const nextEndTime = end_time !== undefined ? new Date(end_time) : event.end_time;

  if (hasInvalidEventWindow(nextStartTime, nextEndTime)) {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'end_time must be after start_time' },
    });
    return;
  }

  const [ownsContact, ownsDeal] = await Promise.all([
    rest.contact_id !== undefined
      ? contactBelongsToOrg(rest.contact_id, orgId)
      : Promise.resolve(true),
    rest.deal_id !== undefined
      ? dealBelongsToOrg(rest.deal_id, orgId)
      : Promise.resolve(true),
  ]);

  if (!ownsContact) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
    });
    return;
  }

  if (!ownsDeal) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    });
    return;
  }

  const result = await db.calendarEvent.updateMany({
    where: { id, organization_id: orgId, status: { not: CalendarEventStatus.cancelled } },
    data: {
      ...rest,
      ...(start_time !== undefined && { start_time: new Date(start_time) }),
      ...(end_time !== undefined && { end_time: new Date(end_time) }),
      ...(attendees !== undefined && { attendee_ids: attendees }),
    },
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  const updated = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!updated) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  await syncYandexEventForUser(request.user.sub, updated.id, orgId);

  reply.send({ data: updated, meta: {} });
}

async function cancel(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.cancelled) {
    reply.status(422).send({ error: { code: 'EVENT_ALREADY_CANCELLED', message: 'Event is already cancelled' } });
    return;
  }

  const result = await db.calendarEvent.updateMany({
    where: { id, organization_id: orgId, status: { not: CalendarEventStatus.cancelled } },
    data: { status: CalendarEventStatus.cancelled },
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  const updated = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!updated) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  await deleteYandexEventForUser(request.user.sub, updated.id, orgId);

  reply.send({ data: updated, meta: {} });
}

async function addPostMeetingNotes(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { notes } = request.body as PostMeetingNotesBody;
  const orgId = request.user.org_id;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.scheduled) {
    reply.status(422).send({ error: { code: 'EVENT_NOT_COMPLETED', message: 'Cannot add post-meeting notes to a scheduled event' } });
    return;
  }

  const result = await db.calendarEvent.updateMany({
    where: { id, organization_id: orgId, status: { not: CalendarEventStatus.scheduled } },
    data: { notes, post_meeting_prompted: true },
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  const updated = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!updated) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  reply.send({ data: updated, meta: {} });
}

async function markCompleted(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.cancelled) {
    reply.status(422).send({ error: { code: 'EVENT_CANCELLED', message: 'Cannot complete a cancelled event' } });
    return;
  }

  const result = await db.calendarEvent.updateMany({
    where: { id, organization_id: orgId, status: { not: CalendarEventStatus.cancelled } },
    data:
      event.status === CalendarEventStatus.completed
        ? { status: CalendarEventStatus.scheduled, completed_at: null }
        : { status: CalendarEventStatus.completed, completed_at: new Date() },
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  const updated = await db.calendarEvent.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!updated) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  reply.send({ data: updated, meta: {} });
}

async function getAvailability(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { date, user_ids } = request.query as AvailabilityQuery;

  const startOfDay = new Date(date);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  const events = await db.calendarEvent.findMany({
    where: {
      organization_id: request.user.org_id,
      status: { not: CalendarEventStatus.cancelled },
      created_by: { in: user_ids },
      start_time: { gte: startOfDay, lt: endOfDay },
    },
    select: {
      created_by: true,
      start_time: true,
      end_time: true,
      title: true,
    },
    orderBy: { start_time: 'asc' },
  });

  const busy_slots = events.map((e) => ({
    user_id: e.created_by,
    start_time: e.start_time,
    end_time: e.end_time,
    title: e.title,
  }));

  reply.send({ data: { busy_slots }, meta: {} });
}

async function yandexOAuthStart(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!yandexConfigured()) {
    reply.status(501).send({
      error: {
        code: 'YANDEX_OAUTH_NOT_CONFIGURED',
        message: 'Yandex Calendar sync requires OAuth credentials. Set YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET in .env.',
      },
    });
    return;
  }

  const state = signState({
    sub: request.user.sub,
    org_id: request.user.org_id,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const redirectUri = yandexRedirectUri(request);
  const authUrl = new URL('https://oauth.yandex.ru/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', process.env.YANDEX_CLIENT_ID ?? '');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('force_confirm', 'yes');
  authUrl.searchParams.set('state', state);

  reply.send({ data: { auth_url: authUrl.toString(), redirect_uri: redirectUri }, meta: {} });
}

async function yandexOAuthCallback(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { code, state, error } = request.query as YandexCallbackQuery;

  if (error) {
    reply.status(400).send({ error: { code: 'YANDEX_OAUTH_DENIED', message: error } });
    return;
  }

  if (!code || !state) {
    reply.status(400).send({ error: { code: 'YANDEX_OAUTH_INVALID_CALLBACK', message: 'Missing code or state' } });
    return;
  }

  if (!yandexConfigured()) {
    reply.status(501).send({
      error: {
        code: 'YANDEX_OAUTH_NOT_CONFIGURED',
        message: 'Yandex Calendar OAuth callback requires YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET in .env.',
      },
    });
    return;
  }

  const payload = verifyState(state);
  if (!payload) {
    reply.status(400).send({ error: { code: 'YANDEX_OAUTH_INVALID_STATE', message: 'Invalid or expired OAuth state' } });
    return;
  }

  const token = await exchangeYandexToken({
    code,
    client_id: process.env.YANDEX_CLIENT_ID ?? '',
    client_secret: process.env.YANDEX_CLIENT_SECRET ?? '',
    redirect_uri: yandexRedirectUri(request),
    grant_type: 'authorization_code',
  });

  const yandexLogin = await getYandexUsername(token.access_token);

  const syncWhere = {
    user_id: payload.sub,
    provider: 'yandex',
    user: { organization_id: payload.org_id },
  };
  const existing = await db.userCalendarSync.findFirst({
    where: syncWhere,
  });

  const user = await db.user.findFirst({
    where: { id: payload.sub, organization_id: payload.org_id },
    select: { id: true },
  });

  if (!user) {
    reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return;
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
      reply.status(404).send({ error: { code: 'YANDEX_SYNC_NOT_CONNECTED', message: 'Yandex Calendar is not connected for this user' } });
      return;
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
  if (successUrl) {
    reply.redirect(successUrl);
    return;
  }

  reply.type('text/html').send('<html><body>Yandex Calendar connected. You can close this window.</body></html>');
}

async function yandexDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const syncWhere = {
    user_id: request.user.sub,
    provider: 'yandex',
    user: { organization_id: request.user.org_id },
  };
  const sync = await db.userCalendarSync.findFirst({
    where: syncWhere,
  });

  if (!sync) {
    reply.status(404).send({ error: { code: 'YANDEX_SYNC_NOT_CONNECTED', message: 'Yandex Calendar is not connected for this user' } });
    return;
  }

  const result = await db.userCalendarSync.deleteMany({
    where: syncWhere,
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'YANDEX_SYNC_NOT_CONNECTED', message: 'Yandex Calendar is not connected for this user' } });
    return;
  }

  await auditLog({
    action: 'calendar.oauth_disconnect',
    outcome: 'success',
    request,
    metadata: { provider: 'yandex' },
  });

  reply.send({ data: { disconnected: true }, meta: {} });
}

async function syncStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sync = await db.userCalendarSync.findFirst({
    where: {
      user_id: request.user.sub,
      provider: 'yandex',
      user: { organization_id: request.user.org_id },
    },
  });

  reply.send({
    data: {
      connected: sync !== null,
      yandex_username: sync?.yandex_username ?? null,
      yandex_calendar_slug: sync?.yandex_calendar_slug ?? null,
      expires_at: sync?.expires_at ?? null,
    },
    meta: {},
  });
}

async function yandexWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expectedSecret = readYandexWebhookSecret(reply);
  if (expectedSecret === null) {
    await auditLog({
      action: 'webhook.yandex',
      outcome: 'failure',
      request,
      metadata: { reason: 'missing_server_secret' },
    });
    return;
  }

  if (expectedSecret) {
    const providedSecret = yandexWebhookSecretFromRequest(request);
    if (!providedSecret || !timingSafeEqualString(providedSecret, expectedSecret)) {
      await auditLog({
        action: 'webhook.yandex',
        outcome: 'denied',
        request,
        metadata: { reason: 'invalid_secret' },
      });
      reply.status(401).send({
        error: { code: 'YANDEX_WEBHOOK_UNAUTHORIZED', message: 'Invalid Yandex webhook secret' },
      });
      return;
    }
  }

  await auditLog({
    action: 'webhook.yandex',
    outcome: 'success',
    request,
  });
  reply.send({ data: { received: true }, meta: {} });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const CalendarController = {
  list,
  create,
  getById,
  update,
  cancel,
  addPostMeetingNotes,
  markCompleted,
  getAvailability,
  yandexOAuthStart,
  yandexOAuthCallback,
  yandexDisconnect,
  syncStatus,
  yandexWebhook,
};
