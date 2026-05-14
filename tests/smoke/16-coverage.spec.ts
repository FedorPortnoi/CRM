import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

interface PipelineStage {
  id: string;
  name: string;
  position: number;
}

interface Pipeline {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStage[];
}

async function getPipelineAndStage(
  request: APIRequestContext,
  token: string
): Promise<{ pipelineId: string; stageId: string }> {
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { data: Pipeline[]; meta: Record<string, unknown> };
  const found = body.data.find((p: Pipeline) => p.stages.length > 0);
  if (found) {
    return { pipelineId: found.id, stageId: found.stages[0].id };
  }
  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `Auto Pipeline ${Date.now()}` },
  });
  const plBody = (await plRes.json()) as { data: { id: string } };
  const pipelineId = plBody.data.id;
  const stRes = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Auto Stage', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  const stBody = (await stRes.json()) as { data: { id: string } };
  return { pipelineId, stageId: stBody.data.id };
}

async function createContact(
  request: APIRequestContext,
  token: string
): Promise<string> {
  const email = `smoke-${Date.now()}-${Math.floor(Math.random() * 10000)}@test.com`;
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Smoke', email },
  });
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

async function registerOrg(
  request: APIRequestContext,
  suffix: string
): Promise<{ token: string; userId: string }> {
  const ts = Date.now().toString() + Math.random().toString(36).slice(2);
  const email = `org16-${suffix}-${ts}@example.com`;
  const res = await request.post('/api/v1/auth/', {
    data: { email, password: 'Password123!', name: 'User ' + suffix, org_name: 'Org16 ' + suffix + ' ' + ts },
  });
  const body = (await res.json()) as { data: { user: { id: string }; token: string } };
  return { token: body.data.token, userId: body.data.user.id };
}

test('POST /contacts without first_name returns 400', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(res.status()).toBe(400);
});

test('POST /contacts with empty string first_name returns 400', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: '' },
  });
  expect(res.status()).toBe(400);
});

test('POST /contacts with invalid email format returns 400', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Valid', email: 'not-an-email' },
  });
  expect(res.status()).toBe(400);
});

test('POST /deals without title returns 400', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  expect(res.status()).toBe(400);
});

test('POST /deals with negative value returns 400', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Negative Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: -5 },
  });
  expect(res.status()).toBe(400);
});

test('POST /deals with value=0 returns 201 (zero is valid boundary)', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Zero Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 0 },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  expect(typeof body.data.id).toBe('string');
});

test('POST /deals with stage from different pipeline returns 400 STAGE_PIPELINE_MISMATCH', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId } = await getPipelineAndStage(request, token);
  const pl2Res = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `Pipeline B ${Date.now()}` },
  });
  const pl2Body = (await pl2Res.json()) as { data: { id: string } };
  const newPipelineId = pl2Body.data.id;
  const st2Res = await request.post(`/api/v1/deals/pipelines/${newPipelineId}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Stage B', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  const st2Body = (await st2Res.json()) as { data: { id: string } };
  const newStageId = st2Body.data.id;
  const contactId = await createContact(request, token);
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Mismatch Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: newStageId },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('STAGE_PIPELINE_MISMATCH');
});

test('PATCH archived contact returns 404 NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const contactId = await createContact(request, token);
  await request.delete(`/api/v1/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const res = await request.patch(`/api/v1/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Updated' },
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('NOT_FOUND');
});

test('GET /contacts?status=archived returns only archived contacts', async ({ request }) => {
  const { token } = getAuth();
  const activeId = await createContact(request, token);
  const archivedId = await createContact(request, token);
  await request.delete(`/api/v1/contacts/${archivedId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const res = await request.get('/api/v1/contacts?status=archived', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: Array<{ id: string; status: string }> };
  for (const c of body.data) {
    expect(c.status).toBe('archived');
  }
  const ids = body.data.map((c: { id: string; status: string }) => c.id);
  expect(ids).toContain(archivedId);
  expect(ids).not.toContain(activeId);
});

test('POST /tasks with past due_date returns 201 (no future-date validation)', async ({ request }) => {
  const { token, userId } = getAuth();
  const res = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Past Task', assigned_to: userId, due_date: '2020-01-01T00:00:00.000Z' },
  });
  expect(res.status()).toBe(201);
});

test('PATCH done task returns 200 with updated title — done tasks are updatable unlike cancelled', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Task to Complete', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const taskId = createBody.data.id;
  // Mark as done via the /complete toggle endpoint
  const completeRes = await request.post(`/api/v1/tasks/${taskId}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(completeRes.status()).toBe(200);
  const completeBody = (await completeRes.json()) as { data: { status: string } };
  expect(completeBody.data.status).toBe('done');
  // PATCH the done task → should succeed (200), unlike cancelled tasks which return 422
  const updateRes = await request.patch(`/api/v1/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Updated Title' },
  });
  expect(updateRes.status()).toBe(200);
  const updateBody = (await updateRes.json()) as { data: { id: string; title: string } };
  expect(updateBody.data.title).toBe('Updated Title');
});

test('GET /tasks?contact_id returns only tasks for that contact', async ({ request }) => {
  const { token, userId } = getAuth();
  const contactAId = await createContact(request, token);
  const contactBId = await createContact(request, token);
  const taskARes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Task A', assigned_to: userId, contact_id: contactAId },
  });
  expect(taskARes.status()).toBe(201);
  const taskABody = (await taskARes.json()) as { data: { id: string } };
  const taskAId = taskABody.data.id;
  const taskBRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Task B', assigned_to: userId, contact_id: contactBId },
  });
  expect(taskBRes.status()).toBe(201);
  const taskBBody = (await taskBRes.json()) as { data: { id: string } };
  const taskBId = taskBBody.data.id;
  const filterRes = await request.get(`/api/v1/tasks?contact_id=${contactAId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(filterRes.status()).toBe(200);
  const filterBody = (await filterRes.json()) as { data: Array<{ id: string; contact_id: string }> };
  for (const t of filterBody.data) {
    expect(t.contact_id).toBe(contactAId);
  }
  const taskIds = filterBody.data.map((t: { id: string; contact_id: string }) => t.id);
  expect(taskIds).toContain(taskAId);
  expect(taskIds).not.toContain(taskBId);
});
