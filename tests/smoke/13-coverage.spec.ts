import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

interface Task { id: string; status: string; due_date: string | null }
interface ActivityItem { type: string; id: string; summary: string; created_at: string }
interface PipelineStage { id: string; position: number }
interface Pipeline { id: string; is_default: boolean; stages: PipelineStage[] }

function todayNoonUTC(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

function futureTime(hours: number): string {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

async function getPipelineAndStage(
  request: APIRequestContext,
  token: string
): Promise<{ pipelineId: string; stageId: string; stages: PipelineStage[] }> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  const pipelines: Pipeline[] = body.data;
  const def = pipelines.find((p) => p.is_default === true);
  if (!def) throw new Error('No default pipeline found');
  return { pipelineId: def.id, stageId: def.stages[0].id, stages: def.stages };
}
test('contact merge re-points calendarEvent.contact_id to target — meeting appears in target activity feed', async ({ request }) => {
  const email = 'merge-cal-' + Date.now() + '@test.com';
  const regRes = await request.post('/api/v1/auth/', { data: { email, password: 'Test1234!', name: 'MergeCal', org_name: 'MergeCal Org' } });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const sourceRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + freshToken }, data: { first_name: 'CalSource' } });
  const targetRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + freshToken }, data: { first_name: 'CalTarget' } });
  const sourceId: string = (await sourceRes.json()).data.id;
  const targetId: string = (await targetRes.json()).data.id;

  const startTime = futureTime(1);
  const endTime = futureTime(2);
  const calRes = await request.post('/api/v1/calendar', { headers: { Authorization: 'Bearer ' + freshToken }, data: { title: 'CalMergeEvent', start_time: startTime, end_time: endTime, contact_id: sourceId } });
  expect(calRes.status()).toBe(201);

  const mergeRes = await request.post('/api/v1/contacts/' + targetId + '/merge', { headers: { Authorization: 'Bearer ' + freshToken }, data: { source_id: sourceId } });
  expect(mergeRes.status()).toBe(200);

  const actRes = await request.get('/api/v1/contacts/' + targetId + '/activity', { headers: { Authorization: 'Bearer ' + freshToken } });
  expect(actRes.status()).toBe(200);
  const actBody = await actRes.json();
  const items: ActivityItem[] = actBody.data.items;
  const meetingItems = items.filter((i) => i.type === 'meeting');
  expect(meetingItems.length).toBeGreaterThanOrEqual(1);
  expect(meetingItems.some((i) => i.summary === 'CalMergeEvent')).toBe(true);
});

test('cancelled task due today is absent from GET /api/v1/tasks/today', async ({ request }) => {
  const email = 'cancel-today-' + Date.now() + '@test.com';
  const regRes = await request.post('/api/v1/auth/', { data: { email, password: 'Test1234!', name: 'CancelToday', org_name: 'CancelToday Org' } });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + freshToken }, data: { title: 'Cancel Today Task', assigned_to: userId, due_date: todayNoonUTC() } });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const cancelRes = await request.delete('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + freshToken } });
  expect(cancelRes.status()).toBe(200);
  expect((await cancelRes.json()).data.status).toBe('cancelled');

  const todayRes = await request.get('/api/v1/tasks/today', { headers: { Authorization: 'Bearer ' + freshToken } });
  expect(todayRes.status()).toBe(200);
  const ids = ((await todayRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).not.toContain(taskId);
});

test('GET /api/v1/contacts/:id/tasks excludes cancelled task linked to that contact', async ({ request }) => {
  const email = 'contact-cancel-' + Date.now() + '@test.com';
  const regRes = await request.post('/api/v1/auth/', { data: { email, password: 'Test1234!', name: 'ContactCancel', org_name: 'ContactCancel Org' } });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const contactRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + freshToken }, data: { first_name: 'TaskedContact' } });
  const contactId: string = (await contactRes.json()).data.id;

  const taskRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + freshToken }, data: { title: 'Linked Task to Cancel', assigned_to: userId, contact_id: contactId } });
  const taskId: string = (await taskRes.json()).data.id;

  await request.delete('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + freshToken } });

  const subRes = await request.get('/api/v1/contacts/' + contactId + '/tasks', { headers: { Authorization: 'Bearer ' + freshToken } });
  expect(subRes.status()).toBe(200);
  const taskIds = ((await subRes.json()).data as Task[]).map((t) => t.id);
  expect(taskIds).not.toContain(taskId);
});
test('POST /api/v1/tasks/:id/start moves pending task to in_progress status', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Start Me Task', assigned_to: userId } });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const startRes = await request.post('/api/v1/tasks/' + taskId + '/start', { headers: { Authorization: 'Bearer ' + token } });
  expect(startRes.status()).toBe(200);
  const body = await startRes.json();
  expect(body.data.status).toBe('in_progress');
});

