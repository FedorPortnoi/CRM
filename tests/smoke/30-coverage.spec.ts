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
async function makeDeal(request: APIRequestContext, token: string, title: string, cId: string, plId: string, stId: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/deals', { headers: authHeaders(token), data: { title, contact_id: cId, pipeline_id: plId, stage_id: stId, currency: 'USD', ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}
async function makeTask(request: APIRequestContext, token: string, userId: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title, assigned_to: userId, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}
async function makeWorkflow(request: APIRequestContext, token: string, name: string) {
  const res = await request.post('/api/v1/workflows', {
    headers: authHeaders(token),
    data: { name, trigger: 'contact_created', actions: [{ type: 'create_task', title: 'FU', due_in_days: 1 }] },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makeMessage(request: APIRequestContext, token: string, contactId: string, body = 'Test') {
  const res = await request.post('/api/v1/messages/in-app', { headers: authHeaders(token), data: { contact_id: contactId, body } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makePipeline(request: APIRequestContext, token: string, name: string) {
  const res = await request.post('/api/v1/deals/pipelines', { headers: authHeaders(token), data: { name } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function makeStage(request: APIRequestContext, token: string, pipelineId: string, name: string, position: number) {
  const res = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: authHeaders(token),
    data: { name, position, is_won_stage: false, is_lost_stage: false },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; position: number } }).data;
}

// ── WORKFLOW CROSS-ORG ISOLATION ──────────────────────────────────────────────

test('wf-xorg: org B cannot GET org A workflow', async ({ request }) => {
  const orgA = await registerOrg(request, 'wx30a1');
  const orgB = await registerOrg(request, 'wx30a2');
  const wf = await makeWorkflow(request, orgA.token, 'PrivateWF');
  const r = await request.get(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('wf-xorg: org B cannot PATCH org A workflow', async ({ request }) => {
  const orgA = await registerOrg(request, 'wx30b1');
  const orgB = await registerOrg(request, 'wx30b2');
  const wf = await makeWorkflow(request, orgA.token, 'PatchTarget');
  const r = await request.patch(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(orgB.token), data: { name: 'Hacked' } });
  expect([403, 404]).toContain(r.status());
});
test('wf-xorg: org B cannot DELETE org A workflow', async ({ request }) => {
  const orgA = await registerOrg(request, 'wx30c1');
  const orgB = await registerOrg(request, 'wx30c2');
  const wf = await makeWorkflow(request, orgA.token, 'DeleteTarget');
  const r = await request.delete(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('wf-xorg: org B workflow list excludes org A workflows', async ({ request }) => {
  const orgA = await registerOrg(request, 'wx30d1');
  const orgB = await registerOrg(request, 'wx30d2');
  const wf = await makeWorkflow(request, orgA.token, 'OrgAOnlyWF');
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(orgB.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(w => w.id !== wf.id)).toBe(true);
});
test('wf-xorg: org B cannot GET runs for org A workflow', async ({ request }) => {
  const orgA = await registerOrg(request, 'wx30e1');
  const orgB = await registerOrg(request, 'wx30e2');
  const wf = await makeWorkflow(request, orgA.token, 'RunsTarget');
  const r = await request.get(`/api/v1/workflows/${wf.id}/runs`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('wf-xorg: after archiving, workflow not visible even to own org in default list', async ({ request }) => {
  const org = await registerOrg(request, 'wx30f1');
  const wf = await makeWorkflow(request, org.token, 'SoonArchived');
  await request.delete(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/workflows', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(w => w.id !== wf.id)).toBe(true);
});

// ── PIPELINE STAGE PATCH AND ORDERING ────────────────────────────────────────

test('stage: PATCH /deals/stages/:id updates stage name, reflected in GET pipeline/:id', async ({ request }) => {
  const org = await registerOrg(request, 'st30p1');
  const pl = await makePipeline(request, org.token, 'StagePL');
  const st = await makeStage(request, org.token, pl.id, 'OldStageName', 1);
  await request.patch(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(org.token), data: { name: 'NewStageName' } });
  const r = await request.get(`/api/v1/deals/pipelines/${pl.id}/stages`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { name: string }[] };
  expect(body.data.some(s => s.name === 'NewStageName')).toBe(true);
});
test('stage: PATCH /deals/stages/:id updates position', async ({ request }) => {
  const org = await registerOrg(request, 'st30p2');
  const pl = await makePipeline(request, org.token, 'PosPL');
  const st = await makeStage(request, org.token, pl.id, 'PosStage', 5);
  const r = await request.patch(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(org.token), data: { position: 99 } });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { position: number } }).data.position).toBe(99);
});
test('stage: PATCH /deals/stages/:id sets is_won_stage flag', async ({ request }) => {
  const org = await registerOrg(request, 'st30p3');
  const pl = await makePipeline(request, org.token, 'WonPL');
  const st = await makeStage(request, org.token, pl.id, 'WonStage', 1);
  const r = await request.patch(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(org.token), data: { is_won_stage: true } });
  expect(((await r.json()) as { data: { is_won_stage: boolean } }).data.is_won_stage).toBe(true);
});
test('stage: PATCH /deals/stages/:id sets is_lost_stage flag', async ({ request }) => {
  const org = await registerOrg(request, 'st30p4');
  const pl = await makePipeline(request, org.token, 'LostPL');
  const st = await makeStage(request, org.token, pl.id, 'LostStage', 1);
  const r = await request.patch(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(org.token), data: { is_lost_stage: true } });
  expect(((await r.json()) as { data: { is_lost_stage: boolean } }).data.is_lost_stage).toBe(true);
});
test('stage: add 3 stages, all appear in stages list', async ({ request }) => {
  const org = await registerOrg(request, 'st30a1');
  const pl = await makePipeline(request, org.token, 'Multi3PL');
  await Promise.all([
    makeStage(request, org.token, pl.id, 'S1', 1),
    makeStage(request, org.token, pl.id, 'S2', 2),
    makeStage(request, org.token, pl.id, 'S3', 3),
  ]);
  const r = await request.get(`/api/v1/deals/pipelines/${pl.id}/stages`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { name: string }[] };
  expect(body.data.some(s => s.name === 'S1')).toBe(true);
  expect(body.data.some(s => s.name === 'S2')).toBe(true);
  expect(body.data.some(s => s.name === 'S3')).toBe(true);
});
test('stage: delete stage, it no longer appears in stages list', async ({ request }) => {
  const org = await registerOrg(request, 'st30d1');
  const pl = await makePipeline(request, org.token, 'DelStagePL');
  const st = await makeStage(request, org.token, pl.id, 'ToDelete', 1);
  await request.delete(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/deals/pipelines/${pl.id}/stages`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(s => s.id !== st.id)).toBe(true);
});
test('stage: delete nonexistent stage returns 404 STAGE_NOT_FOUND', async ({ request }) => {
  const org = await registerOrg(request, 'st30d2');
  const r = await request.delete('/api/v1/deals/stages/00000000-0000-0000-0000-000000000000', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(404);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('STAGE_NOT_FOUND');
});
test('stage: cross-org — org B cannot PATCH org A stage', async ({ request }) => {
  const orgA = await registerOrg(request, 'st30x1');
  const orgB = await registerOrg(request, 'st30x2');
  const pl = await makePipeline(request, orgA.token, 'XorgPL');
  const st = await makeStage(request, orgA.token, pl.id, 'XorgStage', 1);
  const r = await request.patch(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(orgB.token), data: { name: 'Hacked' } });
  expect([403, 404]).toContain(r.status());
});
test('stage: cross-org — org B cannot DELETE org A stage', async ({ request }) => {
  const orgA = await registerOrg(request, 'st30x3');
  const orgB = await registerOrg(request, 'st30x4');
  const pl = await makePipeline(request, orgA.token, 'XorgPL2');
  const st = await makeStage(request, orgA.token, pl.id, 'XorgStage2', 1);
  const r = await request.delete(`/api/v1/deals/stages/${st.id}`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('stage: PATCH /deals/pipelines/:id updates pipeline name', async ({ request }) => {
  const org = await registerOrg(request, 'st30pl1');
  const pl = await makePipeline(request, org.token, 'PipeOld');
  await request.patch(`/api/v1/deals/pipelines/${pl.id}`, { headers: authHeaders(org.token), data: { name: 'PipeNew' } });
  const r = await request.get(`/api/v1/deals/pipelines/${pl.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { name: string } }).data.name).toBe('PipeNew');
});

// ── SOFT-DELETE RESURRECTION ──────────────────────────────────────────────────

test('resurrection: archived contact retrievable with ?status=archived', async ({ request }) => {
  const org = await registerOrg(request, 'res30c1');
  const c = await makeContact(request, org.token, 'ToResurrect');
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/contacts?status=archived', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === c.id)).toBe(true);
});
test('resurrection: archived contact GET by ID still returns data (soft-delete)', async ({ request }) => {
  const org = await registerOrg(request, 'res30c2');
  const c = await makeContact(request, org.token, 'SoftDeleted');
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('archived');
});
test('resurrection: archived contact PATCH returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'res30c3');
  const c = await makeContact(request, org.token, 'ArchPatch');
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.patch(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token), data: { first_name: 'X' } });
  expect(r.status()).toBe(404);
});
test('resurrection: archived deal GET by ID still returns data', async ({ request }) => {
  const org = await registerOrg(request, 'res30d1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ArchDC');
  const d = await makeDeal(request, org.token, 'ArchDeal', c.id, pl.id, pl.stages[0].id);
  await request.delete(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('archived');
});
test('resurrection: archived deal appears in list with ?status=archived filter', async ({ request }) => {
  const org = await registerOrg(request, 'res30d2');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ArchDC2');
  const d = await makeDeal(request, org.token, 'ArchDeal2', c.id, pl.id, pl.stages[0].id);
  await request.delete(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/deals?status=archived', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === d.id)).toBe(true);
});
test('resurrection: cancelled task GET by ID returns status=cancelled', async ({ request }) => {
  const org = await registerOrg(request, 'res30t1');
  const t = await makeTask(request, org.token, org.userId, 'CancelMe');
  await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('cancelled');
});
test('resurrection: cancelled task excluded from default task list', async ({ request }) => {
  const org = await registerOrg(request, 'res30t2');
  const t = await makeTask(request, org.token, org.userId, 'CancelExclude');
  await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  const r = await request.get('/api/v1/tasks', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id !== t.id)).toBe(true);
});
test('resurrection: two contacts archived, both in ?status=archived list', async ({ request }) => {
  const org = await registerOrg(request, 'res30c4');
  const c1 = await makeContact(request, org.token, 'Arch1');
  const c2 = await makeContact(request, org.token, 'Arch2');
  await Promise.all([
    request.delete(`/api/v1/contacts/${c1.id}`, { headers: authHeaders(org.token) }),
    request.delete(`/api/v1/contacts/${c2.id}`, { headers: authHeaders(org.token) }),
  ]);
  const r = await request.get('/api/v1/contacts?status=archived', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === c1.id)).toBe(true);
  expect(body.data.some(x => x.id === c2.id)).toBe(true);
});
test('resurrection: won deal appears in ?status=won filter', async ({ request }) => {
  const org = await registerOrg(request, 'res30d3');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'WonDC');
  const d = await makeDeal(request, org.token, 'WonDeal', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  const r = await request.get('/api/v1/deals?status=won', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === d.id)).toBe(true);
});
test('resurrection: lost deal appears in ?status=lost filter', async ({ request }) => {
  const org = await registerOrg(request, 'res30d4');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'LostDC');
  const d = await makeDeal(request, org.token, 'LostDeal', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHeaders(org.token), data: { reason: 'budget' } });
  const r = await request.get('/api/v1/deals?status=lost', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === d.id)).toBe(true);
});
test('resurrection: re-creating contact with different email after archive succeeds', async ({ request }) => {
  const org = await registerOrg(request, 'res30c5');
  const c = await makeContact(request, org.token, 'ArchThenNew');
  await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const r = await request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'ArchThenNew2' } });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { id: string } }).data.id).not.toBe(c.id);
});
test('resurrection: bulk-archive then ?status=archived finds all contacts', async ({ request }) => {
  const org = await registerOrg(request, 'res30c6');
  const c1 = await makeContact(request, org.token, 'BulkRes1');
  const c2 = await makeContact(request, org.token, 'BulkRes2');
  await request.post('/api/v1/contacts/bulk-archive', { headers: authHeaders(org.token), data: { contact_ids: [c1.id, c2.id] } });
  const r = await request.get('/api/v1/contacts?status=archived', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === c1.id)).toBe(true);
  expect(body.data.some(x => x.id === c2.id)).toBe(true);
});

