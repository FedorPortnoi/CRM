import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  org_id: string;
}

interface AuthResponse {
  data: {
    user: AuthUser;
    token: string;
  };
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

test('POST /api/v1/auth/ registers a new user and returns token + user shape', async ({ request }) => {
  const email = 'auth-smoke-' + Date.now() + '@test.com';
  const res = await request.post('/api/v1/auth/', {
    data: { email, password: 'Test123!', name: 'Auth Test', org_name: 'Auth Test Org' },
  });
  expect(res.status()).toBe(201);
  const body: AuthResponse = await res.json();
  expect(typeof body.data.token).toBe('string');
  expect(body.data.token.length).toBeGreaterThan(0);
  expect(body.data.user.email).toBe(email);
  expect(body.data.user.id).toBeTruthy();
  expect(body.data.user.email).toBeTruthy();
  expect(body.data.user.name).toBeTruthy();
  expect(body.data.user.role).toBeTruthy();
  expect(body.data.user.org_id).toBeTruthy();
});

test('POST /api/v1/auth/login returns token + user for valid credentials', async ({ request }) => {
  const res = await request.post('/api/v1/auth/login', {
    data: { email: getAuth().email, password: 'SmokeTest123!' },
  });
  expect(res.status()).toBe(200);
  const body: AuthResponse = await res.json();
  expect(typeof body.data.token).toBe('string');
  expect(body.data.token.length).toBeGreaterThan(0);
  expect(body.data.user.email).toBe(getAuth().email);
});

test('POST /api/v1/auth/login returns 401 for invalid password', async ({ request }) => {
  const res = await request.post('/api/v1/auth/login', {
    data: { email: getAuth().email, password: 'wrong-password' },
  });
  expect(res.status()).toBe(401);
  const body: ErrorResponse = await res.json();
  expect(body.error.code).toBe('INVALID_CREDENTIALS');
});

test('POST /api/v1/auth/ returns 409 for duplicate email', async ({ request }) => {
  const res = await request.post('/api/v1/auth/', {
    data: { email: getAuth().email, password: 'Test123!', name: 'Dup', org_name: 'Dup Org' },
  });
  expect(res.status()).toBe(409);
  const body: ErrorResponse = await res.json();
  expect(body.error.code).toBe('EMAIL_ALREADY_EXISTS');
});

test('Token from login authenticates protected endpoints', async ({ request }) => {
  const loginRes = await request.post('/api/v1/auth/login', {
    data: { email: getAuth().email, password: 'SmokeTest123!' },
  });
  const body: AuthResponse = await loginRes.json();
  const token = body.data.token;

  const res = await request.get('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
});
