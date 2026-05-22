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

async function createContact(request: APIRequestContext, token: string, firstName: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createDeal(request: APIRequestContext, token: string, contactId: string, pipelineId: string, stageId: string): Promise<{ id: string; stage_id: string }> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'WF37 Test Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, currency: 'USD' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; stage_id: string } }).data;
}

async function createPipelineWithStage(request: APIRequestContext, token: string, suffix: string): Promise<{ pipelineId: string; stageId: string }> {
  const pipelineRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
    data: { name: `WF37 Pipeline ${suffix}` },
  });
  expect(pipelineRes.status()).toBe(201);
  const pipelineId = ((await pipelineRes.json()) as { data: { id: string } }).data.id;

  const stageRes = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: authHeaders(token),
    data: { name: `WF37 Stage ${suffix}`, position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(stageRes.status()).toBe(201);
  const stageId = ((await stageRes.json()) as { data: { id: string } }).data.id;

  return { pipelineId, stageId };
}

async function createTask(request: APIRequestContext, token: string, userId: string, title: string, contactId?: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(token),
    data: { title, assigned_to: userId, ...(contactId ? { contact_id: contactId } : {}) },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

interface TaskList { data: Array<{ id: string; title: string }>; meta: { total: number } }
interface MessageList { data: Array<{ id: string; body: string; channel: string }>; meta: Record<string, unknown> }
interface WorkflowRunList { data: Array<{ id: string; status: string }>; meta: { total: number } }

test.describe.configure({ timeout: 30000 });

// ─── Group 1: Trigger execution ───────────────────────────────────────────────

test('workflow 37: deal_stage_changed trigger fires create_task action', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-dsc');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const stageB = pl.stages[1]!.id;
  const c = await createContact(request, org.token, 'Alice');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnStageChange37', trigger: 'deal_stage_changed', actions: [{ type: 'create_task', title: 'WF37-dsc-task', due_in_days: 1 }] },
  });
  expect(wfRes.status()).toBe(201);

  const patchRes = await request.patch(`/api/v1/deals/${d.id}/stage`, {
    headers: authHeaders(org.token),
    data: { stage_id: stageB },
  });
  expect(patchRes.status()).toBe(200);

  const tasksRes = await request.get('/api/v1/tasks', { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = (await tasksRes.json() as TaskList).data;
  expect(tasks.some(t => t.title === 'WF37-dsc-task')).toBe(true);
});

test('workflow 37: task_completed trigger fires create_task action', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-tc');
  const t = await createTask(request, org.token, org.userId, 'Original Task 37');

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnTaskDone37', trigger: 'task_completed', actions: [{ type: 'create_task', title: 'WF37-tc-followup', due_in_days: 2 }] },
  });
  expect(wfRes.status()).toBe(201);

  const completeRes = await request.post(`/api/v1/tasks/${t.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);
  const completedTask = (await completeRes.json() as { data: { status: string } }).data;
  expect(completedTask.status).toBe('done');

  const tasksRes = await request.get('/api/v1/tasks', { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = (await tasksRes.json() as TaskList).data;
  expect(tasks.some(t => t.title === 'WF37-tc-followup')).toBe(true);
});

test('workflow 37: contact_created + add_contact_note creates message in conversation', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-ccn');

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'NoteOnCreate37', trigger: 'contact_created', actions: [{ type: 'add_contact_note', body: 'WF37-auto-note' }] },
  });
  expect(wfRes.status()).toBe(201);

  const c = await createContact(request, org.token, 'NoteTarget');

  const msgRes = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(org.token) });
  expect(msgRes.status()).toBe(200);
  const msgs = (await msgRes.json() as MessageList).data;
  expect(msgs.some(m => m.body === 'WF37-auto-note')).toBe(true);
  expect(msgs.find(m => m.body === 'WF37-auto-note')!.channel).toBe('in_app');
});

test('workflow 37: task_completed + add_contact_note creates message for task contact', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-tcn');
  const c = await createContact(request, org.token, 'TaskNoteTarget');
  const t = await createTask(request, org.token, org.userId, 'Linked Task 37', c.id);

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'NoteOnDone37', trigger: 'task_completed', actions: [{ type: 'add_contact_note', body: 'WF37-done-note' }] },
  });
  expect(wfRes.status()).toBe(201);

  const completeRes = await request.post(`/api/v1/tasks/${t.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);

  const msgRes = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(org.token) });
  expect(msgRes.status()).toBe(200);
  const msgs = (await msgRes.json() as MessageList).data;
  expect(msgs.some(m => m.body === 'WF37-done-note')).toBe(true);
});

