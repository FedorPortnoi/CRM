import { test, expect, type APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };
type Stage = { id: string; name?: string };
type Pipeline = { id: string; name?: string; is_default?: boolean; stages: Stage[] };

test.describe.configure({ timeout: 30000 });

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const id = unique(suffix);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${id}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${id}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

async function createContact(request: APIRequestContext, token: string, firstName: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createTask(
  request: APIRequestContext,
  token: string,
  userId: string,
  title: string,
): Promise<{ id: string }> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(token),
    data: { title, assigned_to: userId },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createEvent(request: APIRequestContext, token: string, title: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/calendar', {
    headers: authHeaders(token),
    data: {
      title,
      start_time: futureIso(60 * 60 * 1000),
      end_time: futureIso(2 * 60 * 60 * 1000),
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function getDefaultPipeline(request: APIRequestContext, token: string): Promise<Pipeline> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  const pipelines = ((await res.json()) as { data: Pipeline[] }).data;
  const pipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];
  expect(pipeline).toBeTruthy();
  if (pipeline.stages[0]) return pipeline;

  const stage = await createStage(request, token, pipeline.id, 'Default Smoke Stage');
  return { ...pipeline, stages: [stage] };
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  title: string,
  contactId: string,
  pipelineId: string,
  stageId: string,
): Promise<{ id: string }> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title, contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, currency: 'USD' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createPipeline(request: APIRequestContext, token: string, name: string): Promise<Pipeline> {
  const res = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
    data: { name },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: Pipeline }).data;
}

async function createStage(
  request: APIRequestContext,
  token: string,
  pipelineId: string,
  name: string,
): Promise<Stage> {
  const res = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: authHeaders(token),
    data: { name, position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: Stage }).data;
}

function expectBlocked(status: number): void {
  expect([403, 404]).toContain(status);
}

test('tenant isolation: cross-org contact update and delete are blocked', async ({ request }) => {
  const orgA = await registerOrg(request, 'tenant-contact-a');
  const orgB = await registerOrg(request, 'tenant-contact-b');
  const contact = await createContact(request, orgA.token, 'TenantContactA');

  const patch = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: authHeaders(orgB.token),
    data: { first_name: 'TenantContactB' },
  });
  expectBlocked(patch.status());

  const del = await request.delete(`/api/v1/contacts/${contact.id}`, {
    headers: authHeaders(orgB.token),
  });
  expectBlocked(del.status());

  const check = await request.get(`/api/v1/contacts/${contact.id}`, { headers: authHeaders(orgA.token) });
  expect(check.status()).toBe(200);
  const body = await check.json() as { data: { first_name: string; status: string } };
  expect(body.data.first_name).toBe('TenantContactA');
  expect(body.data.status).toBe('active');
});

test('tenant isolation: cross-org task update and delete are blocked', async ({ request }) => {
  const orgA = await registerOrg(request, 'tenant-task-a');
  const orgB = await registerOrg(request, 'tenant-task-b');
  const task = await createTask(request, orgA.token, orgA.userId, 'TenantTaskA');

  const patch = await request.patch(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(orgB.token),
    data: { title: 'TenantTaskB' },
  });
  expectBlocked(patch.status());

  const del = await request.delete(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(orgB.token),
  });
  expectBlocked(del.status());

  const check = await request.get(`/api/v1/tasks/${task.id}`, { headers: authHeaders(orgA.token) });
  expect(check.status()).toBe(200);
  const body = await check.json() as { data: { title: string; status: string } };
  expect(body.data.title).toBe('TenantTaskA');
  expect(body.data.status).toBe('pending');
});

test('tenant isolation: cross-org calendar update and delete are blocked', async ({ request }) => {
  const orgA = await registerOrg(request, 'tenant-calendar-a');
  const orgB = await registerOrg(request, 'tenant-calendar-b');
  const event = await createEvent(request, orgA.token, 'TenantEventA');

  const patch = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(orgB.token),
    data: { location: 'Other Org Room' },
  });
  expectBlocked(patch.status());

  const del = await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(orgB.token),
  });
  expectBlocked(del.status());

  const check = await request.get(`/api/v1/calendar/${event.id}`, { headers: authHeaders(orgA.token) });
  expect(check.status()).toBe(200);
  const body = await check.json() as { data: { title: string; status: string; location: string | null } };
  expect(body.data.title).toBe('TenantEventA');
  expect(body.data.status).toBe('scheduled');
  expect(body.data.location).not.toBe('Other Org Room');
});

