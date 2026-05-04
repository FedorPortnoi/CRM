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
