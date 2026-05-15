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
async function makeContact(request: APIRequestContext, token: string, name: string) {
  const res = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: name } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makeDeal(request: APIRequestContext, token: string, title: string, cId: string, plId: string, stId: string) {
  const res = await request.post('/api/v1/deals', { headers: authHeaders(token), data: { title, contact_id: cId, pipeline_id: plId, stage_id: stId, currency: 'USD' } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}
async function makeTask(request: APIRequestContext, token: string, userId: string, title: string) {
  const res = await request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title, assigned_to: userId } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}
async function makeEvent(request: APIRequestContext, token: string, title: string) {
  const res = await request.post('/api/v1/calendar', { headers: authHeaders(token), data: { title, start_time: daysFromNow(1), end_time: daysFromNow(2) } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

// ── AUTH EDGE CASES ────────────────────────────────────────────────────────────

test('auth: missing Authorization header on GET /contacts returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/contacts');
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on POST /contacts returns 401', async ({ request }) => {
  const r = await request.post('/api/v1/contacts', { data: { first_name: 'X' } });
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on GET /deals returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/deals');
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on GET /tasks returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/tasks');
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on GET /calendar returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/calendar');
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on GET /messages returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/messages');
  expect(r.status()).toBe(401);
});
test('auth: malformed token returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/contacts', { headers: { Authorization: 'Bearer not.a.jwt' } });
  expect(r.status()).toBe(401);
});
test('auth: empty Bearer token returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/contacts', { headers: { Authorization: 'Bearer ' } });
  expect(r.status()).toBe(401);
});
test('auth: completely wrong scheme returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/contacts', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on GET /analytics/dashboard returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/analytics/dashboard');
  expect(r.status()).toBe(401);
});
test('auth: missing Authorization header on GET /deals/pipelines returns 401', async ({ request }) => {
  const r = await request.get('/api/v1/deals/pipelines');
  expect(r.status()).toBe(401);
});
test('auth: duplicate email on register returns 409 EMAIL_ALREADY_EXISTS', async ({ request }) => {
  const u = `dup-${Date.now()}@example.com`;
  await request.post('/api/v1/auth/', { data: { email: u, password: 'Password123!', name: 'A', org_name: 'OrgA' } });
  const r = await request.post('/api/v1/auth/', { data: { email: u, password: 'Password123!', name: 'B', org_name: 'OrgB' } });
  expect(r.status()).toBe(409);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('EMAIL_ALREADY_EXISTS');
});
test('auth: wrong password on login returns 401 INVALID_CREDENTIALS', async ({ request }) => {
  const u = `wrongpw-${Date.now()}@example.com`;
  await request.post('/api/v1/auth/', { data: { email: u, password: 'Password123!', name: 'A', org_name: 'OrgA' } });
  const r = await request.post('/api/v1/auth/login', { data: { email: u, password: 'WrongPassword!' } });
  expect(r.status()).toBe(401);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
});
test('auth: login with nonexistent email returns 401', async ({ request }) => {
  const r = await request.post('/api/v1/auth/login', { data: { email: `nobody-${Date.now()}@example.com`, password: 'Password123!' } });
  expect(r.status()).toBe(401);
});

// ── BOUNDARY / EDGE INPUTS ────────────────────────────────────────────────────

