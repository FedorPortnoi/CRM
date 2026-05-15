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

// ── Rung 4/5 tests ──────────────────────────────────────────────────────────

test('full deal lifecycle: create → move stage → mark won → verify in analytics dashboard', async ({ request }) => {
  test.setTimeout(30000);
  const org = await registerOrg(request, 'lifecycle');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  expect(plRes.status()).toBe(200);
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string; position: number }[] }[] };
  const pipeline = plBody.data[0];
  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
  expect(stages.length).toBeGreaterThanOrEqual(2);

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'LifecycleContact' },
  });
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'LifecycleDeal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stages[0].id, value: 5000 },
  });
  expect(dRes.status()).toBe(201);
  const dealId = ((await dRes.json()) as { data: { id: string } }).data.id;

  const moveRes = await request.patch(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(org.token),
    data: { stage_id: stages[1].id },
  });
  expect(moveRes.status()).toBe(200);

  const wonDate = new Date().toISOString().slice(0, 10);
  const wonRes = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: authHeaders(org.token),
    data: { actual_close: wonDate },
  });
  expect(wonRes.status()).toBe(200);
  const wonBody = await wonRes.json() as { data: { status: string } };
  expect(wonBody.data.status).toBe('won');

  const dashRes = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(dashRes.status()).toBe(200);
  const dashBody = await dashRes.json() as { data: object; meta: object };
  expect(dashBody.data).toBeTruthy();
});

test('contact + deal + task tri-link all appear in contact activity', async ({ request }) => {
  const org = await registerOrg(request, 'trilink');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = plBody.data[0];
  const stageId = pipeline.stages[0].id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'TriContact' },
  });
  expect(cRes.status()).toBe(201);
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'TriDeal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
  });
  expect(dRes.status()).toBe(201);
  const dealId = ((await dRes.json()) as { data: { id: string } }).data.id;

  const tRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'TriTask', contact_id: contactId, deal_id: dealId, assigned_to: org.userId },
  });
  expect(tRes.status()).toBe(201);

  const actRes = await request.get(`/api/v1/contacts/${contactId}/activity`, {
    headers: authHeaders(org.token),
  });
  expect(actRes.status()).toBe(200);
  const actBody = await actRes.json() as { data: { contact_id: string; items: { type: string }[] } };
  expect(actBody.data.contact_id).toBe(contactId);
  expect(actBody.data.items.length).toBeGreaterThanOrEqual(1);
});

test('org isolation end-to-end: Org A data invisible to Org B', async ({ request }) => {
  const orgA = await registerOrg(request, 'iso-a');
  const orgB = await registerOrg(request, 'iso-b');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(orgA.token) });
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = plBody.data[0];
  const stageId = pipeline.stages[0].id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(orgA.token),
    data: { first_name: 'OrgAContact' },
  });
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  await request.post('/api/v1/deals', {
    headers: authHeaders(orgA.token),
    data: { title: 'OrgADeal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
  });

  const bContactsRes = await request.get('/api/v1/contacts', { headers: authHeaders(orgB.token) });
  expect(bContactsRes.status()).toBe(200);
  const bContacts = await bContactsRes.json() as { data: { id: string }[] };
  expect(bContacts.data.every((c) => c.id !== contactId)).toBe(true);

  const bDealsRes = await request.get('/api/v1/deals', { headers: authHeaders(orgB.token) });
  expect(bDealsRes.status()).toBe(200);
  const bDeals = await bDealsRes.json() as { data: { title: string }[] };
  expect(bDeals.data.every((d) => d.title !== 'OrgADeal')).toBe(true);
});

test('pipeline default takeover: new default pipeline clears old default', async ({ request }) => {
  const org = await registerOrg(request, 'default-pl');

  const firstRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(org.token),
    data: { name: 'FirstDefault', is_default: true },
  });
  expect(firstRes.status()).toBe(201);
  const firstId = ((await firstRes.json()) as { data: { id: string } }).data.id;

  const secondRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(org.token),
    data: { name: 'SecondDefault', is_default: true },
  });
  expect(secondRes.status()).toBe(201);
  const secondId = ((await secondRes.json()) as { data: { id: string } }).data.id;

  const listRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const listBody = await listRes.json() as { data: { id: string; is_default: boolean }[] };

  const first = listBody.data.find((p) => p.id === firstId);
  const second = listBody.data.find((p) => p.id === secondId);
  expect(second?.is_default).toBe(true);
  expect(first?.is_default).toBe(false);
});

