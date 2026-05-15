import { FastifyRequest, FastifyReply } from 'fastify';
import { MessageDirection, MessageChannel, MessageStatus, Prisma } from '@prisma/client';
import twilio from 'twilio';
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

type LogCallBody = {
  contact_id: string;
  direction: 'inbound' | 'outbound';
  duration_seconds?: number;
  notes?: string;
  occurred_at?: string;
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

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER;
  const to = contact.mobile ?? contact.phone;

  if (!accountSid || !authToken || !from || process.env.TWILIO_SEND_ENABLED !== 'true') {
    reply.status(201).send({ data: message, meta: { delivery: 'queued_without_twilio_config' } });
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
    const client = twilio(accountSid, authToken);
    const sent = await client.messages.create({ from, to, body });
    const updated = await db.message.update({
      where: { id: message.id },
      data: {
        twilio_sid: sent.sid,
        status: MessageStatus.sent,
      },
    });

    reply.status(201).send({ data: updated, meta: { delivery: 'sent_to_twilio' } });
  } catch (error) {
    const failed = await db.message.update({
      where: { id: message.id },
      data: {
        status: MessageStatus.failed,
        error_message: error instanceof Error ? error.message : 'Twilio send failed',
      },
    });
    reply.status(201).send({ data: failed, meta: { delivery: 'twilio_failed' } });
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

async function twilioInboundWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const body = request.body as Record<string, unknown>;
    const from = body['From'];
    const messageBody = body['Body'];
    const smsSid = body['SmsSid'];

    const contact = await db.contact.findFirst({
      where: { phone: String(from) },
    });

    if (contact) {
      await db.message.create({
        data: {
          organization_id: contact.organization_id,
          contact_id: contact.id,
          direction: MessageDirection.inbound,
          channel: MessageChannel.sms,
          body: String(messageBody),
          status: MessageStatus.delivered,
          twilio_sid: String(smsSid),
        },
      });
    }
  } catch {
    // silently ignore errors - Twilio requires 200 regardless
  }

  reply.status(200).send({ received: true });
}

async function twilioStatusWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const body = request.body as Record<string, unknown>;
    const sid = body['MessageSid'];
    const twilioStatus = body['MessageStatus'];

    const existing = await db.message.findFirst({
      where: { twilio_sid: String(sid) },
    });

    if (existing) {
      let updateData: Prisma.MessageUpdateInput = {};

      if (twilioStatus === 'sent') {
        updateData = { status: MessageStatus.sent };
      } else if (twilioStatus === 'delivered') {
        updateData = { status: MessageStatus.delivered, delivered_at: new Date() };
      } else if (twilioStatus === 'failed' || twilioStatus === 'undelivered') {
        updateData = { status: MessageStatus.failed, error_message: String(twilioStatus) };
      }

      if (Object.keys(updateData).length > 0) {
        await db.message.update({
          where: { id: existing.id },
          data: updateData,
        });
      }
    }
  } catch {
    // silently ignore errors - Twilio requires 200 regardless
  }

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
  twilioInboundWebhook,
  twilioStatusWebhook,
};
