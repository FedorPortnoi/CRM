import { test, expect } from '@playwright/test';

test.describe.configure({ timeout: 30000 });

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

// ─── Auth gates: extended endpoints ──────────────────────────────────────────

test('GET /api/v1/deals without Authorization returns 401 with @fastify/jwt error shape', async ({ request }) => {
  const res = await request.get('/api/v1/deals');
  expect(res.status()).toBe(401);
  const body: { statusCode: number; message: string } = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
});

test('GET /api/v1/messages without Authorization returns 401 with @fastify/jwt error shape', async ({ request }) => {
  const res = await request.get('/api/v1/messages');
  expect(res.status()).toBe(401);
  const body: { statusCode: number; message: string } = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
});

test('GET /api/v1/calendar without Authorization returns 401 with @fastify/jwt error shape', async ({ request }) => {
  const res = await request.get('/api/v1/calendar');
  expect(res.status()).toBe(401);
  const body: { statusCode: number; message: string } = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
});

test('GET /api/v1/analytics/dashboard with malformed (non-JWT) Authorization token returns 401', async ({ request }) => {
  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: 'Bearer this-is-not-a-jwt' },
  });
  expect(res.status()).toBe(401);
  const body: { statusCode: number; message: string } = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
});

test('GET /api/v1/contacts with expired-like Bearer token (plain text) returns 401', async ({ request }) => {
  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: 'Bearer just-some-plain-text' },
  });
  expect(res.status()).toBe(401);
  const body: { statusCode: number; message: string } = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
});

// ─── Contacts screen: pagination and empty-query behaviour ───────────────────

type Contact = { id: string; first_name: string; last_name: string; email?: string | null };

interface ListMeta { total: number; page: number; per_page: number }
interface ListBody<T> { data: T[]; meta: ListMeta }

test('GET /api/v1/contacts?per_page=2 with 3 contacts returns data.length=2 and meta.total=3', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-page-size-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens PageSize User',
      org_name: 'Screens PageSize Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  for (const n of ['Alice', 'Bob', 'Carol']) {
    const r = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: n, last_name: 'Page' },
    });
    expect(r.status()).toBe(201);
  }

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    params: { per_page: '2', page: '1' },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Contact> = await res.json();
  expect(body.data).toHaveLength(2);
  expect(body.meta.total).toBe(3);
  expect(body.meta.per_page).toBe(2);
});

test('GET /api/v1/contacts?page=2&per_page=2 with 3 contacts returns data.length=1 (second page)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-page2-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Page2 User',
      org_name: 'Screens Page2 Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  for (const n of ['Dave', 'Eve', 'Frank']) {
    const r = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: n, last_name: 'Paginate' },
    });
    expect(r.status()).toBe(201);
  }

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    params: { per_page: '2', page: '2' },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Contact> = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.meta.page).toBe(2);
});

test('GET /api/v1/contacts?q= (empty string) returns all contacts (no unintended filter)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-empty-q-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens EmptyQ User',
      org_name: 'Screens EmptyQ Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  for (const n of ['Grace', 'Heidi']) {
    const r = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: n, last_name: 'EmptyQ' },
    });
    expect(r.status()).toBe(201);
  }

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: '' },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Contact> = await res.json();
  expect(body.meta.total).toBe(2);
});

test('GET /api/v1/contacts?q=<exact-email> returns only the contact with that email', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-email-q-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens EmailQ User',
      org_name: 'Screens EmailQ Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const uniqueEmail = `find-me-${Date.now()}@example.com`;
  const aRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Target', last_name: 'EmailSearch', email: uniqueEmail },
  });
  const bRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Other', last_name: 'Person', email: `other-${Date.now()}@example.com` },
  });
  expect(aRes.status()).toBe(201);
  expect(bRes.status()).toBe(201);
  const targetId: string = (await aRes.json()).data.id;
  const otherId: string = (await bRes.json()).data.id;

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: uniqueEmail },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Contact> = await res.json();
  const ids = body.data.map((c) => c.id);
  expect(ids).toContain(targetId);
  expect(ids).not.toContain(otherId);
});

// ─── Tasks screen: status filtering edge-cases ────────────────────────────────

