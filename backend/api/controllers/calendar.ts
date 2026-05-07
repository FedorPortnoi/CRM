import { FastifyRequest, FastifyReply } from 'fastify';
import { CalendarEventStatus, Prisma } from '@prisma/client';
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
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.status(501).send({
    error: {
      code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
      message: 'Google Calendar sync requires OAuth credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
    },
  });
}

async function googleOAuthCallback(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.status(501).send({
    error: {
      code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
      message: 'Google Calendar OAuth callback requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
    },
  });
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