test('workflow 37: update_deal_stage action moves deal to target stage after deal_created', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-uds');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const stageB = pl.stages[1]!.id;

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'MoveStage37', trigger: 'deal_created', actions: [{ type: 'update_deal_stage', stage_id: stageB }] },
  });
  expect(wfRes.status()).toBe(201);

  const c = await createContact(request, org.token, 'StageTarget');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  const getRes = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(getRes.status()).toBe(200);
  const deal = (await getRes.json() as { data: { id: string; stage_id: string } }).data;
  expect(deal.stage_id).toBe(stageB);
});

test('workflow 37: create rejects update_deal_stage stage from another org', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf37-stage-org-a');
  const orgB = await registerOrg(request, 'wf37-stage-org-b');
  const plB = await getPipeline(request, orgB.token);

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: {
      name: 'CrossOrgStage37',
      trigger: 'deal_created',
      actions: [{ type: 'update_deal_stage', stage_id: plB.stages[0]!.id }],
    },
  });

  expect(wfRes.status()).toBe(400);
  const body = (await wfRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('INVALID_WORKFLOW_ACTION');
});

test('workflow 37: patch rejects update_deal_stage stage from another org', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf37-patch-stage-a');
  const orgB = await registerOrg(request, 'wf37-patch-stage-b');
  const plB = await getPipeline(request, orgB.token);

  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'PatchStage37', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'Valid task' }] },
  });
  expect(createRes.status()).toBe(201);
  const workflowId = ((await createRes.json()) as { data: { id: string } }).data.id;

  const patchRes = await request.patch(`/api/v1/workflows/${workflowId}`, {
    headers: authHeaders(orgA.token),
    data: { actions: [{ type: 'update_deal_stage', stage_id: plB.stages[0]!.id }] },
  });

  expect(patchRes.status()).toBe(400);
  const body = (await patchRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('INVALID_WORKFLOW_ACTION');
});

test('workflow 37: create rejects create_task assignee from another org', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf37-assignee-a');
  const orgB = await registerOrg(request, 'wf37-assignee-b');

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: {
      name: 'CrossOrgAssignee37',
      trigger: 'contact_created',
      actions: [{ type: 'create_task', title: 'Bad assignee', assigned_to: orgB.userId }],
    },
  });

  expect(wfRes.status()).toBe(400);
  const body = (await wfRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('INVALID_WORKFLOW_ACTION');
});

test('workflow 37: patch rejects create_task assignee from another org', async ({ request }) => {
  const orgA = await registerOrg(request, 'wf37-patch-assignee-a');
  const orgB = await registerOrg(request, 'wf37-patch-assignee-b');

  const createRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(orgA.token),
    data: { name: 'PatchAssignee37', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'Valid task' }] },
  });
  expect(createRes.status()).toBe(201);
  const workflowId = ((await createRes.json()) as { data: { id: string } }).data.id;

  const patchRes = await request.patch(`/api/v1/workflows/${workflowId}`, {
    headers: authHeaders(orgA.token),
    data: { actions: [{ type: 'create_task', title: 'Bad assignee', assigned_to: orgB.userId }] },
  });

  expect(patchRes.status()).toBe(400);
  const body = (await patchRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('INVALID_WORKFLOW_ACTION');
});

test('workflow 37: update_deal_stage execution rejects stage outside deal pipeline', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-stage-exec');
  const pl = await getPipeline(request, org.token);
  const originalStage = pl.stages[0]!.id;
  const otherPipeline = await createPipelineWithStage(request, org.token, 'Other');

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: {
      name: 'WrongPipelineStage37',
      trigger: 'deal_created',
      actions: [{ type: 'update_deal_stage', stage_id: otherPipeline.stageId }],
    },
  });
  expect(wfRes.status()).toBe(201);
  const workflowId = ((await wfRes.json()) as { data: { id: string } }).data.id;

  const contact = await createContact(request, org.token, 'WrongPipelineTarget');
  const deal = await createDeal(request, org.token, contact.id, pl.id, originalStage);

  const getRes = await request.get(`/api/v1/deals/${deal.id}`, { headers: authHeaders(org.token) });
  expect(getRes.status()).toBe(200);
  const storedDeal = (await getRes.json() as { data: { stage_id: string } }).data;
  expect(storedDeal.stage_id).toBe(originalStage);

  const runsRes = await request.get(`/api/v1/workflows/${workflowId}/runs`, { headers: authHeaders(org.token) });
  expect(runsRes.status()).toBe(200);
  const runs = (await runsRes.json() as WorkflowRunList).data;
  expect(runs[0]?.status).toBe('failed');
});