test('done task (status=done) is present in GET /api/v1/tasks default list (done is not excluded by default)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-done-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Done User',
      org_name: 'Screens Done Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const token: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Task to complete', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const completeRes = await request.post(`/api/v1/tasks/${taskId}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(completeRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const ids = ((await listRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).toContain(taskId);
});

test('in-progress task appears in GET /api/v1/tasks default list', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-inprog-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens InProg User',
      org_name: 'Screens InProg Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const token: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Task to start', assigned_to: userId },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const startRes = await request.post(`/api/v1/tasks/${taskId}/start`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(startRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const tasks = (await listRes.json()).data as Task[];
  const found = tasks.find((t) => t.id === taskId);
  expect(found).toBeDefined();
  expect(found!.status).toBe('in_progress');
});

test('GET /api/v1/tasks/overdue returns tasks with past due_date and status pending', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-overdue2-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens Overdue2 User',
      org_name: 'Screens Overdue2 Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const token: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Past-due pending task', assigned_to: userId, due_date: yesterdayNoonUTC() },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const overdueRes = await request.get('/api/v1/tasks/overdue', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(overdueRes.status()).toBe(200);
  const ids = ((await overdueRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).toContain(taskId);
});

test('GET /api/v1/tasks/overdue excludes cancelled tasks even when past due_date', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-overdue-cancel-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens OverdueCancel User',
      org_name: 'Screens OverdueCancel Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const token: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Past-due cancelled task', assigned_to: userId, due_date: yesterdayNoonUTC() },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const cancelRes = await request.delete(`/api/v1/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(cancelRes.status()).toBe(200);

  const overdueRes = await request.get('/api/v1/tasks/overdue', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(overdueRes.status()).toBe(200);
  const ids = ((await overdueRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).not.toContain(taskId);
});

test('GET /api/v1/tasks/overdue excludes done tasks even when past due_date', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-overdue-done-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens OverdueDone User',
      org_name: 'Screens OverdueDone Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const token: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Past-due done task', assigned_to: userId, due_date: yesterdayNoonUTC() },
  });
  expect(createRes.status()).toBe(201);
  const taskId: string = (await createRes.json()).data.id;

  const completeRes = await request.post(`/api/v1/tasks/${taskId}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(completeRes.status()).toBe(200);

  const overdueRes = await request.get('/api/v1/tasks/overdue', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(overdueRes.status()).toBe(200);
  const ids = ((await overdueRes.json()).data as Task[]).map((t) => t.id);
  expect(ids).not.toContain(taskId);
});

// ─── Pipeline / Kanban screen ─────────────────────────────────────────────────

type Pipeline = { id: string; name: string; is_default: boolean; stages: Stage[] };
type Stage    = { id: string; name: string; position: number };
type Deal     = { id: string; title: string; status: string; value?: number | null };

test('brand-new org has exactly one pipeline after registration', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-pipe-count-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens PipeCount User',
      org_name: 'Screens PipeCount Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Pipeline> = await res.json();
  expect(body.data).toHaveLength(1);
});

test('GET /api/v1/deals/pipelines for brand-new org returns is_default=true pipeline named Sales Pipeline', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-pipe-default-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens PipeDefault User',
      org_name: 'Screens PipeDefault Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Pipeline> = await res.json();
  const pipeline = body.data[0];
  expect(pipeline.is_default).toBe(true);
  expect(pipeline.name).toBe('Sales Pipeline');
  expect(Array.isArray(pipeline.stages)).toBe(true);
});

test('GET /api/v1/deals?status=won returns only won deals', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-deals-won-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DealsWon User',
      org_name: 'Screens DealsWon Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const pipeRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(pipeRes.status()).toBe(200);
  const pipeBody: ListBody<Pipeline> = await pipeRes.json();
  const pipeline: Pipeline = pipeBody.data[0];
  const pipelineId: string = pipeline.id;
  const stageId: string = pipeline.stages[0].id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'WonFilter', last_name: 'Test' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId: string = (await contactRes.json()).data.id;

  const openRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Open Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 100 },
  });
  expect(openRes.status()).toBe(201);
  const openId: string = (await openRes.json()).data.id;

  const wonRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Won Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 200 },
  });
  expect(wonRes.status()).toBe(201);
  const wonId: string = (await wonRes.json()).data.id;

  const markWonRes = await request.post(`/api/v1/deals/${wonId}/won`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(markWonRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    params: { status: 'won' },
  });
  expect(listRes.status()).toBe(200);
  const listBody: ListBody<Deal> = await listRes.json();
  const ids = listBody.data.map((d) => d.id);
  expect(ids).toContain(wonId);
  expect(ids).not.toContain(openId);
  listBody.data.forEach((d) => expect(d.status).toBe('won'));
});

test('GET /api/v1/deals?status=lost returns only lost deals', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-deals-lost-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DealsLost User',
      org_name: 'Screens DealsLost Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const pipeRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(pipeRes.status()).toBe(200);
  const pipeBody: ListBody<Pipeline> = await pipeRes.json();
  const pipeline: Pipeline = pipeBody.data[0];
  const pipelineId: string = pipeline.id;
  const stageId: string = pipeline.stages[0].id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'LostFilter', last_name: 'Test' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId: string = (await contactRes.json()).data.id;

  const openRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Still Open Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 50 },
  });
  expect(openRes.status()).toBe(201);
  const openId: string = (await openRes.json()).data.id;

  const lostCreateRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Lost Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 75 },
  });
  expect(lostCreateRes.status()).toBe(201);
  const lostId: string = (await lostCreateRes.json()).data.id;

  const markLostRes = await request.post(`/api/v1/deals/${lostId}/lost`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(markLostRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    params: { status: 'lost' },
  });
  expect(listRes.status()).toBe(200);
  const listBody: ListBody<Deal> = await listRes.json();
  const ids = listBody.data.map((d) => d.id);
  expect(ids).toContain(lostId);
  expect(ids).not.toContain(openId);
  listBody.data.forEach((d) => expect(d.status).toBe('lost'));
});

test('GET /api/v1/deals for brand-new org returns empty data array', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-deals-empty-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DealsEmpty User',
      org_name: 'Screens DealsEmpty Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: ListBody<Deal> = await res.json();
  expect(body.data).toHaveLength(0);
  expect(body.meta.total).toBe(0);
});

// ─── Dashboard screen ─────────────────────────────────────────────────────────

interface DashboardData {
  open_deals: { count: number; total_value: number };
  tasks_due_today: number;
  recent_activity: unknown[];
  pipeline_health_score: number;
}
interface DashboardBody { data: DashboardData; meta: Record<string, unknown> }

test('dashboard pipeline_health_score is a number between 0 and 1 (inclusive)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-dash-score-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DashScore User',
      org_name: 'Screens DashScore Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: DashboardBody = await res.json();
  const score = body.data.pipeline_health_score;
  expect(typeof score).toBe('number');
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThanOrEqual(1);
});

test('dashboard for org with no deals returns open_deals.count=0 and total_value=0', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-dash-nodeals-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DashNoDeals User',
      org_name: 'Screens DashNoDeals Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: DashboardBody = await res.json();
  expect(body.data.open_deals.count).toBe(0);
  expect(body.data.open_deals.total_value).toBe(0);
});

test('dashboard recent_activity is an array (may be empty for new org)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-dash-activity-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DashActivity User',
      org_name: 'Screens DashActivity Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: DashboardBody = await res.json();
  expect(Array.isArray(body.data.recent_activity)).toBe(true);
});

test('dashboard tasks_due_today=0 for org with no tasks due today', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `screens-dash-notasks-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Screens DashNoTasks User',
      org_name: 'Screens DashNoTasks Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const token: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body: DashboardBody = await res.json();
  expect(body.data.tasks_due_today).toBe(0);
});

// ─── Calendar screen ──────────────────────────────────────────────────────────

test('GET /api/v1/calendar without Authorization returns 401 with statusCode=401 in body', async ({ request }) => {
  const res = await request.get('/api/v1/calendar');
  expect(res.status()).toBe(401);
  const body: { statusCode: number; error: string; message: string } = await res.json();
  expect(body.statusCode).toBe(401);
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
});