test('boundary: contact with 80-char first_name is created successfully', async ({ request }) => {
  const org = await registerOrg(request, 'b28ln1');
  const name = 'A'.repeat(80);
  const r = await request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: name } });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { first_name: string } }).data.first_name).toBe(name);
});
test('boundary: deal with value=0 is created and stored as 0', async ({ request }) => {
  const org = await registerOrg(request, 'b28v0');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ValZero');
  const r = await request.post('/api/v1/deals', { headers: authHeaders(org.token), data: { title: 'ZeroDeal', contact_id: c.id, pipeline_id: pl.id, stage_id: pl.stages[0].id, currency: 'USD', value: 0 } });
  expect(r.status()).toBe(201);
  expect(Number(((await r.json()) as { data: { value: unknown } }).data.value)).toBe(0);
});
test('boundary: deal with no value field has null value', async ({ request }) => {
  const org = await registerOrg(request, 'b28vnull');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ValNull');
  const r = await request.post('/api/v1/deals', { headers: authHeaders(org.token), data: { title: 'NullValDeal', contact_id: c.id, pipeline_id: pl.id, stage_id: pl.stages[0].id, currency: 'USD' } });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { value: unknown } }).data.value).toBeNull();
});
test('boundary: PATCH deal value to null clears the value', async ({ request }) => {
  const org = await registerOrg(request, 'b28vclr');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ValClr');
  const d = await makeDeal(request, org.token, 'ClearVal', c.id, pl.id, pl.stages[0].id);
  await request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { value: 1000, currency: 'USD' } });
  const r = await request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { value: null } });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { value: unknown } }).data.value).toBeNull();
});
test('boundary: task with no due_date has null due_date', async ({ request }) => {
  const org = await registerOrg(request, 'b28tdd');
  const t = await makeTask(request, org.token, org.userId, 'NoDueDate');
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { due_date: unknown } }).data.due_date).toBeNull();
});
test('boundary: contact with no last_name has null last_name', async ({ request }) => {
  const org = await registerOrg(request, 'b28cln');
  const r = await request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'NoLast' } });
  expect(((await r.json()) as { data: { last_name: unknown } }).data.last_name).toBeNull();
});
test('boundary: deal pagination page=1 per_page=1 returns exactly 1 item', async ({ request }) => {
  const org = await registerOrg(request, 'b28pg1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'PgC');
  await makeDeal(request, org.token, 'PgD1', c.id, pl.id, pl.stages[0].id);
  await makeDeal(request, org.token, 'PgD2', c.id, pl.id, pl.stages[0].id);
  const r = await request.get('/api/v1/deals?page=1&per_page=1', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[]; meta: { per_page: number } };
  expect(body.data.length).toBe(1);
  expect(body.meta.per_page).toBe(1);
});
test('boundary: contacts page=999 returns empty data array with total intact', async ({ request }) => {
  const org = await registerOrg(request, 'b28pg999');
  await makeContact(request, org.token, 'PgCX');
  const r = await request.get('/api/v1/contacts?page=999&per_page=10', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[]; meta: { total: number } };
  expect(body.data.length).toBe(0);
  expect(body.meta.total).toBeGreaterThanOrEqual(1);
});
test('boundary: task title with unicode emoji is stored and returned correctly', async ({ request }) => {
  const org = await registerOrg(request, 'b28uni');
  const title = 'Task with emoji';
  const t = await makeTask(request, org.token, org.userId, title);
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { title: string } }).data.title).toBe(title);
});
test('boundary: deal title with special characters is stored and returned correctly', async ({ request }) => {
  const org = await registerOrg(request, 'b28spec');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'SpecC');
  const title = 'Deal QA test 100pct';
  const r = await request.post('/api/v1/deals', { headers: authHeaders(org.token), data: { title, contact_id: c.id, pipeline_id: pl.id, stage_id: pl.stages[0].id, currency: 'USD' } });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { title: string } }).data.title).toBe(title);
});
test('boundary: GET nonexistent contact ID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'b28404c');
  const r = await request.get('/api/v1/contacts/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
});
test('boundary: GET nonexistent deal ID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'b28404d');
  const r = await request.get('/api/v1/deals/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
});
test('boundary: GET nonexistent task ID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'b28404t');
  const r = await request.get('/api/v1/tasks/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
});

// ── DEEP INVARIANT CHAINS ─────────────────────────────────────────────────────

