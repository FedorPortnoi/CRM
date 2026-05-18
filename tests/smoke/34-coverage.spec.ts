import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = suffix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const res = await request.post('/api/v1/auth/', {
    data: { email: unique + '@example.com', password: 'Password123!', name: 'User ' + suffix, org_name: 'Org ' + unique },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

function authHeaders(token: string) { return { Authorization: 'Bearer ' + token }; }

interface OnboardingState {
  completed_steps: string[];
  dismissed_tooltips: string[];
  example_data_loaded: boolean;
  completed_at: string | null;
}

interface OnboardingBody { data: OnboardingState; meta: Record<string, unknown> }
interface ExampleDataBody { data: { contacts: number; deals: number; tasks: number }; meta: Record<string, unknown> }
interface ClearBody { data: { cleared: boolean }; meta: Record<string, unknown> }
interface ListBody { data: unknown[]; meta: { total: number } }

test.describe.configure({ timeout: 30000 });

test('onboarding 34: GET returns default state for new user', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-get-default');
  const r = await request.get('/api/v1/onboarding', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as OnboardingBody;
  expect(body.data.completed_steps).toEqual([]);
  expect(body.data.dismissed_tooltips).toEqual([]);
  expect(body.data.example_data_loaded).toBe(false);
  expect(body.data.completed_at).toBeNull();
});

test('onboarding 34: PATCH completed_steps reflects updated steps', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-patch-steps');
  const r = await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: { completed_steps: ['welcome', 'profile'] },
  });
  expect(r.status()).toBe(200);
  const b2 = (await r.json()) as OnboardingBody;
  expect(b2.data.completed_steps).toEqual(['welcome', 'profile']);
});

test('onboarding 34: PATCH dismissed_tooltips reflects updated tooltips', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-patch-tips');
  const r = await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: { dismissed_tooltips: ['contacts-tip', 'deals-tip'] },
  });
  expect(r.status()).toBe(200);
  const b3 = (await r.json()) as OnboardingBody;
  expect(b3.data.dismissed_tooltips).toEqual(['contacts-tip', 'deals-tip']);
});

test('onboarding 34: PATCH completed_at is persisted', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-patch-at');
  const ts = new Date().toISOString();
  const patchRes = await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: { completed_at: ts },
  });
  expect(patchRes.status()).toBe(200);
  const pBody = (await patchRes.json()) as OnboardingBody;
  expect(pBody.data.completed_at).toBe(ts);
  const r = await request.get('/api/v1/onboarding', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body4 = (await r.json()) as OnboardingBody;
  expect(body4.data.completed_at).toBe(ts);
});

test('onboarding 34: PATCH with no fields leaves state unchanged', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-patch-empty');
  await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: { completed_steps: ['step1'] },
  });
  const r = await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(r.status()).toBe(200);
  const b5 = (await r.json()) as OnboardingBody;
  expect(b5.data.completed_steps).toEqual(['step1']);
});

test('onboarding 34: multiple PATCHes merge, not replace', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-patch-merge');
  await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: { completed_steps: ['step1'] },
  });
  await request.patch('/api/v1/onboarding', {
    headers: authHeaders(org.token),
    data: { dismissed_tooltips: ['tip-a'] },
  });
  const r = await request.get('/api/v1/onboarding', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b6 = (await r.json()) as OnboardingBody;
  expect(b6.data.completed_steps).toEqual(['step1']);
  expect(b6.data.dismissed_tooltips).toEqual(['tip-a']);
});

test('onboarding 34: POST example-data returns correct counts', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-post-ex');
  const r = await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(201);
  const b7 = (await r.json()) as ExampleDataBody;
  expect(b7.data.contacts).toBe(5);
  expect(b7.data.deals).toBe(2);
  expect(b7.data.tasks).toBe(3);
});

test('onboarding 34: POST example-data contacts visible via GET /api/v1/contacts', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-contacts-vis');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b8 = (await r.json()) as ListBody;
  expect(b8.data.length).toBeGreaterThanOrEqual(5);
});

test('onboarding 34: POST example-data deals visible via GET /api/v1/deals', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-deals-vis');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/deals', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b9 = (await r.json()) as ListBody;
  expect(b9.data.length).toBeGreaterThanOrEqual(2);
});

test('onboarding 34: POST example-data tasks visible via GET /api/v1/tasks', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-tasks-vis');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/tasks', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b10 = (await r.json()) as ListBody;
  expect(b10.data.length).toBeGreaterThanOrEqual(3);
});

test('onboarding 34: POST example-data sets example_data_loaded true in state', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-ex-loaded');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/onboarding', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b11 = (await r.json()) as OnboardingBody;
  expect(b11.data.example_data_loaded).toBe(true);
});

test('onboarding 34: DELETE example-data removes example contacts from GET /api/v1/contacts', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-del-contacts');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const beforeRes = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  const beforeBody = (await beforeRes.json()) as ListBody;
  const beforeCount = beforeBody.data.length;
  expect(beforeCount).toBeGreaterThanOrEqual(5);
  await request.delete('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const afterRes = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  const afterBody = (await afterRes.json()) as ListBody;
  expect(afterBody.data.length).toBe(beforeCount - 5);
});

test('onboarding 34: DELETE example-data sets example_data_loaded false in state', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-del-loaded');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  await request.delete('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/onboarding', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b13 = (await r.json()) as OnboardingBody;
  expect(b13.data.example_data_loaded).toBe(false);
});

test('onboarding 34: DELETE example-data returns { cleared: true }', async ({ request }) => {
  const org = await registerOrg(request, 'ob34-del-cleared');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  const r = await request.delete('/api/v1/onboarding/example-data', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const b14 = (await r.json()) as ClearBody;
  expect(b14.data.cleared).toBe(true);
});

test('onboarding 34: org isolation - org A example data not visible to org B', async ({ request }) => {
  const orgA = await registerOrg(request, 'ob34-iso-a');
  const orgB = await registerOrg(request, 'ob34-iso-b');
  await request.post('/api/v1/onboarding/example-data', { headers: authHeaders(orgA.token) });
  const rContacts = await request.get('/api/v1/contacts', { headers: authHeaders(orgB.token) });
  expect(rContacts.status()).toBe(200);
  const cBody = (await rContacts.json()) as ListBody;
  expect(cBody.data.length).toBe(0);
  const rDeals = await request.get('/api/v1/deals', { headers: authHeaders(orgB.token) });
  expect(rDeals.status()).toBe(200);
  const dBody = (await rDeals.json()) as ListBody;
  expect(dBody.data.length).toBe(0);
  const rState = await request.get('/api/v1/onboarding', { headers: authHeaders(orgB.token) });
  expect(rState.status()).toBe(200);
  const sBody = (await rState.json()) as OnboardingBody;
  expect(sBody.data.example_data_loaded).toBe(false);
});

test('onboarding 34: GET without token returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/onboarding');
  expect(r.status()).toBe(401);
});

test('onboarding 34: PATCH without token returns 401', async ({ request }) => {
  const r = await request.patch('/api/v1/onboarding', {
    data: { completed_steps: ['step1'] },
  });
  expect(r.status()).toBe(401);
});

test('onboarding 34: POST example-data without token returns 401', async ({ request }) => {
  const r = await request.post('/api/v1/onboarding/example-data');
  expect(r.status()).toBe(401);
});

test('onboarding 34: DELETE example-data without token returns 401', async ({ request }) => {
  const r = await request.delete('/api/v1/onboarding/example-data');
  expect(r.status()).toBe(401);
});
