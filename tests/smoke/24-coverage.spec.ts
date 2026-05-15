import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

// ── Interfaces ────────────────────────────────────────────────────────────────

interface RegisterResponse {
  data: {
    token: string;
    user: { id: string };
  };
}

interface ContactRecord {
  id: string;
  first_name: string;
  type: string;
  status: string;
  assigned_to: string | null;
  tags?: string[];
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
  pipeline_id: string;
  stage_id: string;
}

interface DealListResponse {
  data: DealRecord[];
  meta: { total: number };
}

interface PipelineStageRecord {
  id: string;
  name: string;
  position: number;
}

interface PipelineRecord {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStageRecord[];
}

interface PipelineListResponse {
  data: PipelineRecord[];
}

interface ImportResultResponse {
  data: { imported_count: number };
  meta: Record<string, never>;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

interface AuthOrg {
  token: string;
  userId: string;
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
  email?: string,
  extra: Record<string, unknown> = {},
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: {
      first_name: firstName,
      type,
      ...(email !== undefined ? { email } : {}),
      ...extra,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: ContactRecord };
  return body.data;
}

async function getContact(request: APIRequestContext, token: string, contactId: string): Promise<ContactRecord> {
  const res = await request.get(`/api/v1/contacts/${contactId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: ContactRecord };
  return body.data;
}

async function createTask(
  request: APIRequestContext,
  org: AuthOrg,
  title: string,
  priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium',
  extra: Record<string, unknown> = {},
): Promise<TaskRecord> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title, assigned_to: org.userId, priority, ...extra },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: TaskRecord };
  return body.data;
}

async function getDefaultPipeline(request: APIRequestContext, token: string): Promise<PipelineRecord> {
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as PipelineListResponse;
  const defaultPipeline = body.data.find((p) => p.is_default);
  expect(defaultPipeline).toBeDefined();
  return defaultPipeline as PipelineRecord;
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
    data: {
      title,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      currency: 'USD',
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: DealRecord };
  return body.data;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('G1: POST /api/v1/contacts/bulk-archive rejects an empty contact_ids array (BulkArchiveSchema min(1))', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(token),
    data: { contact_ids: [] },
  });

  expect(res.status()).toBe(400);
});

test('G2: POST /api/v1/contacts/bulk-assign rejects an empty contact_ids array (BulkAssignSchema min(1))', async ({ request }) => {
  const { token, userId } = getAuth();

  const res = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(token),
    data: { contact_ids: [], assigned_to: userId },
  });

  expect(res.status()).toBe(400);
});

test('G4: POST /api/v1/contacts/import-csv with two rows sharing an email creates both contacts (Contact.email has no unique constraint)', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g4-dup-email');
  const sharedEmail = `dup-${Date.now()}@example.com`;

  const res = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(org.token),
    data: [
      { first_name: 'Alice', email: sharedEmail },
      { first_name: 'Bob', email: sharedEmail },
    ],
  });

  expect(res.status()).toBe(201);
  const body = (await res.json()) as ImportResultResponse;
  expect(body.data.imported_count).toBe(2);
});

test('G5: GET /api/v1/contacts?type=customer returns only customer-type contacts (type filter)', async ({ request }) => {
  const org = await registerOrg(request, 'g5-type-filter');

  await createContact(request, org.token, 'CustomerOne', 'customer');
  await createContact(request, org.token, 'LeadOne', 'lead');

  const res = await request.get('/api/v1/contacts?type=customer', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  expect(body.data.length).toBe(1);
  expect(body.data[0].type).toBe('customer');
});

test('G6: GET /api/v1/contacts?page=2&per_page=1 returns exactly 1 result and meta.total=2 when org has 2 contacts', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g6-pagination');

  await createContact(request, org.token, 'PageFirst');
  await createContact(request, org.token, 'PageSecond');

  const res = await request.get('/api/v1/contacts?page=2&per_page=1', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  expect(body.data.length).toBe(1);
  expect(body.meta.total).toBe(2);
});

test('G7: GET /api/v1/tasks?status=done returns only done tasks and excludes pending tasks', async ({ request }) => {
  const org = await registerOrg(request, 'g7-done-filter');

  const doneTask = await createTask(request, org, 'DoneTask');
  await createTask(request, org, 'PendingTask');

  const completeRes = await request.post(`/api/v1/tasks/${doneTask.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);

  const res = await request.get('/api/v1/tasks?status=done', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  const ids = body.data.map((t) => t.id);
  expect(ids).toContain(doneTask.id);
  expect(body.data.every((t) => t.status === 'done')).toBe(true);
});

test('G8: GET /api/v1/deals?status=won returns only won deals and excludes open deals', async ({ request }) => {
  const org = await registerOrg(request, 'g8-won-filter');
  const contact = await createContact(request, org.token, 'DealContact');
  const pipeline = await getDefaultPipeline(request, org.token);
  const stageId = pipeline.stages[0].id;

  const wonDeal = await createDeal(request, org.token, 'WonDeal', contact.id, pipeline.id, stageId);
  await createDeal(request, org.token, 'OpenDeal', contact.id, pipeline.id, stageId);

  const wonRes = await request.post(`/api/v1/deals/${wonDeal.id}/won`, {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const res = await request.get('/api/v1/deals?status=won', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealListResponse;
  expect(body.data.some((d) => d.id === wonDeal.id)).toBe(true);
  expect(body.data.every((d) => d.status === 'won')).toBe(true);
});

test('G9: POST /api/v1/contacts with email="" returns 400 (CreateContactSchema rejects empty string as invalid email)', async ({
  request,
}) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'BadEmail', email: '' },
  });

  expect(res.status()).toBe(400);
});

test('G10: GET /api/v1/tasks?priority=high returns only high-priority tasks (priority filter)', async ({ request }) => {
  const org = await registerOrg(request, 'g10-priority-filter');

  const highTask = await createTask(request, org, 'HighPriTask', 'high');
  await createTask(request, org, 'MediumPriTask', 'medium');

  const res = await request.get('/api/v1/tasks?priority=high', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  const ids = body.data.map((t) => t.id);
  expect(ids).toContain(highTask.id);
  expect(body.data.every((t) => t.priority === 'high')).toBe(true);
});

test('G11: POST /api/v1/tasks/:id/start on a cancelled task returns 422 INVALID_STATUS_TRANSITION', async ({ request }) => {
  const org = await registerOrg(request, 'g11-start-cancelled');
  const task = await createTask(request, org, 'CancelledTask');

  const cancelRes = await request.delete(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(org.token),
  });
  expect(cancelRes.status()).toBe(200);

  const startRes = await request.post(`/api/v1/tasks/${task.id}/start`, {
    headers: authHeaders(org.token),
  });
  expect(startRes.status()).toBe(422);
  const body = (await startRes.json()) as ErrorResponse;
  expect(body.error.code).toBe('INVALID_STATUS_TRANSITION');
});

test('G12: POST /api/v1/contacts/bulk-archive with 101 contact_ids returns 400 (BulkArchiveSchema max(100))', async ({ request }) => {
  const { token } = getAuth();

  // Generate 101 valid-format UUIDs. Zod's max(100) fires before the controller
  // checks whether each contact exists in the org.
  const contactIds = Array.from({ length: 101 }, () => randomUUID());

  const res = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(token),
    data: { contact_ids: contactIds },
  });