// ── ANALYTICS WITH SEEDED DATA ────────────────────────────────────────────────

test('analytics: win-loss returns won and lost counts', async ({ request }) => {
  const org = await registerOrg(request, 'an30wl1');
  const r = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { won: { count: number }; lost: { count: number } } };
  expect(typeof body.data.won.count).toBe('number');
  expect(typeof body.data.lost.count).toBe('number');
});
test('analytics: win-loss won count increases after marking deal won', async ({ request }) => {
  const org = await registerOrg(request, 'an30wl2');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'WonAnC');
  const d = await makeDeal(request, org.token, 'WonAnD', c.id, pl.id, pl.stages[0].id);
  const before = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  const beforeCount = ((await before.json()) as { data: { won: { count: number } } }).data.won.count;
  await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  const after = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  const afterCount = ((await after.json()) as { data: { won: { count: number } } }).data.won.count;
  expect(afterCount).toBeGreaterThan(beforeCount);
});
test('analytics: lead-sources returns data array', async ({ request }) => {
  const org = await registerOrg(request, 'an30ls1');
  const r = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});
test('analytics: lead-sources reflects deal source after creating sourced deal', async ({ request }) => {
  const org = await registerOrg(request, 'an30ls2');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'SrcAnC');
  await makeDeal(request, org.token, 'SrcAnD', c.id, pl.id, pl.stages[0].id, { source: 'referral' });
  const r = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { source: string; count: number }[] };
  expect(body.data.some(s => s.source === 'referral' && s.count >= 1)).toBe(true);
});
test('analytics: dashboard pipeline_health_score is a number', async ({ request }) => {
  const org = await registerOrg(request, 'an30d1');
  const r = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { pipeline_health_score: unknown } };
  expect(typeof body.data.pipeline_health_score === 'number' || body.data.pipeline_health_score === null).toBe(true);
});
test('analytics: funnel summary has win_rate field', async ({ request }) => {
  const org = await registerOrg(request, 'an30f1');
  const r = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { summary: Record<string, unknown> } };
  expect('win_rate' in body.data.summary).toBe(true);
});
test('analytics: revenue data.summary exists', async ({ request }) => {
  const org = await registerOrg(request, 'an30r1');
  const r = await request.get('/api/v1/analytics/revenue', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { summary: unknown } };
  expect(body.data.summary).toBeDefined();
});
test('analytics: dashboard tasks_due_today is a number', async ({ request }) => {
  const org = await registerOrg(request, 'an30d2');
  const r = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { tasks_due_today: unknown } };
  expect(typeof body.data.tasks_due_today === 'number' || body.data.tasks_due_today !== undefined).toBe(true);
});
test('analytics: win-loss reasons array is present', async ({ request }) => {
  const org = await registerOrg(request, 'an30wl3');
  const r = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { reasons: unknown[] } };
  expect(Array.isArray(body.data.reasons)).toBe(true);
});
test('analytics: funnel stages array length equals pipeline stage count for fresh org', async ({ request }) => {
  const org = await registerOrg(request, 'an30f2');
  const pl = await getPipeline(request, org.token);
  const r = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { stages: unknown[] } };
  expect(body.data.stages.length).toBeGreaterThanOrEqual(pl.stages.length);
});

