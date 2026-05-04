import { test, expect } from '@playwright/test';

test('GET /health returns 200', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: 'ok' });
});