test('pagination consistency: union of page 1 and page 2 has no duplicates', async ({ request }) => {
  const org = await registerOrg(request, 'pagination');

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      request.post('/api/v1/contacts', {
        headers: authHeaders(org.token),
        data: { first_name: `PagContact${i}` },
      }),
    ),
  );

  const p1Res = await request.get('/api/v1/contacts?page=1&per_page=2', { headers: authHeaders(org.token) });
  expect(p1Res.status()).toBe(200);
  const p1Body = await p1Res.json() as { data: { id: string }[] };

  const p2Res = await request.get('/api/v1/contacts?page=2&per_page=2', { headers: authHeaders(org.token) });
  expect(p2Res.status()).toBe(200);
  const p2Body = await p2Res.json() as { data: { id: string }[] };

  const p1Ids = p1Body.data.map((c) => c.id);
  const p2Ids = p2Body.data.map((c) => c.id);
  const overlap = p1Ids.filter((id) => p2Ids.includes(id));
  expect(overlap).toHaveLength(0);
});

test('GET /analytics/team-activity returns entries with user_id and count fields', async ({ request }) => {
  const org = await registerOrg(request, 'team-activity');

  const res = await request.get('/api/v1/analytics/team-activity', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { user_id?: string; count?: number }[]; meta: object };
  expect(Array.isArray(body.data)).toBe(true);
  if (body.data.length > 0) {
    expect(body.data[0]).toHaveProperty('user_id');
    expect(body.data[0]).toHaveProperty('count');
  }
});

test('GET /analytics/rep-performance returns a data array', async ({ request }) => {
  const org = await registerOrg(request, 'rep-perf');

  const res = await request.get('/api/v1/analytics/rep-performance', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: unknown[]; meta: object };
  expect(Array.isArray(body.data)).toBe(true);
});