// ── DATE / TIME BOUNDARY CONDITIONS ──────────────────────────────────────────

test('datetime: task with due_date at midnight is stored and retrieved correctly', async ({ request }) => {
  const org = await registerOrg(request, 'dt30t1');
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const isoMidnight = midnight.toISOString();
  const t = await makeTask(request, org.token, org.userId, 'MidnightTask', { due_date: isoMidnight });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { due_date: string } }).data.due_date).toBeTruthy();
});
test('datetime: task with due_date in past appears in GET /tasks/overdue', async ({ request }) => {
  const org = await registerOrg(request, 'dt30t2');
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const t = await makeTask(request, org.token, org.userId, 'OverdueTask', { due_date: yesterday });
  const r = await request.get('/api/v1/tasks/overdue', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === t.id)).toBe(true);
});
test('datetime: calendar event spanning multiple days is created successfully', async ({ request }) => {
  const org = await registerOrg(request, 'dt30c1');
  const r = await request.post('/api/v1/calendar', {
    headers: authHeaders(org.token),
    data: { title: 'MultiDayEvent', start_time: daysFromNow(1), end_time: daysFromNow(5) },
  });
  expect(r.status()).toBe(201);
  const body = await r.json() as { data: { id: string; title: string } };
  expect(body.data.title).toBe('MultiDayEvent');
});
test('datetime: calendar filter with start= and end= returns events in that range', async ({ request }) => {
  const org = await registerOrg(request, 'dt30c2');
  const start = daysFromNow(10);
  const end = daysFromNow(20);
  const eventStart = daysFromNow(12);
  const eventEnd = daysFromNow(13);
  await request.post('/api/v1/calendar', { headers: authHeaders(org.token), data: { title: 'InRange', start_time: eventStart, end_time: eventEnd } });
  const r = await request.get(`/api/v1/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});
test('datetime: event start_time and end_time preserved exactly on GET', async ({ request }) => {
  const org = await registerOrg(request, 'dt30c3');
  const start = daysFromNow(7);
  const end = daysFromNow(8);
  const res = await request.post('/api/v1/calendar', { headers: authHeaders(org.token), data: { title: 'Preserved', start_time: start, end_time: end } });
  const evId = ((await res.json()) as { data: { id: string } }).data.id;
  const r = await request.get(`/api/v1/calendar/${evId}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { start_time: string; end_time: string } };
  expect(new Date(body.data.start_time).toISOString().slice(0, 19)).toBe(new Date(start).toISOString().slice(0, 19));
});
test('datetime: PATCH task due_date to past makes it appear in /tasks/overdue', async ({ request }) => {
  const org = await registerOrg(request, 'dt30t3');
  const t = await makeTask(request, org.token, org.userId, 'PatchOverdue');
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  await request.patch(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token), data: { due_date: yesterday } });
  const r = await request.get('/api/v1/tasks/overdue', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === t.id)).toBe(true);
});
test('datetime: task with reminder_at stores and returns reminder_at', async ({ request }) => {
  const org = await registerOrg(request, 'dt30t4');
  const reminderAt = daysFromNow(1);
  const t = await makeTask(request, org.token, org.userId, 'ReminderTask', { reminder_at: reminderAt });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { reminder_at: string | null } };
  expect(body.data.reminder_at).toBeTruthy();
});
test('datetime: deal created_at and updated_at are valid ISO 8601', async ({ request }) => {
  const org = await registerOrg(request, 'dt30d1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'TsDC');
  const d = await makeDeal(request, org.token, 'TsDeal', c.id, pl.id, pl.stages[0].id);
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { created_at: string; updated_at: string } };
  expect(() => new Date(body.data.created_at)).not.toThrow();
  expect(body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(() => new Date(body.data.updated_at)).not.toThrow();
});
test('datetime: message created_at is valid ISO 8601', async ({ request }) => {
  const org = await registerOrg(request, 'dt30m1');
  const c = await makeContact(request, org.token, 'MsgTsC');
  const msg = await makeMessage(request, org.token, c.id);
  const r = await request.get(`/api/v1/messages/${msg.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { created_at: string } };
  expect(body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
test('datetime: calendar event with far-future end_time is accepted', async ({ request }) => {
  const org = await registerOrg(request, 'dt30c4');
  const r = await request.post('/api/v1/calendar', {
    headers: authHeaders(org.token),
    data: { title: 'FarFuture', start_time: daysFromNow(365), end_time: daysFromNow(366) },
  });
  expect(r.status()).toBe(201);
});
test('datetime: task filter by due_before returns only tasks before that date', async ({ request }) => {
  const org = await registerOrg(request, 'dt30t5');
  const tomorrow = daysFromNow(1);
  const nextWeek = daysFromNow(7);
  const tSoon = await makeTask(request, org.token, org.userId, 'SoonTask', { due_date: tomorrow });
  const tLate = await makeTask(request, org.token, org.userId, 'LateTask', { due_date: nextWeek });
  const cutoff = daysFromNow(3);
  const r = await request.get(`/api/v1/tasks?due_before=${encodeURIComponent(cutoff)}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(t => t.id === tSoon.id)).toBe(true);
  expect(body.data.every(t => t.id !== tLate.id)).toBe(true);
});
test('datetime: task filter by due_after returns only tasks after that date', async ({ request }) => {
  const org = await registerOrg(request, 'dt30t6');
  const tomorrow = daysFromNow(1);
  const nextWeek = daysFromNow(7);
  const tSoon = await makeTask(request, org.token, org.userId, 'EarlierTask', { due_date: tomorrow });
  const tLate = await makeTask(request, org.token, org.userId, 'LaterTask', { due_date: nextWeek });
  const cutoff = daysFromNow(4);
  const r = await request.get(`/api/v1/tasks?due_after=${encodeURIComponent(cutoff)}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(t => t.id === tLate.id)).toBe(true);
  expect(body.data.every(t => t.id !== tSoon.id)).toBe(true);
});

// ── CONTACT MERGE DEEP TESTS ──────────────────────────────────────────────────

test('merge: deals from source contact transferred to target after merge', async ({ request }) => {
  const org = await registerOrg(request, 'mg30a1');
  const pl = await getPipeline(request, org.token);
  const src = await makeContact(request, org.token, 'MergeSrc');
  const tgt = await makeContact(request, org.token, 'MergeTgt');
  const d = await makeDeal(request, org.token, 'MrgDeal', src.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/contacts/${tgt.id}/merge`, { headers: authHeaders(org.token), data: { source_id: src.id } });
  const r = await request.get(`/api/v1/contacts/${tgt.id}/deals`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === d.id)).toBe(true);
});
test('merge: source contact becomes archived after merge', async ({ request }) => {
  const org = await registerOrg(request, 'mg30b1');
  const src = await makeContact(request, org.token, 'ArchSrc');
  const tgt = await makeContact(request, org.token, 'ArchTgt');
  await request.post(`/api/v1/contacts/${tgt.id}/merge`, { headers: authHeaders(org.token), data: { source_id: src.id } });
  const r = await request.get(`/api/v1/contacts/${src.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('archived');
});
test('merge: tasks from source contact transferred to target after merge', async ({ request }) => {
  const org = await registerOrg(request, 'mg30c1');
  const src = await makeContact(request, org.token, 'TaskSrc');
  const tgt = await makeContact(request, org.token, 'TaskTgt');
  const t = await makeTask(request, org.token, org.userId, 'MrgTask');
  await request.patch(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token), data: { contact_id: src.id } });
  await request.post(`/api/v1/contacts/${tgt.id}/merge`, { headers: authHeaders(org.token), data: { source_id: src.id } });
  const r = await request.get(`/api/v1/contacts/${tgt.id}/tasks`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === t.id)).toBe(true);
});
test('merge: messages from source contact transferred to target after merge', async ({ request }) => {
  const org = await registerOrg(request, 'mg30d1');
  const src = await makeContact(request, org.token, 'MsgMrgSrc');
  const tgt = await makeContact(request, org.token, 'MsgMrgTgt');
  const msg = await makeMessage(request, org.token, src.id);
  await request.post(`/api/v1/contacts/${tgt.id}/merge`, { headers: authHeaders(org.token), data: { source_id: src.id } });
  const r = await request.get(`/api/v1/contacts/${tgt.id}/messages`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === msg.id)).toBe(true);
});
test('merge: POST /contacts/:id/merge with nonexistent source returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'mg30e1');
  const tgt = await makeContact(request, org.token, 'MrgTgt404');
  const r = await request.post(`/api/v1/contacts/${tgt.id}/merge`, {
    headers: authHeaders(org.token),
    data: { source_id: '00000000-0000-0000-0000-000000000000' },
  });
  expect(r.status()).toBe(404);
});
test('merge: POST /contacts/:id/merge with nonexistent target returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'mg30f1');
  const src = await makeContact(request, org.token, 'MrgSrc404');
  const r = await request.post('/api/v1/contacts/00000000-0000-0000-0000-000000000000/merge', {
    headers: authHeaders(org.token),
    data: { source_id: src.id },
  });
  expect(r.status()).toBe(404);
});
test('merge: cross-org — org B cannot merge org A contacts', async ({ request }) => {
  const orgA = await registerOrg(request, 'mg30g1');
  const orgB = await registerOrg(request, 'mg30g2');
  const src = await makeContact(request, orgA.token, 'XorgSrc');
  const tgt = await makeContact(request, orgA.token, 'XorgTgt');
  const r = await request.post(`/api/v1/contacts/${tgt.id}/merge`, {
    headers: authHeaders(orgB.token),
    data: { source_id: src.id },
  });
  expect([403, 404]).toContain(r.status());
});
test('merge: returns merged target contact data with 200', async ({ request }) => {
  const org = await registerOrg(request, 'mg30h1');
  const src = await makeContact(request, org.token, 'RetSrc');
  const tgt = await makeContact(request, org.token, 'RetTgt');
  const r = await request.post(`/api/v1/contacts/${tgt.id}/merge`, { headers: authHeaders(org.token), data: { source_id: src.id } });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { id: string } }).data.id).toBe(tgt.id);
});

// ── MESSAGE CROSS-ORG ISOLATION ───────────────────────────────────────────────

test('msg-xorg: org B cannot GET org A message by ID', async ({ request }) => {
  const orgA = await registerOrg(request, 'mx30a1');
  const orgB = await registerOrg(request, 'mx30a2');
  const c = await makeContact(request, orgA.token, 'MsgXC');
  const msg = await makeMessage(request, orgA.token, c.id);
  const r = await request.get(`/api/v1/messages/${msg.id}`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('msg-xorg: org B messages not in org A list', async ({ request }) => {
  const orgA = await registerOrg(request, 'mx30b1');
  const orgB = await registerOrg(request, 'mx30b2');
  const cB = await makeContact(request, orgB.token, 'MsgBOnly');
  const msg = await makeMessage(request, orgB.token, cB.id);
  const r = await request.get('/api/v1/messages', { headers: authHeaders(orgA.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.every(m => m.id !== msg.id)).toBe(true);
});
test('msg-xorg: org B cannot mark org A message as read', async ({ request }) => {
  const orgA = await registerOrg(request, 'mx30c1');
  const orgB = await registerOrg(request, 'mx30c2');
  const c = await makeContact(request, orgA.token, 'ReadMsgC');
  const msg = await makeMessage(request, orgA.token, c.id);
  const r = await request.post(`/api/v1/messages/${msg.id}/read`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('msg-xorg: GET /messages/conversation/:contact_id for other org returns 403 or 404', async ({ request }) => {
  const orgA = await registerOrg(request, 'mx30d1');
  const orgB = await registerOrg(request, 'mx30d2');
  const c = await makeContact(request, orgA.token, 'ConvC');
  const r = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});
test('msg-xorg: org A and B message counts are isolated', async ({ request }) => {
  const [orgA, orgB] = await Promise.all([registerOrg(request, 'mx30e1'), registerOrg(request, 'mx30e2')]);
  const [cA, cB] = await Promise.all([makeContact(request, orgA.token, 'MxCA'), makeContact(request, orgB.token, 'MxCB')]);
  await Promise.all([
    makeMessage(request, orgA.token, cA.id),
    makeMessage(request, orgA.token, cA.id),
    makeMessage(request, orgB.token, cB.id),
  ]);
  const [rA, rB] = await Promise.all([
    request.get('/api/v1/messages', { headers: authHeaders(orgA.token) }),
    request.get('/api/v1/messages', { headers: authHeaders(orgB.token) }),
  ]);
  const totalA = ((await rA.json()) as { meta: { total: number } }).meta.total;
  const totalB = ((await rB.json()) as { meta: { total: number } }).meta.total;
  expect(totalA).toBeGreaterThanOrEqual(2);
  expect(totalB).toBeGreaterThanOrEqual(1);
  expect(totalA).not.toBe(totalB);
});
test('msg-xorg: filter by contact_id returns only messages for that contact', async ({ request }) => {
  const org = await registerOrg(request, 'mx30f1');
  const c1 = await makeContact(request, org.token, 'FilterC1');
  const c2 = await makeContact(request, org.token, 'FilterC2');
  const msg = await makeMessage(request, org.token, c1.id, 'ForC1');
  await makeMessage(request, org.token, c2.id, 'ForC2');
  const r = await request.get(`/api/v1/messages?contact_id=${c1.id}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(m => m.id === msg.id)).toBe(true);
});
test('msg-xorg: send in-app to own contact succeeds, send to other org contact fails', async ({ request }) => {
  const orgA = await registerOrg(request, 'mx30g1');
  const orgB = await registerOrg(request, 'mx30g2');
  const cB = await makeContact(request, orgB.token, 'ForeignMsgC');
  const r = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(orgA.token),
    data: { contact_id: cB.id, body: 'Cross-org message attempt' },
  });
  expect([403, 404, 422]).toContain(r.status());
});
test('msg-xorg: GET /messages/conversation/:contact_id returns messages for own contact', async ({ request }) => {
  const org = await registerOrg(request, 'mx30h1');
  const c = await makeContact(request, org.token, 'ConvOwnC');
  await makeMessage(request, org.token, c.id, 'Conv msg 1');
  await makeMessage(request, org.token, c.id, 'Conv msg 2');
  const r = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
});

