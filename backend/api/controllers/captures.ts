import { FastifyRequest, FastifyReply } from 'fastify';
import {
  MessageDirection,
  MessageChannel,
  MessageStatus,
  PendingCaptureType,
  PendingCaptureStatus,
  Prisma,
} from '@prisma/client';
import { db } from '../../services/db';
import { decryptField } from '../../services/encryption';
import {
  getAccessibleUserIds,
  canSeeUser,
  ownerVisibilityWhere,
} from '../../services/visibility';

// --- Local request types ---

type ListQuery = {
  status?: 'pending' | 'matched' | 'dismissed' | 'all';
};

type IdParams = { id: string };

type MatchBody = { contact_id: string };

type RawCaptureData = Record<string, unknown>;

type CreateBody = {
  type: PendingCaptureType;
  raw_data: RawCaptureData;
  phone_number?: string;
};

type CaptureForMessage = {
  type: PendingCaptureType;
  raw_data: Prisma.JsonValue;
  phone_number: string | null;
};

type CaptureContact = {
  id: string;
  first_name: string;
  last_name: string | null;
};

// --- Helpers ---

function toRequiredString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPhoneLikeString(value: unknown): string | undefined {
  const trimmed = toRequiredString(value);
  if (!trimmed) {
    return undefined;
  }

  return /\d/.test(trimmed) ? trimmed : undefined;
}

function firstRequiredString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = toRequiredString(value);
    if (stringValue) {
      return stringValue;
    }
  }

  return undefined;
}

function firstPhoneLikeString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = toPhoneLikeString(value);
    if (stringValue) {
      return stringValue;
    }
  }

  return undefined;
}

function rawDataRecord(value: Prisma.JsonValue): RawCaptureData {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as RawCaptureData;
  }

  return {};
}

function toInputJson(rawData: RawCaptureData): Prisma.InputJsonValue {
  return rawData as Prisma.InputJsonObject;
}

function resolveDirection(rawData: RawCaptureData): MessageDirection {
  return rawData.direction === MessageDirection.outbound
    ? MessageDirection.outbound
    : MessageDirection.inbound;
}

function resolveChannel(type: PendingCaptureType): MessageChannel {
  if (type === PendingCaptureType.call) return MessageChannel.call;
  return MessageChannel.email;
}

function resolveStatusFilter(status: ListQuery['status']): PendingCaptureStatus | undefined {
  if (status === 'all') {
    return undefined;
  }

  if (status === 'matched') {
    return PendingCaptureStatus.matched;
  }

  if (status === 'dismissed') {
    return PendingCaptureStatus.dismissed;
  }

  return PendingCaptureStatus.pending;
}

function resolveRawPhoneNumber(rawData: RawCaptureData): string | undefined {
  return firstPhoneLikeString(rawData.phone, rawData.from, rawData.From);
}

function resolveStoredPhoneNumber(rawData: RawCaptureData, phoneNumber?: string | null): string | undefined {
  return toRequiredString(phoneNumber) ?? resolveRawPhoneNumber(rawData);
}

function resolveCaptureTimestamp(rawData: RawCaptureData): Date | undefined {
  const rawTimestamp = firstRequiredString(rawData.timestamp, rawData.occurred_at);
  if (!rawTimestamp) {
    return undefined;
  }

  const timestamp = new Date(rawTimestamp);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
}

function resolveDurationSeconds(rawData: RawCaptureData): number | undefined {
  const rawDuration = rawData.duration_seconds ?? rawData.duration;
  if (typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0) {
    return Math.trunc(rawDuration);
  }

  const durationString = toRequiredString(rawDuration);
  if (!durationString || !/^\d+(\.\d+)?$/.test(durationString)) {
    return undefined;
  }

  return Math.trunc(Number(durationString));
}

function resolveCallBody(rawData: RawCaptureData): string {
  const durationSeconds = resolveDurationSeconds(rawData);
  const notes = firstRequiredString(rawData.notes, rawData.note, rawData.body, rawData.text);
  const durationPrefix = durationSeconds !== undefined ? `[${durationSeconds}s] ` : '';
  return `${durationPrefix}${notes ?? ''}`.trim() || 'Call logged';
}

function resolveMessageBody(type: PendingCaptureType, rawData: RawCaptureData, phoneNumber: string | null): string {
  if (type === PendingCaptureType.call) {
    return resolveCallBody(rawData);
  }

  const body = firstRequiredString(rawData.body, rawData.Body, rawData.text, rawData.message, rawData.subject);
  if (body) {
    return body;
  }

  return phoneNumber ? `Captured email touchpoint from ${phoneNumber}` : 'Captured email touchpoint';
}

