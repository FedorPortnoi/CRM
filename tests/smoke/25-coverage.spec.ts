import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

// -- Interfaces ----------------------------------------------------------------
interface RegisterResponse {
  data: { token: string; user: { id: string } };
}

interface AuthOrg {
  token: string;
  userId: string;
}

interface ContactRecord {
  id: string;
  first_name: string;
  type: string;
  status: string;
}

interface ContactListMeta {
  total: number;
  page: number;
  per_page: number;
}

interface ContactListResponse {
  data: ContactRecord[];
  meta: ContactListMeta;
}

interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_to: string;
  due_date: string | null;
}

interface TaskListResponse {
  data: TaskRecord[];
  meta: { total: number };
}

interface DealRecord {
  id: string;
  title: string;
  status: string;
}

interface DealListResponse {
  data: DealRecord[];
  meta: { total: number };
}

interface PipelineStageRecord {
  id: string;
}

interface PipelineRecord {
  id: string;
  is_default: boolean;
  stages: PipelineStageRecord[];
}

interface PipelineListResponse {
  data: PipelineRecord[];
}

interface DataResponse<T> {
  data: T;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// -- Helpers -------------------------------------------------------------------
function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<AuthOrg> {
  const unique = uniqueSuffix(suffix);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as RegisterResponse;
  return { token: body.data.token, userId: body.data.user.id };
}

async function createContact(
  request: APIRequestContext,
  token: string,
  firstName: string,
  type: 'lead' | 'customer' | 'partner' | 'other' = 'lead',
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName, type },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<ContactRecord>;
  return body.data;
}

async function createTask(
  request: APIRequestContext,
  org: AuthOrg,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<TaskRecord> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title, assigned_to: org.userId, ...extra },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<TaskRecord>;
  return body.data;
}

async function getDefaultPipeline(request: APIRequestContext, token: string): Promise<PipelineRecord> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as PipelineListResponse;
  return body.data.find((p) => p.is_default) ?? body.data[0];
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  title: string,
  contactId: string,
  pipelineId: string,
  stageId: string,
): Promise<DealRecord> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title, contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, currency: 'USD' },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<DealRecord>;
  return body.data;
}

// -- Tests ---------------------------------------------------------------------
test('G1: POST /api/v1/notifications/register without token returns 400', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(token),
    data: {},
  });

  expect(res.status()).toBe(400);
});

test('G2: POST /api/v1/notifications/register with a non-Expo token returns 400 INVALID_PUSH_TOKEN', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(token),
    data: { token: 'not-an-expo-push-token' },
  });

  expect(res.status()).toBe(400);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('INVALID_PUSH_TOKEN');
});

test('G3: POST /api/v1/notifications/send without title returns 400', async ({ request }) => {
  const { token, userId } = getAuth();

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(token),
    data: { user_id: userId, body: 'Missing title should fail schema validation' },
  });

  expect(res.status()).toBe(400);
});

