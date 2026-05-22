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
  assigned_to: string | null;
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
  contact_id: string;
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

interface CalendarEventRecord {
  id: string;
  title: string;
  status: string;
  start_time: string;
  end_time: string;
  contact_id: string | null;
  deal_id: string | null;
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
  extra: Record<string, unknown> = {},
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName, type, ...extra },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<ContactRecord>;
  return body.data;
}

async function getContact(request: APIRequestContext, token: string, contactId: string): Promise<ContactRecord> {
  const res = await request.get(`/api/v1/contacts/${contactId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
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

async function createCalendarEvent(
  request: APIRequestContext,
  org: AuthOrg,
  title: string,
  startTime: string,
  endTime: string,
  extra: Record<string, unknown> = {},
): Promise<CalendarEventRecord> {
  const res = await request.post('/api/v1/calendar', {
    headers: authHeaders(org.token),
    data: { title, start_time: startTime, end_time: endTime, ...extra },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<CalendarEventRecord>;
  return body.data;
}

// -- Tests ---------------------------------------------------------------------
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

test('G3b: notifications/register is idempotent for the same Expo token', async ({ request }) => {
  const org = await registerOrg(request, 'g3b-push-idempotent');
  const tokenValue = `ExponentPushToken[${randomUUID()}]`;

  const first = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: tokenValue },
  });
  expect(first.status()).toBe(200);
  const firstBody = await first.json() as { data: { already_registered: boolean; cleared_duplicate_count?: number } };
  expect(firstBody.data.already_registered).toBe(false);
  expect(firstBody.data.cleared_duplicate_count).toBe(0);

  const second = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: tokenValue },
  });
  expect(second.status()).toBe(200);
  const secondBody = await second.json() as { data: { already_registered: boolean } };
  expect(secondBody.data.already_registered).toBe(true);
});

test('G3c: notifications/send returns stable no-recipient error when user has no push token', async ({ request }) => {
  const org = await registerOrg(request, 'g3c-no-push-token');

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(org.token),
    data: { user_id: org.userId, title: 'Reminder', body: 'Follow up today' },
  });

  expect(res.status()).toBe(422);
  const body = await res.json() as ErrorResponse;
  expect(body.error.code).toBe('NO_PUSH_TOKEN');
});

test('G3d: notifications/send rejects cross-org user_id', async ({ request }) => {
  const orgA = await registerOrg(request, 'g3d-push-org-a');
  const orgB = await registerOrg(request, 'g3d-push-org-b');

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(orgA.token),
    data: { user_id: orgB.userId, title: 'Cross org', body: 'Should not send' },
  });

  expect(res.status()).toBe(404);
  const body = await res.json() as ErrorResponse;
  expect(body.error.code).toBe('USER_NOT_FOUND');
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

test('G13: POST /api/v1/notifications/send with body="" returns 400 before push token lookup', async ({ request }) => {
  const org = await registerOrg(request, 'g13-empty-notification-body');

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(org.token),
    data: {
      user_id: org.userId,
      title: 'Empty body should fail',
      body: '',
    },
  });

  expect(res.status()).toBe(400);
});

test('G14: POST /api/v1/contacts/bulk-assign with 101 contact_ids returns 400 (BulkAssignSchema max(100))', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g14-bulk-assign-max');
  const contactIds = Array.from({ length: 101 }, () => randomUUID());

  const res = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(org.token),
    data: { contact_ids: contactIds, assigned_to: org.userId },
  });

  expect(res.status()).toBe(400);
});

test('G15: POST /api/v1/contacts/bulk-archive rejects an already archived id and preserves active contacts', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g15-archive-archived-contact');
  const active = await createContact(request, org.token, 'G15 Active Contact');
  const archived = await createContact(request, org.token, 'G15 Archived Contact');

  const archiveOneRes = await request.delete(`/api/v1/contacts/${archived.id}`, {
    headers: authHeaders(org.token),
  });
  expect(archiveOneRes.status()).toBe(200);

  const res = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [active.id, archived.id] },
  });

  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NOT_FOUND');

  const storedActive = await getContact(request, org.token, active.id);
  expect(storedActive.status).toBe('active');
});

test('G16: POST /api/v1/contacts/bulk-assign rejects an archived contact id and preserves assignment state', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g16-assign-archived-contact');
  const active = await createContact(request, org.token, 'G16 Active Contact');
  const archived = await createContact(request, org.token, 'G16 Archived Contact');

  const archiveOneRes = await request.delete(`/api/v1/contacts/${archived.id}`, {
    headers: authHeaders(org.token),
  });
  expect(archiveOneRes.status()).toBe(200);

  const res = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(org.token),
    data: { contact_ids: [active.id, archived.id], assigned_to: org.userId },
  });

  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NOT_FOUND');

  const storedActive = await getContact(request, org.token, active.id);
  expect(storedActive.assigned_to).toBeNull();
});

test('G17: GET /api/v1/tasks combines q, status, and priority filters', async ({ request }) => {
  const org = await registerOrg(request, 'g17-task-q-status-priority');
  const prefix = uniqueSuffix('G17TaskCombo');
  const matching = await createTask(request, org, `${prefix} Matching`, { priority: 'urgent' });
  const doneTask = await createTask(request, org, `${prefix} Done`, { priority: 'urgent' });
  const wrongPriority = await createTask(request, org, `${prefix} Wrong Priority`, { priority: 'high' });
  const wrongQuery = await createTask(request, org, 'G17 Different Urgent', { priority: 'urgent' });

  const completeRes = await request.post(`/api/v1/tasks/${doneTask.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);

  const res = await request.get(
    `/api/v1/tasks?q=${encodeURIComponent(prefix)}&status=pending&priority=urgent&per_page=20`,
    { headers: authHeaders(org.token) },
  );

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  const ids = body.data.map((task) => task.id);
  expect(ids).toContain(matching.id);
  expect(ids).not.toContain(doneTask.id);
  expect(ids).not.toContain(wrongPriority.id);
  expect(ids).not.toContain(wrongQuery.id);
  expect(body.data.every((task) => task.title.includes(prefix) && task.status === 'pending' && task.priority === 'urgent')).toBe(true);
});