test('POST /api/v1/tasks/:id/start on already in_progress task returns 422 INVALID_STATUS_TRANSITION', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Double Start Task', assigned_to: userId } });
  const taskId: string = (await createRes.json()).data.id;

  await request.post('/api/v1/tasks/' + taskId + '/start', { headers: { Authorization: 'Bearer ' + token } });
  const res = await request.post('/api/v1/tasks/' + taskId + '/start', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_STATUS_TRANSITION');
  expect(typeof body.error.message).toBe('string');
});

test('POST /api/v1/tasks/:id/complete on cancelled task returns 422 TASK_CANCELLED', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Cancel Then Complete', assigned_to: userId } });
  const taskId: string = (await createRes.json()).data.id;

  await request.delete('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + token } });

  const res = await request.post('/api/v1/tasks/' + taskId + '/complete', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('TASK_CANCELLED');
});

test('POST /api/v1/tasks/:id/complete called twice toggles done task back to pending with completed_at null', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Toggle Complete Task', assigned_to: userId } });
  const taskId: string = (await createRes.json()).data.id;

  const first = await request.post('/api/v1/tasks/' + taskId + '/complete', { headers: { Authorization: 'Bearer ' + token } });
  expect(first.status()).toBe(200);
  expect((await first.json()).data.status).toBe('done');

  const second = await request.post('/api/v1/tasks/' + taskId + '/complete', { headers: { Authorization: 'Bearer ' + token } });
  expect(second.status()).toBe(200);
  const body = await second.json();
  expect(body.data.status).toBe('pending');
  expect(body.data.completed_at).toBeNull();
});

test('PATCH /api/v1/tasks/:id on cancelled task returns 422 TASK_CANCELLED', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Cancel Then Update', assigned_to: userId } });
  const taskId: string = (await createRes.json()).data.id;

  await request.delete('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + token } });

  const res = await request.patch('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + token }, data: { title: 'New Title' } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('TASK_CANCELLED');
});
test('POST /api/v1/deals/:id/won on already-won deal returns 422 DEAL_ALREADY_WON', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + token }, data: { first_name: 'WonContact' } });
  const contactId: string = (await contactRes.json()).data.id;
  const dealRes = await request.post('/api/v1/deals', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Win Twice Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId } });
  const dealId: string = (await dealRes.json()).data.id;

  await request.post('/api/v1/deals/' + dealId + '/won', { headers: { Authorization: 'Bearer ' + token }, data: {} });
  const res = await request.post('/api/v1/deals/' + dealId + '/won', { headers: { Authorization: 'Bearer ' + token }, data: {} });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('DEAL_ALREADY_WON');
});
test('POST /api/v1/deals/:id/lost on already-lost deal returns 422 DEAL_ALREADY_LOST', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + token }, data: { first_name: 'LostContact' } });
  const contactId: string = (await contactRes.json()).data.id;
  const dealRes = await request.post('/api/v1/deals', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Lose Twice Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId } });
  const dealId: string = (await dealRes.json()).data.id;

  await request.post('/api/v1/deals/' + dealId + '/lost', { headers: { Authorization: 'Bearer ' + token }, data: { reason: 'First loss' } });
  const res = await request.post('/api/v1/deals/' + dealId + '/lost', { headers: { Authorization: 'Bearer ' + token }, data: { reason: 'Second loss' } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('DEAL_ALREADY_LOST');
});
test('DELETE /api/v1/deals/:id on already-archived deal returns 422 DEAL_ALREADY_ARCHIVED', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + token }, data: { first_name: 'ArchiveContact' } });
  const contactId: string = (await contactRes.json()).data.id;
  const dealRes = await request.post('/api/v1/deals', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Archive Twice Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId } });
  const dealId: string = (await dealRes.json()).data.id;

  await request.delete('/api/v1/deals/' + dealId, { headers: { Authorization: 'Bearer ' + token } });
  const res = await request.delete('/api/v1/deals/' + dealId, { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('DEAL_ALREADY_ARCHIVED');
});
test('PATCH /api/v1/deals/:id/stage on won deal returns 422 DEAL_NOT_OPEN', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + token }, data: { first_name: 'WonStageContact' } });
  const contactId: string = (await contactRes.json()).data.id;
  const dealRes = await request.post('/api/v1/deals', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Won Stage Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId } });
  const dealId: string = (await dealRes.json()).data.id;

  await request.post('/api/v1/deals/' + dealId + '/won', { headers: { Authorization: 'Bearer ' + token }, data: {} });

  const res = await request.patch('/api/v1/deals/' + dealId + '/stage', { headers: { Authorization: 'Bearer ' + token }, data: { stage_id: stageId } });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('DEAL_NOT_OPEN');
});
test('DELETE /api/v1/deals/pipelines/:id returns 409 PIPELINE_HAS_OPEN_DEALS when pipeline contains open deals', async ({ request }) => {
  const { token } = getAuth();

  const plRes = await request.post('/api/v1/deals/pipelines', { headers: { Authorization: 'Bearer ' + token }, data: { name: 'Delete Test Pipeline', is_default: false } });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', { headers: { Authorization: 'Bearer ' + token }, data: { name: 'Stage A', position: 0, is_won_stage: false, is_lost_stage: false } });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const cRes = await request.post('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + token }, data: { first_name: 'PipelineDeleteContact' } });
  const contactId: string = (await cRes.json()).data.id;
  const dRes = await request.post('/api/v1/deals', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Blocking Deal', contact_id: contactId, pipeline_id: plId, stage_id: stId } });
  expect(dRes.status()).toBe(201);

  const res = await request.delete('/api/v1/deals/pipelines/' + plId, { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe('PIPELINE_HAS_OPEN_DEALS');
  expect(typeof body.error.message).toBe('string');
});
test('malformed Bearer token (non-JWT string) on protected endpoint returns 401 with @fastify/jwt error shape', async ({ request }) => {
  const res = await request.get('/api/v1/contacts', { headers: { Authorization: 'Bearer not-a-real-jwt' } });
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect((body.message as string).length).toBeGreaterThan(0);
});

async function registerOrg(request: APIRequestContext, suffix = '') {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}${suffix}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  const body = await res.json();
  return { token: body.data.token, userId: body.data.user.id };
}

