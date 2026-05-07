import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

interface CalendarEvent {
  id: string;
  status: string;
  completed_at: string | null;
  notes: string | null;
}

interface Message {
  id: string;
  status: string;
  read_at: string | null;
}

interface TaskDetail {
  id: string;
  assignee: { id: string; name: string };
  contact: { id: string; first_name: string; last_name: string | null } | null;
}

interface PipelineStage {
  id: string;
  position: number;
}

interface Pipeline {
  id: string;
  is_default: boolean;
  stages: PipelineStage[];
}

function futureTime(hours: number): string {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

async function getPipelineAndStage(
  request: APIRequestContext,
  token: string,
): Promise<{ pipelineId: string; stageId: string }> {
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = await res.json();
  const pipelines: Pipeline[] = body.data;
  const def = pipelines.find((p) => p.is_default === true);
  if (!def) throw new Error('No default pipeline found');
  return { pipelineId: def.id, stageId: def.stages[0].id };
}

// ─── GET /tasks/:id — new assignee + contact shape ───────────────────────────

test('GET /api/v1/tasks/:id response includes assignee.id and assignee.name', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Assignee Shape Task', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const res = await request.get('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const task: TaskDetail = body.data;
  expect(typeof task.assignee.id).toBe('string');
  expect(task.assignee.id.length).toBeGreaterThan(0);
  expect(typeof task.assignee.name).toBe('string');
  expect(task.assignee.name.length).toBeGreaterThan(0);
});

test('GET /api/v1/tasks/:id includes non-null contact object when task has contact linked', async ({ request }) => {
  const { token, userId } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'ShapeContact' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Contact Shape Task', assigned_to: userId, contact_id: contactId },
  });
  const taskId: string = (await createRes.json()).data.id;

  const res = await request.get('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const task: TaskDetail = body.data;
  expect(task.contact).not.toBeNull();
  expect(task.contact!.id).toBe(contactId);
  expect(typeof task.contact!.first_name).toBe('string');
});

test('GET /api/v1/tasks/:id contact field is null when no contact linked', async ({ request }) => {
  const { token, userId } = getAuth();
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'No Contact Task', assigned_to: userId },
  });
  const taskId: string = (await createRes.json()).data.id;

  const res = await request.get('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.contact).toBeNull();
});

test('GET /api/v1/tasks/:id with non-existent id returns 404 TASK_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/tasks/00000000-0000-0000-0000-000000000000', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('TASK_NOT_FOUND');
  expect(typeof body.error.message).toBe('string');
});

// ─── Cross-org isolation (Rung 5) ─────────────────────────────────────────────

test('cross-org isolation: Org B token cannot access Org A contact — returns 404', async ({ request }) => {
  const emailA = 'org-a-contact-' + Date.now() + '@test.com';
  const emailB = 'org-b-contact-' + (Date.now() + 1) + '@test.com';

  const regA = await request.post('/api/v1/auth/', {
    data: { email: emailA, password: 'Test1234!', name: 'OrgA User', org_name: 'OrgA' },
  });
  expect(regA.status()).toBe(201);
  const tokenA: string = (await regA.json()).data.token;

  const regB = await request.post('/api/v1/auth/', {
    data: { email: emailB, password: 'Test1234!', name: 'OrgB User', org_name: 'OrgB' },
  });
  expect(regB.status()).toBe(201);
  const tokenB: string = (await regB.json()).data.token;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + tokenA },
    data: { first_name: 'OrgA Contact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId: string = (await contactRes.json()).data.id;

  const res = await request.get('/api/v1/contacts/' + contactId, {
    headers: { Authorization: 'Bearer ' + tokenB },
  });
  expect(res.status()).toBe(404);
});

test('cross-org isolation: Org B token cannot access Org A task — returns 404', async ({ request }) => {
  const emailA = 'org-a-task-' + Date.now() + '@test.com';
  const emailB = 'org-b-task-' + (Date.now() + 1) + '@test.com';

  const regA = await request.post('/api/v1/auth/', {
    data: { email: emailA, password: 'Test1234!', name: 'OrgA User', org_name: 'OrgA' },
  });
  expect(regA.status()).toBe(201);
  const regBodyA = await regA.json();
  const tokenA: string = regBodyA.data.token;
  const userIdA: string = regBodyA.data.user.id;

  const regB = await request.post('/api/v1/auth/', {
    data: { email: emailB, password: 'Test1234!', name: 'OrgB User', org_name: 'OrgB' },
  });
  expect(regB.status()).toBe(201);
  const tokenB: string = (await regB.json()).data.token;

  const taskRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + tokenA },
    data: { title: 'OrgA Task', assigned_to: userIdA },
  });
  expect(taskRes.status()).toBe(201);
  const taskId: string = (await taskRes.json()).data.id;

  const res = await request.get('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + tokenB },
  });
  expect(res.status()).toBe(404);
});

// ─── POST /calendar/:id/complete (markCompleted) ──────────────────────────────

test('POST /api/v1/calendar/:id/complete marks scheduled event as completed with completed_at set', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Complete Event', start_time: futureTime(1), end_time: futureTime(2) },
  });
  expect(eventRes.status()).toBe(201);
  const eventId: string = (await eventRes.json()).data.id;

  const res = await request.post('/api/v1/calendar/' + eventId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const event: CalendarEvent = body.data;
  expect(event.status).toBe('completed');
  expect(event.completed_at).not.toBeNull();
});