test('G18: GET /api/v1/deals combines q, contact_id, and status filters', async ({ request }) => {
  const org = await registerOrg(request, 'g18-deal-q-contact-status');
  const prefix = uniqueSuffix('G18DealCombo');
  const contact = await createContact(request, org.token, 'G18 Deal Contact');
  const otherContact = await createContact(request, org.token, 'G18 Other Deal Contact');
  const pipeline = await getDefaultPipeline(request, org.token);
  const stageId = pipeline.stages[0].id;
  const matching = await createDeal(request, org.token, `${prefix} Matching`, contact.id, pipeline.id, stageId);
  const wrongContact = await createDeal(request, org.token, `${prefix} Wrong Contact`, otherContact.id, pipeline.id, stageId);
  const wonSameContact = await createDeal(request, org.token, `${prefix} Won Same Contact`, contact.id, pipeline.id, stageId);

  const wonRes = await request.post(`/api/v1/deals/${wonSameContact.id}/won`, {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const res = await request.get(
    `/api/v1/deals?q=${encodeURIComponent(prefix)}&contact_id=${contact.id}&status=open&per_page=20`,
    { headers: authHeaders(org.token) },
  );

  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealListResponse;
  const ids = body.data.map((deal) => deal.id);
  expect(ids).toContain(matching.id);
  expect(ids).not.toContain(wrongContact.id);
  expect(ids).not.toContain(wonSameContact.id);
  expect(body.data.every((deal) => deal.title.includes(prefix) && deal.contact_id === contact.id && deal.status === 'open')).toBe(true);
});

test('G19: PATCH /api/v1/calendar/:id rejects start_time after the existing end_time and preserves times', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g19-calendar-start-only-invalid');
  const originalStart = daysFromNow(2);
  const originalEnd = daysFromNow(3);
  const event = await createCalendarEvent(request, org, 'G19 Calendar Time Guard', originalStart, originalEnd);

  const res = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
    data: { start_time: daysFromNow(4) },
  });

  expect(res.status()).toBe(400);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('VALIDATION_ERROR');

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
  });
  expect(getRes.status()).toBe(200);
  const stored = (await getRes.json()) as DataResponse<CalendarEventRecord>;
  expect(stored.data.start_time).toBe(originalStart);
  expect(stored.data.end_time).toBe(originalEnd);
});

test('G20: PATCH /api/v1/calendar/:id rejects end_time before the existing start_time and preserves times', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g20-calendar-end-only-invalid');
  const originalStart = daysFromNow(5);
  const originalEnd = daysFromNow(6);
  const event = await createCalendarEvent(request, org, 'G20 Calendar Time Guard', originalStart, originalEnd);

  const res = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
    data: { end_time: daysFromNow(4) },
  });

  expect(res.status()).toBe(400);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('VALIDATION_ERROR');

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
  });
  expect(getRes.status()).toBe(200);
  const stored = (await getRes.json()) as DataResponse<CalendarEventRecord>;
  expect(stored.data.start_time).toBe(originalStart);
  expect(stored.data.end_time).toBe(originalEnd);
});
