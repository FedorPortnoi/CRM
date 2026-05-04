import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

function futureEvent() {
  const startTime = new Date(Date.now() + 3600 * 1000).toISOString();
  const endTime = new Date(Date.now() + 7200 * 1000).toISOString();
  return { startTime, endTime };
}

test('GET /api/v1/calendar returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/calendar creates event', async ({ request }) => {
  const { token } = getAuth();
  const { startTime, endTime } = futureEvent();
  const res = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Smoke Meeting', start_time: startTime, end_time: endTime },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.status).toBe('scheduled');
});

test('PATCH /api/v1/calendar/:id updates event', async ({ request }) => {
  const { token } = getAuth();
  const { startTime, endTime } = futureEvent();
  const create = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Update Me', start_time: startTime, end_time: endTime },
  });
  const { data: event } = await create.json();

  const res = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Updated Meeting' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.title).toBe('Updated Meeting');
});

test('DELETE /api/v1/calendar/:id cancels event (status=cancelled)', async ({ request }) => {
  const { token } = getAuth();
  const { startTime, endTime } = futureEvent();
  const create = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Cancel Me', start_time: startTime, end_time: endTime },
  });
  const { data: event } = await create.json();

  const res = await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('cancelled');
});

test('GET /api/v1/calendar/availability returns slots', async ({ request }) => {
  const { token, userId } = getAuth();
  const date = new Date().toISOString().split('T')[0];
  const res = await request.get(
    `/api/v1/calendar/availability?date=${date}&user_ids=${userId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toBeDefined();
});

test('GET /api/v1/calendar/sync/status returns sync state', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar/sync/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({ connected: false });
});

test('GET /api/v1/calendar/sync/google/auth returns 501 (not configured)', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar/sync/google/auth', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(501);
});