test('POST /api/v1/calendar/:id/complete called twice toggles event back to scheduled with completed_at null', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Toggle Complete Event', start_time: futureTime(1), end_time: futureTime(2) },
  });
  const eventId: string = (await eventRes.json()).data.id;

  await request.post('/api/v1/calendar/' + eventId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });

  const second = await request.post('/api/v1/calendar/' + eventId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(second.status()).toBe(200);
  const body = await second.json();
  const event: CalendarEvent = body.data;
  expect(event.status).toBe('scheduled');
  expect(event.completed_at).toBeNull();
});

test('POST /api/v1/calendar/:id/complete on cancelled event returns 422 EVENT_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Cancel Then Complete', start_time: futureTime(1), end_time: futureTime(2) },
  });
  const eventId: string = (await eventRes.json()).data.id;

  await request.delete('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });

  const res = await request.post('/api/v1/calendar/' + eventId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('EVENT_CANCELLED');
});

// ─── Calendar error cases ─────────────────────────────────────────────────────

test('DELETE /api/v1/calendar/:id called twice returns 422 EVENT_ALREADY_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Double Cancel Event', start_time: futureTime(1), end_time: futureTime(2) },
  });
  const eventId: string = (await eventRes.json()).data.id;

  await request.delete('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });

  const res = await request.delete('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('EVENT_ALREADY_CANCELLED');
});

test('PATCH /api/v1/calendar/:id on cancelled event returns 422 EVENT_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Update Cancelled Event', start_time: futureTime(1), end_time: futureTime(2) },
  });
  const eventId: string = (await eventRes.json()).data.id;

  await request.delete('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
  });

  const res = await request.patch('/api/v1/calendar/' + eventId, {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Attempt Update' },
  });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('EVENT_CANCELLED');
});

// ─── POST /calendar/:id/notes (addPostMeetingNotes) ───────────────────────────

test('POST /api/v1/calendar/:id/notes on scheduled event returns 422 EVENT_NOT_COMPLETED', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Notes Before Complete', start_time: futureTime(1), end_time: futureTime(2) },
  });
  const eventId: string = (await eventRes.json()).data.id;

  const res = await request.post('/api/v1/calendar/' + eventId + '/notes', {
    headers: { Authorization: 'Bearer ' + token },
    data: { notes: 'Early notes attempt' },
  });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('EVENT_NOT_COMPLETED');
});

test('POST /api/v1/calendar/:id/notes on completed event saves notes and returns updated event', async ({ request }) => {
  const { token } = getAuth();
  const eventRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Post Meeting Notes', start_time: futureTime(1), end_time: futureTime(2) },
  });
  const eventId: string = (await eventRes.json()).data.id;

  await request.post('/api/v1/calendar/' + eventId + '/complete', {
    headers: { Authorization: 'Bearer ' + token },
  });

  const res = await request.post('/api/v1/calendar/' + eventId + '/notes', {
    headers: { Authorization: 'Bearer ' + token },
    data: { notes: 'Great meeting!' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const event: CalendarEvent = body.data;
  expect(event.notes).toBe('Great meeting!');
});

// ─── POST /messages/:id/read ──────────────────────────────────────────────────

test('POST /api/v1/messages/:id/read marks in-app message as read (status=read, read_at non-null)', async ({ request }) => {
  const { token } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'ReadContact' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const msgRes = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: 'Bearer ' + token },
    data: { contact_id: contactId, body: 'Mark me read' },
  });
  expect(msgRes.status()).toBe(201);
  const msgId: string = (await msgRes.json()).data.id;

  const res = await request.post('/api/v1/messages/' + msgId + '/read', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const message: Message = body.data;
  expect(message.status).toBe('read');
  expect(message.read_at).not.toBeNull();
});

// ─── Deals — gap cases ────────────────────────────────────────────────────────

test('PATCH /api/v1/deals/:id/stage on lost deal returns 422 DEAL_NOT_OPEN', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'LostStageContact' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Lost Stage Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  await request.post('/api/v1/deals/' + dealId + '/lost', {
    headers: { Authorization: 'Bearer ' + token },
    data: { reason: 'Price' },
  });

  const res = await request.patch('/api/v1/deals/' + dealId + '/stage', {
    headers: { Authorization: 'Bearer ' + token },
    data: { stage_id: stageId },
  });
  expect(res.status()).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('DEAL_NOT_OPEN');
  expect(typeof body.error.message).toBe('string');
});

test('DELETE /api/v1/deals/stages/:id returns 409 STAGE_HAS_OPEN_DEALS when stage contains open deals', async ({ request }) => {
  const { token } = getAuth();

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Stage Delete Test ' + Date.now(), is_default: false },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Stage To Delete', position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'StageDeleteContact' },
  });
  const contactId: string = (await cRes.json()).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Stage Blocking Deal', contact_id: contactId, pipeline_id: plId, stage_id: stId },
  });
  expect(dRes.status()).toBe(201);

  const res = await request.delete('/api/v1/deals/stages/' + stId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe('STAGE_HAS_OPEN_DEALS');
  expect(typeof body.error.message).toBe('string');
});
