import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import {
  MessageDirection,
  MessageChannel,
  MessageStatus,
  PendingCaptureStatus,
  PendingCaptureType,
  Prisma,
} from '@prisma/client';
import { db } from '../../services/db';

// --- Local request types ---

type ListQuery = {
  contact_id?: string;
  channel?: MessageChannel;
  direction?: MessageDirection;
  status?: MessageStatus;
  page: number;
  per_page: number;
};

type ContactIdParams = { contact_id: string };

type IdParams = { id: string };

type SendSmsBody = {
  contact_id: string;
  body: string;
};

type SendInAppBody = {
  contact_id: string;
  body: string;
};

type SmsWebhookBody = Record<string, unknown> & {
  api_id?: unknown;
  from?: unknown;
  From?: unknown;
  text?: unknown;
  Body?: unknown;
  sms_id?: unknown;
  SmsId?: unknown;
  status?: unknown;
  Status?: unknown;
  org_id?: unknown;
  organization_id?: unknown;
};

type SmsRuRecipientResult = {
  status?: string;
  status_code?: number;
  sms_id?: string;
  status_text?: string;
};

type SmsRuSendResponse = {
  status?: string;
  status_code?: number;
  status_text?: string;
  sms?: Record<string, SmsRuRecipientResult>;
};

type WebSocketClientLike = {
  readyState?: number;
  OPEN?: number;
  send: (payload: string) => void;
};

type WebSocketServerLike = {
  clients?: Iterable<WebSocketClientLike>;
};

type FastifyWithWebSocket = FastifyInstance & {
  websocketServer?: WebSocketServerLike;
  ws?: WebSocketServerLike;
};

type LogCallBody = {
  contact_id: string;
  direction: 'inbound' | 'outbound';
  duration_seconds?: number;
  notes?: string;
  occurred_at?: string;
};

type SmsWebhookContact = {
  id: string;
  organization_id: string;
};

type WebhookOrgContext = {
  provided: boolean;
  orgId?: string;
};

const contactOrgCache = new Set<string>();

function contactOrgCacheKey(contactId: string, orgId: string): string {
  return `${orgId}:${contactId}`;
}

async function contactBelongsToOrg(contactId: string, orgId: string): Promise<boolean> {
  const key = contactOrgCacheKey(contactId, orgId);
  if (contactOrgCache.has(key)) {
    return true;
  }

  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    select: { id: true },
  });

  if (contact) {
    contactOrgCache.add(key);
    return true;
  }

  return false;
}

function sendServiceNotConfigured(reply: FastifyReply, variableName: string): void {
  reply.status(503).send({
    error: {
      code: 'SERVICE_NOT_CONFIGURED',
      message: `${variableName} is not configured`,
    },
  });
}

function toRequiredString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toUnknownRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function toSmsWebhookBody(value: unknown): SmsWebhookBody {
  return toUnknownRecord(value);
}

function getSmsRuApiId(): string | undefined {
  return toRequiredString(process.env.SMSRU_API_ID);
}

function getSmsRuSender(): string {
  return toRequiredString(process.env.SMSRU_SENDER) ?? 'CRM';
}

