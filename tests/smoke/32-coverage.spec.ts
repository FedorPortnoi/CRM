import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

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
