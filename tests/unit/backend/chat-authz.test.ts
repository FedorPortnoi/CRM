import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  user: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  chatMessage: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  chatReadReceipt: {
    upsert: vi.fn(),
  },
}));

const wsMock = vi.hoisted(() => ({
  broadcastToOrg: vi.fn(),
  broadcastToUsers: vi.fn(),
}));

const pushMock = vi.hoisted(() => ({
  sendPush: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));
vi.mock('../../../backend/services/wsRooms', () => wsMock);
vi.mock('../../../backend/services/push', () => ({ sendPush: pushMock.sendPush }));

import { ChatController } from '../../../backend/api/controllers/chat';

const ORG_ID = '00000000-0000-4000-a000-000000000123';
const USER_A = '00000000-0000-4000-a000-000000000001';
const USER_B = '00000000-0000-4000-a000-000000000002';
const OUTSIDER = '00000000-0000-4000-a000-000000000003';
const DM_CHANNEL = `dm:${USER_A}:${USER_B}`;

type TestReply = {
  statusCode: number;
  payload: unknown;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function createReply(): TestReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    status: vi.fn(function setStatus(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    send: vi.fn(function send(this: TestReply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };

  return reply as unknown as TestReply;
}

function user(userId: string) {
  return { org_id: ORG_ID, sub: userId };
}

describe('chat channel authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.user.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
    }));
    dbMock.user.findUnique.mockResolvedValue({ name: 'Test User' });
    dbMock.user.findMany.mockResolvedValue([]);
    dbMock.user.update.mockResolvedValue({});
    dbMock.chatMessage.findMany.mockResolvedValue([]);
    dbMock.chatMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'message-1',
      ...data,
      created_at: new Date('2026-07-17T12:00:00.000Z'),
    }));
    dbMock.chatReadReceipt.upsert.mockResolvedValue({});
    pushMock.sendPush.mockResolvedValue({ ok: true });
  });

  it('denies a non-participant before reading, sending, or marking a DM read', async () => {
    const readReply = createReply();
    await ChatController.getMessages(
      { user: user(OUTSIDER), query: { channel: DM_CHANNEL, limit: '50' } } as never,
      readReply as never,
    );

    const sendReply = createReply();
    await ChatController.sendMessage(
      { user: user(OUTSIDER), body: { channel: DM_CHANNEL, body: 'private' } } as never,
      sendReply as never,
    );

    const readReceiptReply = createReply();
    await ChatController.markRead(
      { user: user(OUTSIDER), body: { channel: DM_CHANNEL } } as never,
      readReceiptReply as never,
    );

    for (const reply of [readReply, sendReply, readReceiptReply]) {
      expect(reply.statusCode).toBe(403);
      expect(reply.payload).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'You are not a participant in this chat channel',
        },
      });
    }
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
    expect(dbMock.chatMessage.findMany).not.toHaveBeenCalled();
    expect(dbMock.chatMessage.create).not.toHaveBeenCalled();
    expect(dbMock.chatReadReceipt.upsert).not.toHaveBeenCalled();
    expect(wsMock.broadcastToOrg).not.toHaveBeenCalled();
    expect(wsMock.broadcastToUsers).not.toHaveBeenCalled();
  });

  it.each([
    ['first participant', USER_A, USER_B],
    ['second participant', USER_B, USER_A],
  ])('allows the %s to read and send a DM', async (_label, participantId, otherUserId) => {
    const reversedChannel = `dm:${USER_B}:${USER_A}`;
    const readReply = createReply();
    await ChatController.getMessages(
      { user: user(participantId), query: { channel: reversedChannel, limit: '50' } } as never,
      readReply as never,
    );

    const sendReply = createReply();
    await ChatController.sendMessage(
      { user: user(participantId), body: { channel: reversedChannel, body: '  private  ' } } as never,
      sendReply as never,
    );

    expect(readReply.statusCode).toBe(200);
    expect(sendReply.statusCode).toBe(201);
    expect(dbMock.user.findFirst).toHaveBeenCalledWith({
      where: { id: otherUserId, organization_id: ORG_ID, is_active: true },
      select: { id: true },
    });
    expect(dbMock.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organization_id: ORG_ID, channel: DM_CHANNEL }),
    }));
    expect(dbMock.chatMessage.create).toHaveBeenCalledWith({
      data: {
        organization_id: ORG_ID,
        sender_id: participantId,
        channel: DM_CHANNEL,
        body: 'private',
      },
    });
    expect(wsMock.broadcastToOrg).not.toHaveBeenCalled();
    expect(wsMock.broadcastToUsers).toHaveBeenCalledWith(
      ORG_ID,
      [USER_A, USER_B],
      expect.objectContaining({ type: 'chat:message' }),
    );
    expect(dbMock.user.findMany).toHaveBeenCalledWith({
      where: {
        organization_id: ORG_ID,
        id: otherUserId,
        is_active: true,
        push_token: { not: null },
      },
      select: { id: true, push_token: true },
    });
  });

  it('allows any authenticated organization member to use general chat', async () => {
    const readReply = createReply();
    await ChatController.getMessages(
      { user: user(OUTSIDER), query: { channel: 'general', limit: '50' } } as never,
      readReply as never,
    );

    const sendReply = createReply();
    await ChatController.sendMessage(
      { user: user(OUTSIDER), body: { channel: 'general', body: 'hello team' } } as never,
      sendReply as never,
    );

    const readReceiptReply = createReply();
    await ChatController.markRead(
      { user: user(OUTSIDER), body: { channel: 'general' } } as never,
      readReceiptReply as never,
    );

    expect(readReply.statusCode).toBe(200);
    expect(sendReply.statusCode).toBe(201);
    expect(readReceiptReply.statusCode).toBe(200);
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
    expect(wsMock.broadcastToOrg).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ type: 'chat:message' }),
    );
    expect(wsMock.broadcastToUsers).not.toHaveBeenCalled();
    expect(dbMock.user.findMany).toHaveBeenCalledWith({
      where: {
        organization_id: ORG_ID,
        id: { not: OUTSIDER },
        is_active: true,
        push_token: { not: null },
      },
      select: { id: true, push_token: true },
    });
    expect(dbMock.chatReadReceipt.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { user_id_channel: { user_id: OUTSIDER, channel: 'general' } },
    }));
  });

  it.each([
    'private',
    `dm:${USER_A}`,
    `dm:${USER_A}:${USER_B}:extra`,
    `dm:not-a-uuid:${USER_B}`,
    `dm:${USER_A}:${USER_A}`,
    ' general',
  ])('rejects malformed or unsupported channel %s', async (channel) => {
    const reply = createReply();
    await ChatController.getMessages(
      { user: user(USER_A), query: { channel, limit: '50' } } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({
      error: { code: 'NOT_FOUND', message: 'Chat channel not found' },
    });
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
    expect(dbMock.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('rejects a DM when the other participant is not active in the same organization', async () => {
    dbMock.user.findFirst.mockResolvedValue(null);
    const reply = createReply();

    await ChatController.sendMessage(
      { user: user(USER_A), body: { channel: DM_CHANNEL, body: 'private' } } as never,
      reply as never,
    );

    expect(dbMock.user.findFirst).toHaveBeenCalledWith({
      where: { id: USER_B, organization_id: ORG_ID, is_active: true },
      select: { id: true },
    });
    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({
      error: { code: 'NOT_FOUND', message: 'Chat channel not found' },
    });
    expect(dbMock.chatMessage.create).not.toHaveBeenCalled();
    expect(wsMock.broadcastToUsers).not.toHaveBeenCalled();
  });

  it('normalizes a reversed DM channel before storing a read receipt', async () => {
    const reply = createReply();

    await ChatController.markRead(
      { user: user(USER_A), body: { channel: `dm:${USER_B}:${USER_A}` } } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(dbMock.chatReadReceipt.upsert).toHaveBeenCalledWith({
      where: { user_id_channel: { user_id: USER_A, channel: DM_CHANNEL } },
      update: { last_read_at: expect.any(Date), updated_at: expect.any(Date) },
      create: {
        organization_id: ORG_ID,
        user_id: USER_A,
        channel: DM_CHANNEL,
        last_read_at: expect.any(Date),
      },
    });
  });
});

describe('DM WebSocket delivery', () => {
  it('sends only to participant sockets in the matching organization', async () => {
    const rooms = await vi.importActual<typeof import('../../../backend/services/wsRooms')>(
      '../../../backend/services/wsRooms',
    );
    const participantA = { readyState: 1, send: vi.fn() };
    const participantB = { readyState: 1, send: vi.fn() };
    const outsider = { readyState: 1, send: vi.fn() };
    const otherOrgParticipant = { readyState: 1, send: vi.fn() };
    const otherOrgId = '00000000-0000-4000-a000-000000000999';
    const payload = { type: 'chat:message', message: { body: 'private' } };

    rooms.joinRoom(ORG_ID, USER_A, participantA as never);
    rooms.joinRoom(ORG_ID, USER_B, participantB as never);
    rooms.joinRoom(ORG_ID, OUTSIDER, outsider as never);
    rooms.joinRoom(otherOrgId, USER_A, otherOrgParticipant as never);

    try {
      rooms.broadcastToUsers(ORG_ID, [USER_A, USER_B], payload);

      expect(participantA.send).toHaveBeenCalledWith(JSON.stringify(payload));
      expect(participantB.send).toHaveBeenCalledWith(JSON.stringify(payload));
      expect(outsider.send).not.toHaveBeenCalled();
      expect(otherOrgParticipant.send).not.toHaveBeenCalled();
    } finally {
      rooms.leaveRoom(ORG_ID, participantA as never);
      rooms.leaveRoom(ORG_ID, participantB as never);
      rooms.leaveRoom(ORG_ID, outsider as never);
      rooms.leaveRoom(otherOrgId, otherOrgParticipant as never);
    }
  });
});
