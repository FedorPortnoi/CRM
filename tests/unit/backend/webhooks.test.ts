import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);

const mockDb = vi.hoisted(() => ({
  webhookEndpoint: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  webhookDelivery: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));

import { WorkflowTrigger } from '@prisma/client';
import {
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  buildWebhookPayload,
  enqueueWebhookEvent,
  fireWebhookEvent,
  fireWebhookEventForWorkflowTrigger,
  generateWebhookSecret,
  getWebhookRetryDelayMs,
  isSuccessfulWebhookStatus,
  nextWebhookAttemptAt,
  postSignedWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../../backend/services/webhooks';
import {
  UnsafeWebhookUrlError,
  assertSafeWebhookUrl,
  resolveSafeWebhookUrl,
  type ResolvedWebhookAddress,
} from '../../../backend/services/webhook-ssrf';

const PUBLIC_RESOLVER = async (): Promise<readonly ResolvedWebhookAddress[]> => [
  { address: '93.184.216.34', family: 4 },
];

// ─── SSRF guard ───────────────────────────────────────────────────────────────

describe('webhook SSRF guard', () => {
  const rejected: Array<[string, string]> = [
    ['plain http', 'http://hooks.example.com/crm'],
    ['non-http protocol', 'ftp://hooks.example.com/crm'],
    ['file protocol', 'file:///etc/passwd'],
    ['not a url', 'not-a-url'],
    ['credentials in url', 'https://user:pass@hooks.example.com/crm'],
    ['loopback', 'https://127.0.0.1/crm'],
    ['loopback alias', 'https://127.9.9.9:8080/crm'],
    ['localhost', 'https://localhost/crm'],
    ['localhost subdomain', 'https://api.localhost/crm'],
    ['single-label host', 'https://intranet/crm'],
    ['.internal suffix', 'https://queue.internal/crm'],
    ['.local suffix', 'https://printer.local/crm'],
    ['private 10.x', 'https://10.0.0.5:9200/crm'],
    ['private 172.16.x', 'https://172.16.4.4/crm'],
    ['private 192.168.x', 'https://192.168.1.10/crm'],
    ['link-local / metadata', 'https://169.254.169.254/latest/meta-data'],
    ['CGNAT', 'https://100.100.0.1/crm'],
    ['unspecified', 'https://0.0.0.0/crm'],
    ['decimal literal loopback', 'https://2130706433/crm'],
    ['hex/short literal loopback', 'https://0x7f.1/crm'],
    ['ipv6 loopback', 'https://[::1]/crm'],
    ['ipv6 unique local', 'https://[fd00::1]/crm'],
    ['ipv6 link-local', 'https://[fe80::1]/crm'],
    ['ipv4-mapped metadata', 'https://[::ffff:169.254.169.254]/'],
    ['6to4 wrapper', 'https://[2002:a00:1::1]/crm'],
  ];

  for (const [label, url] of rejected) {
    it(`rejects ${label} (${url})`, async () => {
      await expect(assertSafeWebhookUrl(url, PUBLIC_RESOLVER)).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    });
  }

  it('rejects a hostname that resolves to a private address (DNS rebinding)', async () => {
    const resolver = async (): Promise<readonly ResolvedWebhookAddress[]> => [
      { address: '169.254.169.254', family: 4 },
    ];

    await expect(assertSafeWebhookUrl('https://hooks.example.com/crm', resolver))
      .rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('rejects when only one of several resolved addresses is private', async () => {
    const resolver = async (): Promise<readonly ResolvedWebhookAddress[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ];

    await expect(assertSafeWebhookUrl('https://hooks.example.com/crm', resolver))
      .rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('rejects a hostname that cannot be resolved', async () => {
    const resolver = async (): Promise<readonly ResolvedWebhookAddress[]> => {
      throw new Error('ENOTFOUND');
    };

    await expect(assertSafeWebhookUrl('https://hooks.example.com/crm', resolver))
      .rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('accepts a public https endpoint and pins the resolved address', async () => {
    const target = await resolveSafeWebhookUrl('https://hooks.example.com/crm?x=1', PUBLIC_RESOLVER);

    expect(target.url.toString()).toBe('https://hooks.example.com/crm?x=1');
    expect(target.address).toBe('93.184.216.34');
    expect(target.family).toBe(4);
  });

  it('accepts a public IPv4 literal without touching DNS', async () => {
    const resolver = vi.fn<(hostname: string) => Promise<readonly ResolvedWebhookAddress[]>>();
    const target = await resolveSafeWebhookUrl('https://93.184.216.34/crm', resolver);

    expect(target.address).toBe('93.184.216.34');
    expect(resolver).not.toHaveBeenCalled();
  });
});

// ─── Signing ──────────────────────────────────────────────────────────────────

describe('webhook signing', () => {
  const secret = 'whsec_test-secret';
  const body = JSON.stringify({ event: 'deal.won', data: { id: 'd-1' } });

  it('signs HMAC-SHA256 over `${timestamp}.${body}`', () => {
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`, 'utf8').digest('hex');

    expect(signWebhookPayload(secret, 1700000000, body)).toBe(`sha256=${expected}`);
  });

  it('verifies its own signature', () => {
    const signature = signWebhookPayload(secret, 1700000000, body);

    expect(verifyWebhookSignature(secret, 1700000000, body, signature)).toBe(true);
  });

  it('rejects a tampered body, timestamp or secret', () => {
    const signature = signWebhookPayload(secret, 1700000000, body);

    expect(verifyWebhookSignature(secret, 1700000000, `${body} `, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, 1700000001, body, signature)).toBe(false);
    expect(verifyWebhookSignature('whsec_other', 1700000000, body, signature)).toBe(false);
  });

  it('generates prefixed, high-entropy secrets', () => {
    const secretA = generateWebhookSecret();
    const secretB = generateWebhookSecret();

    expect(secretA.startsWith('whsec_')).toBe(true);
    expect(secretA.length).toBeGreaterThan(40);
    expect(secretA).not.toBe(secretB);
  });
});

// ─── Retry / backoff ──────────────────────────────────────────────────────────

describe('webhook retry policy', () => {
  it('uses exponential-ish backoff and caps the attempts', () => {
    expect(getWebhookRetryDelayMs(1)).toBe(WEBHOOK_RETRY_DELAYS_MS[0]);
    expect(getWebhookRetryDelayMs(2)).toBe(WEBHOOK_RETRY_DELAYS_MS[1]);
    expect(getWebhookRetryDelayMs(3)).toBe(WEBHOOK_RETRY_DELAYS_MS[2]);
    expect(getWebhookRetryDelayMs(MAX_WEBHOOK_ATTEMPTS)).toBeNull();
    expect(getWebhookRetryDelayMs(0)).toBeNull();
    expect(getWebhookRetryDelayMs(-1)).toBeNull();
  });

  it('increases the delay on every retry', () => {
    const delays = [1, 2, 3].map((attempt) => getWebhookRetryDelayMs(attempt) ?? 0);

    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it('schedules the next attempt relative to the failure time', () => {
    const failedAt = new Date('2026-07-25T12:00:00.000Z');

    expect(nextWebhookAttemptAt(1, failedAt)?.toISOString()).toBe('2026-07-25T12:01:00.000Z');
    expect(nextWebhookAttemptAt(3, failedAt)?.toISOString()).toBe('2026-07-25T12:30:00.000Z');
    expect(nextWebhookAttemptAt(MAX_WEBHOOK_ATTEMPTS, failedAt)).toBeNull();
  });

  it('treats only 2xx as delivered', () => {
    expect(isSuccessfulWebhookStatus(200)).toBe(true);
    expect(isSuccessfulWebhookStatus(204)).toBe(true);
    expect(isSuccessfulWebhookStatus(302)).toBe(false);
    expect(isSuccessfulWebhookStatus(404)).toBe(false);
    expect(isSuccessfulWebhookStatus(500)).toBe(false);
    expect(isSuccessfulWebhookStatus(null)).toBe(false);
  });
});

// ─── Transport ────────────────────────────────────────────────────────────────

type Capture = { headers: IncomingMessage['headers']; body: string; path: string };

describe('webhook transport', () => {
  let server: Server;
  let port: number;
  let captured: Capture[] = [];
  let handler: (request: IncomingMessage, response: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured.push({
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          path: request.url ?? '',
        });
        handler(request, response);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    captured = [];
    handler = (_request, response) => {
      response.writeHead(200).end('ok');
    };
  });

  function target(path = '/crm'): { url: URL; address: string; family: 4 } {
    return { url: new URL(`http://127.0.0.1:${port}${path}`), address: '127.0.0.1', family: 4 };
  }

  it('sends a verifiable signature over the exact body', async () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ event: 'deal.won', data: { id: 'deal-1' } });

    const result = await postSignedWebhook(target(), secret, body, {
      event: 'deal.won',
      deliveryId: 'delivery-1',
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(captured).toHaveLength(1);

    const sent = captured[0];
    expect(sent.body).toBe(body);
    expect(sent.headers[WEBHOOK_EVENT_HEADER]).toBe('deal.won');
    expect(sent.headers[WEBHOOK_DELIVERY_HEADER]).toBe('delivery-1');

    const timestamp = Number(sent.headers[WEBHOOK_TIMESTAMP_HEADER]);
    const signature = String(sent.headers[WEBHOOK_SIGNATURE_HEADER]);

    expect(Number.isInteger(timestamp)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, sent.body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, `${sent.body}x`, signature)).toBe(false);
    expect(verifyWebhookSignature('whsec_wrong', timestamp, sent.body, signature)).toBe(false);
  });

  it('never follows a redirect and reports it as a failure', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${port}/elsewhere` }).end();
    };

    const result = await postSignedWebhook(target(), 'whsec_x', '{}', {
      event: 'contact.created',
      deliveryId: 'delivery-2',
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(302);
    expect(result.error).toContain('redirects are not followed');
    // The redirect target was never requested.
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe('/crm');
  });

  it('reports a non-2xx receiver response as a failure', async () => {
    handler = (_request, response) => {
      response.writeHead(500).end('nope');
    };

    const result = await postSignedWebhook(target(), 'whsec_x', '{}', {
      event: 'task.created',
      deliveryId: 'delivery-3',
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
  });

  it('gives up on a receiver that never responds', async () => {
    handler = () => {
      // Deliberately never write a response.
    };

    const result = await postSignedWebhook(target(), 'whsec_x', '{}', {
      event: 'task.completed',
      deliveryId: 'delivery-4',
    }, 150);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toContain('timed out');
  });
});

// ─── Emitting ─────────────────────────────────────────────────────────────────

describe('webhook event emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.webhookEndpoint.findMany.mockResolvedValue([]);
    mockDb.webhookDelivery.createMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues one org-scoped delivery per subscribed endpoint', async () => {
    mockDb.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', events: ['contact.created', 'deal.won'] },
      { id: 'ep-2', events: ['deal.won'] },
      { id: 'ep-3', events: ['task.created'] },
    ]);

    await enqueueWebhookEvent({
      organizationId: 'org-1',
      event: 'deal.won',
      entityId: 'deal-1',
      actorUserId: 'user-1',
      record: { id: 'deal-1', title: 'Big one', status: 'won', password_hash: 'nope' },
    });

    expect(mockDb.webhookEndpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: 'org-1', status: 'active' } }),
    );

    const created = mockDb.webhookDelivery.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(created).toHaveLength(2);
    expect(created.map((row) => row.endpoint_id)).toEqual(['ep-1', 'ep-2']);
    for (const row of created) {
      expect(row.organization_id).toBe('org-1');
      expect(row.event_type).toBe('deal.won');
      expect(row.status).toBe('pending');
    }
  });

  it('does not touch the delivery table when nobody is subscribed', async () => {
    mockDb.webhookEndpoint.findMany.mockResolvedValue([{ id: 'ep-1', events: ['task.completed'] }]);

    await enqueueWebhookEvent({
      organizationId: 'org-1',
      event: 'deal.lost',
      entityId: 'deal-9',
      record: { id: 'deal-9' },
    });

    expect(mockDb.webhookDelivery.createMany).not.toHaveBeenCalled();
  });

  it('forwards only allowlisted fields and decrypts contact PII', () => {
    const payload = buildWebhookPayload({
      organizationId: 'org-1',
      event: 'contact.created',
      entityId: 'contact-1',
      actorUserId: 'user-1',
      record: {
        id: 'contact-1',
        first_name: 'Иван',
        email: 'ivan@example.ru',
        custom_fields: { secret: 'internal' },
        organization_id: 'org-1',
        assigned_to: 'user-2',
      },
    }) as Record<string, unknown>;

    expect(payload.event).toBe('contact.created');
    expect(payload.organization_id).toBe('org-1');
    expect(payload.actor_user_id).toBe('user-1');

    const data = payload.data as Record<string, unknown>;
    expect(data).toEqual({
      id: 'contact-1',
      first_name: 'Иван',
      email: 'ivan@example.ru',
      assigned_to: 'user-2',
    });
    expect(data.custom_fields).toBeUndefined();
  });

  it('maps workflow triggers onto webhook events and ignores the ones without a counterpart', async () => {
    mockDb.webhookEndpoint.findMany.mockResolvedValue([{ id: 'ep-1', events: ['deal.stage_changed'] }]);

    fireWebhookEventForWorkflowTrigger({
      organizationId: 'org-1',
      trigger: WorkflowTrigger.deal_stage_changed,
      record: { id: 'deal-1', stage_id: 'stage-2' },
      userId: 'user-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.webhookDelivery.createMany).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockDb.webhookEndpoint.findMany.mockResolvedValue([{ id: 'ep-1', events: ['deal.stage_changed'] }]);

    fireWebhookEventForWorkflowTrigger({
      organizationId: 'org-1',
      trigger: WorkflowTrigger.deal_stale,
      record: { id: 'deal-1' },
      userId: 'user-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.webhookEndpoint.findMany).not.toHaveBeenCalled();
  });

  it('never propagates a delivery failure to the originating request', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockDb.webhookEndpoint.findMany.mockRejectedValue(new Error('database unreachable'));

    const originatingWrite = async (): Promise<string> => {
      fireWebhookEvent({
        organizationId: 'org-1',
        event: 'contact.created',
        entityId: 'contact-1',
        record: { id: 'contact-1' },
      });
      return 'contact created';
    };

    await expect(originatingWrite()).resolves.toBe('contact created');

    await new Promise((resolve) => setImmediate(resolve));
    expect(errorSpy).toHaveBeenCalled();
    // The rejection was swallowed inside the service, not re-thrown at the call site.
    expect(String(errorSpy.mock.calls[0][0])).toContain('failed to enqueue contact.created');
  });

  it('never propagates a createMany failure either', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockDb.webhookEndpoint.findMany.mockResolvedValue([{ id: 'ep-1', events: ['task.completed'] }]);
    mockDb.webhookDelivery.createMany.mockRejectedValue(new Error('write failed'));

    expect(() => fireWebhookEvent({
      organizationId: 'org-1',
      event: 'task.completed',
      entityId: 'task-1',
      record: { id: 'task-1' },
    })).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));
    expect(errorSpy).toHaveBeenCalled();
  });
});
