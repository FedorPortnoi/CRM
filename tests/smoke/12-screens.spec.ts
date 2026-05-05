import { test, expect } from '@playwright/test';

type Task = { id: string; status: string; due_date: string | null };

function tomorrowNoonUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

function yesterdayNoonUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

function todayNoonUTC(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

// ─── Auth gate ────────────────────────────────────────────────────────────────
// @fastify/jwt returns { statusCode, error, message } for missing/invalid tokens.

test('GET /api/v1/analytics/dashboard without Authorization returns 401 with non-empty message', async ({ request }) => {
  const res = await request.get('/api/v1/analytics/dashboard');
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect((body.message as string).length).toBeGreaterThan(0);
});

test('GET /api/v1/contacts without Authorization returns 401 with non-empty message', async ({ request }) => {
  const res = await request.get('/api/v1/contacts');
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect((body.message as string).length).toBeGreaterThan(0);
});

test('GET /api/v1/tasks/today without Authorization returns 401 with non-empty message', async ({ request }) => {
  const res = await request.get('/api/v1/tasks/today');
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect((body.message as string).length).toBeGreaterThan(0);
});

// ─── Contacts: empty state ────────────────────────────────────────────────────

test('GET /api/v1/contacts for a brand-new org returns an empty data array (contacts empty state)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-empty-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Empty User',
      org_name: 'Screens Empty Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(0);
  expect(body.meta.total).toBe(0);
});

// ─── Contacts: server-side search ────────────────────────────────────────────

test('GET /api/v1/contacts?q=<term> returns only contacts whose name contains the search term', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-search-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Search User',
      org_name: 'Screens Search Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const aRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { first_name: 'Xenophon', last_name: 'Alpha' },
  });
  const bRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { first_name: 'Zephyr', last_name: 'Beta' },
  });
  expect(aRes.status()).toBe(201);
  expect(bRes.status()).toBe(201);
  const aId: string = (await aRes.json()).data.id;
  const bId: string = (await bRes.json()).data.id;

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    params: { q: 'Xenophon' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const ids = (body.data as { id: string }[]).map((c) => c.id);
  expect(ids).toContain(aId);
  expect(ids).not.toContain(bId);
});

// ─── Tasks: cancelled excluded ────────────────────────────────────────────────

test('cancelled task is absent from GET /api/v1/tasks default list (status integrity)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-cancel-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Cancel User',
      org_name: 'Screens Cancel Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { title: 'Task to cancel', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const cancelRes = await request.delete(`/api/v1/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(cancelRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(listRes.status()).toBe(200);
  const ids = ((await listRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).not.toContain(taskId);
});

// ─── Tasks: today boundary ────────────────────────────────────────────────────

test('task due tomorrow is absent from GET /api/v1/tasks/today (today-filter boundary)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-tomorrow-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Tomorrow User',
      org_name: 'Screens Tomorrow Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { title: 'Due tomorrow task', assigned_to: userId, due_date: tomorrowNoonUTC() },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const todayRes = await request.get('/api/v1/tasks/today', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(todayRes.status()).toBe(200);
  const ids = ((await todayRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).not.toContain(taskId);
});

test('overdue task (past due_date, pending) appears in GET /api/v1/tasks but not in GET /api/v1/tasks/today', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-overdue-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Overdue User',
      org_name: 'Screens Overdue Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { title: 'Overdue task', assigned_to: userId, due_date: yesterdayNoonUTC() },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const allRes = await request.get('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(allRes.status()).toBe(200);
  const allIds = ((await allRes.json()).data as Task[]).map((t) => t.id);
  expect(allIds).toContain(taskId);

  const todayRes = await request.get('/api/v1/tasks/today', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(todayRes.status()).toBe(200);
  const todayIds = ((await todayRes.json()).data as Task[]).map((t) => t.id);
  expect(todayIds).not.toContain(taskId);
});

test('GET /api/v1/tasks/today includes a task with due_date set to noon UTC today', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-today-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Today User',
      org_name: 'Screens Today Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { title: 'Due today task', assigned_to: userId, due_date: todayNoonUTC() },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const todayRes = await request.get('/api/v1/tasks/today', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(todayRes.status()).toBe(200);
  const ids = ((await todayRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).toContain(taskId);
});
