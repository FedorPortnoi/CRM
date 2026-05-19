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

async function getPipeline(request: APIRequestContext, token: string): Promise<{ id: string; stages: Array<{ id: string }> }> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: Array<{ id: string; is_default: boolean; stages: Array<{ id: string }> }> };
  return (body.data.find(p => p.is_default) ?? body.data[0]!);
}

async function createContact(request: APIRequestContext, token: string, firstName: string, opts?: { phone?: string }): Promise<{ id: string }> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName, ...(opts?.phone ? { phone: opts.phone } : {}) },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createDeal(request: APIRequestContext, token: string, contactId: string, pipelineId: string, stageId: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Test Deal 38', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, currency: 'USD' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createTask(request: APIRequestContext, token: string, userId: string, title: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(token),
    data: { title, assigned_to: userId },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createCapture(request: APIRequestContext, token: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/captures', {
    headers: authHeaders(token),
    data: { type: 'sms', raw_data: { body: 'test sms', from: '+79001234567' }, phone_number: '+79001234567' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

test.describe.configure({ timeout: 30000 });

// ─── Group 1: Deal state machine edge cases ───────────────────────────────────

test('coverage 38: PATCH /deals/:id/stage on archived deal → 422 DEAL_NOT_OPEN', async ({ request }) => {
  const org = await registerOrg(request, '38-arc-stage');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const stageB = pl.stages[1]!.id;
  const c = await createContact(request, org.token, 'ArcContact');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  await request.delete(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });

  const res = await request.patch(`/api/v1/deals/${d.id}/stage`, {
    headers: authHeaders(org.token),
    data: { stage_id: stageB },
  });
  expect(res.status()).toBe(422);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('DEAL_NOT_OPEN');
});

test('coverage 38: PATCH /deals/:id/stage with stage from wrong pipeline → 404 STAGE_NOT_FOUND', async ({ request }) => {
  const org = await registerOrg(request, '38-wrong-pipe');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const c = await createContact(request, org.token, 'WrongPipeContact');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  const pipe2Res = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(org.token),
    data: { name: 'Other Pipeline 38' },
  });
  expect(pipe2Res.status()).toBe(201);
  const pipe2Id = ((await pipe2Res.json()) as { data: { id: string } }).data.id;

  const stage2Res = await request.post(`/api/v1/deals/pipelines/${pipe2Id}/stages`, {
    headers: authHeaders(org.token),
    data: { name: 'Stage P2', position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(stage2Res.status()).toBe(201);
  const stage2Id = ((await stage2Res.json()) as { data: { id: string } }).data.id;

  const res = await request.patch(`/api/v1/deals/${d.id}/stage`, {
    headers: authHeaders(org.token),
    data: { stage_id: stage2Id },
  });
  expect(res.status()).toBe(404);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('STAGE_NOT_FOUND');
});

test('coverage 38: POST /deals/:id/won on already-won deal → 422 DEAL_ALREADY_WON', async ({ request }) => {
  const org = await registerOrg(request, '38-dbl-won');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const c = await createContact(request, org.token, 'WonContact');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  const wonRes = await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  expect(wonRes.status()).toBe(200);

  const res = await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  expect(res.status()).toBe(422);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('DEAL_ALREADY_WON');
});

test('coverage 38: POST /deals/:id/lost then won → deal status becomes won', async ({ request }) => {
  const org = await registerOrg(request, '38-lost-won');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const c = await createContact(request, org.token, 'LostWonContact');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  const lostRes = await request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHeaders(org.token), data: { reason: 'budget' } });
  expect(lostRes.status()).toBe(200);

  const wonRes = await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  expect(wonRes.status()).toBe(200);
  const deal = ((await wonRes.json()) as { data: { status: string } }).data;
  expect(deal.status).toBe('won');
});

// ─── Group 2: Task state machine edge cases ───────────────────────────────────

test('coverage 38: POST /tasks/:id/start on in_progress task → 422 INVALID_STATUS_TRANSITION', async ({ request }) => {
  const org = await registerOrg(request, '38-task-start');
  const t = await createTask(request, org.token, org.userId, 'Start Task 38');

  const startRes = await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(org.token) });
  expect(startRes.status()).toBe(200);

  const res = await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(org.token) });
  expect(res.status()).toBe(422);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('INVALID_STATUS_TRANSITION');
});

test('coverage 38: POST /tasks/:id/complete on cancelled task → 422 TASK_CANCELLED', async ({ request }) => {
  const org = await registerOrg(request, '38-task-cancel-complete');
  const t = await createTask(request, org.token, org.userId, 'Cancel Me 38');

  await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });

  const res = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(org.token) });
  expect(res.status()).toBe(422);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('TASK_CANCELLED');
});

