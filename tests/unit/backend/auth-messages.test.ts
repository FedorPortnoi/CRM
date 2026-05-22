import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const dbMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  contact: {
    findFirst: vi.fn(),
  },
  org: {
    findUnique: vi.fn(),
  },
  message: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  pendingCapture: {
    create: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({
  db: dbMock,
}));

import { AuthController } from '../../../backend/api/controllers/auth';
import { MessagesController } from '../../../backend/api/controllers/messages';

const orgId = '00000000-0000-4000-a000-000000000123';

type TestReply = {
  statusCode: number;
  payload: unknown;
  code: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  jwtSign: ReturnType<typeof vi.fn>;
};

function createReply(): TestReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn(function setCode(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    status: vi.fn(function setStatus(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    send: vi.fn(function send(this: TestReply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
    jwtSign: vi.fn(async () => 'signed-token'),
  };

  return reply as unknown as TestReply;
}

describe('AuthController.login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects inactive users with the generic invalid credentials envelope', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    dbMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'inactive@example.com',
      password_hash: passwordHash,
      name: 'Inactive User',
      role: 'owner',
      organization_id: orgId,
      is_active: false,
      onboarding_state: null,
    });
    const reply = createReply();

    await AuthController.login(
      { body: { email: 'inactive@example.com', password: 'Password123!' } } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
    });
    expect(reply.jwtSign).not.toHaveBeenCalled();
  });
});

describe('MessagesController SMS.ru webhooks', () => {
  const previousApiId = process.env.SMSRU_API_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SMSRU_API_ID = 'expected-api-id';
  });

  afterEach(() => {
    if (previousApiId === undefined) {
      delete process.env.SMSRU_API_ID;
    } else {
      process.env.SMSRU_API_ID = previousApiId;
    }
  });

  it('rejects inbound webhooks when SMSRU_API_ID is not configured before DB writes', async () => {
    delete process.env.SMSRU_API_ID;
    const reply = createReply();

    await MessagesController.smsruInboundWebhook(
      {
        body: { From: '+15550001000', Body: 'Hello', org_id: orgId },
        query: {},
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({
      error: { code: 'SERVICE_NOT_CONFIGURED', message: 'SMSRU_API_ID is not configured' },
    });
    expect(dbMock.contact.findFirst).not.toHaveBeenCalled();
    expect(dbMock.message.create).not.toHaveBeenCalled();
    expect(dbMock.pendingCapture.create).not.toHaveBeenCalled();
  });

  it('rejects inbound webhooks missing api_id before DB writes', async () => {
    const reply = createReply();

    await MessagesController.smsruInboundWebhook(
      {
        body: { From: '+15550001111', Body: 'Hello', org_id: orgId },
        query: {},
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({
      error: { code: 'SMSRU_API_ID_REQUIRED', message: 'SMS.ru api_id is required' },
    });
    expect(dbMock.contact.findFirst).not.toHaveBeenCalled();
    expect(dbMock.message.create).not.toHaveBeenCalled();
    expect(dbMock.pendingCapture.create).not.toHaveBeenCalled();
  });

  it('rejects status webhooks with invalid api_id before DB writes', async () => {
    const reply = createReply();

    await MessagesController.smsruStatusWebhook(
      {
        body: { api_id: 'wrong-api-id', SmsId: 'SM123', Status: 'delivered', org_id: orgId },
        query: {},
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({
      error: { code: 'FORBIDDEN', message: 'Invalid SMS.ru api_id' },
    });
    expect(dbMock.message.updateMany).not.toHaveBeenCalled();
  });

  it('keeps valid inbound webhook DB queries scoped to the provided org and returns an envelope', async () => {
    dbMock.contact.findFirst.mockResolvedValue(null);
    dbMock.org.findUnique.mockResolvedValue({ id: orgId });
    const reply = createReply();

    await MessagesController.smsruInboundWebhook(
      {
        body: {
          api_id: 'expected-api-id',
          From: '+15550002222',
          Body: 'Capture me',
          SmsId: 'SM456',
          org_id: orgId,
        },
        query: {},
        server: {},
      } as never,
      reply as never,
    );

    expect(dbMock.contact.findFirst).toHaveBeenCalledWith({
      where: {
        organization_id: orgId,
        OR: [{ phone: '+15550002222' }, { mobile: '+15550002222' }],
      },
      select: { id: true, organization_id: true },
    });
    expect(dbMock.pendingCapture.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        org_id: orgId,
        phone_number: '+15550002222',
        raw_data: expect.objectContaining({ api_id: 'expected-api-id', org_id: orgId }),
      }),
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ data: { received: true }, meta: {} });
  });

  it('does not query or write org data when org_id is missing', async () => {
    const reply = createReply();

    await MessagesController.smsruInboundWebhook(
      {
        body: { api_id: 'expected-api-id', From: '+15550003333', Body: 'No org' },
        query: {},
      } as never,
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ data: { received: true }, meta: {} });
    expect(dbMock.contact.findFirst).not.toHaveBeenCalled();
    expect(dbMock.message.create).not.toHaveBeenCalled();
    expect(dbMock.pendingCapture.create).not.toHaveBeenCalled();
  });
});
