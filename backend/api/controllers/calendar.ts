import { FastifyRequest, FastifyReply } from 'fastify';
import { CalendarEventStatus, Prisma } from '@prisma/client';
import crypto from 'crypto';
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

type GoogleCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
};

type GoogleOAuthState = {
  sub: string;
  org_id: string;
  exp: number;
};

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

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

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signState(payload: GoogleOAuthState): string {
  const encoded = base64Url(JSON.stringify(payload));
  const secret = process.env.JWT_SECRET ?? '';
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(state: string): GoogleOAuthState | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? '')
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
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as GoogleOAuthState;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function googleRedirectUri(request: FastifyRequest): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = request.headers.host ?? `localhost:${process.env.PORT ?? '3000'}`;
  return `${request.protocol}://${host}/api/v1/calendar/sync/google/callback`;
}

function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function exchangeGoogleToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const body = await response.json() as GoogleTokenResponse & { error?: string; error_description?: string };

  if (!response.ok) {
    throw new Error(body.error_description ?? body.error ?? `Google token exchange failed with ${response.status}`);
  }

  return body;
}

async function getValidGoogleSync(userId: string) {
  const sync = await db.userCalendarSync.findUnique({
    where: { user_id_provider: { user_id: userId, provider: 'google' } },
  });

  if (!sync) return null;

  const expiresAt = sync.expires_at?.getTime() ?? 0;
  if (!sync.refresh_token || expiresAt > Date.now() + 60_000) {
    return sync;
  }

  const token = await exchangeGoogleToken({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    refresh_token: sync.refresh_token,
    grant_type: 'refresh_token',
  });

  return db.userCalendarSync.update({
    where: { user_id_provider: { user_id: userId, provider: 'google' } },
    data: {
      access_token: token.access_token,
      expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : sync.expires_at,
    },
  });
}

async function syncGoogleEventForUser(userId: string | null | undefined, eventId: string): Promise<void> {
  if (!userId || !googleConfigured()) return;

  const sync = await getValidGoogleSync(userId);
  if (!sync) return;

  const event = await db.calendarEvent.findUnique({
    where: { id: eventId },
    include: {
      contact: { select: { first_name: true, last_name: true, email: true } },
    },
  });

  if (!event || event.status === CalendarEventStatus.cancelled) return;

  const calendarId = sync.google_calendar_id ?? 'primary';
  const payload = {
    summary: event.title,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: { dateTime: event.start_time.toISOString() },
    end: { dateTime: event.end_time.toISOString() },
    attendees: event.contact?.email ? [{ email: event.contact.email }] : undefined,
  };

  const url = event.google_event_id
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.google_event_id)}`
    : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

  const response = await fetch(url, {
    method: event.google_event_id ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${sync.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) return;

  const googleEvent = await response.json() as { id?: string };
  if (googleEvent.id && googleEvent.id !== event.google_event_id) {
    await db.calendarEvent.update({
      where: { id: event.id },
      data: { google_event_id: googleEvent.id, google_calendar_id: calendarId },
    });
  }
}

async function deleteGoogleEventForUser(userId: string | null | undefined, eventId: string): Promise<void> {
  if (!userId || !googleConfigured()) return;

  const event = await db.calendarEvent.findUnique({ where: { id: eventId } });
  if (!event?.google_event_id) return;

  const sync = await getValidGoogleSync(userId);
  if (!sync) return;

  const calendarId = event.google_calendar_id ?? sync.google_calendar_id ?? 'primary';
  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.google_event_id)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sync.access_token}` },
    },
  );
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

  await syncGoogleEventForUser(request.user.sub, event.id);

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

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: request.user.org_id },
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

  const updated = await db.calendarEvent.update({
    where: { id },
    data: {
      ...rest,
      ...(start_time !== undefined && { start_time: new Date(start_time) }),
      ...(end_time !== undefined && { end_time: new Date(end_time) }),
      ...(attendees !== undefined && { attendee_ids: attendees }),
    },
  });

  await syncGoogleEventForUser(request.user.sub, updated.id);

  reply.send({ data: updated, meta: {} });
}

async function cancel(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.cancelled) {
    reply.status(422).send({ error: { code: 'EVENT_ALREADY_CANCELLED', message: 'Event is already cancelled' } });
    return;
  }

  const updated = await db.calendarEvent.update({
    where: { id },
    data: { status: CalendarEventStatus.cancelled },
  });

  await deleteGoogleEventForUser(request.user.sub, updated.id);

  reply.send({ data: updated, meta: {} });
}

