import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../services/db';
import { broadcastToOrg } from '../../services/wsRooms';
import { sendPush } from '../../services/push';

async function pushChatNotification(
  orgId: string,
  senderId: string,
  channel: string,
  senderName: string,
  body: string,
): Promise<void> {
  const isGeneral = channel === 'general';
  const title = isGeneral ? 'Общий чат' : senderName;
  const pushBody = isGeneral ? `${senderName}: ${body}` : body;

  const recipients = await db.user.findMany({
    where: {
      organization_id: orgId,
      id: { not: senderId },
      is_active: true,
      push_token: { not: null },
    },
    select: { id: true, push_token: true },
  });

  await Promise.allSettled(
    recipients.map(async (u) => {
      const result = await sendPush(u.push_token!, title, pushBody.slice(0, 200), {
        type: 'chat:message',
        channel,
        channel_name: title,
      });
      if (!result.ok && result.code === 'DEVICE_NOT_REGISTERED') {
        await db.user.update({ where: { id: u.id }, data: { push_token: null } });
      }
    }),
  );
}

type ChannelRow = {
  channel: string;
  last_body: string | null;
  last_sender_name: string | null;
  last_created_at: Date | null;
  unread: bigint;
};

export const ChatController = {
  getChannels: async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, sub: userId } = request.user;

    const rows = await db.$queryRaw<ChannelRow[]>`
      WITH relevant AS (
        SELECT DISTINCT channel FROM "ChatMessage"
        WHERE organization_id = ${org_id}::uuid
          AND (
            channel = 'general'
            OR channel LIKE ${`dm:${userId}:%`}
            OR channel LIKE ${`dm:%:${userId}`}
          )
        UNION SELECT 'general'
      ),
      last_msg AS (
        SELECT DISTINCT ON (channel) channel, body, sender_id, created_at
        FROM "ChatMessage"
        WHERE organization_id = ${org_id}::uuid
        ORDER BY channel, created_at DESC
      ),
      unread AS (
        SELECT m.channel, COUNT(*)::int AS cnt
        FROM "ChatMessage" m
        LEFT JOIN "ChatReadReceipt" rr
          ON rr.user_id = ${userId}::uuid AND rr.channel = m.channel
        WHERE m.organization_id = ${org_id}::uuid
          AND m.sender_id != ${userId}::uuid
          AND m.created_at > COALESCE(rr.last_read_at, '1970-01-01'::timestamptz)
        GROUP BY m.channel
      )
      SELECT
        r.channel,
        lm.body            AS last_body,
        u.name             AS last_sender_name,
        lm.created_at      AS last_created_at,
        COALESCE(un.cnt, 0) AS unread
      FROM relevant r
      LEFT JOIN last_msg lm USING (channel)
      LEFT JOIN "User" u ON u.id = lm.sender_id
      LEFT JOIN unread un USING (channel)
      ORDER BY last_created_at DESC NULLS LAST
    `;

    // Resolve DM partner names in one lookup
    const dmPartnerIds = rows
      .filter((r) => r.channel.startsWith('dm:'))
      .flatMap((r) => r.channel.slice(3).split(':').filter((id) => id !== userId));
    const uniqueIds = [...new Set(dmPartnerIds)];

    const partners = uniqueIds.length
      ? await db.user.findMany({
          where: { id: { in: uniqueIds }, organization_id: org_id },
          select: { id: true, name: true },
        })
      : [];
    const partnerMap = Object.fromEntries(partners.map((p) => [p.id, p.name]));

    return reply.send({
      data: rows.map((r) => {
        const isDm = r.channel.startsWith('dm:');
        const partnerId = isDm
          ? r.channel.slice(3).split(':').find((id) => id !== userId) ?? null
          : null;
        return {
          channel: r.channel,
          type: isDm ? 'dm' : 'group',
          name: isDm ? (partnerMap[partnerId ?? ''] ?? 'Неизвестно') : 'Общий чат',
          partner: partnerId ? { id: partnerId, name: partnerMap[partnerId] ?? 'Неизвестно' } : null,
          last_message: r.last_body
            ? {
                body: r.last_body,
                sender_name: r.last_sender_name ?? '',
                created_at: r.last_created_at?.toISOString() ?? '',
              }
            : null,
          unread: Number(r.unread),
        };
      }),
      meta: {},
    });
  },

  getMessages: async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id } = request.user;
    const { channel, before, limit: rawLimit } = request.query as {
      channel: string;
      before?: string;
      limit?: string;
    };
    const limit = Math.min(parseInt(rawLimit ?? '50', 10) || 50, 100);

    const messages = await db.chatMessage.findMany({
      where: {
        organization_id: org_id,
        channel,
        ...(before ? { created_at: { lt: new Date(before) } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      include: { sender: { select: { id: true, name: true } } },
    });

    const hasMore = messages.length > limit;

    return reply.send({
      data: messages.slice(0, limit).map((m) => ({
        id: m.id,
        channel: m.channel,
        body: m.body,
        sender: { id: m.sender.id, name: m.sender.name },
        created_at: m.created_at.toISOString(),
      })),
      meta: { has_more: hasMore },
    });
  },

  sendMessage: async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, sub: senderId } = request.user;
    const { channel, body } = request.body as { channel: string; body: string };

    const sender = await db.user.findUnique({
      where: { id: senderId },
      select: { name: true },
    });

    const message = await db.chatMessage.create({
      data: { organization_id: org_id, sender_id: senderId, channel, body: body.trim() },
    });

    const payload = {
      type: 'chat:message',
      message: {
        id: message.id,
        channel: message.channel,
        body: message.body,
        sender: { id: senderId, name: sender?.name ?? '' },
        created_at: message.created_at.toISOString(),
      },
    };

    broadcastToOrg(org_id, payload);
    void pushChatNotification(org_id, senderId, channel, sender?.name ?? '', body.trim());

    return reply.status(201).send({ data: payload.message, meta: {} });
  },

  markRead: async (request: FastifyRequest, reply: FastifyReply) => {
    const { org_id, sub: userId } = request.user;
    const { channel } = request.body as { channel: string };

    await db.chatReadReceipt.upsert({
      where: { user_id_channel: { user_id: userId, channel } },
      update: { last_read_at: new Date(), updated_at: new Date() },
      create: { organization_id: org_id, user_id: userId, channel, last_read_at: new Date() },
    });

    return reply.send({ data: { ok: true }, meta: {} });
  },
};