test('tenant isolation: cross-org deal update and delete are blocked', async ({ request }) => {
  const orgA = await registerOrg(request, 'tenant-deal-a');
  const orgB = await registerOrg(request, 'tenant-deal-b');
  const contact = await createContact(request, orgA.token, 'TenantDealContact');
  const pipeline = await getDefaultPipeline(request, orgA.token);
  const deal = await createDeal(request, orgA.token, 'TenantDealA', contact.id, pipeline.id, pipeline.stages[0].id);

  const patch = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(orgB.token),
    data: { title: 'TenantDealB' },
  });
  expectBlocked(patch.status());

  const del = await request.delete(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(orgB.token),
  });
  expectBlocked(del.status());

  const check = await request.get(`/api/v1/deals/${deal.id}`, { headers: authHeaders(orgA.token) });
  expect(check.status()).toBe(200);
  const body = await check.json() as { data: { title: string; status: string } };
  expect(body.data.title).toBe('TenantDealA');
  expect(body.data.status).toBe('open');
});

test('tenant isolation: cross-org pipeline and stage mutations are blocked', async ({ request }) => {
  const orgA = await registerOrg(request, 'tenant-pipeline-a');
  const orgB = await registerOrg(request, 'tenant-pipeline-b');
  const pipeline = await createPipeline(request, orgA.token, 'TenantPipelineA');
  const stage = await createStage(request, orgA.token, pipeline.id, 'TenantStageA');

  const patchPipeline = await request.patch(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: authHeaders(orgB.token),
    data: { name: 'TenantPipelineB' },
  });
  expectBlocked(patchPipeline.status());

  const deletePipeline = await request.delete(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: authHeaders(orgB.token),
  });
  expectBlocked(deletePipeline.status());

  const patchStage = await request.patch(`/api/v1/deals/stages/${stage.id}`, {
    headers: authHeaders(orgB.token),
    data: { name: 'TenantStageB' },
  });
  expectBlocked(patchStage.status());

  const deleteStage = await request.delete(`/api/v1/deals/stages/${stage.id}`, {
    headers: authHeaders(orgB.token),
  });
  expectBlocked(deleteStage.status());

  const pipelineCheck = await request.get(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: authHeaders(orgA.token),
  });
  expect(pipelineCheck.status()).toBe(200);
  const pipelineBody = await pipelineCheck.json() as { data: { name: string } };
  expect(pipelineBody.data.name).toBe('TenantPipelineA');

  const stagesCheck = await request.get(`/api/v1/deals/pipelines/${pipeline.id}/stages`, {
    headers: authHeaders(orgA.token),
  });
  expect(stagesCheck.status()).toBe(200);
  const stagesBody = await stagesCheck.json() as { data: Array<{ id: string; name: string }> };
  const originalStage = stagesBody.data.find((item) => item.id === stage.id);
  expect(originalStage?.name).toBe('TenantStageA');
});

test('tenant isolation: onboarding state updates stay in the authenticated org', async ({ request }) => {
  const orgA = await registerOrg(request, 'tenant-onboarding-a');
  const orgB = await registerOrg(request, 'tenant-onboarding-b');

  const updateA = await request.patch('/api/v1/onboarding', {
    headers: authHeaders(orgA.token),
    data: { completed_steps: ['org-a-step'] },
  });
  expect(updateA.status()).toBe(200);

  const updateB = await request.patch('/api/v1/onboarding', {
    headers: authHeaders(orgB.token),
    data: { completed_steps: ['org-b-step'] },
  });
  expect(updateB.status()).toBe(200);

  const checkA = await request.get('/api/v1/onboarding', { headers: authHeaders(orgA.token) });
  expect(checkA.status()).toBe(200);
  const bodyA = await checkA.json() as { data: { completed_steps: string[] } };
  expect(bodyA.data.completed_steps).toEqual(['org-a-step']);

  const checkB = await request.get('/api/v1/onboarding', { headers: authHeaders(orgB.token) });
  expect(checkB.status()).toBe(200);
  const bodyB = await checkB.json() as { data: { completed_steps: string[] } };
  expect(bodyB.data.completed_steps).toEqual(['org-b-step']);
});