test('G4: GET /api/v1/contacts?type=customer returns only customer contacts and matched meta.total', async ({ request }) => {
  const org = await registerOrg(request, 'g4-customer-type');
  const customer = await createContact(request, org.token, 'G4 Customer', 'customer');
  const lead = await createContact(request, org.token, 'G4 Lead', 'lead');

  const res = await request.get('/api/v1/contacts?type=customer', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  const ids = body.data.map((contact) => contact.id);
  expect(ids).toContain(customer.id);
  expect(ids).not.toContain(lead.id);
  expect(body.meta.total).toBe(1);
  expect(body.data.every((contact) => contact.type === 'customer')).toBe(true);
});

test('G5: GET /api/v1/tasks?due_before returns tasks before the ISO cutoff only', async ({ request }) => {
  const org = await registerOrg(request, 'g5-due-before');
  const tomorrowDue = daysFromNow(1);
  const futureDue = daysFromNow(10);
  const cutoffDue = daysFromNow(5);
  const tomorrowTask = await createTask(request, org, 'G5 Due Tomorrow', { due_date: tomorrowDue });
  const futureTask = await createTask(request, org, 'G5 Due Later', { due_date: futureDue });

  const res = await request.get(`/api/v1/tasks?due_before=${encodeURIComponent(cutoffDue)}`, {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  const ids = body.data.map((task) => task.id);
  expect(ids).toContain(tomorrowTask.id);
  expect(ids).not.toContain(futureTask.id);
  expect(body.data.every((task) => task.due_date !== null && new Date(task.due_date).getTime() < new Date(cutoffDue).getTime())).toBe(true);
});

test('G6: GET /api/v1/deals?status=lost returns only deals marked lost', async ({ request }) => {
  const org = await registerOrg(request, 'g6-lost-deals');
  const contact = await createContact(request, org.token, 'G6 Deal Contact');
  const pipeline = await getDefaultPipeline(request, org.token);
  const stageId = pipeline.stages[0].id;
  const lostDeal = await createDeal(request, org.token, 'G6 Lost Deal', contact.id, pipeline.id, stageId);
  const openDeal = await createDeal(request, org.token, 'G6 Open Deal', contact.id, pipeline.id, stageId);

  const lostRes = await request.post(`/api/v1/deals/${lostDeal.id}/lost`, {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(lostRes.status()).toBe(200);

  const res = await request.get('/api/v1/deals?status=lost', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealListResponse;
  const ids = body.data.map((deal) => deal.id);
  expect(ids).toContain(lostDeal.id);
  expect(ids).not.toContain(openDeal.id);
  expect(body.data.every((deal) => deal.status === 'lost')).toBe(true);
});

test('G7: GET /api/v1/tasks?status=in_progress returns only started in-progress tasks', async ({ request }) => {
  const org = await registerOrg(request, 'g7-in-progress');
  const startedTask = await createTask(request, org, 'G7 Started Task');
  const pendingTask = await createTask(request, org, 'G7 Pending Task');

  const startRes = await request.post(`/api/v1/tasks/${startedTask.id}/start`, {
    headers: authHeaders(org.token),
  });
  expect(startRes.status()).toBe(200);

  const res = await request.get('/api/v1/tasks?status=in_progress', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  const ids = body.data.map((task) => task.id);
  expect(ids).toContain(startedTask.id);
  expect(ids).not.toContain(pendingTask.id);
  expect(body.data.every((task) => task.status === 'in_progress')).toBe(true);
});

test('G8: POST /api/v1/contacts/bulk-archive with only another-org contact_id returns 404 NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'g8-org-a');
  const orgB = await registerOrg(request, 'g8-org-b');
  const otherOrgContact = await createContact(request, orgB.token, 'G8 Other Org Contact');

  const res = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(orgA.token),
    data: { contact_ids: [otherOrgContact.id] },
  });

  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NOT_FOUND');
});

test('G9: GET /api/v1/contacts?type=customer&status=active applies both filters together', async ({ request }) => {
  const org = await registerOrg(request, 'g9-type-status');
  const activeCustomer = await createContact(request, org.token, 'G9 Active Customer', 'customer');
  const activeLead = await createContact(request, org.token, 'G9 Active Lead', 'lead');
  const archivedCustomer = await createContact(request, org.token, 'G9 Archived Customer', 'customer');

  const archiveRes = await request.delete(`/api/v1/contacts/${archivedCustomer.id}`, {
    headers: authHeaders(org.token),
  });
  expect(archiveRes.status()).toBe(200);

  const res = await request.get('/api/v1/contacts?type=customer&status=active', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  const ids = body.data.map((contact) => contact.id);
  expect(ids).toContain(activeCustomer.id);
  expect(ids).not.toContain(activeLead.id);
  expect(ids).not.toContain(archivedCustomer.id);
  expect(body.data.every((contact) => contact.type === 'customer' && contact.status === 'active')).toBe(true);
});

test('G10: GET /api/v1/tasks?assigned_to returns only tasks assigned to that user', async ({ request }) => {
  const orgA = await registerOrg(request, 'g10-org-a');
  const orgB = await registerOrg(request, 'g10-org-b');
  const userATask = await createTask(request, orgA, 'G10 User A Task');

  const userARes = await request.get(`/api/v1/tasks?assigned_to=${orgA.userId}`, {
    headers: authHeaders(orgA.token),
  });
  expect(userARes.status()).toBe(200);
  const userABody = (await userARes.json()) as TaskListResponse;
  expect(userABody.data.map((task) => task.id)).toContain(userATask.id);
  expect(userABody.data.every((task) => task.assigned_to === orgA.userId)).toBe(true);

  const userBRes = await request.get(`/api/v1/tasks?assigned_to=${orgB.userId}`, {
    headers: authHeaders(orgA.token),
  });
  expect(userBRes.status()).toBe(200);
  const userBBody = (await userBRes.json()) as TaskListResponse;
  expect(userBBody.data.map((task) => task.id)).not.toContain(userATask.id);
  expect(userBBody.data.every((task) => task.assigned_to === orgB.userId)).toBe(true);
});

test('G11: PATCH /api/v1/tasks/:id with a non-existent id returns 404 TASK_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const missingTaskId = randomUUID();

  const res = await request.patch(`/api/v1/tasks/${missingTaskId}`, {
    headers: authHeaders(token),
    data: { title: 'Missing task update' },
  });

  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('TASK_NOT_FOUND');
});

test('G12: POST /api/v1/calendar with end_time not after start_time returns 400', async ({ request }) => {
  const { token } = getAuth();
  const startTime = daysFromNow(2);

  const res = await request.post('/api/v1/calendar', {
    headers: authHeaders(token),
    data: {
      title: 'Invalid calendar window',
      start_time: startTime,
      end_time: startTime,
    },
  });

  expect(res.status()).toBe(400);
});