test('POST /api/v1/tasks/:id/cancel on done task succeeds and sets status=cancelled (no done guard)', async ({ request }) => {
  const { token, userId } = await registerOrg(request, 'cancelDone');
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Cancel Done Task', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const completeRes = await request.post('/api/v1/tasks/' + taskId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(completeRes.status()).toBe(200);
  expect((await completeRes.json()).data.status).toBe('done');

  const cancelRes = await request.delete('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(cancelRes.status()).toBe(200);
  expect((await cancelRes.json()).data.status).toBe('cancelled');
});

test('cancelled task GET readback shows status=cancelled', async ({ request }) => {
  const { token, userId } = await registerOrg(request, 'cancelRead');
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Readback Cancel Task', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  await request.delete('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + token } });

  const getRes = await request.get('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(getRes.status()).toBe(200);
  const body = await getRes.json();
  expect(body.data.status).toBe('cancelled');
});

test('POST /api/v1/tasks/:id/complete on in_progress task succeeds and sets status=done', async ({ request }) => {
  const { token, userId } = await registerOrg(request, 'completeInProg');
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'In Progress Complete Task', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const startRes = await request.post('/api/v1/tasks/' + taskId + '/start', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(startRes.status()).toBe(200);
  expect((await startRes.json()).data.status).toBe('in_progress');

  const completeRes = await request.post('/api/v1/tasks/' + taskId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(completeRes.status()).toBe(200);
  const body = await completeRes.json();
  expect(body.data.status).toBe('done');
  expect(typeof body.data.completed_at).toBe('string');
});

test('task created with priority=high reads back with priority=high', async ({ request }) => {
  const { token, userId } = await registerOrg(request, 'priority');
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'High Priority Task', assigned_to: userId, priority: 'high' },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()).data;
  expect(created.priority).toBe('high');

  const getRes = await request.get('/api/v1/tasks/' + created.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).data.priority).toBe('high');
});

