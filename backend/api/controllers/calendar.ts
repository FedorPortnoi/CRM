import { FastifyRequest, FastifyReply } from 'fastify';
import { CalendarEventStatus, Prisma } from '@prisma/client';
import { paginate } from '../../services/db-paginate';
import {
  yandexConfigured,
  resolveYandexRedirectUri,
  buildYandexOAuthUrl,
  handleYandexOAuthCallback,
  disconnectYandexSync,
  getYandexSyncStatus,
  syncYandexEventForUser,
  deleteYandexEventForUser,
  extractYandexWebhookSecret,
  readConfiguredWebhookSecret,
  timingSafeEqualString,
  verifyState,
} from '../../services/yandex-calendar';
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

  const { data: events, total } = await paginate(
    () => db.calendarEvent.count({ where }),
    () => db.calendarEvent.findMany({
      where,
      skip,
      take,
      orderBy: { start_time: 'asc' },
      include: {
        contact: { select: { id: true, first_name: true, last_name: true } },
        deal: { select: { id: true, title: true } },
      },
    }),
  );

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

// ─── Yandex sync handlers (thin wrappers over yandex-calendar service) ────────

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

  const redirectUri = resolveYandexRedirectUri(request);
  const result = buildYandexOAuthUrl(request.user.sub, request.user.org_id, redirectUri);
  reply.send({ data: result, meta: {} });
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

  // Pre-validate state here so we can return a typed 400 without throwing.
  if (!verifyState(state)) {
    reply.status(400).send({ error: { code: 'YANDEX_OAUTH_INVALID_STATE', message: 'Invalid or expired OAuth state' } });
    return;
  }

  const redirectUri = resolveYandexRedirectUri(request);

  try {
    const { successUrl } = await handleYandexOAuthCallback(code, state, redirectUri, request);
    if (successUrl) {
      reply.redirect(successUrl);
      return;
    }
    reply.type('text/html').send('<html><body>Yandex Calendar connected. You can close this window.</body></html>');
  } catch (err: unknown) {
    const tagged = err as { code?: string; message?: string };
    if (tagged.code === 'USER_NOT_FOUND') {
      reply.status(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
      return;
    }
    if (tagged.code === 'YANDEX_SYNC_NOT_CONNECTED') {
      reply.status(404).send({ error: { code: 'YANDEX_SYNC_NOT_CONNECTED', message: 'Yandex Calendar is not connected for this user' } });
      return;
    }
    throw err;
  }
}

async function yandexDisconnect(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await disconnectYandexSync(request.user.sub, request.user.org_id, request);
    reply.send({ data: { disconnected: true }, meta: {} });
  } catch (err: unknown) {
    const tagged = err as { code?: string };
    if (tagged.code === 'YANDEX_SYNC_NOT_CONNECTED') {
      reply.status(404).send({ error: { code: 'YANDEX_SYNC_NOT_CONNECTED', message: 'Yandex Calendar is not connected for this user' } });
      return;
    }
    throw err;
  }
}

async function syncStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const status = await getYandexSyncStatus(request.user.sub, request.user.org_id);
  reply.send({ data: status, meta: {} });
}

async function yandexWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expectedSecret = readConfiguredWebhookSecret(reply);
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
    const providedSecret = extractYandexWebhookSecret(request);
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