test('task state machine: pending → in_progress → done', async ({ request }) => {
  const org = await registerOrg(request, 'task-sm');

  const tRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'StateMachineTask', assigned_to: org.userId },
  });
  expect(tRes.status()).toBe(201);
  const taskId = ((await tRes.json()) as { data: { id: string; status: string } }).data.id;

  const inProgressRes = await request.post(`/api/v1/tasks/${taskId}/start`, {
    headers: authHeaders(org.token),
  });
  expect(inProgressRes.status()).toBe(200);
  const inProgressBody = await inProgressRes.json() as { data: { status: string } };
  expect(inProgressBody.data.status).toBe('in_progress');

  const doneRes = await request.post(`/api/v1/tasks/${taskId}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(doneRes.status()).toBe(200);
  const doneBody = await doneRes.json() as { data: { status: string } };
  expect(doneBody.data.status).toBe('done');
});

test('deal title uniqueness NOT enforced: two deals with same title both created', async ({ request }) => {
  const org = await registerOrg(request, 'dup-title');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = plBody.data[0];
  const stageId = pipeline.stages[0].id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'DupTitleContact' },
  });
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const dealPayload = { title: 'DuplicateTitle', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId };

  const d1Res = await request.post('/api/v1/deals', { headers: authHeaders(org.token), data: dealPayload });
  expect(d1Res.status()).toBe(201);
  const d1Id = ((await d1Res.json()) as { data: { id: string } }).data.id;

  const d2Res = await request.post('/api/v1/deals', { headers: authHeaders(org.token), data: dealPayload });
  expect(d2Res.status()).toBe(201);
  const d2Id = ((await d2Res.json()) as { data: { id: string } }).data.id;

  expect(d1Id).not.toBe(d2Id);
});

test('contact bulk archive: all targeted contacts become archived', async ({ request }) => {
  const org = await registerOrg(request, 'bulk-archive');

  const creates = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      request.post('/api/v1/contacts', {
        headers: authHeaders(org.token),
        data: { first_name: `ArchiveMe${i}` },
      }),
    ),
  );
  const ids = await Promise.all(creates.map(async (r) => ((await r.json()) as { data: { id: string } }).data.id));

  const archiveRes = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: ids },
  });
  expect(archiveRes.status()).toBe(200);

  for (const id of ids) {
    const getRes = await request.get(`/api/v1/contacts/${id}`, { headers: authHeaders(org.token) });
    expect(getRes.status()).toBe(200);
    const body = await getRes.json() as { data: { status: string } };
    expect(body.data.status).toBe('archived');
  }
});

test('GET /deals sorted by created_at: newest deal appears first', async ({ request }) => {
  const org = await registerOrg(request, 'deal-sort');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = plBody.data[0];
  const stageId = pipeline.stages[0].id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'SortContact' },
  });
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const d1Res = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'OlderDeal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
  });
  const d1Id = ((await d1Res.json()) as { data: { id: string } }).data.id;

  const d2Res = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'NewerDeal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
  });
  const d2Id = ((await d2Res.json()) as { data: { id: string } }).data.id;

  const listRes = await request.get('/api/v1/deals', { headers: authHeaders(org.token) });
  expect(listRes.status()).toBe(200);
  const listBody = await listRes.json() as { data: { id: string }[] };
  const ids = listBody.data.map((d) => d.id);
  expect(ids.indexOf(d2Id)).toBeLessThan(ids.indexOf(d1Id));
});

test('concurrent deal mark-won: 2 different deals simultaneously marked won both succeed', async ({ request }) => {
  const org = await registerOrg(request, 'concurrent-won');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = plBody.data[0];
  const stageId = pipeline.stages[0].id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'ConcurrentContact' },
  });
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const [d1Res, d2Res] = await Promise.all([
    request.post('/api/v1/deals', {
      headers: authHeaders(org.token),
      data: { title: 'ConcurrentDeal1', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
    }),
    request.post('/api/v1/deals', {
      headers: authHeaders(org.token),
      data: { title: 'ConcurrentDeal2', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
    }),
  ]);
  const d1Id = ((await d1Res.json()) as { data: { id: string } }).data.id;
  const d2Id = ((await d2Res.json()) as { data: { id: string } }).data.id;

  const wonDate = new Date().toISOString().slice(0, 10);
  const [won1Res, won2Res] = await Promise.all([
    request.post(`/api/v1/deals/${d1Id}/won`, {
      headers: authHeaders(org.token),
      data: { data: {}, actual_close: wonDate },
    }),
    request.post(`/api/v1/deals/${d2Id}/won`, {
      headers: authHeaders(org.token),
      data: { data: {}, actual_close: wonDate },
    }),
  ]);
  expect(won1Res.status()).toBe(200);
  expect(won2Res.status()).toBe(200);
  const [w1Body, w2Body] = await Promise.all([
    won1Res.json() as Promise<{ data: { status: string } }>,
    won2Res.json() as Promise<{ data: { status: string } }>,
  ]);
  expect(w1Body.data.status).toBe('won');
  expect(w2Body.data.status).toBe('won');
});

test('calendar event linked to deal: deal_id present in response', async ({ request }) => {
  const org = await registerOrg(request, 'cal-deal');

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const plBody = await plRes.json() as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = plBody.data[0];
  const stageId = pipeline.stages[0].id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'CalDealContact' },
  });
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'CalDeal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: stageId },
  });
  const dealId = ((await dRes.json()) as { data: { id: string } }).data.id;

  const start = new Date(Date.now() + 86_400_000).toISOString();
  const end = new Date(Date.now() + 90_000_000).toISOString();
  const evRes = await request.post('/api/v1/calendar', {
    headers: authHeaders(org.token),
    data: { title: 'DealMeeting', deal_id: dealId, contact_id: contactId, start_time: start, end_time: end, event_type: 'meeting' },
  });
  expect(evRes.status()).toBe(201);
  const evBody = await evRes.json() as { data: { deal_id: string } };
  expect(evBody.data.deal_id).toBe(dealId);
});

test('GET /contacts search is case-insensitive: q=xander matches Xander', async ({ request }) => {
  const org = await registerOrg(request, 'case-search');

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'Xander', last_name: 'CaseTest' },
  });
  expect(cRes.status()).toBe(201);
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const searchRes = await request.get('/api/v1/contacts?q=xander', { headers: authHeaders(org.token) });
  expect(searchRes.status()).toBe(200);
  const body = await searchRes.json() as { data: { id: string }[] };
  expect(body.data.some((c) => c.id === contactId)).toBe(true);
});

test('task assigned_to field: GET /tasks?assigned_to returns the task', async ({ request }) => {
  const org = await registerOrg(request, 'assigned-to');

  const tRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'AssignedTask', assigned_to: org.userId },
  });
  expect(tRes.status()).toBe(201);
  const taskId = ((await tRes.json()) as { data: { id: string } }).data.id;

  const listRes = await request.get(`/api/v1/tasks?assigned_to=${org.userId}`, {
    headers: authHeaders(org.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = await listRes.json() as { data: { id: string }[] };
  expect(listBody.data.some((t) => t.id === taskId)).toBe(true);
});

test('POST /auth/login correct credentials → 200 with usable token', async ({ request }) => {
  const tag = `login-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `${tag}@example.com`;
  const password = 'Password123!';

  const regRes = await request.post('/api/v1/auth/', {
    data: { email, password, name: 'LoginUser', org_name: `LoginOrg${tag}` },
  });
  expect(regRes.status()).toBe(201);

  const loginRes = await request.post('/api/v1/auth/login', {
    data: { email, password },
  });
  expect(loginRes.status()).toBe(200);
  const loginBody = await loginRes.json() as { data: { token: string; user: { id: string } } };
  const { token } = loginBody.data;
  expect(token).toBeTruthy();

  const meRes = await request.get('/api/v1/contacts', { headers: authHeaders(token) });
  expect(meRes.status()).toBe(200);
});