function getSmsRuError(body: SmsRuSendResponse, to: string): string {
  const recipient = body.sms?.[to];
  return recipient?.status_text ?? body.status_text ?? 'SMS.ru send failed';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function getWebhookOrgContext(body: SmsWebhookBody, query: SmsWebhookBody): WebhookOrgContext {
  const orgId = toRequiredString(body.org_id)
    ?? toRequiredString(body.organization_id)
    ?? toRequiredString(query.org_id)
    ?? toRequiredString(query.organization_id);

  if (!orgId) {
    return { provided: false };
  }

  return isUuid(orgId) ? { provided: true, orgId } : { provided: true };
}

function buildSmsInboundCaptureRawData(
  from: string,
  text: string,
  smsId: string | undefined,
  apiId: string | undefined,
  orgId: string,
): Prisma.InputJsonObject {
  return {
    provider: 'smsru',
    direction: 'inbound',
    from,
    From: from,
    text,
    Body: text,
    org_id: orgId,
    organization_id: orgId,
    ...(smsId ? { sms_id: smsId, SmsId: smsId } : {}),
    ...(apiId ? { api_id: apiId } : {}),
  };
}

async function findSmsWebhookContact(from: string, orgId: string | undefined): Promise<SmsWebhookContact | null> {
  const phoneWhere = {
    OR: [
      { phone: from },
      { mobile: from },
    ],
  };

  if (orgId) {
    return db.contact.findFirst({
      where: {
        organization_id: orgId,
        ...phoneWhere,
      },
      select: { id: true, organization_id: true },
    });
  }

  const contacts = await db.contact.findMany({
    where: phoneWhere,
    select: { id: true, organization_id: true },
    take: 2,
  });

  return contacts.length === 1 ? contacts[0] : null;
}

async function orgExists(orgId: string): Promise<boolean> {
  const org = await db.org.findUnique({
    where: { id: orgId },
    select: { id: true },
  });

  return Boolean(org);
}

async function sendViaSmsRu(apiId: string, to: string, msg: string): Promise<SmsRuSendResponse> {
  const params = new URLSearchParams({
    api_id: apiId,
    to,
    msg,
    from: getSmsRuSender(),
    json: '1',
  });

  const response = await fetch('https://sms.ru/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const body = await response.json() as SmsRuSendResponse;
  const recipient = body.sms?.[to];

  if (!response.ok || body.status !== 'OK' || body.status_code !== 100 || recipient?.status !== 'OK') {
    throw new Error(getSmsRuError(body, to));
  }

  return body;
}

function broadcastMessageIfAvailable(request: FastifyRequest, message: unknown): void {
  const server = request.server as FastifyWithWebSocket;
  const webSocketServer = server.websocketServer ?? server.ws;
  if (!webSocketServer?.clients) {
    return;
  }

  const payload = JSON.stringify({ type: 'message.created', data: message });
  for (const client of webSocketServer.clients) {
    const openState = client.OPEN ?? 1;
    if (client.readyState !== undefined && client.readyState !== openState) {
      continue;
    }

    try {
      client.send(payload);
    } catch {
      // Broadcast is best-effort; webhook processing should not fail because a socket closed.
    }
  }
}

// --- Handlers ---

async function list(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { contact_id, channel, direction, status, page, per_page } = request.query as ListQuery;

  const where: Prisma.MessageWhereInput = {
    organization_id: request.user.org_id,
    ...(contact_id && { contact_id }),
    ...(channel && { channel }),
    ...(direction && { direction }),
    ...(status && { status }),
  };

  const skip = (page - 1) * per_page;
  const take = per_page;

  const [messages, total] = await Promise.all([
    db.message.findMany({
      where,
      skip,
      take,
      orderBy: [{ created_at: 'desc' }],
    }),
    db.message.count({ where }),
  ]);

  reply.send({ data: messages, meta: { total, page, per_page } });
}

async function getConversation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { contact_id } = request.params as ContactIdParams;

  const ownsContact = await contactBelongsToOrg(contact_id, request.user.org_id);
  if (!ownsContact) {
    reply.status(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } });
    return;
  }

  const messages = await db.message.findMany({
    where: { contact_id, organization_id: request.user.org_id },
    orderBy: [{ created_at: 'asc' }],
  });

  reply.send({ data: messages, meta: {} });
}

async function sendSms(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { contact_id, body } = request.body as SendSmsBody;
  const organization_id = request.user.org_id;

  const contact = await db.contact.findFirst({
    where: { id: contact_id, organization_id },
    select: { id: true, phone: true, mobile: true },
  });

  if (!contact) {
    reply.status(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } });
    return;
  }

  contactOrgCache.add(contactOrgCacheKey(contact_id, organization_id));

  const message = await db.message.create({
    data: {
      organization_id,
      contact_id,
      user_id: request.user.sub,
      direction: MessageDirection.outbound,
      channel: MessageChannel.sms,
      body,
      status: MessageStatus.pending,
    },
  });

  const to = contact.mobile ?? contact.phone;

  const apiId = getSmsRuApiId();
  if (!apiId) {
    reply.status(201).send({ data: message, meta: { delivery: 'queued_without_smsru_config' } });
    return;
  }

  if (!to) {
    const failed = await db.message.update({
      where: { id: message.id },
      data: { status: MessageStatus.failed, error_message: 'Contact has no phone number' },
    });
    reply.status(422).send({ error: { code: 'CONTACT_PHONE_MISSING', message: 'Contact has no phone number' }, data: failed });
    return;
  }

  try {
    const sent = await sendViaSmsRu(apiId, to, body);
    const smsruId = sent.sms?.[to]?.sms_id;
    const updated = await db.message.update({
      where: { id: message.id },
      data: {
        twilio_sid: smsruId,
        status: MessageStatus.sent,
      },
    });

    reply.status(201).send({ data: updated, meta: { delivery: 'sent_to_smsru' } });
  } catch (error) {
    const failed = await db.message.update({
      where: { id: message.id },
      data: {
        status: MessageStatus.failed,
        error_message: error instanceof Error ? error.message : 'SMS.ru send failed',
      },
    });
    reply.status(201).send({ data: failed, meta: { delivery: 'smsru_failed' } });
  }
}

async function sendInApp(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { contact_id, body } = request.body as SendInAppBody;
  const organization_id = request.user.org_id;

  const ownsContact = await contactBelongsToOrg(contact_id, organization_id);
  if (!ownsContact) {
    reply.status(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } });
    return;
  }

  const message = await db.message.create({
    data: {
      organization_id,
      contact_id,
      user_id: request.user.sub,
      direction: MessageDirection.outbound,
      channel: MessageChannel.in_app,
      body,
      status: MessageStatus.sent,
    },
  });

  reply.status(201).send({ data: message, meta: {} });
}

