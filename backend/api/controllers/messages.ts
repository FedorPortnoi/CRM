import { FastifyRequest, FastifyReply } from 'fastify';
import {
  MessageDirection,
  MessageChannel,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { db } from '../../services/db';
import { broadcastToOrg } from '../../services/wsRooms';
import { isEmailSendingEnabled, sendEmail as sendEmailViaResend } from '../../services/email';

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

type SendEmailBody = {
  contact_id: string;
  subject?: string;
  body: string;
};

type SendInAppBody = {
  contact_id: string;
  body: string;
};

type CreateMessageBody = {
  contact_id: string;
  channel: MessageChannel;
  direction?: MessageDirection;
  body: string;
};


type LogCallBody = {
  contact_id: string;
  direction: 'inbound' | 'outbound';
  duration_seconds?: number;
  notes?: string;
  occurred_at?: string;
};

async function contactBelongsToOrg(contactId: string, orgId: string): Promise<boolean> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    select: { id: true },
  });

  return contact !== null;
}

// --- Handlers ---

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
    where: { id, organization_id: request.user.org_id },
    data: { status: MessageStatus.read, read_at: new Date() },
  });

  reply.send({ data: updatedMessage, meta: {} });
}

// --- Export ---

export const MessagesController = {
  getConversation,
  sendInApp,
  logCall,
  markRead,
};
