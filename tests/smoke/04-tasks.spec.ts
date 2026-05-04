import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

test('GET /api/v1/tasks returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/tasks creates task', async ({ request }) => {
  const { token, userId } = getAuth();
  const res = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Smoke Task', assigned_to: userId },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.title).toBe('Smoke Task');
});

test('GET /api/v1/tasks/:id returns task', async ({ request }) => {
  const { token, userId } = getAuth();
  const create = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Get Task', assigned_to: userId },
  });
  const { data: task } = await create.json();

  const res = await request.get(`/api/v1/tasks/${task.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.id).toBe(task.id);
});

test('PATCH /api/v1/tasks/:id/complete marks task complete', async ({ request }) => {
  const { token, userId } = getAuth();
  const create = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Complete Me', assigned_to: userId },
  });
  const { data: task } = await create.json();

  const res = await request.post(`/api/v1/tasks/${task.id}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('done');
});

test('DELETE /api/v1/tasks/:id cancels task (status=cancelled)', async ({ request }) => {
  const { token, userId } = getAuth();
  const create = await request.post('/api/v1/tasks', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Cancel Me', assigned_to: userId },
  });
  const { data: task } = await create.json();

  const res = await request.delete(`/api/v1/tasks/${task.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('cancelled');
});

test('GET /api/v1/tasks/today returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/tasks/today', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/tasks/overdue returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/tasks/overdue', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});
