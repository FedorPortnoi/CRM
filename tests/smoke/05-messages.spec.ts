import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

let contactId: string;

test.beforeAll(async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'MsgContact', phone: '+15550001234' },
  });
  const body = await res.json();
  contactId = body.data.id;
});

test('GET /api/v1/messages returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/messages/in-app sends in-app message', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, body: 'Hello smoke test' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.channel).toBe('in_app');
});

test('POST /api/v1/messages/log-call logs a call', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, direction: 'outbound', duration_seconds: 120, notes: 'Smoke call' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.channel).toBe('in_app');
});

test('GET /api/v1/messages/conversation/:contactId returns thread', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get(`/api/v1/messages/conversation/${contactId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});
