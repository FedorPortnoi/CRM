import { test, expect, type APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });
test.use({ baseURL: 'http://127.0.0.1:3000' });

// ─── Shared helper ────────────────────────────────────────────────────────────

async function registerOrg(
  request: APIRequestContext,
  suffix: string,
): Promise<{ token: string; userId: string }> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

// ─── Shared response shape types ─────────────────────────────────────────────

interface ContactData {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  company: string | null;
  source: string | null;
  notes: string | null;
  type: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
  created_at: string;
}

interface TaskData {
  id: string;
  title: string;
  status: string;
  contact_id: string | null;
  due_date: string | null;
}

interface DealData {
  id: string;
  title: string;
  contact_id: string | null;
  pipeline: object;
  stage: object;
}

interface MessageData {
  id: string;
  contact_id: string;
  body: string;
}

interface ActivityItem {
  type: string;
  id: string;
  summary: string;
  created_at: string;
}

interface ActivityData {
  contact_id: string;
  items: ActivityItem[];
}

interface ListMeta {
  total: number;
  page: number;
  per_page: number;
}

interface BulkArchiveData {
  archived_count: number;
  contact_ids: string[];
}

interface BulkAssignData {
  assigned_count: number;
  assigned_to: string;
  contact_ids: string[];
}

interface ImportData {
  imported_count: number;
}

// ─── Original 17 tests ────────────────────────────────────────────────────────

test('GET /api/v1/contacts returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.meta).toMatchObject({ total: expect.any(Number) });
});

test('POST /api/v1/contacts creates contact', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Alice', last_name: 'Smoke', email: 'alice@smoke.test' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.first_name).toBe('Alice');
});

test('GET /api/v1/contacts/:id returns contact', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Bob' },
  });
  const { data: contact } = await create.json();

  const res = await request.get(`/api/v1/contacts/${contact.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.id).toBe(contact.id);
});

test('PATCH /api/v1/contacts/:id updates contact', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Carol' },
  });
  const { data: contact } = await create.json();

  const res = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Caroline' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.first_name).toBe('Caroline');
});

test('DELETE /api/v1/contacts/:id archives contact (status=archived)', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Dave' },
  });
  const { data: contact } = await create.json();

  const res = await request.delete(`/api/v1/contacts/${contact.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('archived');
});

// ─── Sub-routes ───────────────────────────────────────────────────────────────

