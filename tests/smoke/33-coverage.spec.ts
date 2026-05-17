import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `${unique}@example.com`, password: 'Password123!', name: `User ${suffix}`, org_name: `Org ${unique}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}
function authHeaders(token: string) { return { Authorization: `Bearer ${token}` }; }
function daysFromNow(n: number) { return new Date(Date.now() + n * 86400000).toISOString(); }

interface WorkflowAction {
  type: string;
  config?: Record<string, unknown>;
}

interface WorkflowData {
  id: string;
  trigger: string;
  status: string;
  actions: WorkflowAction[];
  conditions: unknown;
  name: string;
  _count?: { runs: number };
  runs?: unknown[];
}

interface WorkflowBody {
  data: WorkflowData;
}

interface WorkflowListBody {
  data: WorkflowData[];
  meta: { total: number };
}

test.describe.configure({ timeout: 30000 });

test('workflow 33: cross-org GET /:id for org-A workflow returns 404 for org-B', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf33-co-get-a');
  const orgB = await registerOrg(request, 'wf33-co-get-b');
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'OrgA-WF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(res.status()).toBe(201);
  const wfId = ((await res.json()) as WorkflowBody).data.id;
  const r = await request.get(`/api/v1/workflows/${wfId}`, { headers: authHeaders(orgB.token) });
  expect(r.status()).toBe(404);
});

test('workflow 33: cross-org PATCH /:id for org-A workflow returns 404 for org-B', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf33-co-patch-a');
  const orgB = await registerOrg(request, 'wf33-co-patch-b');
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'OrgA-PatchWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(res.status()).toBe(201);
  const wfId = ((await res.json()) as WorkflowBody).data.id;
  const r = await request.patch(`/api/v1/workflows/${wfId}`, {
    headers: authHeaders(orgB.token),
    data: { name: 'Hacked' },
  });
  expect(r.status()).toBe(404);
});

test('workflow 33: cross-org DELETE /:id for org-A workflow returns 404 for org-B', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf33-co-del-a');
  const orgB = await registerOrg(request, 'wf33-co-del-b');
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'OrgA-DelWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(res.status()).toBe(201);
  const wfId = ((await res.json()) as WorkflowBody).data.id;
  const r = await request.delete(`/api/v1/workflows/${wfId}`, { headers: authHeaders(orgB.token) });
  expect(r.status()).toBe(404);
});

test('workflow 33: cross-org GET /workflows list for org-B does NOT contain org-A workflow', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf33-co-list-a');
  const orgB = await registerOrg(request, 'wf33-co-list-b');
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'OrgA-ListWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(res.status()).toBe(201);
  const wfId = ((await res.json()) as WorkflowBody).data.id;
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(orgB.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowListBody;
  expect(body.data.every((w) => w.id !== wfId)).toBe(true);
});

test('workflow 33: cross-org GET /:id/runs for org-A workflow using org-B token returns 404', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf33-co-runs-a');
  const orgB = await registerOrg(request, 'wf33-co-runs-b');
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'OrgA-RunsWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(res.status()).toBe(201);
  const wfId = ((await res.json()) as WorkflowBody).data.id;
  const r = await request.get(`/api/v1/workflows/${wfId}/runs`, { headers: authHeaders(orgB.token) });
  expect(r.status()).toBe(404);
});

test('workflow 33: POST with invalid trigger value returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-inv-trig');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'BadTrigger', trigger: 'deal_lost', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(r.status()).toBe(400);
});

test('workflow 33: POST with empty actions array returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-empty-act');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'NoActions', trigger: 'contact_created', actions: [] },
  });
  expect(r.status()).toBe(400);
});

test('workflow 33: POST with invalid action type returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-inv-act');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'BadAction', trigger: 'contact_created', actions: [{ type: 'send_sms', config: {} }] },
  });
  expect(r.status()).toBe(400);
});

test('workflow 33: POST with deal_won trigger returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-trig-dw');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnDealWon', trigger: 'deal_won', actions: [{ type: 'create_task', config: { title: 'follow-up' } }] },
  });
  expect(r.status()).toBe(201);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.trigger).toBe('deal_won');
});

test('workflow 33: POST with deal_created trigger returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-trig-dc');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnDealCreated', trigger: 'deal_created', actions: [{ type: 'create_task', config: { title: 'follow-up' } }] },
  });
  expect(r.status()).toBe(201);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.trigger).toBe('deal_created');
});

test('workflow 33: POST with task_created trigger returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-trig-tc');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnTaskCreated', trigger: 'task_created', actions: [{ type: 'create_task', config: { title: 'follow-up' } }] },
  });
  expect(r.status()).toBe(201);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.trigger).toBe('task_created');
});

test('workflow 33: POST with add_contact_note action; GET /:id confirms action type', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-act-note');
  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'NoteAction', trigger: 'contact_created', actions: [{ type: 'add_contact_note', config: { body: 'Note text' } }] },
  });
  expect(createRes.status()).toBe(201);
  const wfId = ((await createRes.json()) as WorkflowBody).data.id;
  const r = await request.get(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.actions.some((a) => a.type === 'add_contact_note')).toBe(true);
});

test('workflow 33: POST with update_deal_stage action (no stage_id) returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-act-stage');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'StageAction', trigger: 'deal_stage_changed', actions: [{ type: 'update_deal_stage', config: {} }] },
  });
  expect(r.status()).toBe(201);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.actions.some((a) => a.type === 'update_deal_stage')).toBe(true);
});

test('workflow 33: GET /:id response body.data has runs array', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-runs-arr');
  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'RunsArrayWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  expect(createRes.status()).toBe(201);
  const wfId = ((await createRes.json()) as WorkflowBody).data.id;
  const r = await request.get(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowBody;
  expect(Array.isArray(body.data.runs)).toBe(true);
});

test('workflow 33: GET /workflows list item has _count.runs property', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-count-runs');
  await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'CountWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }] },
  });
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowListBody;
  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data[0]._count).toBeDefined();
  expect(typeof (body.data[0]._count as { runs: number }).runs).toBe('number');
});

test('workflow 33: POST with conditions array; GET /:id confirms conditions non-null', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-conds');
  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'CondsWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'task' } }], conditions: [{ field: 'email', operator: 'contains', value: 'example.com' }] },
  });
  expect(createRes.status()).toBe(201);
  const wfId = ((await createRes.json()) as WorkflowBody).data.id;
  const r = await request.get(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.conditions).not.toBeNull();
});

test('workflow 33: PATCH can update actions; GET /:id reflects new actions', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-patch-act');
  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'PatchActWF', trigger: 'contact_created', actions: [{ type: 'create_task', config: { title: 'old' } }] },
  });
  expect(createRes.status()).toBe(201);
  const wfId = ((await createRes.json()) as WorkflowBody).data.id;
  const patchRes = await request.patch(`/api/v1/workflows/${wfId}`, {
    headers: authHeaders(org.token),
    data: { actions: [{ type: 'add_contact_note', config: { body: 'updated note' } }] },
  });
  expect(patchRes.status()).toBe(200);
  const r = await request.get(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowBody;
  expect(body.data.actions.some((a) => a.type === 'add_contact_note')).toBe(true);
  expect(body.data.actions.every((a) => a.type !== 'create_task')).toBe(true);
});

test('workflow 33: GET /workflows meta.total equals count of non-archived workflows', async ({ request }) => {
  const org = await registerOrg(request, 'wf33-meta-total');
  for (let i = 0; i < 3; i++) {
    const r = await request.post('/api/v1/workflows', {
      headers: authHeaders(org.token),
      data: {
        name: `TotalWF-${i}`,
        trigger: 'contact_created',
        actions: [{ type: 'create_task', config: { title: 'task' } }],
      },
    });
    expect(r.status()).toBe(201);
  }
  const listRes = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  const listBody = (await listRes.json()) as WorkflowListBody;
  const firstId = listBody.data[0].id;
  await request.delete(`/api/v1/workflows/${firstId}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as WorkflowListBody;
  expect(body.meta.total).toBe(body.data.length);
});