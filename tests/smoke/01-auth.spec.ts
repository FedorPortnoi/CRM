import { test, expect, type APIRequestContext } from '@playwright/test';
import { getAuth, verifyRegisteredSmokeUser } from './helpers/auth';

const TEST_PHONE = '+70000000000';

type RegisterPayload = {
  email: string;
  password: string;
  name: string;
  org_name: string;
  phone: string;
};

type RegisterBody = {
  data: {
    user_id: string;
    email: string;
    needs_verification: boolean;
  };
  meta: {
    sms_sent: boolean;
    email_sent: boolean;
  };
};

async function registerAndLogin(request: APIRequestContext, payload: RegisterPayload) {
  const runStartedAt = new Date(Date.now() - 60_000).toISOString();
  const registerRes = await request.post('/api/v1/auth/', { data: payload });
  expect(registerRes.status()).toBe(201);

  const registerBody = await registerRes.json() as RegisterBody;
  expect(registerBody.data.email).toBe(payload.email);
  expect(registerBody.data.needs_verification).toBe(true);

  const { orgId } = await verifyRegisteredSmokeUser({
    userId: registerBody.data.user_id,
    email: payload.email,
    runStartedAt,
  });

  const loginRes = await request.post('/api/v1/auth/login', {
    data: { email: payload.email, password: payload.password },
  });
  expect(loginRes.status()).toBe(200);
  const loginBody = await loginRes.json();
  expect(loginBody.data.user.id).toBe(registerBody.data.user_id);
  expect(loginBody.data.user.org_id).toBe(orgId);

  return { registerBody, loginBody };
}

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
    data: { password: 'ValidPass1!', name: 'No Email', org_name: 'No Email Org', phone: TEST_PHONE },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ missing password returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `user-${tag}@test.com`, name: 'No Pass', org_name: 'No Pass Org', phone: TEST_PHONE },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ missing name returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `user-${tag}@test.com`, password: 'ValidPass1!', org_name: 'No Name Org', phone: TEST_PHONE },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ missing org_name returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `user-${tag}@test.com`, password: 'ValidPass1!', name: 'No Org', phone: TEST_PHONE },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ with invalid email format returns 400', async ({ request }) => {
  const res = await request.post('/api/v1/auth/', {
    data: { email: 'not-an-email', password: 'ValidPass1!', name: 'Bad Email', org_name: 'Bad Email Org', phone: TEST_PHONE },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/auth/ returns an OTP challenge without a session token', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const email = `owner-${tag}@test.com`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email,
      password: 'ValidPass1!',
      name: 'Owner User',
      org_name: `Owner Org ${tag}`,
      phone: TEST_PHONE,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as RegisterBody;
  expect(body.data.user_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.data.email).toBe(email);
  expect(body.data.needs_verification).toBe(true);
  expect(body.data).not.toHaveProperty('token');
  expect(body.data).not.toHaveProperty('user');
  expect(typeof body.meta.sms_sent).toBe('boolean');
  expect(typeof body.meta.email_sent).toBe('boolean');
});

test('POST /api/v1/auth/login rejects a newly registered unverified account', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const email = `unverified-${tag}@test.com`;
  const password = 'ValidPass1!';
  const registerRes = await request.post('/api/v1/auth/', {
    data: {
      email,
      password,
      name: 'Unverified User',
      org_name: `Unverified Org ${tag}`,
      phone: TEST_PHONE,
    },
  });
  expect(registerRes.status()).toBe(201);

  const loginRes = await request.post('/api/v1/auth/login', {
    data: { email, password },
  });
  expect(loginRes.status()).toBe(403);
  const loginBody = await loginRes.json();
  expect(loginBody.error.code).toBe('ACCOUNT_NOT_VERIFIED');
});

test('POST /api/v1/auth/ seeds a default pipeline for new org', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const { loginBody } = await registerAndLogin(request, {
    email: `pipeline-${tag}@test.com`,
    password: 'ValidPass1!',
    name: 'Pipeline Seeder',
    org_name: `Pipeline Org ${tag}`,
    phone: TEST_PHONE,
  });
  const token: string = loginBody.data.token;

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

test('POST /api/v1/auth/login response user.id matches the registered user_id', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const password = 'ValidPass1!';
  const email = `relogin-${tag}@test.com`;
  const { registerBody, loginBody } = await registerAndLogin(request, {
    email,
    password,
    name: 'Re Login',
    org_name: `Re Login Org ${tag}`,
    phone: TEST_PHONE,
  });
  expect(loginBody.data.user.id).toBe(registerBody.data.user_id);
});

// RUNG 5 — concurrency, stress

test('Two concurrent registrations with same email — exactly one 201 and one 409', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;
  const payload = {
    email: `concurrent-${tag}@test.com`,
    password: 'ValidPass1!',
    name: 'Concurrent User',
    org_name: `Concurrent Org ${tag}`,
    phone: TEST_PHONE,
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

  const runStartedAt = new Date(Date.now() - 60_000).toISOString();
  const registerRes = await request.post('/api/v1/auth/', {
    data: { email, password, name: 'Multi Login', org_name: `Multi Login Org ${tag}`, phone: TEST_PHONE },
  });
  expect(registerRes.status()).toBe(201);
  const registerBody = await registerRes.json() as RegisterBody;
  await verifyRegisteredSmokeUser({
    userId: registerBody.data.user_id,
    email,
    runStartedAt,
  });

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
      phone: TEST_PHONE,
      name: 'Special Org Owner',
      org_name: `Müller & Sons — "Ñoño" <Corp> 株式会社 ${tag}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as RegisterBody;
  expect(body.data.user_id).toBeTruthy();
  expect(body.data.needs_verification).toBe(true);
});

test('POST /api/v1/auth/ with 8-char password succeeds; 7-char password returns 400', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2)}`;

  const validRes = await request.post('/api/v1/auth/', {
    data: {
      email: `minpass-${tag}@test.com`,
      password: 'Abcd123!',
      phone: TEST_PHONE,
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
      phone: TEST_PHONE,
      name: 'Short Pass User',
      org_name: `Short Pass Org ${tag2}`,
    },
  });
  expect(invalidRes.status()).toBe(400);
});