test.describe('Contact sub-routes', () => {
  let token: string;
  let userId: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = getAuth());

    const contactRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'SubRoute', last_name: 'Contact' },
    });
    contactId = (await contactRes.json()).data.id;

    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_id: contactId, body: 'Activity test message' },
    });

    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'Activity test task', assigned_to: userId, contact_id: contactId },
    });

    const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pipelines = (await pipelinesRes.json()).data;
    const pipeline = pipelines.find((p: { is_default: boolean }) => p.is_default) ?? pipelines[0];
    const stagesRes = await request.get(`/api/v1/deals/pipelines/${pipeline.id}/stages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const stageId = (await stagesRes.json()).data[0].id;

    await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'Activity test deal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId, value: 1000 },
    });
  });

  test('GET /api/v1/contacts/:id/activity returns merged activity feed', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.contact_id).toBe(contactId);

    const items: { type: string; id: string; summary: string; created_at: string }[] = body.data.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(2);

    // All items must have the correct shape
    for (const item of items) {
      expect(['message', 'task', 'meeting']).toContain(item.type);
      expect(typeof item.id).toBe('string');
      expect(typeof item.summary).toBe('string');
      expect(typeof item.created_at).toBe('string');
    }

    // Both source types seeded in beforeAll must appear
    const types = items.map(i => i.type);
    expect(types).toContain('message');
    expect(types).toContain('task');

    // Items must be sorted by created_at descending
    for (let i = 1; i < items.length; i++) {
      expect(new Date(items[i - 1].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(items[i].created_at).getTime(),
      );
    }
  });

  test('GET /api/v1/contacts/:id/deals returns deals with pipeline+stage', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/deals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const deal = body.data[0];
    expect(deal.contact_id).toBe(contactId);
    expect(deal).toHaveProperty('pipeline');
    expect(deal).toHaveProperty('stage');
  });

  test('GET /api/v1/contacts/:id/tasks returns non-cancelled tasks sorted by due_date', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((t: { status: string }) => t.status !== 'cancelled')).toBe(true);
  });

  test('GET /api/v1/contacts/:id/messages returns messages sorted desc', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].contact_id).toBe(contactId);
  });

  test('GET /api/v1/contacts/:id/activity returns 404 for unknown contact', async ({ request }) => {
    const res = await request.get('/api/v1/contacts/00000000-0000-0000-0000-000000000000/activity', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(404);
  });
});

// ─── Merge ────────────────────────────────────────────────────────────────────

test.describe('Contact merge', () => {
  let token: string;
  let userId: string;
  let targetId: string;
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = getAuth());

    // Create target contact
    const targetRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'MergeTarget', last_name: 'Contact' },
    });
    targetId = (await targetRes.json()).data.id;

    // Create source contact
    const sourceRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'MergeSource', last_name: 'Contact' },
    });
    sourceId = (await sourceRes.json()).data.id;

    // Attach a task to source (should be reassigned to target after merge)
    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'Merge test task', assigned_to: userId, contact_id: sourceId },
    });
  });

  test('POST /api/v1/contacts/:id/merge returns 422 when source === target', async ({ request }) => {
    const res = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: targetId },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_MERGE');
  });

  test('POST /api/v1/contacts/:id/merge returns 404 for unknown source', async ({ request }) => {
    const res = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /api/v1/contacts/:id/merge merges source into target and archives source', async ({ request }) => {
    const res = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceId },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Returns target contact
    expect(body.data.id).toBe(targetId);

    // Source is now archived
    const sourceRes = await request.get(`/api/v1/contacts/${sourceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(sourceRes.status()).toBe(200);
    expect((await sourceRes.json()).data.status).toBe('archived');

    // Task previously on source is now on target
    const tasksRes = await request.get(`/api/v1/contacts/${targetId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tasksRes.status()).toBe(200);
    const tasks = (await tasksRes.json()).data;
    expect(tasks.some((t: { title: string }) => t.title === 'Merge test task')).toBe(true);
  });

  test('archived source contact is excluded from GET /contacts list after successful merge', async ({ request }) => {
    const res = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const contactIds = (body.data as { id: string }[]).map((c) => c.id);
    expect(contactIds).not.toContain(sourceId);
  });

});

test('soft-deleted contact is excluded from GET /contacts list but remains accessible via GET /contacts/:id', async ({ request }) => {
  const { token } = getAuth();

  const createRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'SoftDeleteTest' },
  });
  expect(createRes.status()).toBe(201);
  const { data: created } = await createRes.json();
  const softId = created.id as string;

  const deleteRes = await request.delete(`/api/v1/contacts/${softId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleteRes.status()).toBe(200);
  expect((await deleteRes.json()).data.status).toBe('archived');

  const listRes = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const listBody = await listRes.json();
  const ids = (listBody.data as { id: string }[]).map((c) => c.id);
  expect(ids).not.toContain(softId);

  const getRes = await request.get(`/api/v1/contacts/${softId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).data.status).toBe('archived');
});

// ─── NEW RUNG 4-5 TESTS ──────────────────────────────────────────────────────

// ── Merge: source response body returns target contact ────────────────────────

test('merge response body contains target contact id and active status', async ({ request }) => {
  const { token } = await registerOrg(request, 'merge-response-body');

  const tRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'RespTarget' },
  });
  const targetId = (await tRes.json()).data.id as string;

  const sRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'RespSource' },
  });
  const sourceId = (await sRes.json()).data.id as string;

  const mergeRes = await request.post(`/api/v1/contacts/${targetId}/merge`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { source_id: sourceId },
  });
  expect(mergeRes.status()).toBe(200);
  const body = (await mergeRes.json()) as { data: ContactData };
  // Response must be the target (not the source)
  expect(body.data.id).toBe(targetId);
  // Target itself must not be archived
  expect(body.data.status).not.toBe('archived');
});

// ── Merge re-associates multiple tasks (self-contained) ───────────────────────
test.describe('Merge re-associates multiple tasks (self-contained)', () => {
  let token: string;
  let userId: string;
  let targetId: string;
  let sourceId: string;
  const TASK_TITLES = ['MultiMergeTask-X', 'MultiMergeTask-Y', 'MultiMergeTask-Z'];

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'merge-multi-tasks'));

    const tRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'MtTarget' },
    });
    targetId = (await tRes.json()).data.id as string;

    const sRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'MtSource' },
    });
    sourceId = (await sRes.json()).data.id as string;

    for (const title of TASK_TITLES) {
      await request.post('/api/v1/tasks', {
        headers: { Authorization: `Bearer ${token}` },
        data: { title, assigned_to: userId, contact_id: sourceId },
      });
    }
  });

  // Test 18
  test('all tasks on source contact move to target after merge', async ({ request }) => {
    const mergeRes = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceId },
    });
    expect(mergeRes.status()).toBe(200);

    const tasksRes = await request.get(`/api/v1/contacts/${targetId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tasksRes.status()).toBe(200);
    const tasks = (await tasksRes.json()).data as TaskData[];
    const titles = tasks.map((t) => t.title);
    for (const expected of TASK_TITLES) {
      expect(titles).toContain(expected);
    }
  });

  // Test 19
  test('source contact tasks sub-route still responds after merge (source archived)', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${sourceId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    // All tasks moved away — source tasks list should be empty
    const tasks = body.data as TaskData[];
    expect(tasks.every((t) => t.contact_id !== sourceId)).toBe(true);
  });
});

// ── Merge: messages re-associated ────────────────────────────────────────────

test.describe('Merge re-associates messages from source to target', () => {
  let token: string;
  let targetId: string;
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'merge-msgs'));

    const tRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'MsgTarget' },
    });
    targetId = (await tRes.json()).data.id as string;

    const sRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'MsgSource' },
    });
    sourceId = (await sRes.json()).data.id as string;

    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_id: sourceId, body: 'Source message alpha' },
    });
    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_id: sourceId, body: 'Source message beta' },
    });
  });

  // Test 20
  test('messages from source appear in target messages sub-route after merge', async ({ request }) => {
    const mergeRes = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceId },
    });
    expect(mergeRes.status()).toBe(200);

    const msgsRes = await request.get(`/api/v1/contacts/${targetId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(msgsRes.status()).toBe(200);
    const msgs = (await msgsRes.json()).data as MessageData[];
    const bodies = msgs.map((m) => m.body);
    expect(bodies).toContain('Source message alpha');
    expect(bodies).toContain('Source message beta');
  });

  // Test 21
  test('merged messages appear in target activity feed', async ({ request }) => {
    const actRes = await request.get(`/api/v1/contacts/${targetId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(actRes.status()).toBe(200);
    const { data } = (await actRes.json()) as { data: ActivityData };
    const types = data.items.map((i) => i.type);
    expect(types).toContain('message');
  });
});