async function addPostMeetingNotes(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { notes } = request.body as PostMeetingNotesBody;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.scheduled) {
    reply.status(422).send({ error: { code: 'EVENT_NOT_COMPLETED', message: 'Cannot add post-meeting notes to a scheduled event' } });
    return;
  }

  const updated = await db.calendarEvent.update({
    where: { id },
    data: { notes, post_meeting_prompted: true },
  });

  reply.send({ data: updated, meta: {} });
}

async function markCompleted(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const event = await db.calendarEvent.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!event) {
    reply.status(404).send({ error: { code: 'EVENT_NOT_FOUND', message: 'Calendar event not found' } });
    return;
  }

  if (event.status === CalendarEventStatus.cancelled) {
    reply.status(422).send({ error: { code: 'EVENT_CANCELLED', message: 'Cannot complete a cancelled event' } });
    return;
  }

  const updated = await db.calendarEvent.update({
    where: { id },
    data:
      event.status === CalendarEventStatus.completed
        ? { status: CalendarEventStatus.scheduled, completed_at: null }
        : { status: CalendarEventStatus.completed, completed_at: new Date() },
  });

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

async function googleOAuthStart(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!googleConfigured()) {
    reply.status(501).send({
      error: {
        code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        message: 'Google Calendar sync requires OAuth credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
      },
    });
    return;
  }

  const state = signState({
    sub: request.user.sub,
    org_id: request.user.org_id,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const redirectUri = googleRedirectUri(request);
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID ?? '');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events');
  authUrl.searchParams.set('state', state);

  reply.send({ data: { auth_url: authUrl.toString(), redirect_uri: redirectUri }, meta: {} });
}

async function googleOAuthCallback(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { code, state, error } = request.query as GoogleCallbackQuery;

  if (error) {
    reply.status(400).send({ error: { code: 'GOOGLE_OAUTH_DENIED', message: error } });
    return;
  }

  if (!code || !state) {
    reply.status(400).send({ error: { code: 'GOOGLE_OAUTH_INVALID_CALLBACK', message: 'Missing code or state' } });
    return;
  }

  if (!googleConfigured()) {
    reply.status(501).send({
      error: {
        code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        message: 'Google Calendar OAuth callback requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
      },
    });
    return;
  }

  const payload = verifyState(state);
  if (!payload) {
    reply.status(400).send({ error: { code: 'GOOGLE_OAUTH_INVALID_STATE', message: 'Invalid or expired OAuth state' } });
    return;
  }

  const existing = await db.userCalendarSync.findUnique({
    where: { user_id_provider: { user_id: payload.sub, provider: 'google' } },
  });
  const token = await exchangeGoogleToken({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirect_uri: googleRedirectUri(request),
    grant_type: 'authorization_code',
  });

  await db.userCalendarSync.upsert({
    where: { user_id_provider: { user_id: payload.sub, provider: 'google' } },
    create: {
      user_id: payload.sub,
      provider: 'google',
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
      google_calendar_id: 'primary',
    },
    update: {
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? existing?.refresh_token,
      expires_at: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
      google_calendar_id: existing?.google_calendar_id ?? 'primary',
    },
  });

  const successUrl = process.env.GOOGLE_CALENDAR_SUCCESS_URL;
  if (successUrl) {
    reply.redirect(successUrl);
    return;
  }

  reply.type('text/html').send('<html><body>Google Calendar connected. You can close this window.</body></html>');
}

async function googleDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sync = await db.userCalendarSync.findUnique({
    where: { user_id_provider: { user_id: request.user.sub, provider: 'google' } },
  });

  if (!sync) {
    reply.status(404).send({ error: { code: 'GOOGLE_SYNC_NOT_CONNECTED', message: 'Google Calendar is not connected for this user' } });
    return;
  }

  await db.userCalendarSync.delete({
    where: { user_id_provider: { user_id: request.user.sub, provider: 'google' } },
  });

  reply.send({ data: { disconnected: true }, meta: {} });
}

async function syncStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sync = await db.userCalendarSync.findUnique({
    where: { user_id_provider: { user_id: request.user.sub, provider: 'google' } },
  });

  reply.send({
    data: {
      connected: sync !== null,
      google_calendar_id: sync?.google_calendar_id ?? null,
      expires_at: sync?.expires_at ?? null,
      webhook_expiry: sync?.webhook_expiry ?? null,
    },
    meta: {},
  });
}

async function googleWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const headers = request.headers as Record<string, string>;
  request.log.info(
    { channelId: headers['x-goog-channel-id'], resourceId: headers['x-goog-resource-id'] },
    'Google Calendar push notification received',
  );
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
  googleOAuthStart,
  googleOAuthCallback,
  googleDisconnect,
  syncStatus,
  googleWebhook,
};
