import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = suffix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const res = await request.post('/api/v1/auth/', {
    data: { email: unique + '@example.com', password: 'Password123!', name: 'User ' + suffix, org_name: 'Org ' + unique },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

function authHeaders(token: string) { return { Authorization: 'Bearer ' + token }; }

interface BusinessCardData {
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  raw_text: string;
  extracted: { first_name: string; last_name?: string; email?: string; phone?: string; source?: string };
  contact: unknown;
}
interface BusinessCardBody { data: BusinessCardData; meta: Record<string, unknown> }
interface ContactBody { data: { id: string; source?: string; first_name: string; email?: string; phone?: string }; meta: Record<string, unknown> }
interface ListBody { data: unknown[]; meta: { total: number } }
interface WorkflowBody { data: { id: string; status: string }; meta: Record<string, unknown> }
interface AnalyticsBody { data: unknown; meta: Record<string, unknown> }

test.describe.configure({ timeout: 30000 });

// ─── Group 1: POST /contacts/business-card/scan (completely untested) ──────────

test('biz-card 35: happy path with text → 200 with extracted fields', async ({ request }) => {
  const org = await registerOrg(request, 'bc35-happy');
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: { text: 'Ivan Petrov\nivanov@example.com\n+7 (900) 123-45-67\nACME Corp' },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BusinessCardBody;
  expect(body.data.raw_text).toContain('Ivan Petrov');
  expect(body.data.contact).toBeNull();
});

test('biz-card 35: email extracted from text', async ({ request }) => {
  const org = await registerOrg(request, 'bc35-email');
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: { text: 'John Smith\njohn.smith@company.io\n+7 (999) 000-11-22' },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BusinessCardBody;
  expect(body.data.email).toBe('john.smith@company.io');
});

test('biz-card 35: phone extracted from text', async ({ request }) => {
  const org = await registerOrg(request, 'bc35-phone');
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: { text: 'Maria Ivanova\nmaria@test.ru\n+7 985 222 33 44' },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BusinessCardBody;
  expect(body.data.phone).toContain('7');
});

test('biz-card 35: create_contact true → contact visible via GET /contacts', async ({ request }) => {
  const org = await registerOrg(request, 'bc35-create');
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: { text: 'Alexei Smirnov\nalexei@example.com\n+7 (900) 555-77-88', create_contact: true },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BusinessCardBody;
  const createdId = (body.data.contact as { id?: string } | null)?.id;
  expect(createdId).toBeTruthy();
  const listRes = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ListBody;
  const ids = (listBody.data as Array<{ id: string }>).map(c => c.id);
  expect(ids).toContain(createdId);
});

test('biz-card 35: create_contact true → created contact has source business_card', async ({ request }) => {
  const org = await registerOrg(request, 'bc35-source');
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: { text: 'Olga Kuznetsova\nolga@corp.ru\n+7 911 100 20 30', create_contact: true },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BusinessCardBody;
  const createdId = (body.data.contact as { id?: string } | null)?.id;
  expect(createdId).toBeTruthy();
  const getRes = await request.get(`/api/v1/contacts/${createdId}`, { headers: authHeaders(org.token) });
  expect(getRes.status()).toBe(200);
  const contact = (await getRes.json()) as ContactBody;
  expect(contact.data.source).toBe('business_card');
});

test('biz-card 35: neither text nor image_base64 → 400 Zod validation', async ({ request }) => {
  const org = await registerOrg(request, 'bc35-no-input');
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: { create_contact: false },
  });
  expect(r.status()).toBe(400);
  // Zod refine catches this before the controller — error uses Fastify validation envelope
  const body = await r.json() as { code: string; message: string };
  expect(body.code).toBe('FST_ERR_VALIDATION');
});

test('biz-card 35: without auth → 401', async ({ request }) => {
  const r = await request.post('/api/v1/contacts/business-card/scan', {
    data: { text: 'Test User' },
  });
  expect(r.status()).toBe(401);
});

// ─── Group 2: POST /contacts/transcribe-voice (completely untested) ────────────

test('voice 35: without auth → 401', async ({ request }) => {
  const r = await request.post('/api/v1/contacts/transcribe-voice', {
    data: Buffer.from('fake-audio-bytes'),
  });
  expect(r.status()).toBe(401);
});

test('voice 35: with auth, no Yandex key configured → 503 SERVICE_NOT_CONFIGURED', async ({ request }) => {
  const org = await registerOrg(request, 'voice35-no-key');
  // Send as JSON (audio_base64 field); Fastify accepts JSON, handler checks Yandex config first
  const r = await request.post('/api/v1/contacts/transcribe-voice', {
    headers: authHeaders(org.token),
    data: { audio_base64: 'ZmFrZQ==' },
  });
  expect(r.status()).toBe(503);
  const body = await r.json() as { error: { code: string } };
  expect(body.error.code).toBe('SERVICE_NOT_CONFIGURED');
});

// ─── Group 3: POST /messages/:id/read cross-org isolation ─────────────────────

test('messages 35: mark-read cross-org → 404 MESSAGE_NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'msg35-org-a');
  const orgB = await registerOrg(request, 'msg35-org-b');

  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(orgA.token),
    data: { first_name: 'Contact', phone: '+79001112233' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;

  const msgRes = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(orgA.token),
    data: { contact_id: contactId, body: 'Hello from org A' },
  });
  expect(msgRes.status()).toBe(201);
  const msgId = ((await msgRes.json()) as { data: { id: string } }).data.id;

  const readRes = await request.post(`/api/v1/messages/${msgId}/read`, {
    headers: authHeaders(orgB.token),
  });
  expect(readRes.status()).toBe(404);
  const body = await readRes.json() as { error: { code: string } };
  expect(body.error.code).toBe('MESSAGE_NOT_FOUND');
});

// ─── Group 4: Analytics auth guards (4 endpoints, none have 401 guard tests) ──

test('analytics 35: GET /team-activity without auth → 401', async ({ request }) => {
  const r = await request.get('/api/v1/analytics/team-activity');
  expect(r.status()).toBe(401);
});

test('analytics 35: GET /rep-performance without auth → 401', async ({ request }) => {
  const r = await request.get('/api/v1/analytics/rep-performance');
  expect(r.status()).toBe(401);
});

test('analytics 35: GET /conversion-rates without auth → 401', async ({ request }) => {
  const r = await request.get('/api/v1/analytics/conversion-rates');
  expect(r.status()).toBe(401);
});

test('analytics 35: GET /stage-duration without auth → 401', async ({ request }) => {
  const r = await request.get('/api/v1/analytics/stage-duration');
  expect(r.status()).toBe(401);
});

// ─── Group 5: Workflows double-archive idempotency ────────────────────────────

test('workflows 35: DELETE twice (double-archive) → both return 200', async ({ request }) => {
  const org = await registerOrg(request, 'wf35-double-del');

  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: {
      name: 'Double Archive Test',
      trigger: 'contact_created',
      actions: [{ type: 'create_task', task_title: 'Follow up', task_due_days: 1 }],
    },
  });
  expect(createRes.status()).toBe(201);
  const wfId = ((await createRes.json()) as WorkflowBody).data.id;

  const del1 = await request.delete(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });
  expect(del1.status()).toBe(200);
  const body1 = (await del1.json()) as WorkflowBody;
  expect(body1.data.status).toBe('archived');

  const del2 = await request.delete(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });
  expect(del2.status()).toBe(200);
  const body2 = (await del2.json()) as WorkflowBody;
  expect(body2.data.status).toBe('archived');
});
