import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `${unique}@example.com`, password: 'Password123!', name: `User ${suffix}`, org_name: `Org ${unique}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}
function authHeaders(token: string) { return { Authorization: `Bearer ${token}` }; }
function daysFromNow(n: number) { return new Date(Date.now() + n * 86400000).toISOString(); }

test.describe.configure({ timeout: 30000 });

async function getPipeline(request: APIRequestContext, token: string) {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  const body = await res.json() as { data: { id: string; is_default: boolean; stages: { id: string }[] }[] };
  return body.data.find(p => p.is_default) ?? body.data[0];
}
async function makeContact(request: APIRequestContext, token: string, name: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: name, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makeTask(request: APIRequestContext, token: string, userId: string, title: string) {
  const res = await request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title, assigned_to: userId } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makeWorkflow(request: APIRequestContext, token: string, name: string, trigger = 'contact_created') {
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(token),
    data: { name, trigger, actions: [{ type: 'create_task', title: 'Follow up', due_in_days: 1 }] },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makeEvent(request: APIRequestContext, token: string, title: string, contactId?: string) {
  const data: Record<string, unknown> = { title, start_time: daysFromNow(1), end_time: daysFromNow(2) };
  if (contactId) data.contact_id = contactId;
  const res = await request.post('/api/v1/calendar', { headers: authHeaders(token), data });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

// ── WORKFLOW CRUD ─────────────────────────────────────────────────────────────

test('workflow: GET /workflows returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'wf29l1');
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});
test('workflow: POST /workflows creates workflow with contact_created trigger', async ({ request }) => {
  const org = await registerOrg(request, 'wf29c1');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnCreate', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'FU', due_in_days: 1 }] },
  });
  expect(r.status()).toBe(201);
  const body = await r.json() as { data: { id: string; trigger: string } };
  expect(body.data.id).toBeTruthy();
  expect(body.data.trigger).toBe('contact_created');
});
test('workflow: GET /workflows/:id returns the created workflow', async ({ request }) => {
  const org = await registerOrg(request, 'wf29g1');
  const wf = await makeWorkflow(request, org.token, 'GetMe');
  const r = await request.get(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { id: string } }).data.id).toBe(wf.id);
});
test('workflow: PATCH /workflows/:id updates name, reflected on GET', async ({ request }) => {
  const org = await registerOrg(request, 'wf29p1');
  const wf = await makeWorkflow(request, org.token, 'OldName');
  await request.patch(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token), data: { name: 'NewName' } });
  const r = await request.get(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { name: string } }).data.name).toBe('NewName');
});
test('workflow: DELETE /workflows/:id archives the workflow', async ({ request }) => {
  const org = await registerOrg(request, 'wf29d1');
  const wf = await makeWorkflow(request, org.token, 'ArchiveMe');
  const r = await request.delete(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('archived');
});
test('workflow: archived workflow excluded from default list', async ({ request }) => {
  const org = await registerOrg(request, 'wf29da1');
  const wf = await makeWorkflow(request, org.token, 'HiddenWF');
  await request.delete(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(w => w.id !== wf.id)).toBe(true);
});
test('workflow: GET /workflows/:id/runs returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'wf29r1');
  const wf = await makeWorkflow(request, org.token, 'RunsWF');
  const r = await request.get(`/api/v1/workflows/${wf.id}/runs`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});
test('workflow: filter by status=active returns only active workflows', async ({ request }) => {
  const org = await registerOrg(request, 'wf29fa1');
  const wf = await makeWorkflow(request, org.token, 'ActiveWF');
  const r = await request.get('/api/v1/workflows?status=active', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string; status: string }[] };
  expect(body.data.some(w => w.id === wf.id)).toBe(true);
  expect(body.data.every(w => w.status === 'active')).toBe(true);
});
test('workflow: filter by trigger=contact_created returns matching workflows', async ({ request }) => {
  const org = await registerOrg(request, 'wf29ft1');
  const wf = await makeWorkflow(request, org.token, 'TrigCC', 'contact_created');
  const r = await request.get('/api/v1/workflows?trigger=contact_created', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string; trigger: string }[] };
  expect(body.data.some(w => w.id === wf.id)).toBe(true);
  expect(body.data.every(w => w.trigger === 'contact_created')).toBe(true);
});
test('workflow: create workflow with deal_stage_changed trigger returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf29ds1');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnStageChange', trigger: 'deal_stage_changed', actions: [{ type: 'create_task', title: 'FU', due_in_days: 2 }] },
  });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { trigger: string } }).data.trigger).toBe('deal_stage_changed');
});
test('workflow: create workflow with task_completed trigger returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf29tc1');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'OnTaskDone', trigger: 'task_completed', actions: [{ type: 'add_contact_note', body: 'Done!' }] },
  });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { trigger: string } }).data.trigger).toBe('task_completed');
});
test('workflow: create workflow with paused status returns 201', async ({ request }) => {
  const org = await registerOrg(request, 'wf29ps1');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'PausedWF', trigger: 'contact_created', status: 'paused', actions: [{ type: 'create_task', title: 'X', due_in_days: 1 }] },
  });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('paused');
});
test('workflow: GET nonexistent workflow returns 404 WORKFLOW_NOT_FOUND', async ({ request }) => {
  const org = await registerOrg(request, 'wf29404');
  const r = await request.get('/api/v1/workflows/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('WORKFLOW_NOT_FOUND');
});
test('workflow: PATCH nonexistent workflow returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'wf29p404');
  const r = await request.patch('/api/v1/workflows/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token), data: { name: 'X' } });
  expect(r.status()).toBe(404);
});
test('workflow: DELETE nonexistent workflow returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'wf29d404');
  const r = await request.delete('/api/v1/workflows/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
});
test('workflow: POST without name returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'wf29nn1');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { trigger: 'contact_created', actions: [{ type: 'create_task', title: 'X', due_in_days: 1 }] },
  });
  expect(r.status()).toBe(400);
});
test('workflow: POST without actions returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'wf29na1');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'NoActions', trigger: 'contact_created' },
  });
  expect(r.status()).toBe(400);
});

// ── TOKEN ROTATION / JWT ──────────────────────────────────────────────────────

test('jwt: login twice yields two valid tokens that both work', async ({ request }) => {
  const unique = `jwt29a-${Date.now()}`;
  await request.post('/api/v1/auth/', { data: { email: `${unique}@example.com`, password: 'Password123!', name: 'U', org_name: 'O' } });
  const l1 = await request.post('/api/v1/auth/login', { data: { email: `${unique}@example.com`, password: 'Password123!' } });
  const l2 = await request.post('/api/v1/auth/login', { data: { email: `${unique}@example.com`, password: 'Password123!' } });
  const t1 = ((await l1.json()) as { data: { token: string } }).data.token;
  const t2 = ((await l2.json()) as { data: { token: string } }).data.token;
  const r1 = await request.get('/api/v1/contacts', { headers: authHeaders(t1) });
  const r2 = await request.get('/api/v1/contacts', { headers: authHeaders(t2) });
  expect(r1.status()).toBe(200);
  expect(r2.status()).toBe(200);
});
test('jwt: two distinct tokens sequential both succeed', async ({ request }) => {
  const org1 = await registerOrg(request, 'jwt29b1-' + Date.now());
  const org2 = await registerOrg(request, 'jwt29b2-' + Date.now());
  const t1 = org1.token;
  const t2 = org2.token;
  expect(typeof t1).toBe('string');
  expect(typeof t2).toBe('string');
  expect(t1.length).toBeGreaterThan(0);
  expect(t2.length).toBeGreaterThan(0);
  expect(t1).not.toBe(t2);
  const r1 = await request.get('/api/v1/contacts', { headers: authHeaders(t1) });
  const r2 = await request.get('/api/v1/contacts', { headers: authHeaders(t2) });
  expect(r1.status()).toBe(200);
  expect(r2.status()).toBe(200);
});
test('jwt: same token used 8 times in parallel all return 200', async ({ request }) => {
  const org = await registerOrg(request, 'jwt29c1');
  const rs = await Promise.all(Array.from({ length: 8 }, () => request.get('/api/v1/contacts', { headers: authHeaders(org.token) })));
  for (const r of rs) expect(r.status()).toBe(200);
});
test('jwt: 5 parallel logins all return 200 with tokens', async ({ request }) => {
  const unique = `jwt29d-${Date.now()}`;
  await request.post('/api/v1/auth/', { data: { email: `${unique}@example.com`, password: 'Password123!', name: 'U', org_name: 'O' } });
  const rs = await Promise.all(Array.from({ length: 5 }, () =>
    request.post('/api/v1/auth/login', { data: { email: `${unique}@example.com`, password: 'Password123!' } })));
  for (const r of rs) expect(r.status()).toBe(200);
  const tokens = await Promise.all(rs.map(async r => ((await r.json()) as { data: { token: string } }).data.token));
  for (const t of tokens) expect(t).toBeTruthy();
});
test('jwt: register and immediately access all list endpoints returns 200', async ({ request }) => {
  const org = await registerOrg(request, 'jwt29e1');
  const rs = await Promise.all([
    request.get('/api/v1/contacts', { headers: authHeaders(org.token) }),
    request.get('/api/v1/deals', { headers: authHeaders(org.token) }),
    request.get('/api/v1/tasks', { headers: authHeaders(org.token) }),
    request.get('/api/v1/messages', { headers: authHeaders(org.token) }),
    request.get('/api/v1/calendar', { headers: authHeaders(org.token) }),
  ]);
  for (const r of rs) expect(r.status()).toBe(200);
});
test('jwt: token from org A cannot access data created under org B', async ({ request }) => {
  const orgA = await registerOrg(request, 'jwt29f1');
  const orgB = await registerOrg(request, 'jwt29f2');
  const c = await makeContact(request, orgB.token, 'OrgBContact');
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(orgA.token) });
  expect([403, 404]).toContain(r.status());
});
test('jwt: two orgs registering in parallel both get distinct tokens', async ({ request }) => {
  const [r1, r2] = await Promise.all([
    request.post('/api/v1/auth/', { data: { email: `jwt29g1-${Date.now()}@example.com`, password: 'Password123!', name: 'U', org_name: `Org29g1-${Date.now()}` } }),
    request.post('/api/v1/auth/', { data: { email: `jwt29g2-${Date.now()}@example.com`, password: 'Password123!', name: 'U', org_name: `Org29g2-${Date.now()}` } }),
  ]);
  const t1 = ((await r1.json()) as { data: { token: string } }).data.token;
  const t2 = ((await r2.json()) as { data: { token: string } }).data.token;
  expect(t1).not.toBe(t2);
});
test('jwt: token works on all protected workflow endpoints', async ({ request }) => {
  const org = await registerOrg(request, 'jwt29h1');
  const wf = await makeWorkflow(request, org.token, 'JWTCheck');
  const rs = await Promise.all([
    request.get('/api/v1/workflows', { headers: authHeaders(org.token) }),
    request.get(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token) }),
    request.get(`/api/v1/workflows/${wf.id}/runs`, { headers: authHeaders(org.token) }),
  ]);
  for (const r of rs) expect(r.status()).toBe(200);
});

// ── CONTACT BULK OPERATIONS ───────────────────────────────────────────────────

test('bulk-archive: POST /contacts/bulk-archive archives all specified contacts', async ({ request }) => {
  const org = await registerOrg(request, 'ba29a1');
  const c1 = await makeContact(request, org.token, 'BulkA1');
  const c2 = await makeContact(request, org.token, 'BulkA2');
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c1.id, c2.id] },
  });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { archived_count: number } };
  expect(body.data.archived_count).toBe(2);
});
test('bulk-archive: archived contacts absent from default list after bulk-archive', async ({ request }) => {
  const org = await registerOrg(request, 'ba29b1');
  const c = await makeContact(request, org.token, 'BulkB1');
  await request.post('/api/v1/contacts/bulk-archive', { headers: authHeaders(org.token), data: { contact_ids: [c.id] } });
  const r = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id !== c.id)).toBe(true);
});
test('bulk-archive: POST /contacts/bulk-archive with nonexistent ID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'ba29c1');
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: ['00000000-0000-0000-0000-000000000000'] },
  });
  expect(r.status()).toBe(404);
});
test('bulk-tag: POST /contacts/bulk-tag appends tags to contacts', async ({ request }) => {
  const org = await registerOrg(request, 'bt29a1');
  const c = await makeContact(request, org.token, 'TagMe');
  const r = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id], tags: ['vip', 'hot-lead'], mode: 'append' },
  });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { tagged_count: number } };
  expect(body.data.tagged_count).toBe(1);
});
test('bulk-tag: POST /contacts/bulk-tag with mode=replace replaces existing tags', async ({ request }) => {
  const org = await registerOrg(request, 'bt29b1');
  const c = await makeContact(request, org.token, 'ReplaceTag', { tags: ['old-tag'] });
  await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id], tags: ['new-tag'], mode: 'replace' },
  });
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const tags = ((await r.json()) as { data: { tags: string[] } }).data.tags;
  expect(tags).toContain('new-tag');
  expect(tags).not.toContain('old-tag');
});
test('bulk-tag: POST /contacts/bulk-tag with nonexistent contact returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'bt29c1');
  const r = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: ['00000000-0000-0000-0000-000000000000'], tags: ['x'] },
  });
  expect(r.status()).toBe(404);
});
test('bulk-assign: POST /contacts/bulk-assign to own userId returns 200 with assigned_count', async ({ request }) => {
  const org = await registerOrg(request, 'basn29a1');
  const c1 = await makeContact(request, org.token, 'AssignA');
  const c2 = await makeContact(request, org.token, 'AssignB');
  const r = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c1.id, c2.id], assigned_to: org.userId },
  });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { assigned_count: number } };
  expect(body.data.assigned_count).toBe(2);
});
test('bulk-assign: POST /contacts/bulk-assign to foreign user returns 403', async ({ request }) => {
  const org = await registerOrg(request, 'basn29b1');
  const other = await registerOrg(request, 'basn29b2');
  const c = await makeContact(request, org.token, 'AssignForeign');
  const r = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id], assigned_to: other.userId },
  });
  expect(r.status()).toBe(403);
});
test('import-csv: POST /contacts/import-csv returns 201 with imported_count', async ({ request }) => {
  const org = await registerOrg(request, 'csv29a1');
  const r = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(org.token),
    data: [{ first_name: 'ImportA' }, { first_name: 'ImportB' }],
  });
  expect(r.status()).toBe(201);
  const body = await r.json() as { data: { imported_count: number } };
  expect(body.data.imported_count).toBe(2);
});
test('import-csv: POST /contacts/import-csv with 3 rows returns imported_count=3', async ({ request }) => {
  const org = await registerOrg(request, 'csv29b1');
  const r = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(org.token),
    data: [{ first_name: 'R1' }, { first_name: 'R2' }, { first_name: 'R3' }],
  });
  expect(((await r.json()) as { data: { imported_count: number } }).data.imported_count).toBe(3);
});
test('import/phone: POST /contacts/import/phone returns 201 with imported_count', async ({ request }) => {
  const org = await registerOrg(request, 'ph29a1');
  const r = await request.post('/api/v1/contacts/import/phone', {
    headers: authHeaders(org.token),
    data: [{ first_name: 'PhoneContact', phone: '+15551234567' }],
  });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { imported_count: number } }).data.imported_count).toBe(1);
});
test('merge: POST /contacts/:id/merge with source_id=id returns 422 INVALID_MERGE', async ({ request }) => {
  const org = await registerOrg(request, 'mg29a1');
  const c = await makeContact(request, org.token, 'SelfMerge');
  const r = await request.post(`/api/v1/contacts/${c.id}/merge`, {
    headers: authHeaders(org.token),
    data: { source_id: c.id },
  });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('INVALID_MERGE');
});

// ── CONTACT FILTERS AND SORTING ───────────────────────────────────────────────

test('filter: GET /contacts?type=lead returns only lead-type contacts', async ({ request }) => {
  const org = await registerOrg(request, 'cf29t1');
  await makeContact(request, org.token, 'Lead1', { type: 'lead' });
  await makeContact(request, org.token, 'Cust1', { type: 'customer' });
  const r = await request.get('/api/v1/contacts?type=lead', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { type: string }[] };
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  expect(body.data.every(c => c.type === 'lead')).toBe(true);
});
test('filter: GET /contacts?type=customer returns only customer-type contacts', async ({ request }) => {
  const org = await registerOrg(request, 'cf29t2');
  await makeContact(request, org.token, 'Cust2', { type: 'customer' });
  await makeContact(request, org.token, 'Lead2', { type: 'lead' });
  const r = await request.get('/api/v1/contacts?type=customer', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { type: string }[] };
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  expect(body.data.every(c => c.type === 'customer')).toBe(true);
});
test('filter: GET /contacts?tag=vip returns contacts with vip tag', async ({ request }) => {
  const org = await registerOrg(request, 'cf29tag1');
  await makeContact(request, org.token, 'VIPContact', { tags: ['vip', 'premium'] });
  await makeContact(request, org.token, 'NoTag');
  const r = await request.get('/api/v1/contacts?tag=vip', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { tags: string[] }[] };
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  expect(body.data.every(c => Array.isArray(c.tags) && (c.tags as string[]).includes('vip'))).toBe(true);
});
test('filter: GET /contacts?status=active returns active contacts', async ({ request }) => {
  const org = await registerOrg(request, 'cf29stat1');
  await makeContact(request, org.token, 'ActiveContact');
  const r = await request.get('/api/v1/contacts?status=active', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});
test('filter: GET /contacts?sort=first_name&order=asc returns sorted by first_name ascending', async ({ request }) => {
  const org = await registerOrg(request, 'cf29so1');
  await makeContact(request, org.token, 'Zebra');
  await makeContact(request, org.token, 'Alpha');
  const r = await request.get('/api/v1/contacts?sort=first_name&order=asc', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { first_name: string }[] };
  const names = body.data.map(c => c.first_name);
  expect(names).toEqual([...names].sort());
});
test('filter: GET /contacts?sort=first_name&order=desc returns sorted by first_name descending', async ({ request }) => {
  const org = await registerOrg(request, 'cf29so2');
  await makeContact(request, org.token, 'Zebra2');
  await makeContact(request, org.token, 'Alpha2');
  const r = await request.get('/api/v1/contacts?sort=first_name&order=desc', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { first_name: string }[] };
  const names = body.data.map(c => c.first_name);
  expect(names).toEqual([...names].sort().reverse());
});
test('filter: GET /contacts?status=archived returns archived contacts', async ({ request }) => {
  const org = await registerOrg(request, 'cf29ar1');
  const c = await makeContact(request, org.token, 'ArchivedOne');
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/contacts?status=archived', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === c.id)).toBe(true);
});
test('filter: contact with company field stores and retrieves company', async ({ request }) => {
  const org = await registerOrg(request, 'cf29co1');
  const c = await makeContact(request, org.token, 'WithCompany', { company: 'Acme Corp' });
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { company: string } }).data.company).toBe('Acme Corp');
});
test('filter: contact with email field stores and retrieves email', async ({ request }) => {
  const org = await registerOrg(request, 'cf29em1');
  const email = `cf-${Date.now()}@example.com`;
  const c = await makeContact(request, org.token, 'WithEmail', { email });
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { email: string } }).data.email).toBe(email);
});
test('filter: contact with phone field stores and retrieves phone', async ({ request }) => {
  const org = await registerOrg(request, 'cf29ph1');
  const c = await makeContact(request, org.token, 'WithPhone', { phone: '+15559876543' });
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { phone: string } }).data.phone).toBe('+15559876543');
});
test('filter: contact with tags is returned with tags in list response', async ({ request }) => {
  const org = await registerOrg(request, 'cf29tags2');
  await makeContact(request, org.token, 'TaggedContact', { tags: ['enterprise', 'priority'] });
  const r = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { first_name: string; tags: unknown }[] };
  const found = body.data.find(c => c.first_name === 'TaggedContact');
  expect(found).toBeDefined();
  expect(Array.isArray(found?.tags)).toBe(true);
});
test('filter: GET /contacts?per_page=2 returns at most 2 results', async ({ request }) => {
  const org = await registerOrg(request, 'cf29pp1');
  await Promise.all(Array.from({ length: 5 }, (_, i) => makeContact(request, org.token, `PP${i}`)));
  const r = await request.get('/api/v1/contacts?per_page=2', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: { per_page: number } };
  expect(body.data.length).toBeLessThanOrEqual(2);
  expect(body.meta.per_page).toBe(2);
});

// ── CONTACT SUB-ROUTES ────────────────────────────────────────────────────────

test('sub-route: GET /contacts/:id/events returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ev1');
  const c = await makeContact(request, org.token, 'EventContact');
  const r = await request.get(`/api/v1/contacts/${c.id}/events`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});
test('sub-route: calendar event linked to contact appears in /contacts/:id/events', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ev2');
  const c = await makeContact(request, org.token, 'EventC2');
  const ev = await makeEvent(request, org.token, 'LinkedEvent', c.id);
  const r = await request.get(`/api/v1/contacts/${c.id}/events`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(e => e.id === ev.id)).toBe(true);
});
test('sub-route: calendar event not linked to contact absent from /contacts/:id/events', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ev3');
  const c1 = await makeContact(request, org.token, 'EventC3a');
  const c2 = await makeContact(request, org.token, 'EventC3b');
  const ev = await makeEvent(request, org.token, 'OtherEvent', c2.id);
  const r = await request.get(`/api/v1/contacts/${c1.id}/events`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(e => e.id !== ev.id)).toBe(true);
});
test('sub-route: GET /contacts/:id/events has meta.total', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ev4');
  const c = await makeContact(request, org.token, 'EventC4');
  const r = await request.get(`/api/v1/contacts/${c.id}/events`, { headers: authHeaders(org.token) });
  const body = await r.json() as { meta: { total: number } };
  expect(typeof body.meta.total).toBe('number');
});
test('sub-route: GET nonexistent contact /events returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ev5');
  const r = await request.get('/api/v1/contacts/00000000-0000-0000-0000-000000000000/events', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
});
test('sub-route: GET /contacts/:id/deals returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'sr29dl1');
  const c = await makeContact(request, org.token, 'DealSub');
  const r = await request.get('/api/v1/contacts/' + c.id + '/deals', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});
test('sub-route: GET /contacts/:id/tasks returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'sr29tk1');
  const c = await makeContact(request, org.token, 'TaskSub');
  const r = await request.get(`/api/v1/contacts/${c.id}/tasks`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});
test('sub-route: GET /contacts/:id/messages returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ms1');
  const c = await makeContact(request, org.token, 'MsgSub');
  const r = await request.get(`/api/v1/contacts/${c.id}/messages`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});
test('sub-route: GET /contacts/:id/activity returns 200 with data object containing items', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ac1');
  const c = await makeContact(request, org.token, 'ActSub');
  const r = await request.get('/api/v1/contacts/' + c.id + '/activity', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { contact_id: string; items: unknown[] } };
  expect(body.data).toBeDefined();
  expect(Array.isArray(body.data.items)).toBe(true);
});
test('sub-route: multiple calendar events for contact all appear in /events', async ({ request }) => {
  const org = await registerOrg(request, 'sr29ev6');
  const c = await makeContact(request, org.token, 'MultiEvC');
  const [ev1, ev2, ev3] = await Promise.all([
    makeEvent(request, org.token, 'Ev1', c.id),
    makeEvent(request, org.token, 'Ev2', c.id),
    makeEvent(request, org.token, 'Ev3', c.id),
  ]);
  const r = await request.get(`/api/v1/contacts/${c.id}/events`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(e => e.id === ev1.id)).toBe(true);
  expect(body.data.some(e => e.id === ev2.id)).toBe(true);
  expect(body.data.some(e => e.id === ev3.id)).toBe(true);
});

// ── AUTH MISSING ON WORKFLOW / NOTIFICATION ENDPOINTS ────────────────────────

test('auth: GET /workflows without auth returns 400 or 401', async ({ request }) => {
  const r = await request.get('/api/v1/workflows');
  expect([400, 401]).toContain(r.status());
});
test('auth: POST /workflows without auth returns 400 or 401', async ({ request }) => {
  const r = await request.post('/api/v1/workflows', { data: { name: 'X', trigger: 'contact_created', actions: [] } });
  expect([400, 401]).toContain(r.status());
});
test('auth: GET /workflows/:id without auth returns 401', async ({ request }) => {
  expect((await request.get('/api/v1/workflows/00000000-0000-0000-0000-000000000000')).status()).toBe(401);
});
test('auth: PATCH /workflows/:id without auth returns 401', async ({ request }) => {
  expect((await request.patch('/api/v1/workflows/00000000-0000-0000-0000-000000000000', { data: { name: 'X' } })).status()).toBe(401);
});
test('auth: DELETE /workflows/:id without auth returns 401', async ({ request }) => {
  expect((await request.delete('/api/v1/workflows/00000000-0000-0000-0000-000000000000')).status()).toBe(401);
});
test('auth: GET /workflows/:id/runs without auth returns 401', async ({ request }) => {
  expect((await request.get('/api/v1/workflows/00000000-0000-0000-0000-000000000000/runs')).status()).toBe(401);
});
test('auth: POST /notifications/register without auth returns 401', async ({ request }) => {
  expect((await request.post('/api/v1/notifications/register', { data: { token: 'x' } })).status()).toBe(401);
});
test('auth: POST /notifications/send without auth returns 401', async ({ request }) => {
  expect((await request.post('/api/v1/notifications/send', { data: { user_id: '00000000-0000-0000-0000-000000000000', title: 'T', body: 'B' } })).status()).toBe(401);
});
test('auth: POST /contacts/import-csv without auth returns 401', async ({ request }) => {
  expect((await request.post('/api/v1/contacts/import-csv', { data: [{ first_name: 'X' }] })).status()).toBe(401);
});
test('auth: POST /contacts/bulk-archive without auth returns 401', async ({ request }) => {
  expect((await request.post('/api/v1/contacts/bulk-archive', { data: { contact_ids: ['00000000-0000-0000-0000-000000000000'] } })).status()).toBe(401);
});

// ── MULTI-ORG CONCURRENT WRITES ───────────────────────────────────────────────

test('multi-org: two orgs create contacts with same email, both succeed in isolation', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([
    registerOrg(request, 'mo29a1'),
    registerOrg(request, 'mo29a2'),
  ]);
  const email = `shared-${Date.now()}@example.com`;
  const [rA, rB] = await Promise.all([
    request.post('/api/v1/contacts', { headers: authHeaders(orgA.token), data: { first_name: 'A', email } }),
    request.post('/api/v1/contacts', { headers: authHeaders(orgB.token), data: { first_name: 'B', email } }),
  ]);
  expect(rA.status()).toBe(201);
  expect(rB.status()).toBe(201);
});
test('multi-org: two orgs create deals with same title concurrently, both succeed', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29b1'), registerOrg(request, 'mo29b2')]);
  const [plA, plB] = await Promise.all([getPipeline(request, orgA.token), getPipeline(request, orgB.token)]);
  const [cA, cB] = await Promise.all([makeContact(request, orgA.token, 'MC'), makeContact(request, orgB.token, 'MC')]);
  const [rA, rB] = await Promise.all([
    request.post('/api/v1/deals', { headers: authHeaders(orgA.token), data: { title: 'SharedDeal', contact_id: cA.id, pipeline_id: plA.id, stage_id: plA.stages[0].id, currency: 'USD' } }),
    request.post('/api/v1/deals', { headers: authHeaders(orgB.token), data: { title: 'SharedDeal', contact_id: cB.id, pipeline_id: plB.id, stage_id: plB.stages[0].id, currency: 'USD' } }),
  ]);
  expect(rA.status()).toBe(201);
  expect(rB.status()).toBe(201);
});
test('multi-org: two orgs create workflows with same name concurrently, both succeed', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29c1'), registerOrg(request, 'mo29c2')]);
  const [rA, rB] = await Promise.all([
    request.post('/api/v1/workflows', { headers: authHeaders(orgA.token), data: { name: 'SameWF', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'X', due_in_days: 1 }] } }),
    request.post('/api/v1/workflows', { headers: authHeaders(orgB.token), data: { name: 'SameWF', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'X', due_in_days: 1 }] } }),
  ]);
  expect(rA.status()).toBe(201);
  expect(rB.status()).toBe(201);
});
test('multi-org: two orgs GET /contacts concurrently — results are isolated', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29d1'), registerOrg(request, 'mo29d2')]);
  await Promise.all([makeContact(request, orgA.token, 'OrgA_only'), makeContact(request, orgB.token, 'OrgB_only')]);
  const [rA, rB] = await Promise.all([
    request.get('/api/v1/contacts', { headers: authHeaders(orgA.token) }),
    request.get('/api/v1/contacts', { headers: authHeaders(orgB.token) }),
  ]);
  const bodyA = await rA.json() as { data: { first_name: string }[] };
  const bodyB = await rB.json() as { data: { first_name: string }[] };
  expect(bodyA.data.some(c => c.first_name === 'OrgA_only')).toBe(true);
  expect(bodyA.data.every(c => c.first_name !== 'OrgB_only')).toBe(true);
  expect(bodyB.data.some(c => c.first_name === 'OrgB_only')).toBe(true);
  expect(bodyB.data.every(c => c.first_name !== 'OrgA_only')).toBe(true);
});
test('multi-org: five orgs register concurrently — all succeed with distinct tokens', async ({ request }) => {
  const orgs = await Promise.all(Array.from({ length: 5 }, (_, i) => registerOrg(request, `mo29e${i}`)));
  const tokens = orgs.map(o => o.token);
  expect(new Set(tokens).size).toBe(5);
  const rs = await Promise.all(orgs.map(o => request.get('/api/v1/contacts', { headers: authHeaders(o.token) })));
  for (const r of rs) expect(r.status()).toBe(200);
});
test('multi-org: two orgs create calendar events with same title concurrently, both succeed', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29f1'), registerOrg(request, 'mo29f2')]);
  const [rA, rB] = await Promise.all([
    request.post('/api/v1/calendar', { headers: authHeaders(orgA.token), data: { title: 'SameEvent', start_time: daysFromNow(1), end_time: daysFromNow(2) } }),
    request.post('/api/v1/calendar', { headers: authHeaders(orgB.token), data: { title: 'SameEvent', start_time: daysFromNow(1), end_time: daysFromNow(2) } }),
  ]);
  expect(rA.status()).toBe(201);
  expect(rB.status()).toBe(201);
  const idA = ((await rA.json()) as { data: { id: string } }).data.id;
  const idB = ((await rB.json()) as { data: { id: string } }).data.id;
  expect(idA).not.toBe(idB);
});
test('multi-org: org A and B list messages concurrently — lists are isolated', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29g1'), registerOrg(request, 'mo29g2')]);
  const [cA, cB] = await Promise.all([makeContact(request, orgA.token, 'MsgCA'), makeContact(request, orgB.token, 'MsgCB')]);
  await Promise.all([
    request.post('/api/v1/messages/in-app', { headers: authHeaders(orgA.token), data: { contact_id: cA.id, body: 'OrgA msg' } }),
    request.post('/api/v1/messages/in-app', { headers: authHeaders(orgB.token), data: { contact_id: cB.id, body: 'OrgB msg' } }),
  ]);
  const [rA, rB] = await Promise.all([
    request.get('/api/v1/messages', { headers: authHeaders(orgA.token) }),
    request.get('/api/v1/messages', { headers: authHeaders(orgB.token) }),
  ]);
  expect(rA.status()).toBe(200);
  expect(rB.status()).toBe(200);
  const bodyA = await rA.json() as { meta: { total: number } };
  const bodyB = await rB.json() as { meta: { total: number } };
  expect(bodyA.meta.total).toBeGreaterThanOrEqual(1);
  expect(bodyB.meta.total).toBeGreaterThanOrEqual(1);
});
test('multi-org: three orgs each create 3 contacts sequentially — lists are isolated', async ({ request }) => {
  const o1 = await registerOrg(request, 'mo29h1');
  const o2 = await registerOrg(request, 'mo29h2');
  const o3 = await registerOrg(request, 'mo29h3');
  for (let i = 0; i < 3; i++) await makeContact(request, o1.token, `O1C${i}`);
  for (let i = 0; i < 3; i++) await makeContact(request, o2.token, `O2C${i}`);
  for (let i = 0; i < 3; i++) await makeContact(request, o3.token, `O3C${i}`);
  const r1 = await request.get('/api/v1/contacts', { headers: authHeaders(o1.token) });
  const r2 = await request.get('/api/v1/contacts', { headers: authHeaders(o2.token) });
  const r3 = await request.get('/api/v1/contacts', { headers: authHeaders(o3.token) });
  const t1 = ((await r1.json()) as { meta: { total: number } }).meta.total;
  const t2 = ((await r2.json()) as { meta: { total: number } }).meta.total;
  const t3 = ((await r3.json()) as { meta: { total: number } }).meta.total;
  expect(t1).toBe(3);
  expect(t2).toBe(3);
  expect(t3).toBe(3);
});
test('multi-org: two orgs race to complete own tasks — each sees correct status', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29i1'), registerOrg(request, 'mo29i2')]);
  const [tA, tB] = await Promise.all([makeTask(request, orgA.token, orgA.userId, 'RaceTA'), makeTask(request, orgB.token, orgB.userId, 'RaceTB')]);
  await Promise.all([
    request.post(`/api/v1/tasks/${tA.id}/complete`, { headers: authHeaders(orgA.token) }),
    request.post(`/api/v1/tasks/${tB.id}/complete`, { headers: authHeaders(orgB.token) }),
  ]);
  const [rA, rB] = await Promise.all([
    request.get(`/api/v1/tasks/${tA.id}`, { headers: authHeaders(orgA.token) }),
    request.get(`/api/v1/tasks/${tB.id}`, { headers: authHeaders(orgB.token) }),
  ]);
  expect(((await rA.json()) as { data: { status: string } }).data.status).toBe('done');
  expect(((await rB.json()) as { data: { status: string } }).data.status).toBe('done');
});
test('multi-org: org A task not visible in org B task list', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mo29j1'), registerOrg(request, 'mo29j2')]);
  const t = await makeTask(request, orgA.token, orgA.userId, 'IsolatedTask');
  const r = await request.get('/api/v1/tasks', { headers: authHeaders(orgB.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id !== t.id)).toBe(true);
});

// ── RESPONSE ENVELOPES FOR REMAINING ENDPOINTS ────────────────────────────────

test('envelope: GET /tasks response has meta.total, meta.page, meta.per_page', async ({ request }) => {
  const org = await registerOrg(request, 'env29t1');
  const r = await request.get('/api/v1/tasks', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
  expect(Array.isArray(body.data)).toBe(true);
  expect(typeof body.meta.total).toBe('number');
  expect(typeof body.meta.page).toBe('number');
  expect(typeof body.meta.per_page).toBe('number');
});
test('envelope: GET /messages response has data array and meta', async ({ request }) => {
  const org = await registerOrg(request, 'env29m1');
  const r = await request.get('/api/v1/messages', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: unknown };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.meta).toBeDefined();
});
test('envelope: GET /calendar response has data array and meta', async ({ request }) => {
  const org = await registerOrg(request, 'env29c1');
  const r = await request.get('/api/v1/calendar', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: unknown };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.meta).toBeDefined();
});
test('envelope: GET /deals/pipelines returns data array', async ({ request }) => {
  const org = await registerOrg(request, 'env29pl1');
  const r = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});
test('envelope: GET /workflows returns data array and meta.total', async ({ request }) => {
  const org = await registerOrg(request, 'env29wf1');
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: { total: number } };
  expect(Array.isArray(body.data)).toBe(true);
  expect(typeof body.meta.total).toBe('number');
});
test('envelope: POST /workflows response has data and no error key', async ({ request }) => {
  const org = await registerOrg(request, 'env29wf2');
  const r = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: { name: 'EnvWF', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'X', due_in_days: 1 }] },
  });
  const body = await r.json() as Record<string, unknown>;
  expect('data' in body).toBe(true);
  expect('error' in body).toBe(false);
});
test('envelope: GET /contacts/:id/events returns data array and meta.total', async ({ request }) => {
  const org = await registerOrg(request, 'env29ev1');
  const c = await makeContact(request, org.token, 'EnvEv');
  const r = await request.get(`/api/v1/contacts/${c.id}/events`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: { total: number } };
  expect(Array.isArray(body.data)).toBe(true);
  expect(typeof body.meta.total).toBe('number');
});
test('envelope: GET /contacts/:id/deals returns data array', async ({ request }) => {
  const org = await registerOrg(request, 'env29dl1');
  const c = await makeContact(request, org.token, 'EnvDl');
  const r = await request.get('/api/v1/contacts/' + c.id + '/deals', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});

// ── CALENDAR EDGE CASES ───────────────────────────────────────────────────────

test('calendar: end_time before start_time returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'cal29e1');
  const r = await request.post('/api/v1/calendar', {
    headers: authHeaders(org.token),
    data: { title: 'BadTime', start_time: daysFromNow(2), end_time: daysFromNow(1) },
  });
  expect(r.status()).toBe(400);
});
test('calendar: event with location stores location on GET', async ({ request }) => {
  const org = await registerOrg(request, 'cal29loc1');
  const ev = await makeEvent(request, org.token, 'WithLocation');
  await request.patch(`/api/v1/calendar/${ev.id}`, { headers: authHeaders(org.token), data: { location: 'Conference Room A' } });
  const r = await request.get(`/api/v1/calendar/${ev.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { location: string } }).data.location).toBe('Conference Room A');
});
test('calendar: event with contact_id links to contact on GET', async ({ request }) => {
  const org = await registerOrg(request, 'cal29c1');
  const c = await makeContact(request, org.token, 'CalC');
  const ev = await makeEvent(request, org.token, 'LinkedCal', c.id);
  const r = await request.get(`/api/v1/calendar/${ev.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { contact_id: string } }).data.contact_id).toBe(c.id);
});
test('calendar: filter by contact_id returns only matching events', async ({ request }) => {
  const org = await registerOrg(request, 'cal29cf1');
  const c1 = await makeContact(request, org.token, 'CF1');
  const c2 = await makeContact(request, org.token, 'CF2');
  const ev1 = await makeEvent(request, org.token, 'E1', c1.id);
  await makeEvent(request, org.token, 'E2', c2.id);
  const r = await request.get(`/api/v1/calendar?contact_id=${c1.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string; contact_id?: string }[] };
  expect(body.data.some(e => e.id === ev1.id)).toBe(true);
  expect(body.data.every(e => e.contact_id === c1.id || e.contact_id === undefined)).toBe(true);
});
test('calendar: PATCH event title updates reflected on GET /:id', async ({ request }) => {
  const org = await registerOrg(request, 'cal29p1');
  const ev = await makeEvent(request, org.token, 'OldCalTitle');
  await request.patch(`/api/v1/calendar/${ev.id}`, { headers: authHeaders(org.token), data: { title: 'NewCalTitle' } });
  const r = await request.get(`/api/v1/calendar/${ev.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { title: string } }).data.title).toBe('NewCalTitle');
});
test('calendar: GET /calendar/:id returns event with start_time and end_time', async ({ request }) => {
  const org = await registerOrg(request, 'cal29g1');
  const ev = await makeEvent(request, org.token, 'TimeEvent');
  const r = await request.get(`/api/v1/calendar/${ev.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { start_time: string; end_time: string } };
  expect(body.data.start_time).toBeTruthy();
  expect(body.data.end_time).toBeTruthy();
});
test('calendar: POST /calendar/:id/complete marks event as completed', async ({ request }) => {
  const org = await registerOrg(request, 'cal29comp1');
  const ev = await makeEvent(request, org.token, 'CompletableEvent');
  const r = await request.post(`/api/v1/calendar/${ev.id}/complete`, { headers: authHeaders(org.token) });
  expect([200, 204]).toContain(r.status());
});
test('calendar: POST /calendar/:id/notes adds post-meeting notes', async ({ request }) => {
  const org = await registerOrg(request, 'cal29n1');
  const ev = await makeEvent(request, org.token, 'NoteableEvent');
  await request.post(`/api/v1/calendar/${ev.id}/complete`, { headers: authHeaders(org.token) });
  const r = await request.post(`/api/v1/calendar/${ev.id}/notes`, { headers: authHeaders(org.token), data: { notes: 'Meeting went well.' } });
  expect(r.status()).toBe(200);
});
test('calendar: filter by status=scheduled returns only scheduled events', async ({ request }) => {
  const org = await registerOrg(request, 'cal29sf1');
  await makeEvent(request, org.token, 'SchedEvent');
  const r = await request.get('/api/v1/calendar?status=scheduled', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { status: string }[] };
  expect(r.status()).toBe(200);
  expect(body.data.every(e => e.status === 'scheduled')).toBe(true);
});
test('calendar: GET /calendar nonexistent ID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'cal29404');
  const r = await request.get('/api/v1/calendar/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
});