  expect(res.status()).toBe(400);
});

test('G13: POST /api/v1/notifications/register without body returns 400 (RegisterTokenSchema requires token)', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(token),
    data: {},
  });

  expect(res.status()).toBe(400);
});

test('G14: POST /api/v1/notifications/register with valid token returns 200 and registers push token once', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(token),
    data: { token: 'ExponentPushToken[test-device-abc]' },
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: { message: string; already_registered: boolean };
  };
  expect(body.data.message).toBe('Push token registered');
  expect(body.data.already_registered).toBe(false);
});

test('G15: POST /api/v1/notifications/send for user with no push_token returns 422 NO_PUSH_TOKEN', async ({ request }) => {
  const org = await registerOrg(request, 'g15-no-token');

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(org.token),
    data: {
      user_id: org.userId,
      title: 'Hello',
      body: 'Test',
    },
  });

  expect(res.status()).toBe(422);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NO_PUSH_TOKEN');
});

test('G16: POST /api/v1/notifications/send for cross-org user returns 404 USER_NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'g16-org-a');
  const orgB = await registerOrg(request, 'g16-org-b');

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(orgA.token),
    data: {
      user_id: orgB.userId,
      title: 'Cross-org',
      body: 'Should not reach',
    },
  });

  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('USER_NOT_FOUND');
});

test('G17: POST /api/v1/notifications/register with same token twice for same user is idempotent', async ({ request }) => {
  const org = await registerOrg(request, 'g17-same-user-token');
  const pushToken = `ExponentPushToken[g17-${Date.now()}]`;

  const firstRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: pushToken },
  });
  expect(firstRes.status()).toBe(200);

  const secondRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: pushToken },
  });
  expect(secondRes.status()).toBe(200);
  const body = (await secondRes.json()) as {
    data: { already_registered: boolean };
  };
  expect(body.data.already_registered).toBe(true);
});

