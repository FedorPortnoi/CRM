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

// RUNG 4 — data integrity, validation

test('POST /api/v1/auth/ missing email field returns 400', async ({ request }) => {
  const res = await request.post('/api/v1/auth/', {
    data: { password: 'ValidPass1!', name: 'No Email', org_name: 'No Email Org' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ missing password returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `user-${tag}@test.com`, name: 'No Pass', org_name: 'No Pass Org' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ missing name returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `user-${tag}@test.com`, password: 'ValidPass1!', org_name: 'No Name Org' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ missing org_name returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `user-${tag}@test.com`, password: 'ValidPass1!', name: 'No Org' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ with invalid email format returns 400', async ({ request }) => {
  const res = await request.post('/api/v1/auth/', {
    data: { email: 'not-an-email', password: 'ValidPass1!', name: 'Bad Email', org_name: 'Bad Email Org' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ response user.role is owner for first user in org', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `owner-${tag}@test.com`,
      password: 'ValidPass1!',
      name: 'Owner User',
      org_name: `Owner Org ${tag}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.user.role).toBe('owner');
});

test('POST /api/v1/auth/ response user.org_id is a valid UUID string', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `uuid-${tag}@test.com`,
      password: 'ValidPass1!',
      name: 'UUID Check',
      org_name: `UUID Org ${tag}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  expect(body.data.user.org_id).toMatch(uuidRegex);
});

test('POST /api/v1/auth/ seeds a default pipeline for new org', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const registerRes = await request.post('/api/v1/auth/', {
    data: {
      email: `pipeline-${tag}@test.com`,
      password: 'ValidPass1!',
      name: 'Pipeline Seeder',
      org_name: `Pipeline Org ${tag}`,
    },
  });
  expect(registerRes.status()).toBe(201);
  const registerBody = await registerRes.json();
  const token: string = registerBody.data.token;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(pipelinesRes.status()).toBe(200);
  const pipelinesBody = await pipelinesRes.json();
  expect((pipelinesBody.data as unknown[]).length).toBeGreaterThanOrEqual(1);
});

test('POST /api/v1/auth/login with unregistered email returns 401 INVALID_CREDENTIALS', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/login', {
    data: { email: `ghost-${tag}@test.com`, password: 'SomePassword1!' },
  });
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_CREDENTIALS');
});

test('POST /api/v1/auth/login with empty password string returns 400 (Zod catches before auth logic)', async ({ request }) => {
  const { email } = getAuth();
  const res = await request.post('/api/v1/auth/login', {
    data: { email, password: '' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/login response user.id matches userId from re-login', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const password = 'ValidPass1!';
  const registerRes = await request.post('/api/v1/auth/', {
    data: {
      email: `relogin-${tag}@test.com`,
      password,
      name: 'Re Login',
      org_name: `Re Login Org ${tag}`,
    },
  });
  expect(registerRes.status()).toBe(201);
  const registerBody = await registerRes.json();
  const registeredUserId: string = registerBody.data.user.id;

  const loginRes = await request.post('/api/v1/auth/login', {
    data: { email: `relogin-${tag}@test.com`, password },
  });
  expect(loginRes.status()).toBe(200);
  const loginBody = await loginRes.json();
  expect(loginBody.data.user.id).toBe(registeredUserId);
});

// RUNG 5 — concurrency, stress

test('Two concurrent registrations with same email — exactly one 201 and one 409', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const payload = {
    email: `concurrent-${tag}@test.com`,
    password: 'ValidPass1!',
    name: 'Concurrent User',
    org_name: `Concurrent Org ${tag}`,
  };

  const [res1, res2] = await Promise.all([
    request.post('/api/v1/auth/', { data: payload }),
    request.post('/api/v1/auth/', { data: payload }),
  ]);

  const statuses = [res1.status(), res2.status()].sort((a, b) => a - b);
  expect(statuses).toEqual([201, 409]);

  const losingBody = res1.status() === 409 ? await res1.json() : await res2.json();
  expect(losingBody.error.code).toBe('EMAIL_ALREADY_EXISTS');
});

test('Three sequential logins for same user all return valid tokens', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const email = `multi-login-${tag}@test.com`;
  const password = 'ValidPass1!';

  const registerRes = await request.post('/api/v1/auth/', {
    data: { email, password, name: 'Multi Login', org_name: `Multi Login Org ${tag}` },
  });
  expect(registerRes.status()).toBe(201);

  for (let i = 0; i < 3; i++) {
    const loginRes = await request.post('/api/v1/auth/login', {
      data: { email, password },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.data.token).toBeTruthy();
  }
});

test('POST /api/v1/auth/ with special characters in org_name creates successfully', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `special-${tag}@test.com`,
      password: 'ValidPass1!',
      name: 'Special Org Owner',
      org_name: `Müller & Sons — "Ñoño" <Corp> 株式会社 ${tag}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.token).toBeTruthy();
  expect(body.data.user.org_id).toBeTruthy();
});

test('POST /api/v1/auth/ with 8-char password succeeds; 7-char password returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;

  const validRes = await request.post('/api/v1/auth/', {
    data: {
      email: `minpass-${tag}@test.com`,
      password: 'Abcd123!',
      name: 'Min Pass User',
      org_name: `Min Pass Org ${tag}`,
    },
  });
  expect(validRes.status()).toBe(201);

  const tag2 = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const invalidRes = await request.post('/api/v1/auth/', {
    data: {
      email: `shortpass-${tag2}@test.com`,
      password: 'Abc123!',
      name: 'Short Pass User',
      org_name: `Short Pass Org ${tag2}`,
    },
  });
  expect(invalidRes.status()).toBe(400);
});