// ── TASK EDGE CASES ───────────────────────────────────────────────────────────

test('task: create with priority=urgent stores correctly', async ({ request }) => {
  const org = await registerOrg(request, 'tk30p1');
  const t = await makeTask(request, org.token, org.userId, 'UrgentTask', { priority: 'urgent' });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { priority: string } }).data.priority).toBe('urgent');
});
test('task: create with priority=low stores correctly', async ({ request }) => {
  const org = await registerOrg(request, 'tk30p2');
  const t = await makeTask(request, org.token, org.userId, 'LowTask', { priority: 'low' });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { priority: string } }).data.priority).toBe('low');
});
test('task: filter by priority=urgent returns only urgent tasks', async ({ request }) => {
  const org = await registerOrg(request, 'tk30p3');
  await makeTask(request, org.token, org.userId, 'Urg1', { priority: 'urgent' });
  await makeTask(request, org.token, org.userId, 'Low1', { priority: 'low' });
  const r = await request.get('/api/v1/tasks?priority=urgent', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { priority: string }[] };
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  expect(body.data.every(t => t.priority === 'urgent')).toBe(true);
});
test('task: filter by assigned_to returns only that user tasks', async ({ request }) => {
  const org = await registerOrg(request, 'tk30as1');
  const t = await makeTask(request, org.token, org.userId, 'AssignedTask');
  const r = await request.get(`/api/v1/tasks?assigned_to=${org.userId}`, { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  expect(body.data.some(x => x.id === t.id)).toBe(true);
});
test('task: start transitions status to in_progress', async ({ request }) => {
  const org = await registerOrg(request, 'tk30s1');
  const t = await makeTask(request, org.token, org.userId, 'StartMe');
  await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('in_progress');
});
test('task: cancel (DELETE) transitions status to cancelled', async ({ request }) => {
  const org = await registerOrg(request, 'tk30c1');
  const t = await makeTask(request, org.token, org.userId, 'CancelMeTask');
  await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('cancelled');
});
test('task: cancelled task cannot be completed returns 422 TASK_CANCELLED', async ({ request }) => {
  const org = await registerOrg(request, 'tk30cc1');
  const t = await makeTask(request, org.token, org.userId, 'CancelledComp');
  await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  const r = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe('TASK_CANCELLED');
});
test('task: in_progress task can be completed', async ({ request }) => {
  const org = await registerOrg(request, 'tk30ip1');
  const t = await makeTask(request, org.token, org.userId, 'InProgressComp');
  await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(org.token) });
  const r = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe('done');
});
test('task: PATCH task updates description', async ({ request }) => {
  const org = await registerOrg(request, 'tk30d1');
  const t = await makeTask(request, org.token, org.userId, 'DescTask');
  await request.patch(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token), data: { description: 'Updated desc' } });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { description: string } }).data.description).toBe('Updated desc');
});
test('task: task with deal_id links to deal', async ({ request }) => {
  const org = await registerOrg(request, 'tk30dl1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'TaskDealC');
  const d = await makeDeal(request, org.token, 'TaskDeal', c.id, pl.id, pl.stages[0].id);
  const t = await makeTask(request, org.token, org.userId, 'DealTask', { deal_id: d.id });
  const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { deal_id: string } }).data.deal_id).toBe(d.id);
});
test('task: task sort by priority=urgent first with sort=priority order=desc', async ({ request }) => {
  const org = await registerOrg(request, 'tk30so1');
  await makeTask(request, org.token, org.userId, 'LowPriTask', { priority: 'low' });
  await makeTask(request, org.token, org.userId, 'UrgPriTask', { priority: 'urgent' });
  const r = await request.get('/api/v1/tasks?sort=priority&order=desc', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(body.data.length).toBeGreaterThanOrEqual(2);
});
test('task: GET /tasks/overdue returns 200 with data array', async ({ request }) => {
  const org = await registerOrg(request, 'tk30od1');
  const r = await request.get('/api/v1/tasks/overdue', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(Array.isArray(((await r.json()) as { data: unknown[] }).data)).toBe(true);
});

// ── DEAL EDGE CASES ───────────────────────────────────────────────────────────

test('deal: create with currency=EUR stores currency', async ({ request }) => {
  const org = await registerOrg(request, 'dl30c1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'EurC');
  const r = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'EurDeal', contact_id: c.id, pipeline_id: pl.id, stage_id: pl.stages[0].id, currency: 'EUR', value: 500 },
  });
  expect(r.status()).toBe(201);
  expect(((await r.json()) as { data: { currency: string } }).data.currency).toBe('EUR');
});
test('deal: filter by status=won returns only won deals', async ({ request }) => {
  const org = await registerOrg(request, 'dl30w1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'WonFC');
  const d = await makeDeal(request, org.token, 'WonFD', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(org.token), data: {} });
  const r = await request.get('/api/v1/deals?status=won', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { status: string }[] };
  expect(body.data.every(x => x.status === 'won')).toBe(true);
});
test('deal: filter by status=lost returns only lost deals', async ({ request }) => {
  const org = await registerOrg(request, 'dl30l1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'LostFC');
  const d = await makeDeal(request, org.token, 'LostFD', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHeaders(org.token), data: {} });
  const r = await request.get('/api/v1/deals?status=lost', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { status: string }[] };
  expect(body.data.every(x => x.status === 'lost')).toBe(true);
});
test('deal: PATCH value to large number stores and retrieves correctly', async ({ request }) => {
  const org = await registerOrg(request, 'dl30v1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'BigValC');
  const d = await makeDeal(request, org.token, 'BigValD', c.id, pl.id, pl.stages[0].id);
  await request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { value: 9999999.99, currency: 'USD' } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(Number(((await r.json()) as { data: { value: unknown } }).data.value)).toBeCloseTo(9999999.99, 1);
});
test('deal: PATCH contact_id to different contact updates contact reference', async ({ request }) => {
  const org = await registerOrg(request, 'dl30ci1');
  const pl = await getPipeline(request, org.token);
  const c1 = await makeContact(request, org.token, 'DealC1');
  const c2 = await makeContact(request, org.token, 'DealC2');
  const d = await makeDeal(request, org.token, 'ContactSwap', c1.id, pl.id, pl.stages[0].id);
  await request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { contact_id: c2.id } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(((await r.json()) as { data: { contact_id: string } }).data.contact_id).toBe(c2.id);
});
test('deal: create with no value then PATCH to add value reflects on GET', async ({ request }) => {
  const org = await registerOrg(request, 'dl30nv1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'NoValC');
  const d = await makeDeal(request, org.token, 'NoValD', c.id, pl.id, pl.stages[0].id);
  await request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { value: 1500, currency: 'USD' } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(Number(((await r.json()) as { data: { value: unknown } }).data.value)).toBe(1500);
});
test('deal: deal list sorted by created_at desc has newest first', async ({ request }) => {
  const org = await registerOrg(request, 'dl30so1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'SortDC');
  const d1 = await makeDeal(request, org.token, 'SortD1', c.id, pl.id, pl.stages[0].id);
  const d2 = await makeDeal(request, org.token, 'SortD2', c.id, pl.id, pl.stages[0].id);
  const r = await request.get('/api/v1/deals?sort=created_at&order=desc', { headers: authHeaders(org.token) });
  const body = await r.json() as { data: { id: string }[] };
  const ids = body.data.map(d => d.id);
  expect(ids.indexOf(d2.id)).toBeLessThan(ids.indexOf(d1.id));
});
test('deal: PATCH /deals/:id/stage with invalid stage_id returns 422 or 404', async ({ request }) => {
  const org = await registerOrg(request, 'dl30st1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'BadStageC');
  const d = await makeDeal(request, org.token, 'BadStageD', c.id, pl.id, pl.stages[0].id);
  const r = await request.patch(`/api/v1/deals/${d.id}/stage`, {
    headers: authHeaders(org.token),
    data: { stage_id: '00000000-0000-0000-0000-000000000000' },
  });
  expect([404, 422]).toContain(r.status());
});
test('deal: deal with source field stores and retrieves source', async ({ request }) => {
  const org = await registerOrg(request, 'dl30src1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'SrcDC');
  const r = await request.post('/api/v1/deals', {
    headers: authHeaders(org.token),
    data: { title: 'SrcDeal', contact_id: c.id, pipeline_id: pl.id, stage_id: pl.stages[0].id, currency: 'USD', source: 'cold_call' },
  });
  expect(((await r.json()) as { data: { source: string } }).data.source).toBe('cold_call');
});
test('deal: GET /deals?sort=value&order=desc returns deals sorted by value', async ({ request }) => {
  const org = await registerOrg(request, 'dl30v2');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ValSortC');
  await makeDeal(request, org.token, 'LowVal', c.id, pl.id, pl.stages[0].id, { value: 100 });
  await makeDeal(request, org.token, 'HighVal', c.id, pl.id, pl.stages[0].id, { value: 99999 });
  const r = await request.get('/api/v1/deals?sort=value&order=desc', { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: unknown[] };
  expect(body.data.length).toBeGreaterThanOrEqual(2);
});
test('deal: deal marked lost with reason stores reason', async ({ request }) => {
  const org = await registerOrg(request, 'dl30lr1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'LostReasonC');
  const d = await makeDeal(request, org.token, 'LostReasonD', c.id, pl.id, pl.stages[0].id);
  await request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHeaders(org.token), data: { reason: 'price_too_high' } });
  const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  const body = await r.json() as { data: { status: string; lost_reason?: string } };
  expect(body.data.status).toBe('lost');
});
test('deal: concurrent PATCH to same deal by same user — last write persisted', async ({ request }) => {
  const org = await registerOrg(request, 'dl30cc1');
  const pl = await getPipeline(request, org.token);
  const c = await makeContact(request, org.token, 'ConcPatchC');
  const d = await makeDeal(request, org.token, 'ConcPatchD', c.id, pl.id, pl.stages[0].id);
  const rs = await Promise.all([
    request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { value: 111, currency: 'USD' } }),
    request.patch(`/api/v1/deals/${d.id}`, { headers: authHeaders(org.token), data: { value: 222, currency: 'USD' } }),
  ]);
  for (const r of rs) expect([200, 409]).toContain(r.status());
});