test('G18: POST /api/v1/notifications/register moves duplicate device token to the latest user', async ({ request }) => {
  const orgA = await registerOrg(request, 'g18-token-owner-a');
  const orgB = await registerOrg(request, 'g18-token-owner-b');
  const pushToken = `ExponentPushToken[g18-${Date.now()}]`;

  const firstRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(orgA.token),
    data: { token: pushToken },
  });
  expect(firstRes.status()).toBe(200);

  const secondRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(orgB.token),
    data: { token: pushToken },
  });
  expect(secondRes.status()).toBe(200);
  const secondBody = (await secondRes.json()) as {
    data: { cleared_duplicate_count: number };
  };
  expect(secondBody.data.cleared_duplicate_count).toBe(1);

  const oldOwnerSendRes = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(orgA.token),
    data: {
      user_id: orgA.userId,
      title: 'Should not send',
      body: 'The old owner should no longer have this token',
    },
  });
  expect(oldOwnerSendRes.status()).toBe(422);
  const oldOwnerBody = (await oldOwnerSendRes.json()) as ErrorResponse;
  expect(oldOwnerBody.error.code).toBe('NO_PUSH_TOKEN');
});

test('G19: POST /api/v1/notifications/register with token="" returns 400 before controller validation', async ({ request }) => {
  const org = await registerOrg(request, 'g19-empty-push-token');

  const res = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: '' },
  });

  expect(res.status()).toBe(400);
});

test('G20: POST /api/v1/notifications/send with malformed user_id returns 400 before lookup', async ({ request }) => {
  const org = await registerOrg(request, 'g20-bad-send-user-id');

  const res = await request.post('/api/v1/notifications/send', {
    headers: authHeaders(org.token),
    data: {
      user_id: 'not-a-uuid',
      title: 'Bad user id',
      body: 'Schema validation should reject this before org lookup',
    },
  });

  expect(res.status()).toBe(400);
});

test('G21: POST /api/v1/notifications/register replaces the same user device token with duplicate count 0', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g21-replace-token');
  const firstToken = `ExponentPushToken[g21-first-${Date.now()}]`;
  const secondToken = `ExponentPushToken[g21-second-${Date.now()}]`;

  const firstRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: firstToken },
  });
  expect(firstRes.status()).toBe(200);

  const replaceRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: secondToken },
  });
  expect(replaceRes.status()).toBe(200);
  const replaceBody = (await replaceRes.json()) as {
    data: { message: string; already_registered: boolean; cleared_duplicate_count: number };
  };
  expect(replaceBody.data.message).toBe('Push token registered');
  expect(replaceBody.data.already_registered).toBe(false);
  expect(replaceBody.data.cleared_duplicate_count).toBe(0);

  const repeatRes = await request.post('/api/v1/notifications/register', {
    headers: authHeaders(org.token),
    data: { token: secondToken },
  });
  expect(repeatRes.status()).toBe(200);
  const repeatBody = (await repeatRes.json()) as {
    data: { message: string; already_registered: boolean };
  };
  expect(repeatBody.data.message).toBe('Push token already registered');
  expect(repeatBody.data.already_registered).toBe(true);
});

test('G22: POST /api/v1/contacts/bulk-tag with empty tags returns 400 (BulkTagSchema min(1))', async ({
  request,
}) => {
  const org = await registerOrg(request, 'g22-bulk-tag-empty');
  const contact = await createContact(request, org.token, 'G22 Empty Tags');

  const res = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: [contact.id], tags: [] },
  });

  expect(res.status()).toBe(400);
});

test('G23: POST /api/v1/contacts/bulk-tag rejects another-org contact_id and preserves requester tags', async ({
  request,
}) => {
  const orgA = await registerOrg(request, 'g23-bulk-tag-a');
  const orgB = await registerOrg(request, 'g23-bulk-tag-b');
  const requester = await createContact(request, orgA.token, 'G23 Requester Tagged', 'lead', undefined, {
    tags: ['original'],
  });
  const other = await createContact(request, orgB.token, 'G23 Other Tagged');

  const res = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(orgA.token),
    data: { contact_ids: [requester.id, other.id], tags: ['blocked'] },
  });

  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NOT_FOUND');

  const stored = await getContact(request, orgA.token, requester.id);
  expect(stored.tags).toEqual(['original']);
});

