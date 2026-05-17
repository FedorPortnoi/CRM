import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };
type CaptureType = 'call' | 'sms' | 'email';
type CaptureStatus = 'pending' | 'matched' | 'dismissed';
type CaptureStatusQuery = CaptureStatus | 'all';
type Envelope<T, M extends Record<string, unknown> = Record<string, unknown>> = { data: T; meta: M };
type Capture = {
  id: string;
  type: CaptureType;
  status: CaptureStatus;
  raw_data: Record<string, unknown>;
  phone_number: string | null;
  contact_id: string | null;
};
type Contact = {
  id: string;
  first_name: string;
  phone: string | null;
  mobile: string | null;
};
type Message = {
  id: string;
  body: string;
  channel: string;
  direction: string;
  status: string;
  twilio_sid?: string | null;
};
type ErrorBody = { error: { code: string; message: string } };

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
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

function authHeaders(token: string) { return { Authorization: `Bearer ${token}` }; }

async function getPipeline(request: APIRequestContext, token: string) {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  const body = await res.json() as { data: Array<{ id: string; is_default: boolean; stages: Array<{ id: string }> }> };
  return body.data.find(p => p.is_default) ?? body.data[0]!;
}

async function makeContact(request: APIRequestContext, token: string, name: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: name, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function makeDeal(request: APIRequestContext, token: string, cId: string, plId: string, stId: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Test Deal', contact_id: cId, pipeline_id: plId, stage_id: stId, currency: 'USD', ...extra },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}

async function makeTask(request: APIRequestContext, token: string, userId: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title, assigned_to: userId, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function decodeOrgId(token: string): string {
  const payloadPart = token.split('.')[1];
  expect(payloadPart).toBeTruthy();
  const base64 = payloadPart!
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(payloadPart!.length / 4) * 4, '=');
  const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as unknown;
  expect(isRecord(decoded)).toBe(true);
  const orgId = (decoded as Record<string, unknown>).org_id;
  expect(typeof orgId).toBe('string');
  return orgId as string;
}

function uniqueDigits(length: number): string {
  let digits = `${Date.now()}${Math.floor(Math.random() * 1_000_000_000)}`;
  while (digits.length < length) {
    digits += Math.floor(Math.random() * 10).toString();
  }
  return digits.slice(-length);
}

function uniquePhone(): string {
  return `+1555${uniqueDigits(7)}`;
}

function uniqueNationalPhone(): string {
  return `9${uniqueDigits(9)}`;
}

function formatPhoneVariant(digits: string): string {
  return `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}

function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return params.toString();
}

async function createCapture(
  request: APIRequestContext,
  token: string,
  type: CaptureType,
  rawData: Record<string, unknown>,
  phoneNumber?: string,
): Promise<Capture> {
  const data: { type: CaptureType; raw_data: Record<string, unknown>; phone_number?: string } = {
    type,
    raw_data: rawData,
  };
  if (phoneNumber !== undefined) {
    data.phone_number = phoneNumber;
  }

  const res = await request.post('/api/v1/captures', { headers: authHeaders(token), data });
  expect(res.status()).toBe(201);
  return ((await res.json()) as Envelope<Capture>).data;
}

async function listCaptures(
  request: APIRequestContext,
  token: string,
  status?: CaptureStatusQuery,
): Promise<Envelope<Capture[], { total: number }>> {
  const path = status ? `/api/v1/captures?status=${status}` : '/api/v1/captures';
  const res = await request.get(path, { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  return await res.json() as Envelope<Capture[], { total: number }>;
}

async function conversation(request: APIRequestContext, token: string, contactId: string): Promise<Message[]> {
  const res = await request.get(`/api/v1/messages/conversation/${contactId}`, { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as Envelope<Message[]>).data;
}

async function seedCaptureStates(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<{ pending: Capture; matched: Capture; dismissed: Capture }> {
  const contact = await makeContact(request, token, `Capture ${suffix}`, { phone: uniquePhone() });
  const pending = await createCapture(request, token, 'call', { phone: uniquePhone(), notes: `${suffix} pending` });
  const matched = await createCapture(request, token, 'sms', { from: uniquePhone(), Body: `${suffix} matched` });
  const dismissed = await createCapture(request, token, 'email', { from: uniquePhone(), subject: `${suffix} dismissed` });

  const matchRes = await request.post(`/api/v1/captures/${matched.id}/match`, {
    headers: authHeaders(token),
    data: { contact_id: contact.id },
  });
  expect(matchRes.status()).toBe(200);

  const dismissRes = await request.post(`/api/v1/captures/${dismissed.id}/dismiss`, {
    headers: authHeaders(token),
  });
  expect(dismissRes.status()).toBe(200);

  return { pending, matched, dismissed };
}

test.describe.configure({ timeout: 30000 });

// ── 1. CSV EXPORT ──────────────────────────────────────────────────────────────

test.describe('export csv', () => {
  test('export: funnel report as csv returns text/csv', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-csv-funnel');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'funnel', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
    const text = await r.text();
    expect(text).toContain('stage_id');
  });

  test('export: revenue report as csv returns text/csv with headers', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-csv-rev');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'revenue', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
    const text = await r.text();
    expect(text).toContain('period');
  });

  test('export: win_loss report as csv returns text/csv', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-csv-wl');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'win_loss', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
  });

  test('export: lead_sources report as csv returns text/csv', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-csv-ls');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'lead_sources', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
  });

  test('export: team_activity report as csv returns text/csv', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-csv-ta');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'team_activity', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
  });

  test('export: custom period date range works', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-csv-custom');
    const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'funnel', period: 'custom', start, end },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/csv');
  });
});

// ── 2. PDF EXPORT ──────────────────────────────────────────────────────────────

test.describe('export pdf', () => {
  test('export: funnel report as pdf returns application/pdf', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-pdf-funnel');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'pdf', report: 'funnel', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/pdf');
    const buf = await r.body();
    // PDF magic bytes: %PDF-
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('export: revenue report as pdf returns application/pdf', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-pdf-rev');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'pdf', report: 'revenue', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/pdf');
  });

  test('export: win_loss report as pdf returns application/pdf', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-pdf-wl');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'pdf', report: 'win_loss', period: 'month' },
    });
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/pdf');
  });

  test('export: missing format returns 400', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-bad-fmt');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { report: 'funnel', period: 'month' },
    });
    expect(r.status()).toBe(400);
  });

  test('export: invalid report type returns 400', async ({ request }) => {
    const { token } = await registerOrg(request, 'exp-bad-rpt');
    const r = await request.post('/api/v1/analytics/export', {
      headers: authHeaders(token),
      data: { format: 'csv', report: 'nonexistent_report', period: 'month' },
    });
    expect(r.status()).toBe(400);
  });
});

// ── 3. TWILIO WEBHOOKS ────────────────────────────────────────────────────────

test.describe('sms.ru webhooks', () => {
  test('sms.ru: inbound webhook returns 200 for unknown phone', async ({ request }) => {
    // When phone doesn't match any contact, webhook still returns 200
    const r = await request.post('/api/v1/messages/webhooks/sms/inbound', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'From=%2B15559999999&Body=Hello+from+unknown&SmsId=SMtest001',
    });
    expect(r.status()).toBe(200);
  });

  test('sms.ru: inbound webhook creates message when phone matches contact', async ({ request }) => {
    const { token } = await registerOrg(request, 'smsru-inbound');
    const phone = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
    // Create contact with that phone
    const c = await makeContact(request, token, 'SmsRuContact', { phone });

    // Simulate SMS.ru sending an inbound SMS
    const smsSid = `SM${Date.now()}test`;
    const r = await request.post('/api/v1/messages/webhooks/sms/inbound', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `From=${encodeURIComponent(phone)}&Body=Hello+from+SMS.ru&SmsId=${smsSid}`,
    });
    expect(r.status()).toBe(200);

    // Verify message was created — check conversation
    const conv = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(token) });
    expect(conv.status()).toBe(200);
    const convBody = await conv.json() as { data: Array<{ body: string; channel: string; direction: string }> };
    const found = convBody.data.find(m => m.body === 'Hello from SMS.ru' && m.channel === 'sms' && m.direction === 'inbound');
    expect(found).toBeDefined();
  });

  test('sms.ru: status webhook accepts delivery status for unknown SmsId', async ({ request }) => {
    const r = await request.post('/api/v1/messages/webhooks/sms/status', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'SmsId=SMunknown999&Status=delivered',
    });
    expect(r.status()).toBe(200);
  });

  test('sms.ru: status webhook requires SmsId and Status', async ({ request }) => {
    const r = await request.post('/api/v1/messages/webhooks/sms/status', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `SmsId=SMstatus${Date.now()}`,
    });
    expect(r.status()).toBe(400);
  });
});

// ── 4. NEW WORKFLOW TRIGGERS ──────────────────────────────────────────────────
// These tests require the workflow migration (deal_won, deal_created, task_created) to be deployed.

test.describe('workflow triggers extended', () => {
  test('workflow: deal_created trigger fires task on deal creation', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'wf-deal-created');
    const pl = await getPipeline(request, token);
    const stId = pl.stages[0]!.id;

    // Create workflow with deal_created trigger
    const wfRes = await request.post('/api/v1/workflows', {
      headers: authHeaders(token),
      data: {
        name: 'Auto task on deal created',
        trigger: 'deal_created',
        actions: [{ type: 'create_task', title: 'Follow up on new deal', due_in_days: 1 }],
        status: 'active',
      },
    });
    expect(wfRes.status()).toBe(201);

    // Create a deal — should fire the trigger
    const c = await makeContact(request, token, 'DealCreatedContact');
    await makeDeal(request, token, c.id, pl.id, stId);

    // Wait briefly and check tasks were created
    await new Promise(r => setTimeout(r, 200));
    const tasksRes = await request.get('/api/v1/tasks', { headers: authHeaders(token) });
    expect(tasksRes.status()).toBe(200);
    const tasksBody = await tasksRes.json() as { data: Array<{ title: string }> };
    const found = tasksBody.data.find(t => t.title.includes('Follow up on new deal'));
    expect(found).toBeDefined();
  });

  test('workflow: deal_won trigger fires task when deal marked won', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'wf-deal-won');
    const pl = await getPipeline(request, token);
    const stId = pl.stages[0]!.id;

    // Create workflow with deal_won trigger
    const wfRes = await request.post('/api/v1/workflows', {
      headers: authHeaders(token),
      data: {
        name: 'Congrats task on deal won',
        trigger: 'deal_won',
        actions: [{ type: 'create_task', title: 'Send contract to client', due_in_days: 1 }],
        status: 'active',
      },
    });
    expect(wfRes.status()).toBe(201);

    // Create and mark won
    const c = await makeContact(request, token, 'WonContact');
    const d = await makeDeal(request, token, c.id, pl.id, stId);
    const wonRes = await request.post(`/api/v1/deals/${d.id}/won`, {
      headers: authHeaders(token),
      data: {},
    });
    expect(wonRes.status()).toBe(200);

    // Check task was created
    await new Promise(r => setTimeout(r, 200));
    const tasksRes = await request.get('/api/v1/tasks', { headers: authHeaders(token) });
    const tasksBody = await tasksRes.json() as { data: Array<{ title: string }> };
    const found = tasksBody.data.find(t => t.title.includes('Send contract to client'));
    expect(found).toBeDefined();
  });

  test('workflow: task_created trigger fires task when task created', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'wf-task-created');

    // Create workflow with task_created trigger
    const wfRes = await request.post('/api/v1/workflows', {
      headers: authHeaders(token),
      data: {
        name: 'Follow-up on new task',
        trigger: 'task_created',
        actions: [{ type: 'create_task', title: 'Verify task created', due_in_days: 1 }],
        status: 'active',
      },
    });
    expect(wfRes.status()).toBe(201);

    // Create a task — should fire trigger
    await makeTask(request, token, userId, 'Original task that triggers workflow');

    await new Promise(r => setTimeout(r, 200));
    const tasksRes = await request.get('/api/v1/tasks', { headers: authHeaders(token) });
    const tasksBody = await tasksRes.json() as { data: Array<{ title: string }> };
    const found = tasksBody.data.find(t => t.title.includes('Verify task created'));
    expect(found).toBeDefined();
  });
});

// ── 5. ONBOARDING FLOW ────────────────────────────────────────────────────────

test.describe('onboarding', () => {
  test('onboarding: GET /auth/onboarding returns current state', async ({ request }) => {
    const { token } = await registerOrg(request, 'ob-get');
    const r = await request.get('/api/v1/auth/onboarding', { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: Record<string, unknown>; meta: Record<string, unknown> };
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
  });

  test('onboarding: PATCH /auth/onboarding sets completed=true', async ({ request }) => {
    const { token } = await registerOrg(request, 'ob-patch');
    const r = await request.patch('/api/v1/auth/onboarding', {
      headers: authHeaders(token),
      data: { completed: true },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { onboarding_completed: boolean } };
    expect(body.data.onboarding_completed).toBe(true);
  });

  test('onboarding: PATCH with dismissed_steps records steps', async ({ request }) => {
    const { token } = await registerOrg(request, 'ob-steps');
    const r = await request.patch('/api/v1/auth/onboarding', {
      headers: authHeaders(token),
      data: { completed: false, dismissed_steps: ['add_contact', 'create_deal'] },
    });
    expect(r.status()).toBe(200);
  });

  test('onboarding: completing onboarding → GET shows completed=true', async ({ request }) => {
    const { token } = await registerOrg(request, 'ob-roundtrip');
    // Complete
    await request.patch('/api/v1/auth/onboarding', {
      headers: authHeaders(token),
      data: { completed: true },
    });
    // Verify
    const r = await request.get('/api/v1/auth/onboarding', { headers: authHeaders(token) });
    const body = await r.json() as { data: { completed: boolean } };
    expect(body.data.completed).toBe(true);
  });

  test('onboarding: new user has onboarding_completed=false in auth response', async ({ request }) => {
    const unique = `ob-new-${Date.now()}`;
    const res = await request.post('/api/v1/auth/', {
      data: { email: `${unique}@example.com`, password: 'Password123!', name: 'New User', org_name: `Org ${unique}` },
    });
    expect(res.status()).toBe(201);
    const body = await res.json() as { data: { user: { onboarding_completed?: boolean } } };
    // New users should have onboarding_completed = false (or undefined treated as false)
    expect(body.data.user.onboarding_completed === false || body.data.user.onboarding_completed === undefined).toBe(true);
  });
});

test.describe('auto-capture', () => {
  test('captures: POST creates pending call capture with response envelope', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-create-call');
    const phone = uniquePhone();
    const r = await request.post('/api/v1/captures', {
      headers: authHeaders(token),
      data: {
        type: 'call',
        raw_data: { phone, direction: 'inbound', duration_seconds: 42, notes: 'Initial call' },
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json() as Envelope<Capture>;
    expect(body.meta).toEqual({});
    expect(body.data.type).toBe('call');
    expect(body.data.status).toBe('pending');
    expect(body.data.phone_number).toBe(phone);
    expect(body.data.raw_data.phone).toBe(phone);
  });

  test('captures: POST backfills phone_number from raw_data phone fields', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-phone-backfill');
    const phoneValue = uniquePhone();
    const fromValue = uniquePhone();
    const upperFromValue = uniquePhone();

    const fromPhone = await createCapture(request, token, 'sms', { phone: phoneValue, Body: 'phone field' });
    const fromLower = await createCapture(request, token, 'sms', { from: fromValue, Body: 'from field' });
    const fromUpper = await createCapture(request, token, 'sms', { From: upperFromValue, Body: 'From field' });

    expect(fromPhone.phone_number).toBe(phoneValue);
    expect(fromLower.phone_number).toBe(fromValue);
    expect(fromUpper.phone_number).toBe(upperFromValue);
  });

  test('captures: GET defaults to pending only and returns meta.total', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-list-pending');
    const seeded = await seedCaptureStates(request, token, 'default');

    const body = await listCaptures(request, token);
    expect(body.meta.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(seeded.pending.id);
    expect(body.data[0]!.status).toBe('pending');
  });

  test('captures: GET status=all includes pending matched and dismissed', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-list-all');
    const seeded = await seedCaptureStates(request, token, 'all');

    const body = await listCaptures(request, token, 'all');
    expect(body.meta.total).toBe(3);
    expect(body.data.map(c => c.id)).toEqual(expect.arrayContaining([seeded.pending.id, seeded.matched.id, seeded.dismissed.id]));
    expect(body.data.map(c => c.status)).toEqual(expect.arrayContaining(['pending', 'matched', 'dismissed']));
  });

  test('captures: GET status=matched returns matched captures only', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-list-matched');
    const seeded = await seedCaptureStates(request, token, 'matched');

    const body = await listCaptures(request, token, 'matched');
    expect(body.meta.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(seeded.matched.id);
    expect(body.data[0]!.status).toBe('matched');
  });

  test('captures: GET status=dismissed returns dismissed captures only', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-list-dismissed');
    const seeded = await seedCaptureStates(request, token, 'dismissed');

    const body = await listCaptures(request, token, 'dismissed');
    expect(body.meta.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(seeded.dismissed.id);
    expect(body.data[0]!.status).toBe('dismissed');
  });

  test('captures: dismiss marks pending capture dismissed and removes it from default list', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-dismiss');
    const capture = await createCapture(request, token, 'call', { phone: uniquePhone(), notes: 'Dismiss me' });

    const dismissRes = await request.post(`/api/v1/captures/${capture.id}/dismiss`, { headers: authHeaders(token) });
    expect(dismissRes.status()).toBe(200);
    const dismissed = await dismissRes.json() as Envelope<Capture>;
    expect(dismissed.data.status).toBe('dismissed');
    expect(dismissed.meta).toEqual({});

    const pending = await listCaptures(request, token);
    expect(pending.data.find(c => c.id === capture.id)).toBeUndefined();
    const dismissedList = await listCaptures(request, token, 'dismissed');
    expect(dismissedList.data.find(c => c.id === capture.id)?.status).toBe('dismissed');
  });

  test('captures: dismissing an already resolved capture returns CAPTURE_ALREADY_RESOLVED', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-dismiss-resolved');
    const capture = await createCapture(request, token, 'call', { phone: uniquePhone(), notes: 'Resolve once' });

    const firstDismiss = await request.post(`/api/v1/captures/${capture.id}/dismiss`, { headers: authHeaders(token) });
    expect(firstDismiss.status()).toBe(200);

    const secondDismiss = await request.post(`/api/v1/captures/${capture.id}/dismiss`, { headers: authHeaders(token) });
    expect(secondDismiss.status()).toBe(422);
    const body = await secondDismiss.json() as ErrorBody;
    expect(body.error.code).toBe('CAPTURE_ALREADY_RESOLVED');
  });

  test('captures: match rejects a contact from another org and leaves capture pending', async ({ request }) => {
    const orgA = await registerOrg(request, 'cap-cross-contact-a');
    const orgB = await registerOrg(request, 'cap-cross-contact-b');
    const capture = await createCapture(request, orgA.token, 'sms', { from: uniquePhone(), Body: 'Cross org candidate' });
    const otherContact = await makeContact(request, orgB.token, 'OtherOrgContact', { phone: uniquePhone() });

    const matchRes = await request.post(`/api/v1/captures/${capture.id}/match`, {
      headers: authHeaders(orgA.token),
      data: { contact_id: otherContact.id },
    });
    expect(matchRes.status()).toBe(404);
    const error = await matchRes.json() as ErrorBody;
    expect(error.error.code).toBe('NOT_FOUND');

    const pending = await listCaptures(request, orgA.token);
    expect(pending.data.find(c => c.id === capture.id)?.status).toBe('pending');
  });

  test('captures: match creates a call message linked to the matched contact', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-match-message');
    const contact = await makeContact(request, token, 'CallContact', { phone: uniquePhone() });
    const capture = await createCapture(request, token, 'call', {
      phone: uniquePhone(),
      direction: 'outbound',
      duration_seconds: 123,
      notes: 'Qualified lead call',
    });

    const matchRes = await request.post(`/api/v1/captures/${capture.id}/match`, {
      headers: authHeaders(token),
      data: { contact_id: contact.id },
    });
    expect(matchRes.status()).toBe(200);
    const matchBody = await matchRes.json() as Envelope<Capture>;
    expect(matchBody.data.status).toBe('matched');
    expect(matchBody.data.contact_id).toBe(contact.id);

    const messages = await conversation(request, token, contact.id);
    const message = messages.find(m => m.body === '[123s] Qualified lead call');
    expect(message).toBeDefined();
    expect(message?.channel).toBe('call');
    expect(message?.direction).toBe('outbound');
    expect(message?.status).toBe('delivered');
  });

  test('captures: org A capture is not visible or actionable from org B', async ({ request }) => {
    const orgA = await registerOrg(request, 'cap-scope-a');
    const orgB = await registerOrg(request, 'cap-scope-b');
    const capture = await createCapture(request, orgA.token, 'call', { phone: uniquePhone(), notes: 'Private capture' });
    const orgBContact = await makeContact(request, orgB.token, 'OrgBContact', { phone: uniquePhone() });

    const orgBList = await listCaptures(request, orgB.token, 'all');
    expect(orgBList.data.find(c => c.id === capture.id)).toBeUndefined();

    const orgBMatch = await request.post(`/api/v1/captures/${capture.id}/match`, {
      headers: authHeaders(orgB.token),
      data: { contact_id: orgBContact.id },
    });
    expect(orgBMatch.status()).toBe(404);

    const orgBDismiss = await request.post(`/api/v1/captures/${capture.id}/dismiss`, {
      headers: authHeaders(orgB.token),
    });
    expect(orgBDismiss.status()).toBe(404);

    const orgAPending = await listCaptures(request, orgA.token);
    expect(orgAPending.data.find(c => c.id === capture.id)?.status).toBe('pending');
  });

  test('captures: create-contact creates a contact, matches the capture, and creates a message', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-create-contact');
    const phone = uniquePhone();
    const capture = await createCapture(request, token, 'sms', {
      first_name: 'Captured',
      phone,
      Body: 'Imported from pending capture',
    });

    const createRes = await request.post(`/api/v1/captures/${capture.id}/create-contact`, {
      headers: authHeaders(token),
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json() as Envelope<Contact>;
    expect(created.meta).toEqual({});
    expect(created.data.first_name).toBe('Captured');
    expect(created.data.phone).toBe(phone);

    const allCaptures = await listCaptures(request, token, 'all');
    const matched = allCaptures.data.find(c => c.id === capture.id);
    expect(matched?.status).toBe('matched');
    expect(matched?.contact_id).toBe(created.data.id);

    const messages = await conversation(request, token, created.data.id);
    expect(messages.find(m => m.channel === 'sms' && m.body === 'Imported from pending capture')).toBeDefined();
  });

  test('captures: create-contact falls back to Unknown and uses the raw phone', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-create-contact-fallback');
    const phone = uniquePhone();
    const capture = await createCapture(request, token, 'sms', {
      From: phone,
      Body: 'Nameless capture body',
    });

    const createRes = await request.post(`/api/v1/captures/${capture.id}/create-contact`, {
      headers: authHeaders(token),
    });
    expect(createRes.status()).toBe(201);
    const created = await createRes.json() as Envelope<Contact>;
    expect(created.data.first_name).toBe('Unknown');
    expect(created.data.phone).toBe(phone);

    const messages = await conversation(request, token, created.data.id);
    expect(messages.find(m => m.channel === 'sms' && m.body === 'Nameless capture body')).toBeDefined();
  });

  test('captures: unauthenticated GET is rejected', async ({ request }) => {
    const r = await request.get('/api/v1/captures');
    expect(r.status()).toBe(401);
  });

  test('captures: invalid status query returns 400', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-bad-status');
    const r = await request.get('/api/v1/captures?status=resolved', { headers: authHeaders(token) });
    expect(r.status()).toBe(400);
  });

  test('captures: invalid type on POST returns 400', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-bad-type');
    const r = await request.post('/api/v1/captures', {
      headers: authHeaders(token),
      data: { type: 'fax', raw_data: { phone: uniquePhone() } },
    });
    expect(r.status()).toBe(400);
  });

  test('sms.ru: unmatched inbound with valid org_id creates a pending sms capture', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-sms-unmatched');
    const orgId = decodeOrgId(token);
    const phone = uniquePhone();
    const text = 'Unmatched SMS capture';
    const smsId = `SMcap${Date.now()}${uniqueDigits(4)}`;

    const webhook = await request.post('/api/v1/messages/webhooks/sms/inbound', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: formBody({ From: phone, Body: text, SmsId: smsId, org_id: orgId }),
    });
    expect(webhook.status()).toBe(200);

    const captures = await listCaptures(request, token, 'all');
    const capture = captures.data.find(c => c.type === 'sms' && c.phone_number === phone);
    expect(capture).toBeDefined();
    expect(capture?.status).toBe('pending');
    expect(capture?.raw_data.Body).toBe(text);
    expect(capture?.raw_data.text).toBe(text);
    expect(capture?.raw_data.SmsId).toBe(smsId);
    expect(capture?.raw_data.org_id).toBe(orgId);
  });

  test('sms.ru: matched inbound with valid org_id creates message and no pending capture', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-sms-matched');
    const orgId = decodeOrgId(token);
    const phone = uniquePhone();
    const text = 'Matched SMS message';
    const contact = await makeContact(request, token, 'SmsMatchedContact', { phone });

    const webhook = await request.post('/api/v1/messages/webhooks/sms/inbound', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: formBody({ From: phone, Body: text, SmsId: `SMcap${Date.now()}${uniqueDigits(4)}`, org_id: orgId }),
    });
    expect(webhook.status()).toBe(200);

    const messages = await conversation(request, token, contact.id);
    const message = messages.find(m => m.body === text && m.channel === 'sms' && m.direction === 'inbound');
    expect(message).toBeDefined();
    expect(message?.status).toBe('delivered');

    const captures = await listCaptures(request, token, 'all');
    expect(captures.data.find(c => c.phone_number === phone && c.status === 'pending')).toBeUndefined();
  });

  test('contacts: phone filter matches normalized phone and mobile variants only', async ({ request }) => {
    const { token } = await registerOrg(request, 'cap-phone-filter');
    const digits = uniqueNationalPhone();
    const phoneContact = await makeContact(request, token, 'PhoneVariant', { phone: formatPhoneVariant(digits) });
    const mobileContact = await makeContact(request, token, 'MobileVariant', { mobile: `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}` });
    const unrelated = await makeContact(request, token, 'UnrelatedPhone', { phone: formatPhoneVariant(uniqueNationalPhone()) });

    const r = await request.get(`/api/v1/contacts?phone=${digits}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as Envelope<Contact[], { total: number; page: number; per_page: number }>;
    const ids = body.data.map(c => c.id);
    expect(ids).toContain(phoneContact.id);
    expect(ids).toContain(mobileContact.id);
    expect(ids).not.toContain(unrelated.id);
    expect(body.meta.total).toBe(2);
  });
});
