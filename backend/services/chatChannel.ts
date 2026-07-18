import { db } from './db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuthorizedChatChannel =
  | { type: 'general'; channel: 'general' }
  | {
      type: 'dm';
      channel: string;
      participantIds: [string, string];
      otherUserId: string;
    };

export class ChatChannelError extends Error {
  constructor(
    readonly statusCode: 403 | 404,
    readonly code: 'FORBIDDEN' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ChatChannelError';
  }
}

function notFound(): ChatChannelError {
  return new ChatChannelError(404, 'NOT_FOUND', 'Chat channel not found');
}

function parseDmParticipants(channel: string): [string, string] {
  const parts = channel.split(':');
  if (parts.length !== 3 || parts[0] !== 'dm') {
    throw notFound();
  }

  const first = parts[1].toLowerCase();
  const second = parts[2].toLowerCase();
  if (!UUID_PATTERN.test(first) || !UUID_PATTERN.test(second) || first === second) {
    throw notFound();
  }

  return first < second ? [first, second] : [second, first];
}

export async function authorizeChatChannel(
  channel: string,
  userId: string,
  orgId: string,
): Promise<AuthorizedChatChannel> {
  if (channel === 'general') {
    return { type: 'general', channel: 'general' };
  }

  const participantIds = parseDmParticipants(channel);
  const normalizedUserId = userId.toLowerCase();
  if (!participantIds.includes(normalizedUserId)) {
    throw new ChatChannelError(403, 'FORBIDDEN', 'You are not a participant in this chat channel');
  }

  const otherUserId = participantIds[0] === normalizedUserId
    ? participantIds[1]
    : participantIds[0];
  const otherUser = await db.user.findFirst({
    where: { id: otherUserId, organization_id: orgId, is_active: true },
    select: { id: true },
  });

  if (!otherUser) {
    throw notFound();
  }

  return {
    type: 'dm',
    channel: `dm:${participantIds[0]}:${participantIds[1]}`,
    participantIds,
    otherUserId,
  };
}