// ─── Group 2: WorkflowRun record ─────────────────────────────────────────────

test('workflow 37: GET /:id/runs shows success run after deal_stage_changed fires', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-runs');
  const pl = await getPipeline(request, org.token);
  const stageA = pl.stages[0]!.id;
  const stageB = pl.stages[1]!.id;
  const c = await createContact(request, org.token, 'RunTarget');
  const d = await createDeal(request, org.token, c.id, pl.id, stageA);

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'RunsWF37', trigger: 'deal_stage_changed', actions: [{ type: 'create_task', title: 'WF37-runs-task', due_in_days: 1 }] },
  });
  expect(wfRes.status()).toBe(201);
  const wfId = ((await wfRes.json()) as { data: { id: string } }).data.id;

  await request.patch(`/api/v1/deals/${d.id}/stage`, {
    headers: authHeaders(org.token),
    data: { stage_id: stageB },
  });

  const runsRes = await request.get(`/api/v1/workflows/${wfId}/runs`, { headers: authHeaders(org.token) });
  expect(runsRes.status()).toBe(200);
  const runsBody = await runsRes.json() as WorkflowRunList;
  expect(runsBody.data.length).toBeGreaterThan(0);
  expect(runsBody.data[0]!.status).toBe('success');
});

// ─── Group 3: Non-firing scenarios ───────────────────────────────────────────

test('workflow 37: paused workflow does not fire on contact_created', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-paused');

  await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'PausedWF37', trigger: 'contact_created', status: 'paused', actions: [{ type: 'create_task', title: 'WF37-paused-task', due_in_days: 1 }] },
  });

  const c = await createContact(request, org.token, 'PausedTarget');

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${c.id}`, { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = (await tasksRes.json() as TaskList).data;
  expect(tasks).toHaveLength(0);
});

test('workflow 37: archived workflow does not fire on contact_created', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-archno');

  const wfRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'ArchWF37', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'WF37-arch-task', due_in_days: 1 }] },
  });
  expect(wfRes.status()).toBe(201);
  const wfId = ((await wfRes.json()) as { data: { id: string } }).data.id;

  await request.delete(`/api/v1/workflows/${wfId}`, { headers: authHeaders(org.token) });

  const c = await createContact(request, org.token, 'ArchivedTarget');

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${c.id}`, { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = (await tasksRes.json() as TaskList).data;
  expect(tasks).toHaveLength(0);
});

test('workflow 37: condition non-match → workflow does NOT fire', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-cond-no');

  await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: {
      name: 'CondWF37',
      trigger: 'contact_created',
      conditions: [{ field: 'first_name', operator: 'equals', value: 'VIPOnly' }],
      actions: [{ type: 'create_task', title: 'WF37-cond-task', due_in_days: 1 }],
    },
  });

  const c = await createContact(request, org.token, 'NotVIP');

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${c.id}`, { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = (await tasksRes.json() as TaskList).data;
  expect(tasks).toHaveLength(0);
});

test('workflow 37: condition match → workflow fires', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-cond-yes');

  await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: {
      name: 'CondMatchWF37',
      trigger: 'contact_created',
      conditions: [{ field: 'first_name', operator: 'equals', value: 'VIPOnly' }],
      actions: [{ type: 'create_task', title: 'WF37-condmatch-task', due_in_days: 1 }],
    },
  });

  const c = await createContact(request, org.token, 'VIPOnly');

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${c.id}`, { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = (await tasksRes.json() as TaskList).data;
  expect(tasks.some(t => t.title === 'WF37-condmatch-task')).toBe(true);
});

// ─── Group 4: Filter and auth ─────────────────────────────────────────────────

test('workflow 37: GET /workflows?trigger=deal_stage_changed returns only that trigger type', async ({ request }) => {
  const org = await registerOrg(request, 'wf37-filter');

  await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'DSC-WF37', trigger: 'deal_stage_changed', actions: [{ type: 'create_task', title: 'T1', due_in_days: 1 }] },
  });
  await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'CC-WF37', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'T2', due_in_days: 1 }] },
  });

  const res = await request.get('/api/v1/workflows?trigger=deal_stage_changed', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: Array<{ trigger: string }> };
  expect(body.data.length).toBeGreaterThan(0);
  expect(body.data.every(w => w.trigger === 'deal_stage_changed')).toBe(true);
});

test('workflow 37: GET /:id/runs without auth → 401', async ({ request }) => {
  const r = await request.get('/api/v1/workflows/00000000-0000-0000-0000-000000000001/runs');
  expect(r.status()).toBe(401);
});
