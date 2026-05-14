import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string; onboarding_completed?: boolean } } };
  expect(body.data.user.onboarding_completed).toBe(false);
  return { token: body.data.token, userId: body.data.user.id };
}

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

test('business-card scan parses text and creates a contact', async ({ request }) => {
  const org = await registerOrg(request, 'business-card');
  const res = await request.post('/api/v1/contacts/business-card/scan', {
    headers: authHeaders(org.token),
    data: {
      text: 'Morgan Lee\nAcme Field Sales\nmorgan@example.com\n+15551231234',
      create_contact: true,
    },
  });

  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { extracted: { first_name: string; email: string }; contact: { id: string } } };
  expect(body.data.extracted.first_name).toBe('Morgan');
  expect(body.data.extracted.email).toBe('morgan@example.com');
  expect(body.data.contact.id).toBeTruthy();
});

test('workflow contact_created trigger creates a follow-up task', async ({ request }) => {
  const org = await registerOrg(request, 'workflow-contact');
  const workflowRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: {
      name: 'New contact follow-up',
      trigger: 'contact_created',
      actions: [{ type: 'create_task', title: 'Call {{first_name}}', due_in_days: 1 }],
    },
  });
  expect(workflowRes.status()).toBe(201);

  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'WorkflowTarget' },
  });
  expect(contactRes.status()).toBe(201);
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${contactId}`, {
    headers: authHeaders(org.token),
  });
  expect(tasksRes.status()).toBe(200);
  const tasksBody = await tasksRes.json() as { data: { title: string; contact_id: string }[] };
  expect(tasksBody.data.some((task) => task.title === 'Call WorkflowTarget' && task.contact_id === contactId)).toBe(true);
});

test('bulk-tag appends tags to selected contacts', async ({ request }) => {
  const org = await registerOrg(request, 'bulk-tag');
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'Tagged' },
  });
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;

  const tagRes = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: [contactId], tags: ['vip', 'field'] },
  });
  expect(tagRes.status()).toBe(200);

  const getRes = await request.get(`/api/v1/contacts/${contactId}`, {
    headers: authHeaders(org.token),
  });
  const body = await getRes.json() as { data: { tags: string[] } };
  expect(body.data.tags).toEqual(expect.arrayContaining(['vip', 'field']));
});

test('contact events sub-route returns calendar events for the contact', async ({ request }) => {
  const org = await registerOrg(request, 'contact-events');
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'EventContact' },
  });
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const end = new Date(Date.now() + 90_000_000).toISOString();

  await request.post('/api/v1/calendar', {
    headers: authHeaders(org.token),
    data: { title: 'Contact Event', contact_id: contactId, start_time: start, end_time: end },
  });

  const eventsRes = await request.get(`/api/v1/contacts/${contactId}/events`, {
    headers: authHeaders(org.token),
  });
  expect(eventsRes.status()).toBe(200);
  const body = await eventsRes.json() as { data: { title: string }[]; meta: { total: number } };
  expect(body.meta.total).toBeGreaterThanOrEqual(1);
  expect(body.data.some((event) => event.title === 'Contact Event')).toBe(true);
});

test('auth onboarding state can be completed', async ({ request }) => {
  const org = await registerOrg(request, 'onboarding');
  const patchRes = await request.patch('/api/v1/auth/onboarding', {
    headers: authHeaders(org.token),
    data: { completed: true },
  });
  expect(patchRes.status()).toBe(200);
  const patchBody = await patchRes.json() as { data: { onboarding_completed: boolean } };
  expect(patchBody.data.onboarding_completed).toBe(true);

  const getRes = await request.get('/api/v1/auth/onboarding', {
    headers: authHeaders(org.token),
  });
  const getBody = await getRes.json() as { data: { completed: boolean } };
  expect(getBody.data.completed).toBe(true);
});