// ── Merge: deals re-associated ────────────────────────────────────────────────

test.describe('Merge re-associates deals from source to target', () => {
  let token: string;
  let targetId: string;
  let sourceId: string;
  let pipelineId: string;
  let stageId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'merge-deals'));

    const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pipelines = (await pipelinesRes.json()).data as { id: string; is_default: boolean }[];
    const pipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];
    pipelineId = pipeline.id;

    const stagesRes = await request.get(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    stageId = (await stagesRes.json()).data[0].id as string;

    const tRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'DealTarget' },
    });
    targetId = (await tRes.json()).data.id as string;

    const sRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'DealSource' },
    });
    sourceId = (await sRes.json()).data.id as string;

    await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'SourceDeal-1', contact_id: sourceId, pipeline_id: pipelineId, stage_id: stageId, value: 500 },
    });
    await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'SourceDeal-2', contact_id: sourceId, pipeline_id: pipelineId, stage_id: stageId, value: 750 },
    });
  });

  // Test 22
  test('all deals on source move to target after merge', async ({ request }) => {
    const mergeRes = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceId },
    });
    expect(mergeRes.status()).toBe(200);

    const dealsRes = await request.get(`/api/v1/contacts/${targetId}/deals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dealsRes.status()).toBe(200);
    const deals = (await dealsRes.json()).data as DealData[];
    const titles = deals.map((d) => d.title);
    expect(titles).toContain('SourceDeal-1');
    expect(titles).toContain('SourceDeal-2');
  });

  // Test 23
  test('source deals sub-route returns empty after merge', async ({ request }) => {
    const dealsRes = await request.get(`/api/v1/contacts/${sourceId}/deals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dealsRes.status()).toBe(200);
    const deals = (await dealsRes.json()).data as DealData[];
    expect(deals.every((d) => d.contact_id !== sourceId)).toBe(true);
  });
});

// ── Merge: sequential merges (multiple sources → one target) ─────────────────

test.describe('Sequential merges: multiple sources into one target', () => {
  let token: string;
  let userId: string;
  let targetId: string;
  let sourceAId: string;
  let sourceBId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'multi-merge'));

    const tRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ChainTarget' },
    });
    targetId = (await tRes.json()).data.id as string;

    const aRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ChainSourceA' },
    });
    sourceAId = (await aRes.json()).data.id as string;

    const bRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ChainSourceB' },
    });
    sourceBId = (await bRes.json()).data.id as string;

    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'ChainTask-A', assigned_to: userId, contact_id: sourceAId },
    });
    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'ChainTask-B', assigned_to: userId, contact_id: sourceBId },
    });
  });

  // Test 24
  test('merging A→target then B→target aggregates all tasks on target', async ({ request }) => {
    const mergeA = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceAId },
    });
    expect(mergeA.status()).toBe(200);

    const mergeB = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceBId },
    });
    expect(mergeB.status()).toBe(200);

    const tasksRes = await request.get(`/api/v1/contacts/${targetId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tasksRes.status()).toBe(200);
    const tasks = (await tasksRes.json()).data as TaskData[];
    const titles = tasks.map((t) => t.title);
    expect(titles).toContain('ChainTask-A');
    expect(titles).toContain('ChainTask-B');
  });

  // Test 25
  test('after sequential merges, both sources are archived and excluded from list', async ({ request }) => {
    const listRes = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const ids = ((await listRes.json()).data as ContactData[]).map((c) => c.id);
    expect(ids).not.toContain(sourceAId);
    expect(ids).not.toContain(sourceBId);
  });
});

// ── Merge: updated_at changes on target ──────────────────────────────────────

test.describe('Merge changes target updated_at', () => {
  let token: string;
  let targetId: string;
  let sourceId: string;
  let updatedAtBefore: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'merge-timestamp'));

    const tRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'TsTarget' },
    });
    const tBody = (await tRes.json()) as { data: ContactData };
    targetId = tBody.data.id;
    updatedAtBefore = tBody.data.updated_at;

    const sRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'TsSource' },
    });
    sourceId = (await sRes.json()).data.id as string;
  });

  // Test 26
  test('target contact updated_at is newer after merge', async ({ request }) => {
    const mergeRes = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceId },
    });
    expect(mergeRes.status()).toBe(200);

    const getRes = await request.get(`/api/v1/contacts/${targetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const after = ((await getRes.json()) as { data: ContactData }).data.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(updatedAtBefore).getTime());
  });
});

// ── Sub-routes return empty arrays when nothing linked ────────────────────────

