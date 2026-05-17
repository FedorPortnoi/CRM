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
  if (type === PendingCaptureType.sms) return MessageChannel.sms;
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

  const label = type === PendingCaptureType.sms ? 'SMS' : 'email';
  return phoneNumber ? `Captured ${label} touchpoint from ${phoneNumber}` : `Captured ${label} touchpoint`;
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

  const captures = await db.pendingCapture.findMany({
    where: {
      org_id: request.user.org_id,
      ...(statusFilter ? { status: statusFilter } : {}),
    },
    include: {
      contact: {
        select: { id: true, first_name: true, last_name: true, phone: true },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  reply.send({ data: captures, meta: { total: captures.length } });
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
    select: { id: true },
  });

  if (!contact) {
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

      return updated;
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

async function createContact(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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

  const raw = rawDataRecord(capture.raw_data);
  const first_name = firstRequiredString(raw.first_name, raw.name) ?? 'Unknown';
  const rawPhone = resolveRawPhoneNumber(raw) ?? toRequiredString(capture.phone_number);

  try {
    const newContact = await db.$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: {
          organization_id: orgId,
          first_name,
          phone: rawPhone,
          created_by: request.user.sub,
        },
      });

      await tx.message.create({
        data: buildMessageData(orgId, contact.id, capture),
      });

      await tx.pendingCapture.update({
        where: { id, org_id: orgId, status: PendingCaptureStatus.pending },
        data: { status: PendingCaptureStatus.matched, contact_id: contact.id },
      });

      return contact;
    });

    reply.status(201).send({ data: newContact, meta: {} });
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
  createContact,
  create,
};
