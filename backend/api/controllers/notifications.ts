import { FastifyRequest, FastifyReply } from 'fastify';
import { Expo } from 'expo-server-sdk';
import { db } from '../../services/db';

const expo = new Expo();

type RegisterTokenBody = {
  token: string;
};

type SendNotificationBody = {
  user_id: string;
  title: string;
  body: string;
};

async function registerToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { token } = request.body as RegisterTokenBody;

  if (!Expo.isExpoPushToken(token)) {
    reply.status(400).send({
      error: { code: 'INVALID_PUSH_TOKEN', message: 'Invalid Expo push token' },
    });
    return;
  }

  const existingUser = await db.user.findUnique({
    where: { id: request.user.sub },
    select: { push_token: true },
  });

  if (!existingUser) {
    reply.status(404).send({
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
    return;
  }

  if (existingUser?.push_token === token) {
    reply.send({
      data: {
        message: 'Push token already registered',
        already_registered: true,
      },
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
    db.user.update({
      where: { id: request.user.sub },
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
    where: {
      id: user_id,
      organization_id: request.user.org_id,
    },
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
      error: {
        code: 'NO_PUSH_TOKEN',
        message: 'User has no registered push token',
      },
    });
    return;
  }

  if (!Expo.isExpoPushToken(user.push_token)) {
    await db.user.update({
      where: { id: user.id },
      data: { push_token: null },
    });

    reply.status(422).send({
      error: {
        code: 'INVALID_PUSH_TOKEN',
        message: 'User has an invalid registered push token',
      },
    });
    return;
  }

  const message = {
    to: user.push_token,
    sound: 'default' as const,
    title,
    body,
  };

  const [ticket] = await expo.sendPushNotificationsAsync([message]);

  if (ticket?.status === 'error') {
    if (ticket.details?.error === 'DeviceNotRegistered') {
      await db.user.update({
        where: { id: user.id },
        data: { push_token: null },
      });
    }

    reply.status(502).send({
      error: {
        code: 'PUSH_SEND_FAILED',
        message: ticket.message,
      },
    });
    return;
  }

  reply.send({
    data: { message: 'Notification sent', ticket_id: ticket?.id ?? null },
    meta: {},
  });
}

export const NotificationsController = {
  registerToken,
  sendNotification,
};
