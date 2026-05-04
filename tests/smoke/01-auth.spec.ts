import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

test('global-setup registered a user with token', () => {
  const auth = getAuth();
  expect(auth.token).toBeTruthy();
  expect(auth.userId).toBeTruthy();
  expect(auth.email).toMatch(/smoke-\d+@test\.com/);
});

test('POST /api/v1/auth/login returns token for registered user', async ({ request }) => {
  const { email } = getAuth();
  const res = await request.post('/api/v1/auth/login', {
    data: { email, password: 'SmokeTest123!' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.token).toBeTruthy();
});

test('POST /api/v1/auth/login rejects wrong password', async ({ request }) => {
  const { email } = getAuth();
  const res = await request.post('/api/v1/auth/login', {
    data: { email, password: 'WrongPassword!' },
  });
  expect(res.status()).toBe(401);
});