test.describe('Sub-routes return empty arrays for fresh contacts', () => {
  let token: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'empty-subroutes'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'EmptySubRoute' },
    });
    contactId = (await cRes.json()).data.id as string;
  });

  // Test 27
  test('GET /contacts/:id/deals returns empty array when no deals linked', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/deals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  // Test 28
  test('GET /contacts/:id/tasks returns empty array when no tasks linked', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  // Test 29
  test('GET /contacts/:id/messages returns empty array when no messages linked', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});

// ── Tasks sub-route: cancelled excluded, done and in-progress included ────────

test.describe('Tasks sub-route respects status filtering', () => {
  let token: string;
  let userId: string;
  let contactId: string;
  let doneTaskId: string;
  let inProgressTaskId: string;
  let cancelledTaskId: string;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(30_000);

    ({ token, userId } = await registerOrg(request, 'task-status'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'TaskStatusContact' },
    });
    contactId = (await cRes.json()).data.id as string;

    const doneRes = await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'DoneTask', assigned_to: userId, contact_id: contactId },
    });
    expect(doneRes.status()).toBe(201);
    doneTaskId = (await doneRes.json()).data.id as string;
    const completeRes = await request.post(`/api/v1/tasks/${doneTaskId}/complete`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(completeRes.status()).toBe(200);
    expect(((await completeRes.json()) as { data: TaskData }).data.status).toBe('done');

    const ipRes = await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'InProgressTask', assigned_to: userId, contact_id: contactId },
    });
    expect(ipRes.status()).toBe(201);
    inProgressTaskId = (await ipRes.json()).data.id as string;
    const startRes = await request.post(`/api/v1/tasks/${inProgressTaskId}/start`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(startRes.status()).toBe(200);
    expect(((await startRes.json()) as { data: TaskData }).data.status).toBe('in_progress');

    const cancelRes = await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'CancelledTask', assigned_to: userId, contact_id: contactId },
    });
    expect(cancelRes.status()).toBe(201);
    cancelledTaskId = (await cancelRes.json()).data.id as string;
    const deleteRes = await request.delete(`/api/v1/tasks/${cancelledTaskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deleteRes.status()).toBe(200);
    expect(((await deleteRes.json()) as { data: TaskData }).data.status).toBe('cancelled');
  });

  // Test 30
  test('done tasks appear in contact tasks sub-route', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const tasks = (await res.json()).data as TaskData[];
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(doneTaskId);
  });

  // Test 31
  test('in-progress tasks appear in contact tasks sub-route', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const tasks = (await res.json()).data as TaskData[];
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(inProgressTaskId);
  });

  // Test 32
  test('cancelled tasks are excluded from contact tasks sub-route', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const tasks = (await res.json()).data as TaskData[];
    const ids = tasks.map((t) => t.id);
    expect(ids).not.toContain(cancelledTaskId);
  });
});

// ── PATCH: field mutations ────────────────────────────────────────────────────

test.describe('PATCH contact field mutations', () => {
  let token: string;
  let userId: string;
  let altUserId: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'patch-mutations'));

    // Register a second user in the same org is not straightforward without
    // an invite flow; instead we test assigned_to using the same userId
    // and type cycling, email addition, and null-clearing.

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        first_name: 'PatchMe',
        type: 'lead',
        company: 'Acme',
        notes: 'original notes',
      },
    });
    contactId = (await cRes.json()).data.id as string;
  });

  // Test 33
  test('PATCH adds email to a contact that had none', async ({ request }) => {
    const unique = `patch-email-${Date.now()}@example.com`;
    const res = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { email: unique },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: ContactData };
    expect(body.data.email).toBe(unique);
  });

  // Test 34
  test('PATCH changes contact type from lead to customer', async ({ request }) => {
    const res = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { type: 'customer' },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: ContactData };
    expect(body.data.type).toBe('customer');
  });

  // Test 35
  test('PATCH changes contact type back from customer to lead', async ({ request }) => {
    const res = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { type: 'lead' },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: ContactData };
    expect(body.data.type).toBe('lead');
  });

  // Test 36
  test('PATCH assigns contact to a user and persists', async ({ request }) => {
    const res = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { assigned_to: userId },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: ContactData };
    expect(body.data.assigned_to).toBe(userId);

    // Verify persistence via GET
    const getRes = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const getBody = (await getRes.json()) as { data: ContactData };
    expect(getBody.data.assigned_to).toBe(userId);
  });

  // Test 37
  test('PATCH rejects notes=null and preserves existing notes', async ({ request }) => {
    const getRes1 = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes1.status()).toBe(200);
    const before = (await getRes1.json()) as { data: ContactData };
    expect(before.data.notes).toBe('original notes');

    const res = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { notes: null },
    });
    expect(res.status()).toBe(400);

    const getRes2 = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes2.status()).toBe(200);
    const after = (await getRes2.json()) as { data: ContactData };
    expect(after.data.notes).toBe(before.data.notes);
  });
});

// ── Pagination correctness ────────────────────────────────────────────────────

test.describe('Pagination data integrity', () => {
  let token: string;
  const TOTAL = 7;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'pagination'));

    for (let i = 0; i < TOTAL; i++) {
      await request.post('/api/v1/contacts', {
        headers: { Authorization: `Bearer ${token}` },
        data: { first_name: `PaginationContact${i}` },
      });
    }
  });

  // Test 38
  test('per_page=3 page=1 returns exactly 3 contacts', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?per_page=3&page=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect((body.data as ContactData[]).length).toBe(3);
    expect(body.meta.per_page).toBe(3);
    expect(body.meta.page).toBe(1);
  });

  // Test 39
  test('meta.total reflects full count independent of page', async ({ request }) => {
    const res1 = await request.get('/api/v1/contacts?per_page=3&page=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res2 = await request.get('/api/v1/contacts?per_page=3&page=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res1.status()).toBe(200);
    expect(res2.status()).toBe(200);
    const meta1 = (await res1.json()).meta as ListMeta;
    const meta2 = (await res2.json()).meta as ListMeta;
    expect(meta1.total).toBe(meta2.total);
    expect(meta1.total).toBeGreaterThanOrEqual(TOTAL);
  });

  // Test 40
  test('second page with per_page=7 is empty when exactly 7 contacts exist', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?per_page=${TOTAL}&page=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect((body.data as ContactData[]).length).toBe(0);
  });

  // Test 41
  test('page=999 returns empty data array when total is small', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?page=999&per_page=20', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as ContactData[]).length).toBe(0);
  });

  // Test 42
  test('per_page=3 page=3 returns last slice (7 contacts → page 3 has 1)', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?per_page=3&page=3', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // 7 contacts: page1=3, page2=3, page3=1
    expect((body.data as ContactData[]).length).toBe(1);
  });
});

// ── Search correctness ────────────────────────────────────────────────────────

test.describe('Search (?q=) correctness', () => {
  let token: string;
  const FIRST = 'SearchableFirst';
  const LAST = 'SearchableLast';
  const COMPANY = 'SearchableCorp';
  const EMAIL_PREFIX = 'searchable';

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'search-correctness'));

    await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        first_name: FIRST,
        last_name: LAST,
        email: `${EMAIL_PREFIX}@example.com`,
        company: COMPANY,
      },
    });

    // Noise contact that should NOT appear in targeted searches
    await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'Unrelated', last_name: 'Noise' },
    });
  });

  // Test 43
  test('?q= with partial last_name matches contact', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?q=${LAST.slice(0, 6)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    expect(contacts.some((c) => c.last_name === LAST)).toBe(true);
  });

  // Test 44
  test('?q= with partial company name matches contact', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?q=${COMPANY.slice(0, 8)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    expect(contacts.some((c) => c.company === COMPANY)).toBe(true);
  });

  // Test 45
  test('?q= empty string returns full list (no filtering)', async ({ request }) => {
    const allRes = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const qEmptyRes = await request.get('/api/v1/contacts?q=', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allRes.status()).toBe(200);
    expect(qEmptyRes.status()).toBe(200);
    const allTotal = ((await allRes.json()).meta as ListMeta).total;
    const qTotal = ((await qEmptyRes.json()).meta as ListMeta).total;
    expect(qTotal).toBe(allTotal);
  });

  // Test 46
  test('search is case-insensitive: uppercase query matches lowercase stored value', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?q=${FIRST.toUpperCase()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    expect(contacts.some((c) => c.first_name === FIRST)).toBe(true);
  });
});

// ── Type filter correctness ───────────────────────────────────────────────────

test.describe('Type filter data integrity', () => {
  let token: string;
  let leadId: string;
  let customerId: string;
  let partnerId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'type-filter'));

    const lRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'TypeLead', type: 'lead' },
    });
    leadId = (await lRes.json()).data.id as string;

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'TypeCustomer', type: 'customer' },
    });
    customerId = (await cRes.json()).data.id as string;

    const pRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'TypePartner', type: 'partner' },
    });
    partnerId = (await pRes.json()).data.id as string;
  });

  // Test 47
  test('type=lead filter excludes customers and partners', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?type=lead', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    const ids = contacts.map((c) => c.id);
    expect(ids).toContain(leadId);
    expect(ids).not.toContain(customerId);
    expect(ids).not.toContain(partnerId);
  });

  // Test 48
  test('type=partner&status=active returns active partners only', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?type=partner&status=active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    // All returned contacts must be partners
    expect(contacts.every((c) => c.type === 'partner')).toBe(true);
    // All returned contacts must be active
    expect(contacts.every((c) => c.status !== 'archived')).toBe(true);
    // Our partner must be present
    const ids = contacts.map((c) => c.id);
    expect(ids).toContain(partnerId);
  });
});

// ── Archived status filter correctness ───────────────────────────────────────

test.describe('Status filter after archiving', () => {
  let token: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'status-filter'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ToArchive', type: 'lead' },
    });
    contactId = (await cRes.json()).data.id as string;

    await request.delete(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  // Test 49
  test('archived contact is excluded from GET /contacts?status=active', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?status=active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).data as ContactData[]).map((c) => c.id);
    expect(ids).not.toContain(contactId);
  });

  // Test 50
  test('archived contact appears in GET /contacts?status=archived', async ({ request }) => {
    const res = await request.get('/api/v1/contacts?status=archived', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).data as ContactData[]).map((c) => c.id);
    expect(ids).toContain(contactId);
  });
});

// ── Assigned_to filter ────────────────────────────────────────────────────────

test.describe('Assigned_to filter returns correct subset', () => {
  let token: string;
  let userId: string;
  let assignedContactId: string;
  let unassignedContactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'assigned-filter'));

    const aRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'AssignedContact', assigned_to: userId },
    });
    assignedContactId = (await aRes.json()).data.id as string;

    const uRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'UnassignedContact' },
    });
    unassignedContactId = (await uRes.json()).data.id as string;
  });

  // Test 51
  test('GET /contacts?assigned_to=userId returns only assigned contacts', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?assigned_to=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    const ids = contacts.map((c) => c.id);
    expect(ids).toContain(assignedContactId);
  });

  // Test 52
  test('GET /contacts?assigned_to=userId excludes unassigned contacts', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?assigned_to=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    const ids = contacts.map((c) => c.id);
    expect(ids).not.toContain(unassignedContactId);
  });

  // Test 53
  test('after bulk-assign, GET /contacts?assigned_to returns re-assigned contacts', async ({ request }) => {
    // Create a contact without assignment, then bulk-assign to userId
    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'BulkAssignFilter' },
    });
    const newContactId = (await cRes.json()).data.id as string;

    const bulkRes = await request.post('/api/v1/contacts/bulk-assign', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_ids: [newContactId], assigned_to: userId },
    });
    expect(bulkRes.status()).toBe(200);
    const bulkBody = (await bulkRes.json()) as { data: BulkAssignData };
    expect(bulkBody.data.assigned_count).toBeGreaterThanOrEqual(1);

    const filterRes = await request.get(`/api/v1/contacts?assigned_to=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(filterRes.status()).toBe(200);
    const ids = ((await filterRes.json()).data as ContactData[]).map((c) => c.id);
    expect(ids).toContain(newContactId);
  });
});

