import { FastifyRequest, FastifyReply } from 'fastify';
import { Expo } from 'expo-server-sdk';
import { db } from '../../services/db';
import { sendPushToUser } from '../../services/push';
import {
  isPushPlatform,
  isPushProvider,
  registerPushDevice,
  PushDeviceOrgConflictError,
  type PushPlatform,
  type PushProvider,
} from '../../services/push-devices';

type RegisterTokenBody = {
  token: string;
  provider?: PushProvider;
  platform?: PushPlatform;
  app_version?: string;
  device_name?: string;
};
type SendNotificationBody = { user_id: string; title: string; body: string };
type IdParams = { id: string };

async function registerToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as RegisterTokenBody;
  const { token, app_version, device_name } = body;
  // Backward compatibility for the currently-installed app, which posts only `{ token }`.
  // Every token it has ever produced is Expo or raw FCM; RuStore is never inferred because
  // its opaque token cannot be distinguished from FCM by shape.
  const provider: PushProvider = body.provider ?? (Expo.isExpoPushToken(token) ? 'expo' : 'fcm');
  const platform: PushPlatform = body.platform ?? 'unknown';

  const tokenMatchesProvider =
    (provider === 'expo' && Expo.isExpoPushToken(token)) ||
    (provider === 'fcm' && /^[A-Za-z0-9_:%-]{32,}$/.test(token)) ||
    (provider === 'rustore' && token.length >= 16 && !/\s/.test(token)) ||
    (provider === 'apns' && token.length >= 32 && !/\s/.test(token));

  const providerAndPlatformAgree =
    isPushProvider(provider) &&
    isPushPlatform(platform) &&
    (provider !== 'rustore' || platform === 'android') &&
    (provider !== 'apns' || platform === 'ios') &&
    tokenMatchesProvider;

  if (!providerAndPlatformAgree) {
    reply.status(400).send({
      error: {
        code: 'INVALID_PUSH_DEVICE',
        message: 'Push provider, platform, and token do not agree',
      },
    });
    return;
  }

  const existingUser = await db.user.findFirst({
    where: { id: request.user.sub, organization_id: request.user.org_id },
    select: { id: true },
  });

  if (!existingUser) {
    reply.status(404).send({
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
    return;
  }

  let device;
  try {
    device = await registerPushDevice({
      userId: request.user.sub,
      organizationId: request.user.org_id,
      token,
      provider,
      platform,
      appVersion: app_version,
      deviceName: device_name,
    });
  } catch (error) {
    if (error instanceof PushDeviceOrgConflictError) {
      reply.status(409).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }

  // Preserve the legacy rollback column only for providers the old server understands.
  // Writing a RuStore token here would make a rolled-back server send it to FCM.
  if (provider === 'expo' || provider === 'fcm') {
    await db.user.updateMany({
      where: {
        push_token: token,
        organization_id: request.user.org_id,
        id: { not: request.user.sub },
      },
      data: { push_token: null },
    });
    await db.user.updateMany({
      where: { id: request.user.sub, organization_id: request.user.org_id },
      data: { push_token: token },
    });
  }

  reply.send({
    data: {
      message: 'Push device registered',
      device_id: device.id,
      provider: device.provider,
      platform: device.platform,
    },
    meta: {},
  });
}

async function sendNotification(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { user_id, title, body } = request.body as SendNotificationBody;

  const user = await db.user.findFirst({
    where: { id: user_id, organization_id: request.user.org_id },
    select: { id: true },
  });

  if (!user) {
    reply.status(404).send({
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    });
    return;
  }

  const result = await sendPushToUser(user.id, title, body);
  if (result.attempted === 0) {
    reply.status(422).send({
      error: { code: 'NO_PUSH_TOKEN', message: 'User has no registered push device' },
    });
    return;
  }

  if (result.sent === 0) {
    const allGone = result.devices.every(
      (device) => !device.result.ok && device.result.code === 'DEVICE_NOT_REGISTERED',
    );
    if (allGone) {
      reply.status(422).send({
        error: { code: 'DEVICE_NOT_REGISTERED', message: 'Every registered device is gone' },
      });
      return;
    }
    reply.status(502).send({
      error: { code: 'PUSH_SEND_FAILED', message: 'Push delivery failed for every device' },
    });
    return;
  }

  reply.send({
    data: { message: 'Notification sent', sent: result.sent, failed: result.failed },
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