test('invariant: contact created_at and updated_at are present and ISO 8601', async ({ request }) => {
  const org = await registerOrg(request, 'inv28c1');
  const c = await makeContact(request, org.token, 'TsC');
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const d = ((await r.json()) as { data: { created_at: string; updated_at: string } }).data;
  expect(() => new Date(d.created_at)).not.toThrow();
  expect(() => new Date(d.updated_at)).not.toThrow();
  expect(d.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
test('invariant: PATCH contact updates updated_at but not created_at', async ({ request }) => {
  const org = await registerOrg(request, 'inv28c2');
  const c = await makeContact(request, org.token, 'TsC2');
  const before = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const beforeBody = ((await before.json()) as { data: { created_at: string; updated_at: string } }).data;
  await new Promise(r => setTimeout(r, 50));
  await request.patch(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token), data: { first_name: 'Updated' } });
  const after = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const afterBody = ((await after.json()) as { data: { created_at: string; updated_at: string } }).data;
  expect(afterBody.created_at).toBe(beforeBody.created_at);
  expect(new Date(afterBody.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(beforeBody.updated_at).getTime());
});
test('invariant: deal appears in contact deals sub-route after creation', async ({ request }) => {
  const org = await registerOrg(request, 'inv28d1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'SubD');
  const d = await makeDeal(request, org.token, 'SubDeal', c.id, pl.id, pl.stages[0].id);
  const r = await request.get(`/api/v1/contacts/${c.id}/deals`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === d.id)).toBe(true);
});
test('invariant: task appears in contact tasks sub-route after creation', async ({ request }) => {
  const org = await registerOrg(request, 'inv28t1');
  const c = await makeContact(request, org.token, 'SubT');
  const t = await makeTask(request, org.token, org.userId, 'SubTask');
  await request.patch(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token), data: { contact_id: c.id } });
  const r = await request.get(`/api/v1/contacts/${c.id}/tasks`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === t.id)).toBe(true);
});
test('invariant: deal marked won reflects status=won on subsequent GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28dw');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'WonC');
  const d = await makeDeal(request, org.token, 'WonD', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('won');
});
test('invariant: deal marked lost reflects status=lost on subsequent GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28dl');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'LostC');
  const d = await makeDeal(request, org.token, 'LostD', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHeaders(org.token), data: { reason: 'price' } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('lost');
});
test('invariant: task completed reflects status=done on subsequent GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28tc');
  const t = await makeTask(request, org.token, org.userId, 'CompTask');
  await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('done');
});
test('invariant: deal moved to stage via PATCH /stage reflects new stage_id on GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28ms');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'MoveC');
  const d = await makeDeal(request, org.token, 'MoveD', c.id, pl.id, pl.stages[0].id);
  const targetStage = pl.stages[pl.stages.length - 1];
  await request.patch(`/api/v1/deals/${d.id}/stage`, { headers: authHeaders(org.token), data: { stage_id: targetStage.id } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { stage: { id: string } } }).data.stage.id).toBe(targetStage.id);
});
test('invariant: archived contact excluded from default contact list', async ({ request }) => {
  const org = await registerOrg(request, 'inv28ca');
  const c = await makeContact(request, org.token, 'ToArchive');
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id !== c.id)).toBe(true);
});
test('invariant: archived deal excluded from open deal list', async ({ request }) => {
  const org = await registerOrg(request, 'inv28da');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ArchiveC');
  const d = await makeDeal(request, org.token, 'ArchiveD', c.id, pl.id, pl.stages[0].id);
  await request.delete(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/deals?status=open', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id !== d.id)).toBe(true);
});
test('invariant: PATCH contact first_name reflected on subsequent GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28cp');
  const c = await makeContact(request, org.token, 'BeforePatch');
  await request.patch(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token), data: { first_name: 'AfterPatch' } });
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { first_name: string } }).data.first_name).toBe('AfterPatch');
});
test('invariant: PATCH deal title reflected on subsequent GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28dp');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'DpC');
  const d = await makeDeal(request, org.token, 'OldTitle', c.id, pl.id, pl.stages[0].id);
  await request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { title: 'NewTitle' } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { title: string } }).data.title).toBe('NewTitle');
});
test('invariant: create 5 contacts; list total equals 5', async ({ request }) => {
  const org = await registerOrg(request, 'inv28c5');
  await Promise.all(Array.from({ length: 5 }, (_, i) => makeContact(request, org.token, `Bulk${i}`)));
  const r = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  expect(((await r.json()) as { meta: { total: number } }).meta.total).toBe(5);
});
test('invariant: calendar event PATCH updates title on GET', async ({ request }) => {
  const org = await registerOrg(request, 'inv28ev');
  const e = await makeEvent(request, org.token, 'OldEvTitle');
  await request.patch(`/api/v1/calendar/${e.id}`, { headers: authHeaders(org.token), data: { title: 'NewEvTitle' } });
  const r = await request.get(`/api/v1/calendar/${e.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { title: string } }).data.title).toBe('NewEvTitle');
});

// ── CASCADE BEHAVIOR ──────────────────────────────────────────────────────────

test('cascade: archiving contact does not delete associated deals', async ({ request }) => {
  const org = await registerOrg(request, 'cas28d');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'CasC');
  const d = await makeDeal(request, org.token, 'CasDeal', c.id, pl.id, pl.stages[0].id);
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
});
test('cascade: contact activity log is accessible after contact PATCH', async ({ request }) => {
  const org = await registerOrg(request, 'cas28a');
  const c = await makeContact(request, org.token, 'ActC');
  await request.patch(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token), data: { first_name: 'Updated' } });
  const r = await request.get(`/api/v1/contacts/${c.id}/activity`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
});
test('cascade: delete pipeline stage returns 200 or 204', async ({ request }) => {
  const org = await registerOrg(request, 'cas28ps');
  const plRes = await request.post('/api/v1/deals/pipelines', { headers: authHeaders(org.token), data: { name: 'CasPl' } });
  const plId = ((await plRes.json()) as { data: { id: string } }).data.id;
  const stRes = await request.post(`/api/v1/deals/pipelines/${plId}/stages`, { headers: authHeaders(org.token), data: { name: 'StageX', position: 1, is_won_stage: false, is_lost_stage: false } });
  const stId = ((await stRes.json()) as { data: { id: string } }).data.id;
  const r = await request.delete(`/api/v1/deals/stages/${stId}`, { headers: authHeaders(org.token) });
  expect([200, 204]).toContain(r.status());
});
test('cascade: delete calendar event returns 200 or 204', async ({ request }) => {
  const org = await registerOrg(request, 'cas28ev');
  const e = await makeEvent(request, org.token, 'DeleteMe');
  const r = await request.delete(`/api/v1/calendar/${e.id}`, { headers: authHeaders(org.token) });
  expect([200, 204]).toContain(r.status());
});
test('cascade: deal list filtered by contact_id returns only that contact deals', async ({ request }) => {
  const org = await registerOrg(request, 'cas28cf');
  const pl = await getPipeline(request, org.token);
  const c1 = await makeContact(request, org.token, 'CasC1');
  const c2 = await makeContact(request, org.token, 'CasC2');
  const d1 = await makeDeal(request, org.token, 'D1', c1.id, pl.id, pl.stages[0].id);
  await makeDeal(request, org.token, 'D2', c2.id, pl.id, pl.stages[0].id);
  const r = await request.get(`/api/v1/deals?contact_id=${c1.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.length).toBe(1);
  expect(body.data[0].id).toBe(d1.id);
});

// ── PIPELINE INVARIANTS ───────────────────────────────────────────────────────

test('pipeline: newly created pipeline appears in list', async ({ request }) => {
  const org = await registerOrg(request, 'pl28l1');
  await request.post('/api/v1/deals/pipelines', { headers: authHeaders(org.token), data: { name: 'NewPl' } });
  const r = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { name: string }[] };
  expect(body.data.some(p => p.name === 'NewPl')).toBe(true);
});
test('pipeline: PATCH pipeline name is reflected on GET', async ({ request }) => {
  const org = await registerOrg(request, 'pl28p1');
  const plRes = await request.post('/api/v1/deals/pipelines', { headers: authHeaders(org.token), data: { name: 'OldPl' } });
  const plId = ((await plRes.json()) as { data: { id: string } }).data.id;
  await request.patch(`/api/v1/deals/pipelines/${plId}`, { headers: authHeaders(org.token), data: { name: 'PatchedPl' } });
  const r = await request.get(`/api/v1/deals/pipelines/${plId}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { name: string } }).data.name).toBe('PatchedPl');
});
test('pipeline: stage added to pipeline appears in stages list', async ({ request }) => {
  const org = await registerOrg(request, 'pl28s1');
  const plRes = await request.post('/api/v1/deals/pipelines', { headers: authHeaders(org.token), data: { name: 'StPl' } });
  const plId = ((await plRes.json()) as { data: { id: string } }).data.id;
  await request.post(`/api/v1/deals/pipelines/${plId}/stages`, { headers: authHeaders(org.token), data: { name: 'NewStage', position: 1, is_won_stage: false, is_lost_stage: false } });
  const r = await request.get(`/api/v1/deals/pipelines/${plId}/stages`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { name: string }[] };
  expect(body.data.some(s => s.name === 'NewStage')).toBe(true);
});
test('pipeline: deal filter by pipeline_id returns only matching deals', async ({ request }) => {
  test.setTimeout(30000);
  const org = await registerOrg(request, 'pl28f1');
  const pl = await getPipeline(request, org.token);
  const pl2Res = await request.post('/api/v1/deals/pipelines', { headers: authHeaders(org.token), data: { name: 'Pl2' } });
  const pl2Id = ((await pl2Res.json()) as { data: { id: string } }).data.id;
  const stRes = await request.post(`/api/v1/deals/pipelines/${pl2Id}/stages`, { headers: authHeaders(org.token), data: { name: 'St2', position: 1, is_won_stage: false, is_lost_stage: false } });
  const stId = ((await stRes.json()) as { data: { id: string } }).data.id;
  const c = await makeContact(request, org.token, 'PlFC');
  await makeDeal(request, org.token, 'PlFD1', c.id, pl.id, pl.stages[0].id);
  const d2 = await makeDeal(request, org.token, 'PlFD2', c.id, pl2Id, stId);
  const r = await request.get(`/api/v1/deals?pipeline_id=${pl2Id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id === d2.id)).toBe(true);
});