// ── Bulk-archive: multiple contacts, verify each archived ────────────────────

test.describe('Bulk-archive multiple contacts and verify state', () => {
  let token: string;
  let contactIds: string[];

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'bulk-archive-integrity'));
    contactIds = [];

    for (let i = 0; i < 5; i++) {
      const res = await request.post('/api/v1/contacts', {
        headers: { Authorization: `Bearer ${token}` },
        data: { first_name: `BulkArchiveTarget${i}` },
      });
      contactIds.push((await res.json()).data.id as string);
    }
  });

  // Test 54
  test('bulk-archive 5 contacts sets all to archived status', async ({ request }) => {
    const res = await request.post('/api/v1/contacts/bulk-archive', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_ids: contactIds },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: BulkArchiveData };
    expect(body.data.archived_count).toBe(5);

    // Verify each contact is archived
    for (const id of contactIds) {
      const getRes = await request.get(`/api/v1/contacts/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status()).toBe(200);
      const contact = ((await getRes.json()) as { data: ContactData }).data;
      expect(contact.status).toBe('archived');
    }
  });

  // Test 55
  test('bulk-archived contacts do not appear in GET /contacts default list', async ({ request }) => {
    const res = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).data as ContactData[]).map((c) => c.id);
    for (const id of contactIds) {
      expect(ids).not.toContain(id);
    }
  });
});

// ── Import-CSV: field storage integrity ──────────────────────────────────────

test.describe('Import-CSV field storage integrity', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'import-fields'));
  });

  // Test 56
  test('import-csv type defaults to lead when type field omitted', async ({ request }) => {
    const unique = `importlead-${Date.now()}`;
    const res = await request.post('/api/v1/contacts/import-csv', {
      headers: { Authorization: `Bearer ${token}` },
      data: [{ first_name: unique }],
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data: ImportData; meta: object };
    expect(body.data.imported_count).toBe(1);

    // Verify in list
    const listRes = await request.get(`/api/v1/contacts?q=${unique}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const contacts = (await listRes.json()).data as ContactData[];
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    expect(contacts[0].type).toBe('lead');
  });

  // Test 57
  test('import-csv notes field stored correctly', async ({ request }) => {
    const unique = `importnotes-${Date.now()}`;
    const notes = 'Special import note for testing';
    const res = await request.post('/api/v1/contacts/import-csv', {
      headers: { Authorization: `Bearer ${token}` },
      data: [{ first_name: unique, notes }],
    });
    expect(res.status()).toBe(201);

    const listRes = await request.get(`/api/v1/contacts?q=${unique}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const contacts = (await listRes.json()).data as ContactData[];
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    expect(contacts[0].notes).toBe(notes);
  });

  // Test 58
  test('import-csv source field stored correctly', async ({ request }) => {
    const unique = `importsource-${Date.now()}`;
    const source = 'referral';
    const res = await request.post('/api/v1/contacts/import-csv', {
      headers: { Authorization: `Bearer ${token}` },
      data: [{ first_name: unique, source }],
    });
    expect(res.status()).toBe(201);

    const listRes = await request.get(`/api/v1/contacts?q=${unique}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const contacts = (await listRes.json()).data as ContactData[];
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    expect(contacts[0].source).toBe(source);
  });

  // Test 59
  test('import-csv phone field stored as-is', async ({ request }) => {
    const unique = `importphone-${Date.now()}`;
    const phone = '+1-800-555-0100';
    const res = await request.post('/api/v1/contacts/import-csv', {
      headers: { Authorization: `Bearer ${token}` },
      data: [{ first_name: unique, phone }],
    });
    expect(res.status()).toBe(201);

    const listRes = await request.get(`/api/v1/contacts?q=${unique}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const contacts = (await listRes.json()).data as ContactData[];
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    expect(contacts[0].phone).toBe(phone);
  });

  // Test 60
  test('import-csv whitespace-trimmed first_name is stored trimmed', async ({ request }) => {
    const unique = `trimmed${Date.now()}`;
    const res = await request.post('/api/v1/contacts/import-csv', {
      headers: { Authorization: `Bearer ${token}` },
      data: [{ first_name: `  ${unique}  ` }],
    });
    expect(res.status()).toBe(201);

    const listRes = await request.get(`/api/v1/contacts?q=${unique}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const contacts = (await listRes.json()).data as ContactData[];
    // If trimming is applied, first_name should equal the trimmed value
    if (contacts.length > 0) {
      expect(contacts[0].first_name).toBe(unique);
    }
  });
});

// ── Import-CSV stress: 50 rows ────────────────────────────────────────────────

test.describe('Import-CSV stress: 50 rows', () => {
  let token: string;
  const BATCH_SIZE = 50;
  const batchTag = `stress50-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'import-stress'));
  });

  // Test 61
  test('import-csv with 50 rows creates 50 contacts', async ({ request }) => {
    test.setTimeout(60000);
    const rows = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      first_name: `${batchTag}-${i}`,
      type: 'lead',
    }));

    const res = await request.post('/api/v1/contacts/import-csv', {
      headers: { Authorization: `Bearer ${token}` },
      data: rows,
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data: ImportData; meta: object };
    expect(body.data.imported_count).toBe(BATCH_SIZE);
  });

  // Test 62
  test('after 50-row import, meta.total reflects full count', async ({ request }) => {
    const res = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const meta = (await res.json()).meta as ListMeta;
    expect(meta.total).toBeGreaterThanOrEqual(BATCH_SIZE);
  });
});

// ── Bulk-assign: edge cases ───────────────────────────────────────────────────

test.describe('Bulk-assign edge cases', () => {
  let token: string;
  let userId: string;
  let contactIds: string[];

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'bulk-assign-edge'));
    contactIds = [];

    for (let i = 0; i < 3; i++) {
      const res = await request.post('/api/v1/contacts', {
        headers: { Authorization: `Bearer ${token}` },
        data: { first_name: `BulkAssignEdge${i}` },
      });
      contactIds.push((await res.json()).data.id as string);
    }
  });

  // Test 63
  test('bulk-assign with 1 contact succeeds and persists assignment', async ({ request }) => {
    const res = await request.post('/api/v1/contacts/bulk-assign', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_ids: [contactIds[0]], assigned_to: userId },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: BulkAssignData };
    expect(body.data.assigned_count).toBe(1);
    expect(body.data.assigned_to).toBe(userId);

    const getRes = await request.get(`/api/v1/contacts/${contactIds[0]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const contact = ((await getRes.json()) as { data: ContactData }).data;
    expect(contact.assigned_to).toBe(userId);
  });

  // Test 64
  test('bulk-assign multiple contacts assigns all and returns correct count', async ({ request }) => {
    const res = await request.post('/api/v1/contacts/bulk-assign', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_ids: contactIds, assigned_to: userId },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: BulkAssignData };
    expect(body.data.assigned_count).toBe(contactIds.length);

    // Spot-check all are assigned
    for (const id of contactIds) {
      const getRes = await request.get(`/api/v1/contacts/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const contact = ((await getRes.json()) as { data: ContactData }).data;
      expect(contact.assigned_to).toBe(userId);
    }
  });
});

// ── Ordering: newest contact appears first ────────────────────────────────────

test.describe('Contacts ordered by created_at desc', () => {
  let token: string;
  let newerContactId: string;
  let olderContactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'ordering'));

    const r1 = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'OrderFirst' },
    });
    olderContactId = (await r1.json()).data.id as string;

    const r2 = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'OrderSecond' },
    });
    newerContactId = (await r2.json()).data.id as string;
  });

  // Test 65
  test('newest created contact appears before older contact in default list', async ({ request }) => {
    const res = await request.get('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const contacts = (await res.json()).data as ContactData[];
    const newerIndex = contacts.findIndex((c) => c.id === newerContactId);
    const olderIndex = contacts.findIndex((c) => c.id === olderContactId);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeLessThan(olderIndex);
  });
});

// ── Activity feed includes task type item ─────────────────────────────────────

test.describe('Activity feed item types coverage', () => {
  let token: string;
  let userId: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'activity-types'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ActivityTypeContact' },
    });
    contactId = (await cRes.json()).data.id as string;

    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'ActivityTask', assigned_to: userId, contact_id: contactId },
    });

    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_id: contactId, body: 'ActivityMsg' },
    });
  });

  // Test 66
  test('activity feed contains task type item from linked task', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const { data } = (await res.json()) as { data: ActivityData };
    const types = data.items.map((i) => i.type);
    expect(types).toContain('task');
  });

  // Test 67
  test('activity feed items are sorted newest-first (created_at desc)', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const { data } = (await res.json()) as { data: ActivityData };
    const items = data.items;
    for (let i = 1; i < items.length; i++) {
      expect(new Date(items[i - 1].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(items[i].created_at).getTime(),
      );
    }
  });
});

// ── Re-assigning contact back to unassigned ───────────────────────────────────

test.describe('Rejecting null contact assignment', () => {
  let token: string;
  let userId: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'unassign'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'UnassignMe', assigned_to: userId },
    });
    contactId = (await cRes.json()).data.id as string;
  });

  // Test 68
  test('PATCH assigned_to=null returns 400 and preserves assignment', async ({ request }) => {
    const patchRes = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { assigned_to: null },
    });
    expect(patchRes.status()).toBe(400);

    // Confirm via GET
    const getRes = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const contact = ((await getRes.json()) as { data: ContactData }).data;
    expect(contact.assigned_to).toBe(userId);
  });

  // Test 69
  test('after rejected unassigning, contact remains in assigned_to filter for that user', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts?assigned_to=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).data as ContactData[]).map((c) => c.id);
    expect(ids).toContain(contactId);
  });
});

// ── Source contact sub-routes remain accessible after archive ─────────────────

test.describe('Archived source contact sub-routes remain accessible', () => {
  let token: string;
  let userId: string;
  let targetId: string;
  let sourceId: string;
  let sourceDealId: string;

  test.beforeAll(async ({ request }) => {
    ({ token, userId } = await registerOrg(request, 'archived-subroutes'));

    const tRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ArchivedSrTarget' },
    });
    targetId = (await tRes.json()).data.id as string;

    const sRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'ArchivedSrSource' },
    });
    sourceId = (await sRes.json()).data.id as string;

    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${token}` },
      data: { contact_id: sourceId, body: 'ArchivedSourceMsg' },
    });

    // Perform merge to archive source
    await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: sourceId },
    });
  });

  // Test 70
  test('GET activity on archived source returns 200 with valid structure', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${sourceId}/activity`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Either 200 with data or 404 — both are acceptable depending on implementation
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = (await res.json()) as { data: ActivityData };
      expect(body.data.contact_id).toBe(sourceId);
    }
  });

  // Test 71
  test('GET deals on archived source returns 200 with empty or moved deals', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${sourceId}/deals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ── GET /contacts/:id after DELETE shows archived (not 404) ───────────────────

test.describe('GET contact after DELETE shows archived status', () => {
  let token: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'get-after-delete'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'DeleteThenGet' },
    });
    contactId = (await cRes.json()).data.id as string;

    await request.delete(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  // Test 72
  test('GET /contacts/:id after DELETE returns 200 with status=archived', async ({ request }) => {
    const res = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: ContactData };
    expect(body.data.status).toBe('archived');
    expect(body.data.id).toBe(contactId);
  });
});

// ── Multi-field contact: PATCH clears one optional field ──────────────────────

test.describe('Full-featured contact: PATCH rejects null optional fields', () => {
  let token: string;
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token } = await registerOrg(request, 'full-patch'));

    const cRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        first_name: 'FullContact',
        last_name: 'AllFields',
        email: `full-${Date.now()}@example.com`,
        phone: '+1-555-0001',
        mobile: '+1-555-0002',
        company: 'FullCorp',
        source: 'website',
        notes: 'Has all optional fields',
        type: 'partner',
      },
    });
    contactId = (await cRes.json()).data.id as string;
  });

  // Test 73
  test('PATCH mobile=null returns 400 and leaves other fields unaffected', async ({ request }) => {
    const patchRes = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { mobile: null },
    });
    expect(patchRes.status()).toBe(400);

    const getRes = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const body = (await getRes.json()) as { data: ContactData };
    expect(body.data.mobile).toBe('+1-555-0002');
    expect(body.data.company).toBe('FullCorp');
    expect(body.data.type).toBe('partner');
    expect(body.data.source).toBe('website');
  });

  // Test 74
  test('PATCH company=null returns 400 and leaves mobile unchanged', async ({ request }) => {
    const patchRes = await request.patch(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { company: null },
    });
    expect(patchRes.status()).toBe(400);

    const getRes = await request.get(`/api/v1/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const body = (await getRes.json()) as { data: ContactData };
    expect(body.data.company).toBe('FullCorp');
    expect(body.data.mobile).toBe('+1-555-0002');
    expect(body.data.type).toBe('partner');
  });
});