test('G24: GET /api/v1/contacts combines q, type, and assigned_to filters', async ({ request }) => {
  const org = await registerOrg(request, 'g24-contact-combo');
  const prefix = uniqueSuffix('G24Combo');
  const target = await createContact(request, org.token, `${prefix} Target`, 'customer', undefined, {
    assigned_to: org.userId,
  });
  const wrongType = await createContact(request, org.token, `${prefix} Lead`, 'lead', undefined, {
    assigned_to: org.userId,
  });
  const unassigned = await createContact(request, org.token, `${prefix} Unassigned`, 'customer');
  const wrongQuery = await createContact(request, org.token, 'G24 Different Customer', 'customer', undefined, {
    assigned_to: org.userId,
  });

  const res = await request.get(
    `/api/v1/contacts?q=${encodeURIComponent(prefix)}&type=customer&assigned_to=${org.userId}&per_page=20`,
    { headers: authHeaders(org.token) },
  );

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  const ids = body.data.map((contact) => contact.id);
  expect(ids).toContain(target.id);
  expect(ids).not.toContain(wrongType.id);
  expect(ids).not.toContain(unassigned.id);
  expect(ids).not.toContain(wrongQuery.id);
  expect(
    body.data.every(
      (contact) =>
        contact.first_name.includes(prefix) &&
        contact.type === 'customer' &&
        contact.assigned_to === org.userId,
    ),
  ).toBe(true);
});

test('G25: GET /api/v1/tasks combines status, priority, due_after, and due_before filters', async ({ request }) => {
  const org = await registerOrg(request, 'g25-task-combo');
  const windowStart = daysFromNow(2);
  const matchingDue = daysFromNow(3);
  const windowEnd = daysFromNow(4);
  const lateDue = daysFromNow(5);

  const matching = await createTask(request, org, 'G25 Matching Task', 'high', { due_date: matchingDue });
  const lowPriority = await createTask(request, org, 'G25 Low Priority Task', 'low', { due_date: matchingDue });
  const lateTask = await createTask(request, org, 'G25 Late Task', 'high', { due_date: lateDue });
  const pendingHigh = await createTask(request, org, 'G25 Pending High Task', 'high', { due_date: matchingDue });

  for (const task of [matching, lowPriority, lateTask]) {
    const startRes = await request.post(`/api/v1/tasks/${task.id}/start`, {
      headers: authHeaders(org.token),
    });
    expect(startRes.status()).toBe(200);
  }

  const res = await request.get(
    `/api/v1/tasks?status=in_progress&priority=high&due_after=${encodeURIComponent(windowStart)}&due_before=${encodeURIComponent(windowEnd)}&per_page=20`,
    { headers: authHeaders(org.token) },
  );

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  const ids = body.data.map((task) => task.id);
  expect(ids).toContain(matching.id);
  expect(ids).not.toContain(lowPriority.id);
  expect(ids).not.toContain(lateTask.id);
  expect(ids).not.toContain(pendingHigh.id);
  expect(
    body.data.every(
      (task) =>
        task.status === 'in_progress' &&
        task.priority === 'high' &&
        task.due_date !== null &&
        new Date(task.due_date).getTime() >= new Date(windowStart).getTime() &&
        new Date(task.due_date).getTime() < new Date(windowEnd).getTime(),
    ),
  ).toBe(true);
});

test('G26: GET /api/v1/deals combines pipeline_id, stage_id, and status filters', async ({ request }) => {
  const org = await registerOrg(request, 'g26-deal-combo');
  const contact = await createContact(request, org.token, 'G26 Deal Contact');
  const pipeline = await getDefaultPipeline(request, org.token);
  const stageId = pipeline.stages[0].id;

  const extraStageRes = await request.post(`/api/v1/deals/pipelines/${pipeline.id}/stages`, {
    headers: authHeaders(org.token),
    data: {
      name: uniqueSuffix('G26 Extra Stage'),
      position: pipeline.stages.length + 10,
    },
  });
  expect(extraStageRes.status()).toBe(201);
  const extraStageBody = (await extraStageRes.json()) as { data: PipelineStageRecord };
  const extraStageId = extraStageBody.data.id;

  const matching = await createDeal(request, org.token, 'G26 Matching Deal', contact.id, pipeline.id, stageId);
  const otherStage = await createDeal(request, org.token, 'G26 Other Stage Deal', contact.id, pipeline.id, extraStageId);
  const wonInStage = await createDeal(request, org.token, 'G26 Won In Stage Deal', contact.id, pipeline.id, stageId);

  const wonRes = await request.post(`/api/v1/deals/${wonInStage.id}/won`, {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const res = await request.get(`/api/v1/deals?pipeline_id=${pipeline.id}&stage_id=${stageId}&status=open&per_page=20`, {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealListResponse;
  const ids = body.data.map((deal) => deal.id);
  expect(ids).toContain(matching.id);
  expect(ids).not.toContain(otherStage.id);
  expect(ids).not.toContain(wonInStage.id);
  expect(body.data.every((deal) => deal.pipeline_id === pipeline.id && deal.stage_id === stageId && deal.status === 'open')).toBe(true);
});
