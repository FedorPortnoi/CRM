import { FastifyRequest, FastifyReply } from 'fastify';
import {
  MessageDirection,
  MessageChannel,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { db } from '../../services/db';
import { getContactForUser, ContactNotFoundError } from '../../services/contact-domain';
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

// --- Handlers ---

/**
 * Resolve a contact the caller is allowed to see (org + visibility cone).
 * Returns true when visible; otherwise sends a 404 and returns false so the
 * caller can `return` early. Members/viewers cannot read or write messages for
 * contacts outside their org-chart cone.
 */
async function ensureContactVisible(
  request: FastifyRequest,
  reply: FastifyReply,
  contactId: string,
): Promise<boolean> {
  try {
    await getContactForUser(contactId, request.user.org_id, request.user);
    return true;
  } catch (err) {
    if (err instanceof ContactNotFoundError) {
      reply.status(404).send({ error: { code: err.code, message: err.message } });
      return false;
    }
    throw err;
  }
}

async function getConversation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { contact_id } = request.params as ContactIdParams;

  if (!(await ensureContactVisible(request, reply, contact_id))) return;

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

  if (!(await ensureContactVisible(request, reply, contact_id))) return;

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

  if (!(await ensureContactVisible(request, reply, contact_id))) return;

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

  // Enforce the visibility cone on the message's contact. Return the same
  // MESSAGE_NOT_FOUND as above so an out-of-cone message is indistinguishable
  // from a nonexistent one (no existence oracle).
  try {
    await getContactForUser(existing.contact_id, request.user.org_id, request.user);
  } catch (err) {
    if (err instanceof ContactNotFoundError) {
      reply.status(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
      return;
    }
    throw err;
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