async function logCall(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { contact_id, direction, duration_seconds, notes, occurred_at } = request.body as LogCallBody;
  const organization_id = request.user.org_id;

  const ownsContact = await contactBelongsToOrg(contact_id, organization_id);
  if (!ownsContact) {
    reply.status(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } });
    return;
  }

  const durationPrefix = duration_seconds != null ? `[${duration_seconds}s] ` : ``;
  const callBody = (durationPrefix + (notes?.trim() ?? '')).trim() || 'Call logged';

  const message = await db.message.create({
    data: {
      organization_id,
      contact_id,
      user_id: request.user.sub,
      direction: direction as MessageDirection,
      channel: MessageChannel.call,
      body: callBody,
      status: MessageStatus.delivered,
      ...(occurred_at ? { created_at: new Date(occurred_at) } : {}),
    },
  });

  reply.status(201).send({ data: message, meta: {} });
}

async function markRead(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const existing = await db.message.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!existing) {
    reply.status(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    return;
  }

  const updatedMessage = await db.message.update({
    where: { id },
    data: { status: MessageStatus.read, read_at: new Date() },
  });

  reply.send({ data: updatedMessage, meta: {} });
}

async function smsruInboundWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = toSmsWebhookBody(request.body);
  const query = toSmsWebhookBody(request.query);
  const configuredApiId = getSmsRuApiId();
  const apiId = toRequiredString(body.api_id) ?? toRequiredString(query.api_id);
  const from = toRequiredString(body.From) ?? toRequiredString(body.from) ?? toRequiredString(query.From) ?? toRequiredString(query.from);
  const text = toRequiredString(body.Body) ?? toRequiredString(body.text) ?? toRequiredString(query.Body) ?? toRequiredString(query.text);
  const smsId = toRequiredString(body.SmsId) ?? toRequiredString(body.sms_id) ?? toRequiredString(query.SmsId) ?? toRequiredString(query.sms_id);
  const orgContext = getWebhookOrgContext(body, query);
  const orgId = orgContext.orgId;

  if (configuredApiId && apiId && apiId !== configuredApiId) {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid SMS.ru api_id' } });
    return;
  }

  if (!from || !text) {
    reply.status(400).send({ error: { code: 'INVALID_WEBHOOK_PAYLOAD', message: 'from and text are required' } });
    return;
  }

  if (orgContext.provided && !orgId) {
    reply.status(200).send({ received: true });
    return;
  }

  const contact = await findSmsWebhookContact(from, orgId);

  if (contact) {
    const message = await db.message.create({
      data: {
        organization_id: contact.organization_id,
        contact_id: contact.id,
        direction: MessageDirection.inbound,
        channel: MessageChannel.sms,
        body: text,
        status: MessageStatus.delivered,
        twilio_sid: smsId,
      },
    });

    broadcastMessageIfAvailable(request, message);
  } else if (orgId && (await orgExists(orgId))) {
    await db.pendingCapture.create({
      data: {
        org_id: orgId,
        type: PendingCaptureType.sms,
        raw_data: buildSmsInboundCaptureRawData(from, text, smsId, apiId, orgId),
        phone_number: from,
        status: PendingCaptureStatus.pending,
      },
    });
  }

  reply.status(200).send({ received: true });
}

async function smsruStatusWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = toSmsWebhookBody(request.body);
  const query = toSmsWebhookBody(request.query);
  const configuredApiId = getSmsRuApiId();
  const apiId = toRequiredString(body.api_id) ?? toRequiredString(query.api_id);
  const smsId = toRequiredString(body.SmsId) ?? toRequiredString(body.sms_id) ?? toRequiredString(query.SmsId) ?? toRequiredString(query.sms_id);
  const rawStatus = toRequiredString(body.Status) ?? toRequiredString(body.status) ?? toRequiredString(query.Status) ?? toRequiredString(query.status);

  if (configuredApiId && apiId && apiId !== configuredApiId) {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid SMS.ru api_id' } });
    return;
  }

  if (!smsId || !rawStatus) {
    reply.status(400).send({ error: { code: 'INVALID_WEBHOOK_PAYLOAD', message: 'SmsId and Status are required' } });
    return;
  }

  const normalized = rawStatus.toLowerCase();
  const status =
    normalized === 'delivered'
      ? MessageStatus.delivered
      : normalized === 'not_delivered' || normalized === 'expired'
        ? MessageStatus.failed
        : MessageStatus.sent;

  await db.message.updateMany({
    where: { twilio_sid: smsId },
    data: { status },
  });

  reply.status(200).send({ received: true });
}

// --- Export ---

export const MessagesController = {
  list,
  getConversation,
  sendSms,
  sendInApp,
  logCall,
  markRead,
  smsruInboundWebhook,
  smsruStatusWebhook,
};