function buildMessageData(
  organizationId: string,
  contactId: string,
  capture: CaptureForMessage,
): Prisma.MessageUncheckedCreateInput {
  const rawData = rawDataRecord(capture.raw_data);
  const createdAt = resolveCaptureTimestamp(rawData);
  const phoneNumber = toRequiredString(capture.phone_number) ?? resolveRawPhoneNumber(rawData);

  return {
    organization_id: organizationId,
    contact_id: contactId,
    direction: resolveDirection(rawData),
    channel: resolveChannel(capture.type),
    body: resolveMessageBody(capture.type, rawData, phoneNumber ?? null),
    status: MessageStatus.delivered,
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

/**
 * Where "09:00 tomorrow" is measured.
 *
 * `Europe/Moscow` is the market's zone — the same value `src/market/profile.ts`
 * and `docs/architecture/market-profile.md` carry for the RU profile.
 * `backend/config/market.ts` holds the market constants on this side of the wire
 * (currency, the default pipeline and its stages) but no zone, so there was no
 * existing backend constant to reuse; when a per-organisation or per-user zone
 * arrives, this is the line it replaces.
 */
const FOLLOW_UP_TIME_ZONE = 'Europe/Moscow';
const FOLLOW_UP_HOUR = 9;

/**
 * How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds.
 *
 * Done through `Intl` with an explicit zone rather than a hard-coded +03:00, so
 * this stays correct if the offset ever moves again — Russia has changed it twice
 * in living memory — and so the same helper is right for a zone that observes
 * DST, which `America/New_York` in the US profile does.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`: some ICU builds render midnight
 * as «24» under the latter, which would silently push the answer a day out.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const wallClockAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  // formatToParts resolves to whole seconds, so the instant is truncated to
  // seconds too rather than letting its milliseconds leak into the offset.
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The auto follow-up a matched capture staples onto the contact: 09:00 tomorrow.
 *
 * "Tomorrow at nine" is a claim about the OPERATOR'S wall clock, and this used to
 * be measured on the server's: `new Date()` + `setDate(+1)` + `setHours(9,0,0,0)`
 * are all local-time operations, and production runs `Etc/UTC` (the DB session is
 * pinned to UTC per docs/architecture/timestamp-storage.md, and the box follows).
 * So the task appeared at 12:00 Moscow — three hours into the working day it was
 * promised for, right through lunch. Between 21:00 and 00:00 Moscow it was also
 * the wrong DAY, because the date being incremented was the UTC date, not the
 * one the operator was living in.
 *
 * `now` is a parameter so the calculation can be tested at a fixed instant; every
 * caller uses the default.
 */
function followUpDueDate(now: Date = new Date()): Date {
  const offsetNow = zoneOffsetMs(now, FOLLOW_UP_TIME_ZONE);

  // Today's date in the MARKET's zone, then tomorrow at FOLLOW_UP_HOUR, as a bare
  // wall clock. Shifting the instant and then reading it back with getUTC* is
  // what keeps the server's own zone out of the arithmetic entirely — no method
  // below consults it.
  const wallClockNow = new Date(now.getTime() + offsetNow);
  const wallClockDue = Date.UTC(
    wallClockNow.getUTCFullYear(),
    wallClockNow.getUTCMonth(),
    wallClockNow.getUTCDate() + 1,
    FOLLOW_UP_HOUR,
  );

  // And back to an instant. The offset is re-read AT the target, because a DST
  // boundary can fall between now and tomorrow morning and the two offsets then
  // differ. Europe/Moscow has not observed DST since 2014, so today this second
  // read always returns the first one — it is here so the helper is not quietly
  // wrong for the first zone that does.
  const offsetDue = zoneOffsetMs(new Date(wallClockDue - offsetNow), FOLLOW_UP_TIME_ZONE);
  return new Date(wallClockDue - offsetDue);
}

function contactFullName(contact: CaptureContact): string {
  return `${contact.first_name}${contact.last_name ? ' ' + contact.last_name : ''}`;
}

function buildFollowUpTaskData(
  organizationId: string,
  contact: CaptureContact,
  userId: string,
): Prisma.TaskUncheckedCreateInput {
  return {
    organization_id: organizationId,
    title: `Follow up: ${contactFullName(contact)}`,
    contact_id: contact.id,
    assigned_to: userId,
    due_date: followUpDueDate(),
    priority: 'medium',
    status: 'pending',
    created_by: userId,
  };
}

function sendAlreadyResolved(reply: FastifyReply): void {
  reply.status(422).send({
    error: {
      code: 'CAPTURE_ALREADY_RESOLVED',
      message: 'Capture has already been resolved',
    },
  });
}

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

// --- Handlers ---

async function list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { status } = request.query as ListQuery;
  const statusFilter = resolveStatusFilter(status);

  // The cone. This list joins the linked Contact in and decrypts its phone below,
  // so org scoping alone let ANY role read the name and plaintext number of a
  // contact in another branch. PendingCapture has no owner column of its own —
  // org_id and contact_id are the only scoping it carries — so the cone is applied
  // through the contact, on the same assigned_to/created_by pair the contacts,
  // deals and tasks list endpoints use.
  //
  // The route has no `scope` query parameter, so there is nothing to toggle: the
  // caller gets their full subtree rather than the 'direct' default the toggled
  // list endpoints fall back to.
  const accessibleIds = await getAccessibleUserIds(request.user);
  const contactVisibility = ownerVisibilityWhere(accessibleIds);

  const captures = await db.pendingCapture.findMany({
    where: {
      org_id: request.user.org_id,
      ...(statusFilter ? { status: statusFilter } : {}),
      // An UNMATCHED capture belongs to nobody yet — it is precisely the shared
      // inbox this screen exists to work through, and it carries no contact PII —
      // so it stays visible to everyone in the org. Only a capture already
      // pointing at somebody else's contact is filtered out.
      ...(contactVisibility && {
        OR: [{ contact_id: null }, { contact: contactVisibility }],
      }),
    },
    include: {
      contact: {
        select: { id: true, first_name: true, last_name: true, phone: true },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  // Contact.phone comes back as ciphertext. This used to be sent to the client verbatim
  // and only looked correct because a since-removed create-contact handler in this file
  // wrote plaintext; a contact created through any other route rendered as "enc:v1:…" in
  // the capture list.
  const data = captures.map((capture) =>
    capture.contact
      ? { ...capture, contact: { ...capture.contact, phone: decryptField(capture.contact.phone) } }
      : capture,
  );

  reply.send({ data, meta: { total: data.length } });
}

async function match(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;
  const { contact_id } = request.body as MatchBody;
  const orgId = request.user.org_id;

  const capture = await db.pendingCapture.findFirst({
    where: { id, org_id: orgId },
  });

  if (!capture) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Capture not found' } });
    return;
  }

  if (capture.status !== PendingCaptureStatus.pending) {
    sendAlreadyResolved(reply);
    return;
  }

  const contact = await db.contact.findFirst({
    where: { id: contact_id, organization_id: orgId },
    select: { id: true, first_name: true, last_name: true, assigned_to: true, created_by: true },
  });

  if (!contact) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    return;
  }

  // Matching is a WRITE against the contact — it staples a Message and a follow-up
  // Task onto it below — so org scoping alone let a user fabricate activity on
  // another branch's record. Looked up org-wide and then tested against the cone,
  // exactly as the deals controller does, so an out-of-cone contact answers with
  // the same 404 as a nonexistent one and the response is not an existence oracle.
  const accessibleIds = await getAccessibleUserIds(request.user);
  if (!canSeeUser(accessibleIds, contact.assigned_to) && !canSeeUser(accessibleIds, contact.created_by)) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    return;
  }

  try {
    const updatedCapture = await db.$transaction(async (tx) => {
      const updated = await tx.pendingCapture.update({
        where: { id, org_id: orgId, status: PendingCaptureStatus.pending },
        data: { status: PendingCaptureStatus.matched, contact_id },
      });

      await tx.message.create({
        data: buildMessageData(orgId, contact_id, capture),
      });

      await tx.task.create({
        data: buildFollowUpTaskData(orgId, contact, request.user.sub),
      });

      return updated;
    });

    reply.send({ data: { ...updatedCapture, follow_up_task_created: true }, meta: {} });
  } catch (error) {
    if (isRecordNotFound(error)) {
      sendAlreadyResolved(reply);
      return;
    }

    throw error;
  }
}

async function dismiss(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const capture = await db.pendingCapture.findFirst({
    where: { id, org_id: orgId },
  });

  if (!capture) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Capture not found' } });
    return;
  }

  if (capture.status !== PendingCaptureStatus.pending) {
    sendAlreadyResolved(reply);
    return;
  }

  try {
    const updatedCapture = await db.pendingCapture.update({
      where: { id, org_id: orgId, status: PendingCaptureStatus.pending },
      data: { status: PendingCaptureStatus.dismissed },
    });

    reply.send({ data: updatedCapture, meta: {} });
  } catch (error) {
    if (isRecordNotFound(error)) {
      sendAlreadyResolved(reply);
      return;
    }

    throw error;
  }
}

async function create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { type, raw_data, phone_number } = request.body as CreateBody;
  const resolvedPhoneNumber = resolveStoredPhoneNumber(raw_data, phone_number);

  const capture = await db.pendingCapture.create({
    data: {
      org_id: request.user.org_id,
      type,
      raw_data: toInputJson(raw_data),
      phone_number: resolvedPhoneNumber ?? null,
      status: PendingCaptureStatus.pending,
    },
  });

  reply.status(201).send({ data: capture, meta: {} });
}

// --- Export ---

export const CapturesController = {
  list,
  match,
  dismiss,
  create,
};