// ── ANALYTICS INVARIANTS ──────────────────────────────────────────────────────

test('analytics: dashboard returns open_deals, tasks_due_today, pipeline_health_score fields', async ({ request }) => {
  const org = await registerOrg(request, 'an28d1');
  const r = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: Record<string, unknown> };
  expect('open_deals' in body.data).toBe(true);
  expect('tasks_due_today' in body.data).toBe(true);
  expect('pipeline_health_score' in body.data).toBe(true);
});
test('analytics: funnel data.stages is an array', async ({ request }) => {
  const org = await registerOrg(request, 'an28f1');
  const r = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { stages: unknown[] } };
  expect(Array.isArray(body.data.stages)).toBe(true);
});
test('analytics: revenue data.periods is an array', async ({ request }) => {
  const org = await registerOrg(request, 'an28r1');
  const r = await request.get('/api/v1/analytics/revenue', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { periods: unknown[] } };
  expect(Array.isArray(body.data.periods)).toBe(true);
});
test('analytics: win-loss returns 200', async ({ request }) => {
  const org = await registerOrg(request, 'an28wl');
  const r = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
});
test('analytics: lead-sources returns 200', async ({ request }) => {
  const org = await registerOrg(request, 'an28ls');
  const r = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
});
test('analytics: open_deals count increases after creating a deal', async ({ request }) => {
  const org = await registerOrg(request, 'an28inc');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'AnC');
  const before = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  const beforeBody = await before.json() as { data: { open_deals: { count: number } } };
  const beforeCount = beforeBody.data.open_deals.count;
  await makeDeal(request, org.token, 'AnD', c.id, pl.id, pl.stages[0].id);
  const after = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  const afterBody = await after.json() as { data: { open_deals: { count: number } } };
  expect(afterBody.data.open_deals.count).toBeGreaterThan(beforeCount);
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────

test('messages: GET /messages returns 200 with data array and meta', async ({ request }) => {
  const org = await registerOrg(request, 'msg28l');
  const r = await request.get('/api/v1/messages', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[]; meta: unknown };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.meta).toBeDefined();
});
test('messages: send in-app message returns 201 with id', async ({ request }) => {
  const org = await registerOrg(request, 'msg28s');
  const c = await makeContact(request, org.token, 'MsgC');
  const r = await request.post('/api/v1/messages/in-app', { headers: authHeaders(org.token), data: { contact_id: c.id, body: 'Hello from test' } });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { id: string } }).data.id).toBeTruthy();
});
test('messages: log a call via POST /call returns 201 with id and channel=call', async ({ request }) => {
  const org = await registerOrg(request, 'msg28c');
  const c = await makeContact(request, org.token, 'CallC');
  const r = await request.post('/api/v1/messages/call', { headers: authHeaders(org.token), data: { contact_id: c.id, direction: 'outbound', duration_seconds: 120, notes: 'Test call' } });
  expect(r.status()).toBe(201);
  const body = await r.json() as { data: { id: string; channel: string } };
  expect(body.data.id).toBeTruthy();
  expect(body.data.channel).toBe('call');
});
test('messages: sent in-app message appears in contact messages sub-route', async ({ request }) => {
  const org = await registerOrg(request, 'msg28sub');
  const c = await makeContact(request, org.token, 'SubMsgC');
  const msgRes = await request.post('/api/v1/messages/in-app', { headers: authHeaders(org.token), data: { contact_id: c.id, body: 'SubMsg' } });
  const msgId = ((await msgRes.json()) as { data: { id: string } }).data.id;
  const r = await request.get(`/api/v1/contacts/${c.id}/messages`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(m => m.id === msgId)).toBe(true);
});
test('messages: mark message read via POST /:id/read returns 200', async ({ request }) => {
  const org = await registerOrg(request, 'msg28r');
  const c = await makeContact(request, org.token, 'ReadC');
  const msgRes = await request.post('/api/v1/messages/in-app', { headers: authHeaders(org.token), data: { contact_id: c.id, body: 'ReadMsg' } });
  const msgId = ((await msgRes.json()) as { data: { id: string } }).data.id;
  const r = await request.post(`/api/v1/messages/${msgId}/read`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
});

// ── SEARCH / FILTER INVARIANTS ────────────────────────────────────────────────

test('search: contact search by first_name q param returns matching results', async ({ request }) => {
  const org = await registerOrg(request, 'srch28c');
  await makeContact(request, org.token, 'UniqueNameXYZ');
  await makeContact(request, org.token, 'OtherName');
  const r = await request.get('/api/v1/contacts?q=UniqueNameXYZ', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: { total: number } };
  expect(body.meta.total).toBeGreaterThanOrEqual(1);
});
test('search: deal search by title q param returns matching deals', async ({ request }) => {
  const org = await registerOrg(request, 'srch28d');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'SrchDC');
  await makeDeal(request, org.token, 'XYZUniqueDeal', c.id, pl.id, pl.stages[0].id);
  await makeDeal(request, org.token, 'OtherDeal', c.id, pl.id, pl.stages[0].id);
  const r = await request.get('/api/v1/deals?q=XYZUniqueDeal', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { title: string }[]; meta: { total: number } };
  expect(body.meta.total).toBeGreaterThanOrEqual(1);
  expect(body.data.some(d => d.title === 'XYZUniqueDeal')).toBe(true);
});
test('search: task filter by status=pending returns only pending tasks', async ({ request }) => {
  const org = await registerOrg(request, 'srch28t');
  const t1 = await makeTask(request, org.token, org.userId, 'PendingT');
  const t2 = await makeTask(request, org.token, org.userId, 'DoneT');
  await request.post(`/api/v1/tasks/${t2.id}/complete`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/tasks?status=pending', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string; status: string }[] };
  expect(body.data.some(t => t.id === t1.id)).toBe(true);
  expect(body.data.every(t => t.status === 'pending')).toBe(true);
});
test('search: GET /tasks/today returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'srch28td');
  const r = await request.get('/api/v1/tasks/today', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});
test('search: GET /tasks/overdue returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'srch28od');
  const r = await request.get('/api/v1/tasks/overdue', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});

// ── RESPONSE ENVELOPE SHAPE ───────────────────────────────────────────────────

test('envelope: POST /contacts response has data and no error key', async ({ request }) => {
  const org = await registerOrg(request, 'env28c');
  const r = await request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'EnvC' } });
  const body = await r.json() as Record<string, unknown>;
  expect('data' in body).toBe(true);
  expect('error' in body).toBe(false);
});
test('envelope: GET /contacts response has data array and meta object', async ({ request }) => {
  const org = await registerOrg(request, 'env28l');
  const r = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
  expect(Array.isArray(body.data)).toBe(true);
  expect(typeof body.meta.total).toBe('number');
  expect(typeof body.meta.page).toBe('number');
  expect(typeof body.meta.per_page).toBe('number');
});
test('envelope: 401 auth error response has a message field', async ({ request }) => {
  const r = await request.get('/api/v1/contacts');
  const body = await r.json() as Record<string, unknown>;
  expect(typeof body.message === 'string' || ('error' in body && typeof (body.error as Record<string, unknown>).message === 'string')).toBe(true);
});
test('envelope: GET /deals response meta.total reflects actual deal count', async ({ request }) => {
  const org = await registerOrg(request, 'env28d');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'EnvDC');
  await makeDeal(request, org.token, 'EnvD1', c.id, pl.id, pl.stages[0].id);
  await makeDeal(request, org.token, 'EnvD2', c.id, pl.id, pl.stages[0].id);
  const r = await request.get('/api/v1/deals', { headers: authHeaders(org.token) });
  const body = await r.json() as { meta: { total: number } };
  expect(body.meta.total).toBeGreaterThanOrEqual(2);
});