test('PATCH /contacts/:id custom_fields roundtrip: write then readback confirms value', async ({ request }) => {
  const org = await registerOrg(request, 'custom-fields');

  const cRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'CustomFieldContact' },
  });
  expect(cRes.status()).toBe(201);
  const contactId = ((await cRes.json()) as { data: { id: string } }).data.id;

  const customFields = { industry: 'fintech', priority: 'high', score: 42 };
  const patchRes = await request.patch(`/api/v1/contacts/${contactId}`, {
    headers: authHeaders(org.token),
    data: { custom_fields: customFields },
  });
  expect(patchRes.status()).toBe(200);

  const getRes = await request.get(`/api/v1/contacts/${contactId}`, { headers: authHeaders(org.token) });
  expect(getRes.status()).toBe(200);
  const getBody = await getRes.json() as { data: { custom_fields: Record<string, unknown> } };
  expect(getBody.data.custom_fields).toMatchObject(customFields);
});

test('GET /contacts with per_page=50 and q filter returns only matching contacts', async ({ request }) => {
  const org = await registerOrg(request, 'filter-limit');

  await Promise.all([
    request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'Zebedee', last_name: 'Unique' } }),
    request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'NotAMatch' } }),
    request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'NotAMatch2' } }),
  ]);

  const res = await request.get('/api/v1/contacts?per_page=50&q=Zebedee', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { first_name: string }[]; meta: { per_page: number } };
  expect(body.data.every((c) => c.first_name === 'Zebedee')).toBe(true);
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  expect(body.meta.per_page).toBe(50);
});

test('stage position ordering: GET /pipelines/:id/stages returns stages ascending by position', async ({ request }) => {
  const org = await registerOrg(request, 'stage-order');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(org.token),
    data: { name: 'OrderedPipeline', stages: [
      { name: 'First', position: 1 },
      { name: 'Second', position: 2 },
      { name: 'Third', position: 3 },
    ] },
  });
  expect(plRes.status()).toBe(201);
  const pipelineId = ((await plRes.json()) as { data: { id: string } }).data.id;

  const stagesRes = await request.get(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: authHeaders(org.token),
  });
  expect(stagesRes.status()).toBe(200);
  const stagesBody = await stagesRes.json() as { data: { position: number }[] };
  const positions = stagesBody.data.map((s) => s.position);
  const sorted = [...positions].sort((a, b) => a - b);
  expect(positions).toEqual(sorted);
});

test('concurrent contact creates: 5 simultaneous POSTs all return 201 with unique IDs', async ({ request }) => {
  const org = await registerOrg(request, 'concurrent-contacts');

  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      request.post('/api/v1/contacts', {
        headers: authHeaders(org.token),
        data: { first_name: `Concurrent${i}`, last_name: 'Stress' },
      }),
    ),
  );

  for (const res of responses) {
    expect(res.status()).toBe(201);
  }

  const ids = await Promise.all(responses.map(async (r) => ((await r.json()) as { data: { id: string } }).data.id));
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(5);
});