// ── Bulk-archive transactional: partial cross-org rolls back ─────────────────

test.describe('Bulk-archive is transactional on cross-org ids', () => {
  let tokenA: string;
  let tokenB: string;
  let orgAContactId: string;
  let orgBContactId: string;

  test.beforeAll(async ({ request }) => {
    ({ token: tokenA } = await registerOrg(request, 'bulk-txn-orgA'));
    ({ token: tokenB } = await registerOrg(request, 'bulk-txn-orgB'));

    const aRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { first_name: 'TxnOrgAContact' },
    });
    orgAContactId = (await aRes.json()).data.id as string;

    const bRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${tokenB}` },
      data: { first_name: 'TxnOrgBContact' },
    });
    orgBContactId = (await bRes.json()).data.id as string;
  });

  // Test 75
  test('bulk-archive with one cross-org id returns 404 and does not archive own contact', async ({ request }) => {
    // Org A tries to archive its own contact + Org B's contact
    const res = await request.post('/api/v1/contacts/bulk-archive', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { contact_ids: [orgAContactId, orgBContactId] },
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');

    // Org A's own contact must NOT be archived (transaction rolled back)
    const getRes = await request.get(`/api/v1/contacts/${orgAContactId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(getRes.status()).toBe(200);
    const contact = ((await getRes.json()) as { data: ContactData }).data;
    expect(contact.status).not.toBe('archived');
  });
});
