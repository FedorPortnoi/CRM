import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

type Auth = { token: string; userId: string; email: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string; email: string } } };
  return { token: body.data.token, userId: body.data.user.id, email: body.data.user.email };
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

test.describe.configure({ timeout: 30000 });

// ─── Delta Sync Endpoint ─────────────────────────────────────────────────────

test.describe('GET /sync/delta', () => {
  test('returns 200 with correct envelope shape', async ({ request }) => {
    const auth = getAuth();
    const res = await request.get('/api/v1/sync/delta', {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as {
      data: { contacts: unknown[]; deals: unknown[]; tasks: unknown[]; events: unknown[] };
      meta: { since: string; server_time: string };
    };
    expect(Array.isArray(body.data.contacts)).toBe(true);
    expect(Array.isArray(body.data.deals)).toBe(true);
    expect(Array.isArray(body.data.tasks)).toBe(true);
    expect(Array.isArray(body.data.events)).toBe(true);
    expect(typeof body.meta.since).toBe('string');
    expect(typeof body.meta.server_time).toBe('string');
  });

  test('requires authentication', async ({ request }) => {
    const res = await request.get('/api/v1/sync/delta');
    expect(res.status()).toBe(401);
  });

  test('since far future returns all arrays empty', async ({ request }) => {
    const auth = getAuth();
    const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(futureIso)}`, {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { contacts: unknown[]; deals: unknown[]; tasks: unknown[]; events: unknown[] } };
    expect(body.data.contacts.length).toBe(0);
    expect(body.data.deals.length).toBe(0);
    expect(body.data.tasks.length).toBe(0);
    expect(body.data.events.length).toBe(0);
  });

  test('since omitted: meta.since is within last 31 days', async ({ request }) => {
    const auth = getAuth();
    const res = await request.get('/api/v1/sync/delta', {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { meta: { since: string } };
    const sinceDate = new Date(body.meta.since);
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(sinceDate.getTime()).toBeGreaterThan(thirtyOneDaysAgo.getTime());
  });

  test('includes record created after since timestamp', async ({ request }) => {
    const auth = getAuth();
    const beforeCreate = new Date().toISOString();

    const createRes = await request.post('/api/v1/contacts', {
      headers: authHeaders(auth.token),
      data: { first_name: 'DeltaSyncTest', last_name: 'User' },
    });
    expect(createRes.status()).toBe(201);
    const contact = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(beforeCreate)}`, {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { contacts: { id: string }[] } };
    const ids = body.data.contacts.map((c) => c.id);
    expect(ids).toContain(contact.id);
  });

  test('cross-org isolation: org A records not in org B delta', async ({ request }) => {
    const orgA = await registerOrg(request, 'delta-a');
    const orgB = await registerOrg(request, 'delta-b');

    const createRes = await request.post('/api/v1/contacts', {
      headers: authHeaders(orgA.token),
      data: { first_name: 'OrgAContact' },
    });
    expect(createRes.status()).toBe(201);
    const contactA = ((await createRes.json()) as { data: { id: string } }).data;

    const res = await request.get('/api/v1/sync/delta', {
      headers: authHeaders(orgB.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { contacts: { id: string }[] } };
    const ids = body.data.contacts.map((c) => c.id);
    expect(ids).not.toContain(contactA.id);
  });

  test('archived contacts included (tombstone propagation)', async ({ request }) => {
    const auth = getAuth();
    const beforeCreate = new Date().toISOString();

    const createRes = await request.post('/api/v1/contacts', {
      headers: authHeaders(auth.token),
      data: { first_name: 'ToArchive', last_name: 'Delta' },
    });
    expect(createRes.status()).toBe(201);
    const contact = ((await createRes.json()) as { data: { id: string } }).data;

    await request.delete(`/api/v1/contacts/${contact.id}`, {
      headers: authHeaders(auth.token),
    });

    const res = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(beforeCreate)}`, {
      headers: authHeaders(auth.token),
    });
    const body = await res.json() as { data: { contacts: { id: string; status: string }[] } };
    const found = body.data.contacts.find((c) => c.id === contact.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe('archived');
  });
});

// ─── Yandex Calendar Sync Routes ─────────────────────────────────────────────

test.describe('Yandex Calendar sync', () => {
  test('GET /calendar/sync/yandex/auth returns 501 or 200 with yandex auth_url', async ({ request }) => {
    const auth = getAuth();
    const res = await request.get('/api/v1/calendar/sync/yandex/auth', {
      headers: authHeaders(auth.token),
    });
    expect([200, 501]).toContain(res.status());
    if (res.status() === 501) {
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('YANDEX_OAUTH_NOT_CONFIGURED');
    } else {
      const body = await res.json() as { data: { auth_url: string } };
      expect(body.data.auth_url).toContain('oauth.yandex.ru');
    }
  });

  test('GET /calendar/sync/yandex/auth requires auth', async ({ request }) => {
    const res = await request.get('/api/v1/calendar/sync/yandex/auth');
    expect(res.status()).toBe(401);
  });

  test('GET /calendar/sync/status returns connected:false for new org', async ({ request }) => {
    const auth = await registerOrg(request, 'ysync-status');
    const res = await request.get('/api/v1/calendar/sync/status', {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });

  test('GET /calendar/sync/status requires auth', async ({ request }) => {
    const res = await request.get('/api/v1/calendar/sync/status');
    expect(res.status()).toBe(401);
  });

  test('DELETE /calendar/sync/yandex returns 404 when not connected', async ({ request }) => {
    const auth = await registerOrg(request, 'ysync-disconnect');
    const res = await request.delete('/api/v1/calendar/sync/yandex', {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('YANDEX_SYNC_NOT_CONNECTED');
  });

  test('DELETE /calendar/sync/yandex requires auth', async ({ request }) => {
    const res = await request.delete('/api/v1/calendar/sync/yandex');
    expect(res.status()).toBe(401);
  });

  test('old Google route /sync/google/auth returns 404', async ({ request }) => {
    const auth = getAuth();
    const res = await request.get('/api/v1/calendar/sync/google/auth', {
      headers: authHeaders(auth.token),
    });
    expect(res.status()).toBe(404);
  });

  test('POST /calendar/webhooks/yandex returns 200', async ({ request }) => {
    const res = await request.post('/api/v1/calendar/webhooks/yandex', {
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { received: boolean } };
    expect(body.data.received).toBe(true);
  });
});