test('coverage 38: POST /tasks/:id/complete toggles done→pending (no workflow re-fire)', async ({ request }) => {
  const org = await registerOrg(request, '38-toggle-done');
  const t = await createTask(request, org.token, org.userId, 'Toggle Task 38');

  const done = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(org.token) });
  expect(done.status()).toBe(200);
  expect(((await done.json()) as { data: { status: string } }).data.status).toBe('done');

  const pending = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(org.token) });
  expect(pending.status()).toBe(200);
  expect(((await pending.json()) as { data: { status: string } }).data.status).toBe('pending');
});

// ─── Group 3: Messages ────────────────────────────────────────────────────────

test('coverage 38: POST /messages/sms without SMSRU config queues message (201 with delivery meta)', async ({ request }) => {
  const org = await registerOrg(request, '38-no-smsru');
  const c = await createContact(request, org.token, 'NoPhone');

  const res = await request.post('/api/v1/messages/sms', {
    headers: authHeaders(org.token),
    data: { contact_id: c.id, body: 'Hello queued' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { id: string }; meta: { delivery: string } };
  expect(body.meta.delivery).toBe('queued_without_smsru_config');
  expect(body.data.id).toBeTruthy();
});

test('coverage 38: GET /messages with cross-org contact_id returns empty (isolation)', async ({ request }) => {
  const orgA = await registerOrg(request, '38-msg-iso-a');
  const orgB = await registerOrg(request, '38-msg-iso-b');

  const cA = await createContact(request, orgA.token, 'OrgAContact', { phone: '+79991110001' });
  await request.post('/api/v1/messages/sms', {
    headers: authHeaders(orgA.token),
    data: { contact_id: cA.id, body: 'OrgA message' },
  });

  const res = await request.get(`/api/v1/messages?contact_id=${cA.id}`, { headers: authHeaders(orgB.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: unknown[]; meta: { total: number } };
  expect(body.meta.total).toBe(0);
  expect(body.data).toHaveLength(0);
});

// ─── Group 4: Captures ───────────────────────────────────────────────────────

test('coverage 38: POST /captures/:id/match on already-matched capture → 422 CAPTURE_ALREADY_RESOLVED', async ({ request }) => {
  const org = await registerOrg(request, '38-cap-dbl-match');
  const cap = await createCapture(request, org.token);
  const c = await createContact(request, org.token, 'MatchTarget');

  const firstMatch = await request.post(`/api/v1/captures/${cap.id}/match`, {
    headers: authHeaders(org.token),
    data: { contact_id: c.id },
  });
  expect(firstMatch.status()).toBe(200);

  const c2 = await createContact(request, org.token, 'MatchTarget2');
  const res = await request.post(`/api/v1/captures/${cap.id}/match`, {
    headers: authHeaders(org.token),
    data: { contact_id: c2.id },
  });
  expect(res.status()).toBe(422);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe('CAPTURE_ALREADY_RESOLVED');
});

// ─── Group 5: Onboarding example data ────────────────────────────────────────

test('coverage 38: POST /onboarding/example-data twice → second call still 201 (idempotent load)', async ({ request }) => {
  const org = await registerOrg(request, '38-example-twice');

  const first = await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  expect(first.status()).toBe(201);

  const second = await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  expect(second.status()).toBe(201);
  const body = await second.json() as { data: { contacts: number } };
  expect(body.data.contacts).toBeGreaterThan(0);
});

test('coverage 38: DELETE /onboarding/example-data when none loaded → 200 cleared:true', async ({ request }) => {
  const org = await registerOrg(request, '38-del-no-data');

  const res = await request.delete('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { cleared: boolean } };
  expect(body.data.cleared).toBe(true);
});

// ─── Group 6: Sync delta ─────────────────────────────────────────────────────

test('coverage 38: GET /sync/delta with invalid since format → 400', async ({ request }) => {
  const org = await registerOrg(request, '38-sync-bad');

  const res = await request.get('/api/v1/sync/delta?since=not-a-datetime', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(400);
});

// ─── Group 7: Dashboard pipeline health score denominator=0 ──────────────────

test('coverage 38: GET /analytics/dashboard with no won/lost/stalled → health score is 0', async ({ request }) => {
  const org = await registerOrg(request, '38-health-zero');

  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { pipeline_health_score: number } };
  expect(body.data.pipeline_health_score).toBe(0);
});
