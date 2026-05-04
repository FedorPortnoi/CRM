import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

test('GET /api/v1/analytics/funnel returns funnel data', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/funnel', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    stages: expect.any(Array),
    summary: expect.any(Object),
  });
});

test('GET /api/v1/analytics/revenue returns revenue data', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/revenue', {
    headers: { Authorization: `Bearer ${token}` },
    params: { period: 'month' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    periods: expect.any(Array),
    summary: expect.any(Object),
  });
});
