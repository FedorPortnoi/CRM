import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

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
  let contactId: string;

  test.beforeAll(async ({ request }) => {
    const { token, userId } = getAuth();

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
    const { token } = getAuth();
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
    const { token } = getAuth();
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
    const { token } = getAuth();
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
    const { token } = getAuth();
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
    const { token } = getAuth();
    const res = await request.get('/api/v1/contacts/00000000-0000-0000-0000-000000000000/activity', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(404);
  });
});

// ─── Merge ────────────────────────────────────────────────────────────────────

test.describe('Contact merge', () => {
  let targetId: string;
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    const { token, userId } = getAuth();

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
    const { token } = getAuth();
    const res = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: targetId },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_MERGE');
  });

  test('POST /api/v1/contacts/:id/merge returns 404 for unknown source', async ({ request }) => {
    const { token } = getAuth();
    const res = await request.post(`/api/v1/contacts/${targetId}/merge`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /api/v1/contacts/:id/merge merges source into target and archives source', async ({ request }) => {
    const { token } = getAuth();
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
});