test('POST /api/v1/calendar creates event and GET readback confirms all fields', async ({ request }) => {
  const { token } = await registerOrg(request, 'calCreate');
  const start = futureTime(2);
  const end = futureTime(3);
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Readback Event', start_time: start, end_time: end },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()).data;
  expect(created.id).toBeTruthy();

  const getRes = await request.get('/api/v1/calendar/' + created.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(getRes.status()).toBe(200);
  const body = await getRes.json();
  expect(body.data.title).toBe('Readback Event');
  expect(body.data.start_time).toBeTruthy();
  expect(body.data.end_time).toBeTruthy();
  expect(body.data.id).toBe(created.id);
});

test('PATCH /api/v1/calendar/:id updates title and readback confirms new value', async ({ request }) => {
  const { token } = await registerOrg(request, 'calPatch');
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Original Title', start_time: futureTime(1), end_time: futureTime(2) },
  });
  expect(createRes.status()).toBe(201);
  const eventId: string = (await createRes.json()).data.id;

  const patchRes = await request.patch('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Updated Title' },
  });
  expect(patchRes.status()).toBe(200);

  const getRes = await request.get('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).data.title).toBe('Updated Title');
});

test('DELETE /api/v1/calendar/:id cancels event and readback shows status=cancelled', async ({ request }) => {
  const { token } = await registerOrg(request, 'calDelete');
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'To Be Cancelled', start_time: futureTime(1), end_time: futureTime(2) },
  });
  expect(createRes.status()).toBe(201);
  const eventId: string = (await createRes.json()).data.id;

  const delRes = await request.delete('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(delRes.status()).toBe(200);

  const getRes = await request.get('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).data.status).toBe('cancelled');
});

test('POST /api/v1/messages/in-app creates in-app message and GET /messages?contact_id= returns it', async ({ request }) => {
  const { token } = await registerOrg(request, 'msgInApp');
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'MsgContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId: string = (await contactRes.json()).data.id;

  const sendRes = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: 'Bearer ' + token },
    data: { contact_id: contactId, body: 'Hello in-app' },
  });
  expect(sendRes.status()).toBe(201);
  const msgId: string = (await sendRes.json()).data.id;

  const listRes = await request.get('/api/v1/messages', {
    headers: { Authorization: 'Bearer ' + token },
    params: { contact_id: contactId },
  });
  expect(listRes.status()).toBe(200);
  const messages = (await listRes.json()).data as { id: string }[];
  expect(messages.some((m) => m.id === msgId)).toBe(true);
});

test('POST /api/v1/messages/call creates a call log entry for the contact', async ({ request }) => {
  const { token } = await registerOrg(request, 'msgCall');
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'CallContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId: string = (await contactRes.json()).data.id;

  const logRes = await request.post('/api/v1/messages/call', {
    headers: { Authorization: 'Bearer ' + token },
    data: { contact_id: contactId, direction: 'outbound', duration_seconds: 120, notes: 'Discussed proposal' },
  });
  expect(logRes.status()).toBe(201);
  const body = await logRes.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.contact_id).toBe(contactId);
});

test('GET /api/v1/analytics/funnel returns data with stages array', async ({ request }) => {
  const { token } = await registerOrg(request, 'funnel');

  const res = await request.get('/api/v1/analytics/funnel', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toBeDefined();
  expect(Array.isArray(body.data.stages)).toBe(true);
  expect(body.meta).toBeDefined();
});

test('GET /api/v1/contacts?assigned_to=<userId> returns only contacts assigned to that user', async ({ request }) => {
  const { token, userId } = await registerOrg(request, 'assignedContacts');

  await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'AssignedA', assigned_to: userId },
  });
  await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'AssignedB', assigned_to: userId },
  });
  await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'Unassigned' },
  });

  const res = await request.get('/api/v1/contacts?assigned_to=' + userId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const contacts = (await res.json()).data as { assigned_to: string | null }[];
  expect(contacts.length).toBeGreaterThanOrEqual(2);
  expect(contacts.every((c) => c.assigned_to === userId)).toBe(true);
});

test('GET /api/v1/deals?assigned_to=<userId> returns only deals assigned to that user', async ({ request }) => {
  const { token, userId } = await registerOrg(request, 'assignedDeals');
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'DealOwner' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Assigned Deal 1', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, assigned_to: userId },
  });
  await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Assigned Deal 2', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, assigned_to: userId },
  });
  await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Unassigned Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });

  const res = await request.get('/api/v1/deals?assigned_to=' + userId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const deals = (await res.json()).data as { assigned_to: string | null }[];
  expect(deals.length).toBeGreaterThanOrEqual(2);
  expect(deals.every((d) => d.assigned_to === userId)).toBe(true);
});
