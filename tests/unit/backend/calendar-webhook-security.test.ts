import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../backend/services/db', () => ({
  db: {},
}));

import { CalendarController } from '../../../backend/api/controllers/calendar';

type TestReply = {
  statusCode: number;
  payload: unknown;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

const webhookSecret = 'w'.repeat(32);
const previousEnv = {
  NODE_ENV: process.env.NODE_ENV,
  YANDEX_WEBHOOK_SECRET: process.env.YANDEX_WEBHOOK_SECRET,
};

function restoreEnv(name: keyof typeof previousEnv): void {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const value = previousEnv[name];
  if (value === undefined) {
    delete mutableEnv[name];
  } else {
    mutableEnv[name] = value;
  }
}

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

describe('CalendarController.yandexWebhook security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mutableEnv = process.env as Record<string, string | undefined>;
    mutableEnv.NODE_ENV = 'test';
    delete process.env.YANDEX_WEBHOOK_SECRET;
  });

  afterEach(() => {
    restoreEnv('NODE_ENV');
    restoreEnv('YANDEX_WEBHOOK_SECRET');
  });

  it('keeps local and test webhooks open when no secret is configured', async () => {
    const reply = createReply();

    await CalendarController.yandexWebhook({ headers: {} } as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ data: { received: true }, meta: {} });
  });

  it('rejects production webhooks when the shared secret is missing', async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    mutableEnv.NODE_ENV = 'production';
    const reply = createReply();

    await CalendarController.yandexWebhook({ headers: {} } as never, reply as never);

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({
      error: { code: 'YANDEX_WEBHOOK_SECRET_NOT_CONFIGURED', message: 'Yandex webhook secret is not configured' },
    });
  });

  it('rejects webhooks with a missing or invalid shared secret', async () => {
    process.env.YANDEX_WEBHOOK_SECRET = webhookSecret;
    const missingReply = createReply();
    const invalidReply = createReply();

    await CalendarController.yandexWebhook({ headers: {} } as never, missingReply as never);
    await CalendarController.yandexWebhook({
      headers: { 'x-yandex-webhook-secret': 'wrong-secret' },
    } as never, invalidReply as never);

    expect(missingReply.statusCode).toBe(401);
    expect(invalidReply.statusCode).toBe(401);
  });

  it('accepts webhooks with the configured shared secret', async () => {
    process.env.YANDEX_WEBHOOK_SECRET = webhookSecret;
    const headerReply = createReply();
    const bearerReply = createReply();

    await CalendarController.yandexWebhook({
      headers: { 'x-yandex-webhook-secret': webhookSecret },
    } as never, headerReply as never);
    await CalendarController.yandexWebhook({
      headers: { authorization: `Bearer ${webhookSecret}` },
    } as never, bearerReply as never);

    expect(headerReply.statusCode).toBe(200);
    expect(headerReply.payload).toEqual({ data: { received: true }, meta: {} });
    expect(bearerReply.statusCode).toBe(200);
    expect(bearerReply.payload).toEqual({ data: { received: true }, meta: {} });
  });
});
