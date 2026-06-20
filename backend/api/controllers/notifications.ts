import { FastifyRequest, FastifyReply } from 'fastify';
import { Expo } from 'expo-server-sdk';
import { db } from '../../services/db';
import { sendPush } from '../../services/push';

type RegisterTokenBody = { token: string };
type SendNotificationBody = { user_id: string; title: string; body: string };
type IdParams = { id: string };

async function registerToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { token } = request.body as RegisterTokenBody;

  const isExpo = Expo.isExpoPushToken(token);
  // Accept Expo tokens and raw FCM tokens (32+ char alphanumeric strings)
  const isFcm = !isExpo && /^[A-Za-z0-9_:%-]{32,}$/.test(token);

  if (!isExpo && !isFcm) {
    reply.status(400).send({
      error: { code: 'INVALID_PUSH_TOKEN', message: 'Invalid push token' },
    });
    return;
  }

  const existingUser = await db.user.findFirst({
    where: { id: request.user.sub, organization_id: request.user.org_id },
    select: { push_token: true },
  });

  if (!existingUser) {
    reply.status(404).send({
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
    return;
  }

  if (existingUser.push_token === token) {
    reply.send({
      data: { message: 'Push token already registered', already_registered: true },
      meta: {},
    });
    return;
  }

  const [clearedDuplicates] = await db.$transaction([
    db.user.updateMany({
      where: {
        push_token: token,
        id: { not: request.user.sub },
      },
      data: { push_token: null },
    }),
    db.user.updateMany({
      where: { id: request.user.sub, organization_id: request.user.org_id },
      data: { push_token: token },
    }),
  ]);

  reply.send({
    data: {
      message: 'Push token registered',
      already_registered: false,
      cleared_duplicate_count: clearedDuplicates.count,
    },
    meta: {},
  });
}

async function sendNotification(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { user_id, title, body } = request.body as SendNotificationBody;

  const user = await db.user.findFirst({
    where: { id: user_id, organization_id: request.user.org_id },
    select: { id: true, push_token: true },
  });

  if (!user) {
    reply.status(404).send({
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
    return;
  }

  if (!user.push_token) {
    reply.status(422).send({
      error: { code: 'NO_PUSH_TOKEN', message: 'User has no registered push token' },
    });
    return;
  }

  const result = await sendPush(user.push_token, title, body);

  if (!result.ok) {
    if (result.code === 'DEVICE_NOT_REGISTERED') {
      await db.user.updateMany({
        where: { id: user.id, organization_id: request.user.org_id },
        data: { push_token: null },
      });
      reply.status(422).send({
        error: { code: 'DEVICE_NOT_REGISTERED', message: 'Device is no longer registered' },
      });
      return;
    }

    reply.status(502).send({
      error: { code: 'PUSH_SEND_FAILED', message: result.message },
    });
    return;
  }

  reply.send({
    data: { message: 'Notification sent' },
    meta: {},
  });
}

async function list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { page = 1, per_page = 30 } = request.query as { page?: number; per_page?: number };

  const where = { recipient_id: request.user.sub, organization_id: request.user.org_id };
  const [notifications, total, unread] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * per_page,
      take: per_page,
    }),
    db.notification.count({ where }),
    db.notification.count({ where: { ...where, is_read: false } }),
  ]);

  reply.send({ data: notifications, meta: { total, page, per_page, unread } });
}

async function markRead(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  const { count } = await db.notification.updateMany({
    where: { id, recipient_id: request.user.sub, organization_id: request.user.org_id },
    data: { is_read: true, read_at: new Date() },
  });

  if (count === 0) {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Notification not found' } });
    return;
  }

  reply.send({ data: { ok: true }, meta: {} });
}

async function markAllRead(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { count } = await db.notification.updateMany({
    where: { recipient_id: request.user.sub, organization_id: request.user.org_id, is_read: false },
    data: { is_read: true, read_at: new Date() },
  });

  reply.send({ data: { marked: count }, meta: {} });
}

async function unreadCount(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const count = await db.notification.count({
    where: { recipient_id: request.user.sub, organization_id: request.user.org_id, is_read: false },
  });

  reply.send({ data: { count }, meta: {} });
}

export const NotificationsController = {
  registerToken,
  sendNotification,
  list,
  markRead,
  markAllRead,
  unreadCount,
};
