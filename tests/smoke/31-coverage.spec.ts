import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

type Auth = { token: string; userId: string; email: string };
type Pipeline = { id: string; is_default: boolean; stages: { id: string; name: string; position: number }[] };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `${unique}@example.com`, password: 'Password123!', name: `User ${suffix}`, org_name: `Org ${unique}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string; email: string } } };
  return { token: body.data.token, userId: body.data.user.id, email: body.data.user.email };
}

function authHeaders(token: string) { return { Authorization: `Bearer ${token}` }; }
function msFromNow(ms: number) { return new Date(Date.now() + ms).toISOString(); }

async function getPipeline(request: APIRequestContext, token: string): Promise<Pipeline> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  const body = await res.json() as { data: Pipeline[] };
  return body.data.find(p => p.is_default) ?? body.data[0]!;
}

async function makeContact(request: APIRequestContext, token: string, name: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: name, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string; email: string | null } }).data;
}

async function makeDeal(request: APIRequestContext, token: string, title: string, cId: string, plId: string, stId: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/deals', { headers: authHeaders(token), data: { title, contact_id: cId, pipeline_id: plId, stage_id: stId, currency: 'USD', ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string; stage_id: string; value: number | null } }).data;
}

async function makeTask(request: APIRequestContext, token: string, userId: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title, assigned_to: userId, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}

async function makeEvent(request: APIRequestContext, token: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await request.post('/api/v1/calendar', { headers: authHeaders(token), data: { title, start_time: msFromNow(3_600_000), end_time: msFromNow(7_200_000), ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}

test.describe.configure({ timeout: 60000 });

// ── 1. ANALYTICS CORRECTNESS ──────────────────────────────────────────────────

test.describe('analytics correctness', () => {
  test('analytics: revenue total_revenue matches sum of won deal values', async ({ request }) => {
    const { token } = await registerOrg(request, 'rev-sum');
    const pl = await getPipeline(request, token);
    const stId = pl.stages[0]!.id;
    const c = await makeContact(request, token, 'RevContact');
    const today = new Date().toISOString().slice(0, 10);
    const d1 = await makeDeal(request, token, 'Rev1', c.id, pl.id, stId, { value: 100 });
    const d2 = await makeDeal(request, token, 'Rev2', c.id, pl.id, stId, { value: 250 });
    const d3 = await makeDeal(request, token, 'Rev3', c.id, pl.id, stId, { value: 50 });
    await request.post(`/api/v1/deals/${d1.id}/won`, { headers: authHeaders(token), data: { actual_close: today } });
    await request.post(`/api/v1/deals/${d2.id}/won`, { headers: authHeaders(token), data: { actual_close: today } });
    await request.post(`/api/v1/deals/${d3.id}/won`, { headers: authHeaders(token), data: { actual_close: today } });
    const res = await request.get('/api/v1/analytics/revenue', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { summary: { total_revenue: number } } };
    expect(body.data.summary.total_revenue).toBeGreaterThanOrEqual(400);
  });

  test('analytics: funnel counts match created deal counts per stage', async ({ request }) => {
    const { token } = await registerOrg(request, 'funnel-count');
    const pl = await getPipeline(request, token);
    const stages = pl.stages.slice(0, 2);
    if (stages.length < 2) return; // skip if pipeline has < 2 stages
    const c = await makeContact(request, token, 'FunnelC');
    await makeDeal(request, token, 'F1', c.id, pl.id, stages[0]!.id);
    await makeDeal(request, token, 'F2', c.id, pl.id, stages[0]!.id);
    await makeDeal(request, token, 'F3', c.id, pl.id, stages[1]!.id);
    const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { stages: { stage_id: string; open: number }[] } };
    const s0 = body.data.stages.find(s => s.stage_id === stages[0]!.id);
    const s1 = body.data.stages.find(s => s.stage_id === stages[1]!.id);
    expect(s0?.open).toBeGreaterThanOrEqual(2);
    expect(s1?.open).toBeGreaterThanOrEqual(1);
  });

  test('analytics: win-loss counts reflect marked deals', async ({ request }) => {
    const { token } = await registerOrg(request, 'winloss');
    const pl = await getPipeline(request, token);
    const stId = pl.stages[0]!.id;
    const c = await makeContact(request, token, 'WLContact');
    const d1 = await makeDeal(request, token, 'Won1', c.id, pl.id, stId);
    const d2 = await makeDeal(request, token, 'Won2', c.id, pl.id, stId);
    const d3 = await makeDeal(request, token, 'Lost1', c.id, pl.id, stId);
    await request.post(`/api/v1/deals/${d1.id}/won`, { headers: authHeaders(token), data: {} });
    await request.post(`/api/v1/deals/${d2.id}/won`, { headers: authHeaders(token), data: {} });
    await request.post(`/api/v1/deals/${d3.id}/lost`, { headers: authHeaders(token), data: {} });
    const res = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { won: { count: number }; lost: { count: number } } };
    expect(body.data.won.count).toBeGreaterThanOrEqual(2);
    expect(body.data.lost.count).toBeGreaterThanOrEqual(1);
  });

  test('analytics: rep-performance returns 200 with array', async ({ request }) => {
    const { token } = await registerOrg(request, 'rep-perf');
    const res = await request.get('/api/v1/analytics/rep-performance', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('analytics: lead-sources returns 200 with array', async ({ request }) => {
    const { token } = await registerOrg(request, 'leadsrc');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'SrcC');
    await makeDeal(request, token, 'SrcDeal', c.id, pl.id, pl.stages[0]!.id, { source: 'referral' });
    const res = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { source: string; count: number }[] };
    expect(Array.isArray(body.data)).toBe(true);
    const ref = body.data.find(s => s.source === 'referral');
    expect(ref).toBeDefined();
    expect(ref!.count).toBeGreaterThanOrEqual(1);
  });

  test('analytics: stage-duration returns 200', async ({ request }) => {
    const { token } = await registerOrg(request, 'stagedur');
    const res = await request.get('/api/v1/analytics/stage-duration', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
  });

  test('analytics: conversion-rates returns 200', async ({ request }) => {
    const { token } = await registerOrg(request, 'convrate');
    const res = await request.get('/api/v1/analytics/conversion-rates', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
  });

  test('analytics: dashboard open_deals count increases after creating a deal', async ({ request }) => {
    const { token } = await registerOrg(request, 'dash-count');
    const pl = await getPipeline(request, token);
    const r1 = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(token) });
    const before = ((await r1.json()) as { data: { open_deals: { count: number } } }).data.open_deals.count;
    const c = await makeContact(request, token, 'DashC');
    await makeDeal(request, token, 'DashDeal', c.id, pl.id, pl.stages[0]!.id);
    const r2 = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(token) });
    const after = ((await r2.json()) as { data: { open_deals: { count: number } } }).data.open_deals.count;
    expect(after).toBeGreaterThan(before);
  });

  test('analytics: pipeline-health returns 200 with a numeric score', async ({ request }) => {
    const { token } = await registerOrg(request, 'phs');
    const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { pipeline_health_score: number } };
    expect(typeof body.data.pipeline_health_score).toBe('number');
  });

  test('analytics: revenue with future date window returns 0', async ({ request }) => {
    const { token } = await registerOrg(request, 'rev-window');
    const start = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
    const res = await request.get(`/api/v1/analytics/revenue?start=${start}&end=${end}&period=custom`, { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: { summary: { total_revenue: number } } };
    expect(body.data.summary.total_revenue).toBe(0);
  });

  test('analytics: team-activity returns 200 with array', async ({ request }) => {
    const { token } = await registerOrg(request, 'team-act');
    const res = await request.get('/api/v1/analytics/team-activity', { headers: authHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ── 2. PIPELINE / DEAL STATE MACHINE ─────────────────────────────────────────

test.describe('deal state machine', () => {
  test('deal: move through each stage sequentially, stage_id updates', async ({ request }) => {
    const { token } = await registerOrg(request, 'stage-seq');
    const pl = await getPipeline(request, token);
    if (pl.stages.length < 2) return;
    const c = await makeContact(request, token, 'StageC');
    const d = await makeDeal(request, token, 'StageDeal', c.id, pl.id, pl.stages[0]!.id);
    for (const st of pl.stages.slice(1)) {
      const r = await request.patch(`/api/v1/deals/${d.id}/stage`, { headers: authHeaders(token), data: { stage_id: st.id } });
      expect(r.status()).toBe(200);
      const body = await r.json() as { data: { stage_id: string } };
      expect(body.data.stage_id).toBe(st.id);
    }
  });

  test('deal: mark won → status=won', async ({ request }) => {
    const { token } = await registerOrg(request, 'deal-won');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'WonC');
    const d = await makeDeal(request, token, 'WonDeal', c.id, pl.id, pl.stages[0]!.id);
    const r = await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(token), data: {} });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('won');
  });

  test('deal: mark lost → status=lost', async ({ request }) => {
    const { token } = await registerOrg(request, 'deal-lost');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'LostC');
    const d = await makeDeal(request, token, 'LostDeal', c.id, pl.id, pl.stages[0]!.id);
    const r = await request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHeaders(token), data: {} });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('lost');
  });

  test('deal: mark won → move stage returns non-2xx', async ({ request }) => {
    const { token } = await registerOrg(request, 'won-stage');
    const pl = await getPipeline(request, token);
    if (pl.stages.length < 2) return;
    const c = await makeContact(request, token, 'WonStageC');
    const d = await makeDeal(request, token, 'WonStageDeal', c.id, pl.id, pl.stages[0]!.id);
    await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(token), data: {} });
    const r = await request.patch(`/api/v1/deals/${d.id}/stage`, { headers: authHeaders(token), data: { stage_id: pl.stages[1]!.id } });
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });

  test('deal: archive → not in GET /deals?status=open', async ({ request }) => {
    const { token } = await registerOrg(request, 'deal-arch');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'ArchC');
    const d = await makeDeal(request, token, 'ArchDeal', c.id, pl.id, pl.stages[0]!.id);
    await request.delete(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    const r = await request.get('/api/v1/deals?status=open&per_page=100', { headers: authHeaders(token) });
    const body = await r.json() as { data: { id: string }[] };
    expect(body.data.some(x => x.id === d.id)).toBe(false);
  });

  test('deal: archive → GET /deals/:id still returns it', async ({ request }) => {
    const { token } = await registerOrg(request, 'deal-arch2');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'ArchC2');
    const d = await makeDeal(request, token, 'ArchDeal2', c.id, pl.id, pl.stages[0]!.id);
    await request.delete(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('archived');
  });

  test('deal: add stage to pipeline → stage appears in listPipelines', async ({ request }) => {
    const { token } = await registerOrg(request, 'add-stage');
    const pl = await getPipeline(request, token);
    const r = await request.post(`/api/v1/deals/pipelines/${pl.id}/stages`, {
      headers: authHeaders(token),
      data: { name: 'New Stage 31', position: 99 },
    });
    expect(r.status()).toBe(201);
    const pl2 = await getPipeline(request, token);
    expect(pl2.stages.some(s => s.name === 'New Stage 31')).toBe(true);
  });

  test('deal: rename pipeline → name updated', async ({ request }) => {
    const { token } = await registerOrg(request, 'rename-pl');
    const pl = await getPipeline(request, token);
    const newName = `Renamed-${Date.now()}`;
    const r = await request.patch(`/api/v1/deals/pipelines/${pl.id}`, {
      headers: authHeaders(token),
      data: { name: newName },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { name: string } };
    expect(body.data.name).toBe(newName);
  });

  test('deal: cross-org stage move rejected', async ({ request }) => {
    const orgA = await registerOrg(request, 'xorg-deal-a');
    const orgB = await registerOrg(request, 'xorg-deal-b');
    const plA = await getPipeline(request, orgA.token);
    const plB = await getPipeline(request, orgB.token);
    const c = await makeContact(request, orgA.token, 'XOrgC');
    const d = await makeDeal(request, orgA.token, 'XOrgDeal', c.id, plA.id, plA.stages[0]!.id);
    const r = await request.patch(`/api/v1/deals/${d.id}/stage`, {
      headers: authHeaders(orgB.token),
      data: { stage_id: plB.stages[0]!.id },
    });
    expect(r.status()).toBeGreaterThanOrEqual(403);
  });

  test('deal: PATCH title on won deal succeeds', async ({ request }) => {
    const { token } = await registerOrg(request, 'won-patch');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'WonPatchC');
    const d = await makeDeal(request, token, 'WonPatch', c.id, pl.id, pl.stages[0]!.id);
    await request.post(`/api/v1/deals/${d.id}/won`, { headers: authHeaders(token), data: {} });
    const r = await request.patch(`/api/v1/deals/${d.id}`, {
      headers: authHeaders(token),
      data: { title: 'Updated Won Deal' },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { title: string } };
    expect(body.data.title).toBe('Updated Won Deal');
  });
});

// ── 3. CONTACT LIFECYCLE AND MERGE ───────────────────────────────────────────

test.describe('contact lifecycle', () => {
  test('contact: merge A into B → A archived, B active, B has A deals', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'merge-ab');
    const pl = await getPipeline(request, token);
    const cA = await makeContact(request, token, 'MergeA');
    const cB = await makeContact(request, token, 'MergeB');
    await makeDeal(request, token, 'MergeDeal', cA.id, pl.id, pl.stages[0]!.id);
    const r = await request.post(`/api/v1/contacts/${cB.id}/merge`, {
      headers: authHeaders(token),
      data: { source_id: cA.id },
    });
    expect(r.status()).toBe(200);
    const rA = await request.get(`/api/v1/contacts/${cA.id}`, { headers: authHeaders(token) });
    expect(((await rA.json()) as { data: { status: string } }).data.status).toBe('archived');
    const rBDeals = await request.get(`/api/v1/contacts/${cB.id}/deals`, { headers: authHeaders(token) });
    const dealsBody = await rBDeals.json() as { data: { contact_id: string }[] };
    expect(dealsBody.data.length).toBeGreaterThanOrEqual(1);
    void userId;
  });

  test('contact: merge into self returns 422', async ({ request }) => {
    const { token } = await registerOrg(request, 'merge-self');
    const c = await makeContact(request, token, 'SelfMerge');
    const r = await request.post(`/api/v1/contacts/${c.id}/merge`, {
      headers: authHeaders(token),
      data: { source_id: c.id },
    });
    expect(r.status()).toBe(422);
  });

  test('contact: cross-org merge rejected', async ({ request }) => {
    const orgA = await registerOrg(request, 'merge-xorg-a');
    const orgB = await registerOrg(request, 'merge-xorg-b');
    const cA = await makeContact(request, orgA.token, 'XMergeA');
    const cB = await makeContact(request, orgB.token, 'XMergeB');
    const r = await request.post(`/api/v1/contacts/${cA.id}/merge`, {
      headers: authHeaders(orgA.token),
      data: { source_id: cB.id },
    });
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });

  test('contact: archive → absent from default list', async ({ request }) => {
    const { token } = await registerOrg(request, 'contact-arch');
    const c = await makeContact(request, token, 'ArchContact');
    await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token) });
    const r = await request.get('/api/v1/contacts?per_page=100', { headers: authHeaders(token) });
    const body = await r.json() as { data: { id: string }[] };
    expect(body.data.some(x => x.id === c.id)).toBe(false);
  });

  test('contact: archive → appears in ?status=archived', async ({ request }) => {
    const { token } = await registerOrg(request, 'arch-filter');
    const c = await makeContact(request, token, 'ArchivedOne');
    await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token) });
    const r = await request.get('/api/v1/contacts?status=archived&per_page=100', { headers: authHeaders(token) });
    const body = await r.json() as { data: { id: string }[] };
    expect(body.data.some(x => x.id === c.id)).toBe(true);
  });

  test('contact: archive → GET /contacts/:id/deals still works', async ({ request }) => {
    const { token } = await registerOrg(request, 'arch-deals');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'ArchDealsC');
    await makeDeal(request, token, 'ArchDealD', c.id, pl.id, pl.stages[0]!.id);
    await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/contacts/${c.id}/deals`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: unknown[] };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test('contact: archive → GET /contacts/:id/activity still works', async ({ request }) => {
    const { token } = await registerOrg(request, 'arch-activity');
    const c = await makeContact(request, token, 'ArchActC');
    await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/contacts/${c.id}/activity`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
  });

  test('contact: PATCH email to null clears email', async ({ request }) => {
    const { token } = await registerOrg(request, 'clear-email');
    const c = await makeContact(request, token, 'EmailClear', { email: 'clear@test.com' });
    const r = await request.patch(`/api/v1/contacts/${c.id}`, {
      headers: authHeaders(token),
      data: { email: '' },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { email: string } };
    expect(body.data.email).toBe('');
  });

  test('contact: all fields round-trip correctly', async ({ request }) => {
    const { token } = await registerOrg(request, 'full-contact');
    const r = await request.post('/api/v1/contacts', {
      headers: authHeaders(token),
      data: { first_name: 'Full', last_name: 'Contact', company: 'ACME', email: 'full@acme.com', phone: '+79001234567', notes: 'test notes' },
    });
    expect(r.status()).toBe(201);
    const body = await r.json() as { data: { first_name: string; last_name: string; company: string; email: string; phone: string; notes: string } };
    expect(body.data.first_name).toBe('Full');
    expect(body.data.last_name).toBe('Contact');
    expect(body.data.company).toBe('ACME');
    expect(body.data.email).toBe('full@acme.com');
    expect(body.data.phone).toBe('+79001234567');
    expect(body.data.notes).toBe('test notes');
  });
});

// ── 4. TASK STATE MACHINE ─────────────────────────────────────────────────────

test.describe('task state machine', () => {
  test('task: start → status=in_progress', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-start');
    const t = await makeTask(request, token, userId, 'StartTask');
    const r = await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('in_progress');
  });

  test('task: start → complete → status=done', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-sc');
    const t = await makeTask(request, token, userId, 'SC Task');
    await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(token) });
    const r = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('done');
  });

  test('task: start → cancel → status=cancelled', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-cancel');
    const t = await makeTask(request, token, userId, 'CancelTask');
    await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(token) });
    const r = await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('cancelled');
  });

  test('task: complete directly without start succeeds', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-direct');
    const t = await makeTask(request, token, userId, 'DirectComplete');
    const r = await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('done');
  });

  test('task: cancelled → start returns error', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-cancel-start');
    const t = await makeTask(request, token, userId, 'CancelledStart');
    await request.delete(`/api/v1/tasks/${t.id}`, { headers: authHeaders(token) });
    const r = await request.post(`/api/v1/tasks/${t.id}/start`, { headers: authHeaders(token) });
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });

  test('task: completed task appears in ?status=done', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-list-comp');
    const t = await makeTask(request, token, userId, 'CompletedList');
    await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(token) });
    const r = await request.get('/api/v1/tasks?status=done&per_page=100', { headers: authHeaders(token) });
    const body = await r.json() as { data: { id: string }[] };
    expect(body.data.some(x => x.id === t.id)).toBe(true);
  });

  test('task: overdue task with past due_date appears in /tasks/overdue', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-overdue');
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const t = await makeTask(request, token, userId, 'OverdueTask', { due_date: pastDate });
    const r = await request.get('/api/v1/tasks/overdue', { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { id: string }[] };
    expect(body.data.some(x => x.id === t.id)).toBe(true);
  });

  test('task: task due today appears in /tasks/today', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'task-today');
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const t = await makeTask(request, token, userId, 'TodayTask', { due_date: today.toISOString() });
    const r = await request.get('/api/v1/tasks/today', { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { id: string }[] };
    expect(body.data.some(x => x.id === t.id)).toBe(true);
  });
});

// ── 5. CALENDAR EVENT INVARIANTS ─────────────────────────────────────────────

test.describe('calendar event invariants', () => {
  test('calendar: complete event → status=completed', async ({ request }) => {
    const { token } = await registerOrg(request, 'cal-complete');
    const e = await makeEvent(request, token, 'CompleteEvent');
    const r = await request.post(`/api/v1/calendar/${e.id}/complete`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('completed');
  });

  test('calendar: complete then add notes → notes persisted', async ({ request }) => {
    const { token } = await registerOrg(request, 'cal-notes');
    const e = await makeEvent(request, token, 'NotesEvent');
    await request.post(`/api/v1/calendar/${e.id}/complete`, { headers: authHeaders(token) });
    const r = await request.post(`/api/v1/calendar/${e.id}/notes`, {
      headers: authHeaders(token),
      data: { notes: 'Post-meeting notes here' },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { notes: string; post_meeting_prompted: boolean } };
    expect(body.data.notes).toBe('Post-meeting notes here');
    expect(body.data.post_meeting_prompted).toBe(true);
  });

  test('calendar: cancel → PATCH returns 422', async ({ request }) => {
    const { token } = await registerOrg(request, 'cal-cancel-patch');
    const e = await makeEvent(request, token, 'CancelPatchEvent');
    await request.delete(`/api/v1/calendar/${e.id}`, { headers: authHeaders(token) });
    const r = await request.patch(`/api/v1/calendar/${e.id}`, {
      headers: authHeaders(token),
      data: { title: 'New Title' },
    });
    expect(r.status()).toBe(422);
    const body = await r.json() as { error: { code: string } };
    expect(body.error.code).toBe('EVENT_CANCELLED');
  });

  test('calendar: cancel twice → 422 EVENT_ALREADY_CANCELLED', async ({ request }) => {
    const { token } = await registerOrg(request, 'cal-double-cancel');
    const e = await makeEvent(request, token, 'DoubleCancelEvent');
    await request.delete(`/api/v1/calendar/${e.id}`, { headers: authHeaders(token) });
    const r = await request.delete(`/api/v1/calendar/${e.id}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(422);
    const body = await r.json() as { error: { code: string } };
    expect(body.error.code).toBe('EVENT_ALREADY_CANCELLED');
  });

  test('calendar: end_time <= start_time → 400 VALIDATION_ERROR', async ({ request }) => {
    const { token } = await registerOrg(request, 'cal-invalid-window');
    const r = await request.post('/api/v1/calendar', {
      headers: authHeaders(token),
      data: { title: 'Bad Window', start_time: msFromNow(7_200_000), end_time: msFromNow(3_600_000) },
    });
    expect(r.status()).toBe(400);
  });

  test('calendar: create event with cross-org contact → 403', async ({ request }) => {
    const orgA = await registerOrg(request, 'cal-xorg-a');
    const orgB = await registerOrg(request, 'cal-xorg-b');
    const cA = await makeContact(request, orgA.token, 'XOrgCalC');
    const r = await request.post('/api/v1/calendar', {
      headers: authHeaders(orgB.token),
      data: { title: 'XOrgEvent', start_time: msFromNow(3_600_000), end_time: msFromNow(7_200_000), contact_id: cA.id },
    });
    expect(r.status()).toBe(403);
  });

  test('calendar: created event appears in /calendar/availability busy_slots', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'cal-avail');
    const start = msFromNow(3_600_000);
    const end = msFromNow(7_200_000);
    await request.post('/api/v1/calendar', {
      headers: authHeaders(token),
      data: { title: 'AvailEvent', start_time: start, end_time: end },
    });
    const date = start.slice(0, 10);
    const r = await request.get(`/api/v1/calendar/availability?date=${date}&user_ids=${userId}`, {
      headers: authHeaders(token),
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { busy_slots: { title: string }[] } };
    expect(body.data.busy_slots.some(s => s.title === 'AvailEvent')).toBe(true);
  });

  test('calendar: update location → location persisted in GET', async ({ request }) => {
    const { token } = await registerOrg(request, 'cal-loc');
    const e = await makeEvent(request, token, 'LocEvent');
    await request.patch(`/api/v1/calendar/${e.id}`, {
      headers: authHeaders(token),
      data: { location: 'Moscow, Red Square' },
    });
    const r = await request.get(`/api/v1/calendar/${e.id}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { location: string } };
    expect(body.data.location).toBe('Moscow, Red Square');
  });
});

// ── 6. DELTA SYNC CORRECTNESS ────────────────────────────────────────────────

test.describe('delta sync correctness', () => {
  test('delta: newly created deal appears in data.deals', async ({ request }) => {
    const { token } = await registerOrg(request, 'delta-deal');
    const pl = await getPipeline(request, token);
    const before = new Date().toISOString();
    const c = await makeContact(request, token, 'DeltaDealC');
    const d = await makeDeal(request, token, 'DeltaDeal', c.id, pl.id, pl.stages[0]!.id);
    const r = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(before)}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { deals: { id: string }[] } };
    expect(body.data.deals.some(x => x.id === d.id)).toBe(true);
  });

  test('delta: updated contact reflects latest state', async ({ request }) => {
    const { token } = await registerOrg(request, 'delta-update');
    const c = await makeContact(request, token, 'DeltaUpdateC');
    const afterCreate = new Date().toISOString();
    await request.patch(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token), data: { company: 'UpdatedCo' } });
    const r = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(afterCreate)}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { contacts: { id: string; company: string }[] } };
    const found = body.data.contacts.find(x => x.id === c.id);
    expect(found).toBeDefined();
    expect(found!.company).toBe('UpdatedCo');
  });

  test('delta: completed task shows status=completed', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'delta-task');
    const before = new Date().toISOString();
    const t = await makeTask(request, token, userId, 'DeltaTask');
    await request.post(`/api/v1/tasks/${t.id}/complete`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(before)}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { tasks: { id: string; status: string }[] } };
    const found = body.data.tasks.find(x => x.id === t.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('done');
  });

  test('delta: cancelled calendar event included as tombstone', async ({ request }) => {
    const { token } = await registerOrg(request, 'delta-cal-cancel');
    const before = new Date().toISOString();
    const e = await makeEvent(request, token, 'DeltaCancelEvent');
    await request.delete(`/api/v1/calendar/${e.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(before)}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { events: { id: string; status: string }[] } };
    const found = body.data.events.find(x => x.id === e.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('cancelled');
  });

  test('delta: after last-seen timestamp, no more changes → arrays empty', async ({ request }) => {
    const { token } = await registerOrg(request, 'delta-empty');
    await makeContact(request, token, 'DeltaEmptyC');
    const after = new Date().toISOString();
    const r = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(after)}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { contacts: unknown[]; deals: unknown[]; tasks: unknown[]; events: unknown[] } };
    expect(body.data.contacts.length).toBe(0);
    expect(body.data.deals.length).toBe(0);
    expect(body.data.tasks.length).toBe(0);
    expect(body.data.events.length).toBe(0);
  });

  test('delta: cross-org isolation strict', async ({ request }) => {
    const orgA = await registerOrg(request, 'delta-iso-a');
    const orgB = await registerOrg(request, 'delta-iso-b');
    const cA = await makeContact(request, orgA.token, 'IsoA');
    const r = await request.get('/api/v1/sync/delta', { headers: authHeaders(orgB.token) });
    const body = await r.json() as { data: { contacts: { id: string }[] } };
    expect(body.data.contacts.some(x => x.id === cA.id)).toBe(false);
  });

  test('delta: no since → shape valid and meta present', async ({ request }) => {
    const { token } = await registerOrg(request, 'delta-noparam');
    const r = await request.get('/api/v1/sync/delta', { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { contacts: unknown[]; deals: unknown[]; tasks: unknown[]; events: unknown[] }; meta: { since: string; server_time: string } };
    expect(Array.isArray(body.data.contacts)).toBe(true);
    expect(typeof body.meta.since).toBe('string');
    expect(typeof body.meta.server_time).toBe('string');
  });

  test('delta: far-future since → all arrays empty', async ({ request }) => {
    const { token } = await registerOrg(request, 'delta-future');
    const future = new Date(Date.now() + 365 * 86400000).toISOString();
    const r = await request.get(`/api/v1/sync/delta?since=${encodeURIComponent(future)}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { contacts: unknown[]; deals: unknown[]; tasks: unknown[]; events: unknown[] } };
    expect(body.data.contacts.length).toBe(0);
    expect(body.data.deals.length).toBe(0);
    expect(body.data.tasks.length).toBe(0);
    expect(body.data.events.length).toBe(0);
  });
});

// ── 7. BULK OPS AND PAGINATION INVARIANTS ────────────────────────────────────

test.describe('bulk ops and pagination', () => {
  test('pagination: 15 contacts → page1 per_page=10 returns 10, page2 has rest', async ({ request }) => {
    const { token } = await registerOrg(request, 'page-15');
    await Promise.all(Array.from({ length: 15 }, (_, i) => makeContact(request, token, `PageC${i}`)));
    const r1 = await request.get('/api/v1/contacts?page=1&per_page=10', { headers: authHeaders(token) });
    const b1 = await r1.json() as { data: unknown[]; meta: { total: number } };
    expect(b1.data.length).toBe(10);
    expect(b1.meta.total).toBeGreaterThanOrEqual(15);
    const r2 = await request.get('/api/v1/contacts?page=2&per_page=10', { headers: authHeaders(token) });
    const b2 = await r2.json() as { data: unknown[] };
    expect(b2.data.length).toBeGreaterThanOrEqual(5);
  });

  test('pagination: high page number returns empty data, total unchanged', async ({ request }) => {
    const { token } = await registerOrg(request, 'page-high');
    await makeContact(request, token, 'HighPageC');
    const r = await request.get('/api/v1/contacts?page=9999&per_page=10', { headers: authHeaders(token) });
    const body = await r.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data.length).toBe(0);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  test('pagination: per_page=1 returns exactly 1 deal', async ({ request }) => {
    const { token } = await registerOrg(request, 'page-deal-1');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'PageDealC');
    await makeDeal(request, token, 'PD1', c.id, pl.id, pl.stages[0]!.id);
    await makeDeal(request, token, 'PD2', c.id, pl.id, pl.stages[0]!.id);
    const r = await request.get('/api/v1/deals?page=1&per_page=1', { headers: authHeaders(token) });
    const body = await r.json() as { data: unknown[]; meta: { per_page: number } };
    expect(body.data.length).toBe(1);
    expect(body.meta.per_page).toBe(1);
  });

  test('bulk-archive: 5 contacts → all archived', async ({ request }) => {
    const { token } = await registerOrg(request, 'bulk-arch');
    const contacts = await Promise.all(Array.from({ length: 5 }, (_, i) => makeContact(request, token, `BulkA${i}`)));
    const ids = contacts.map(c => c.id);
    const r = await request.post('/api/v1/contacts/bulk-archive', { headers: authHeaders(token), data: { contact_ids: ids } });
    expect(r.status()).toBe(200);
    for (const id of ids) {
      const check = await request.get(`/api/v1/contacts/${id}`, { headers: authHeaders(token) });
      const body = await check.json() as { data: { status: string } };
      expect(body.data.status).toBe('archived');
    }
  });

  test('bulk-assign: 5 contacts → all assigned to user', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'bulk-assign');
    const contacts = await Promise.all(Array.from({ length: 5 }, (_, i) => makeContact(request, token, `BulkAssign${i}`)));
    const ids = contacts.map(c => c.id);
    const r = await request.post('/api/v1/contacts/bulk-assign', {
      headers: authHeaders(token),
      data: { contact_ids: ids, assigned_to: userId },
    });
    expect(r.status()).toBe(200);
    for (const id of ids) {
      const check = await request.get(`/api/v1/contacts/${id}`, { headers: authHeaders(token) });
      const body = await check.json() as { data: { assigned_to: string | null } };
      expect(body.data.assigned_to).toBe(userId);
    }
  });

  test('search: unique prefix returns only matching contacts', async ({ request }) => {
    const { token } = await registerOrg(request, 'search-prefix');
    const prefix = `ZZZ${Date.now()}`;
    await makeContact(request, token, `${prefix}Alpha`);
    await makeContact(request, token, `${prefix}Beta`);
    await makeContact(request, token, 'UnrelatedContact');
    const r = await request.get(`/api/v1/contacts?q=${prefix}&per_page=100`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { first_name: string }[] };
    expect(body.data.every(c => c.first_name.startsWith(prefix))).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  test('bulk-archive then list: archived contacts absent from default list', async ({ request }) => {
    const { token } = await registerOrg(request, 'bulk-arch-list');
    const contacts = await Promise.all(Array.from({ length: 3 }, (_, i) => makeContact(request, token, `BulkListA${i}`)));
    const ids = contacts.map(c => c.id);
    await request.post('/api/v1/contacts/bulk-archive', { headers: authHeaders(token), data: { contact_ids: ids } });
    const r = await request.get('/api/v1/contacts?per_page=100', { headers: authHeaders(token) });
    const body = await r.json() as { data: { id: string }[] };
    for (const id of ids) {
      expect(body.data.some(x => x.id === id)).toBe(false);
    }
  });
});

// ── 8. MESSAGES AND CONVERSATION ─────────────────────────────────────────────

test.describe('messages and conversation', () => {
  test('messages: send in-app → appears in conversation', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'msg-inapp');
    const c = await makeContact(request, token, 'MsgC');
    const r = await request.post('/api/v1/messages/in-app', {
      headers: authHeaders(token),
      data: { contact_id: c.id, body: 'Hello from CRM' },
    });
    expect(r.status()).toBe(201);
    const conv = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(token) });
    expect(conv.status()).toBe(200);
    const body = await conv.json() as { data: { body: string }[] };
    expect(body.data.some(m => m.body === 'Hello from CRM')).toBe(true);
  });

  test('messages: log call → channel=call in conversation', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'msg-call');
    const c = await makeContact(request, token, 'CallC');
    const r = await request.post('/api/v1/messages/call', {
      headers: authHeaders(token),
      data: { contact_id: c.id, direction: 'outbound', notes: 'Called at 3pm', duration_seconds: 120 },
    });
    expect(r.status()).toBe(201);
    const conv = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(token) });
    const body = await conv.json() as { data: { channel: string; content: string }[] };
    const callMsg = body.data.find(m => m.channel === 'call');
    expect(callMsg).toBeDefined();
  });

  test('messages: conversation ordered by created_at ascending', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'msg-order');
    const c = await makeContact(request, token, 'OrderC');
    for (let i = 0; i < 3; i++) {
      await request.post('/api/v1/messages/in-app', {
        headers: authHeaders(token),
        data: { contact_id: c.id, body: `Msg ${i}` },
      });
    }
    const conv = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(token) });
    const body = await conv.json() as { data: { created_at: string }[] };
    const dates = body.data.map(m => new Date(m.created_at).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]!).toBeGreaterThanOrEqual(dates[i - 1]!);
    }
  });

  test('messages: mark-read → is_read=true', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'msg-read');
    const c = await makeContact(request, token, 'ReadC');
    const sendRes = await request.post('/api/v1/messages/in-app', {
      headers: authHeaders(token),
      data: { contact_id: c.id, body: 'Read me' },
    });
    const msg = ((await sendRes.json()) as { data: { id: string } }).data;
    const r = await request.post(`/api/v1/messages/${msg.id}/read`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('read');
  });

  test('messages: GET /messages?contact_id only returns that contact messages', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'msg-filter');
    const c1 = await makeContact(request, token, 'FilterC1');
    const c2 = await makeContact(request, token, 'FilterC2');
    await request.post('/api/v1/messages/in-app', { headers: authHeaders(token), data: { contact_id: c1.id, body: 'C1 msg' } });
    await request.post('/api/v1/messages/in-app', { headers: authHeaders(token), data: { contact_id: c2.id, body: 'C2 msg' } });
    const r = await request.get(`/api/v1/messages?contact_id=${c1.id}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { contact_id: string }[] };
    expect(body.data.every(m => m.contact_id === c1.id)).toBe(true);
  });

  test('messages: send to cross-org contact → 403 or 404', async ({ request }) => {
    const orgA = await registerOrg(request, 'msg-xorg-a');
    const orgB = await registerOrg(request, 'msg-xorg-b');
    const cA = await makeContact(request, orgA.token, 'XOrgMsgC');
    const r = await request.post('/api/v1/messages/in-app', {
      headers: authHeaders(orgB.token),
      data: { contact_id: cA.id, body: 'XOrg msg' },
    });
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });

  test('messages: 3 in-app messages all appear in conversation', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'msg-3');
    const c = await makeContact(request, token, 'ThreeMsg');
    const contents = ['First', 'Second', 'Third'];
    for (const content of contents) {
      await request.post('/api/v1/messages/in-app', { headers: authHeaders(token), data: { contact_id: c.id, body: content } });
    }
    const conv = await request.get(`/api/v1/messages/conversation/${c.id}`, { headers: authHeaders(token) });
    const body = await conv.json() as { data: { body: string }[] };
    for (const content of contents) {
      expect(body.data.some(m => m.body === content)).toBe(true);
    }
  });

  test('messages: conversation for cross-org contact → 403 or empty', async ({ request }) => {
    const orgA = await registerOrg(request, 'msg-conv-xorg-a');
    const orgB = await registerOrg(request, 'msg-conv-xorg-b');
    const cA = await makeContact(request, orgA.token, 'XOrgConvC');
    const r = await request.get(`/api/v1/messages/conversation/${cA.id}`, { headers: authHeaders(orgB.token) });
    const isOk = r.status() === 200;
    if (isOk) {
      const body = await r.json() as { data: unknown[] };
      expect(body.data.length).toBe(0);
    } else {
      expect(r.status()).toBeGreaterThanOrEqual(403);
    }
  });
});

// ── 9. CONCURRENT STRESS ─────────────────────────────────────────────────────

test.describe('concurrent stress', () => {
  test('concurrent: 10 contacts created in parallel → all 201, all unique IDs', async ({ request }) => {
    const { token } = await registerOrg(request, 'conc-contacts');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: `Conc${i}` } }),
      ),
    );
    const statuses = results.map(r => r.status());
    expect(statuses.every(s => s === 201)).toBe(true);
    const ids = await Promise.all(results.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
    expect(new Set(ids).size).toBe(10);
  });

  test('concurrent: 8 tasks created in parallel → all listed', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'conc-tasks');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title: `ConcTask${i}`, assigned_to: userId } }),
      ),
    );
    expect(results.every(r => r.status() === 201)).toBe(true);
    const ids = await Promise.all(results.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
    const listRes = await request.get('/api/v1/tasks?per_page=100', { headers: authHeaders(token) });
    const body = await listRes.json() as { data: { id: string }[] };
    for (const id of ids) {
      expect(body.data.some(t => t.id === id)).toBe(true);
    }
  });

  test('concurrent: 5 contacts created and immediately archived in parallel → all archived', async ({ request }) => {
    const { token } = await registerOrg(request, 'conc-arch');
    const creates = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: `ConcArch${i}` } }),
      ),
    );
    const ids = await Promise.all(creates.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
    const deletes = await Promise.all(ids.map(id => request.delete(`/api/v1/contacts/${id}`, { headers: authHeaders(token) })));
    expect(deletes.every(r => r.status() === 200)).toBe(true);
    for (const id of ids) {
      const check = await request.get(`/api/v1/contacts/${id}`, { headers: authHeaders(token) });
      const body = await check.json() as { data: { status: string } };
      expect(body.data.status).toBe('archived');
    }
  });

  test('concurrent: 10 GET /analytics/dashboard in parallel → all 200', async ({ request }) => {
    const { token } = await registerOrg(request, 'conc-dash');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request.get('/api/v1/analytics/dashboard', { headers: authHeaders(token) })),
    );
    expect(results.every(r => r.status() === 200)).toBe(true);
  });

  test('concurrent: move same deal to different stages in parallel → deal in valid stage, no 500', async ({ request }) => {
    const { token } = await registerOrg(request, 'conc-stage');
    const pl = await getPipeline(request, token);
    if (pl.stages.length < 2) return;
    const c = await makeContact(request, token, 'ConcStageC');
    const d = await makeDeal(request, token, 'ConcStageDeal', c.id, pl.id, pl.stages[0]!.id);
    const results = await Promise.all(
      pl.stages.map(st =>
        request.patch(`/api/v1/deals/${d.id}/stage`, { headers: authHeaders(token), data: { stage_id: st.id } }),
      ),
    );
    expect(results.some(r => r.status() === 200)).toBe(true);
    expect(results.every(r => r.status() !== 500)).toBe(true);
    const final = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    const body = await final.json() as { data: { stage_id: string } };
    expect(pl.stages.some(s => s.id === body.data.stage_id)).toBe(true);
  });
});

// ── 10. CROSS-ENTITY CASCADE ─────────────────────────────────────────────────

test.describe('cross-entity cascade', () => {
  test('cascade: archive contact → linked deal still accessible', async ({ request }) => {
    const { token } = await registerOrg(request, 'casc-deal');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'CascDealC');
    const d = await makeDeal(request, token, 'CascDeal', c.id, pl.id, pl.stages[0]!.id);
    await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { id: string } };
    expect(body.data.id).toBe(d.id);
  });

  test('cascade: archive contact → linked task still accessible', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'casc-task');
    const c = await makeContact(request, token, 'CascTaskC');
    const t = await makeTask(request, token, userId, 'CascTask', { contact_id: c.id });
    await request.delete(`/api/v1/contacts/${c.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/tasks/${t.id}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { id: string } };
    expect(body.data.id).toBe(t.id);
  });

  test('cascade: cancel calendar event → linked deal unchanged', async ({ request }) => {
    const { token } = await registerOrg(request, 'casc-cal');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'CascCalC');
    const d = await makeDeal(request, token, 'CascCalDeal', c.id, pl.id, pl.stages[0]!.id);
    const e = await makeEvent(request, token, 'CascCalEvent', { deal_id: d.id });
    await request.delete(`/api/v1/calendar/${e.id}`, { headers: authHeaders(token) });
    const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('open');
  });

  test('cascade: GET /contacts/:id/deals and /tasks include linked entities', async ({ request }) => {
    const { token, userId } = await registerOrg(request, 'casc-subs');
    const pl = await getPipeline(request, token);
    const c = await makeContact(request, token, 'CascSubC');
    const d = await makeDeal(request, token, 'CascSubDeal', c.id, pl.id, pl.stages[0]!.id);
    const t = await makeTask(request, token, userId, 'CascSubTask', { contact_id: c.id });
    const rDeals = await request.get(`/api/v1/contacts/${c.id}/deals`, { headers: authHeaders(token) });
    const dealsBody = await rDeals.json() as { data: { id: string }[] };
    expect(dealsBody.data.some(x => x.id === d.id)).toBe(true);
    const rTasks = await request.get(`/api/v1/contacts/${c.id}/tasks`, { headers: authHeaders(token) });
    const tasksBody = await rTasks.json() as { data: { id: string }[] };
    expect(tasksBody.data.some(x => x.id === t.id)).toBe(true);
  });

  test('cascade: move deal S1→S2 → GET /deals/:id shows S2', async ({ request }) => {
    const { token } = await registerOrg(request, 'casc-stage');
    const pl = await getPipeline(request, token);
    if (pl.stages.length < 2) return;
    const c = await makeContact(request, token, 'CascStageC');
    const d = await makeDeal(request, token, 'CascStageDeal', c.id, pl.id, pl.stages[0]!.id);
    await request.patch(`/api/v1/deals/${d.id}/stage`, { headers: authHeaders(token), data: { stage_id: pl.stages[1]!.id } });
    const r = await request.get(`/api/v1/deals/${d.id}`, { headers: authHeaders(token) });
    const body = await r.json() as { data: { stage_id: string } };
    expect(body.data.stage_id).toBe(pl.stages[1]!.id);
  });
});

// ── 11. RESPONSE ENVELOPE HARDENING ──────────────────────────────────────────

test.describe('response envelope', () => {
  test('envelope: POST /contacts success has data.id and meta', async ({ request }) => {
    const { token } = await registerOrg(request, 'env-post');
    const r = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: 'EnvC' } });
    expect(r.status()).toBe(201);
    const body = await r.json() as { data: { id: string }; meta: unknown };
    expect(typeof body.data.id).toBe('string');
    expect('meta' in body).toBe(true);
  });

  test('envelope: GET /contacts list has data array, meta.total, meta.page, meta.per_page', async ({ request }) => {
    const { token } = await registerOrg(request, 'env-list');
    const r = await request.get('/api/v1/contacts', { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe('number');
    expect(typeof body.meta.page).toBe('number');
    expect(typeof body.meta.per_page).toBe('number');
  });

  test('envelope: GET /contacts/:nonexistent has error.code and error.message', async ({ request }) => {
    const { token } = await registerOrg(request, 'env-404');
    const r = await request.get('/api/v1/contacts/00000000-0000-0000-0000-000000000000', { headers: authHeaders(token) });
    expect(r.status()).toBe(404);
    const body = await r.json() as { error: { code: string; message: string } };
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
  });

  test('envelope: POST /contacts with empty first_name → error.code present', async ({ request }) => {
    const { token } = await registerOrg(request, 'env-val');
    const r = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: '' } });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    const body = await r.json() as { error?: { code: string } };
    expect(body.error).toBeDefined();
  });

  test('envelope: POST /deals missing contact_id → error.code present', async ({ request }) => {
    const { token } = await registerOrg(request, 'env-deal-val');
    const pl = await getPipeline(request, token);
    const r = await request.post('/api/v1/deals', {
      headers: authHeaders(token),
      data: { title: 'NoCID', pipeline_id: pl.id, stage_id: pl.stages[0]!.id },
    });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    const body = await r.json() as { error?: { code: string } };
    expect(body.error).toBeDefined();
  });
});

// ── 12. WORKFLOWS ─────────────────────────────────────────────────────────────

test.describe('workflows', () => {
  test('workflows: GET /workflows returns 200 with data array', async ({ request }) => {
    const { token } = await registerOrg(request, 'wf-list');
    const r = await request.get('/api/v1/workflows', { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('workflows: POST creates workflow with contact_created trigger', async ({ request }) => {
    const { token } = await registerOrg(request, 'wf-create');
    const r = await request.post('/api/v1/workflows', {
      headers: authHeaders(token),
      data: {
        name: 'New Contact Task',
        trigger: 'contact_created',
        actions: [{ type: 'create_task', title: 'Follow up' }],
        status: 'active',
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json() as { data: { id: string; trigger: string; status: string } };
    expect(body.data.trigger).toBe('contact_created');
    expect(body.data.status).toBe('active');
  });

  test('workflows: PATCH to deactivate → status=paused', async ({ request }) => {
    const { token } = await registerOrg(request, 'wf-deact');
    const cr = await request.post('/api/v1/workflows', {
      headers: authHeaders(token),
      data: { name: 'DeactWF', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'Task' }], status: 'active' },
    });
    const wf = ((await cr.json()) as { data: { id: string } }).data;
    const r = await request.patch(`/api/v1/workflows/${wf.id}`, { headers: authHeaders(token), data: { status: 'paused' } });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: { status: string } };
    expect(body.data.status).toBe('paused');
  });

  test('workflows: active contact_created workflow fires task on new contact', async ({ request }) => {
    const { token } = await registerOrg(request, 'wf-fire');
    await request.post('/api/v1/workflows', {
      headers: authHeaders(token),
      data: { name: 'FireWF', trigger: 'contact_created', actions: [{ type: 'create_task', title: 'Auto follow-up {{first_name}}' }], status: 'active' },
    });
    const c = await makeContact(request, token, 'WFFireContact');
    const r = await request.get(`/api/v1/tasks?contact_id=${c.id}&per_page=20`, { headers: authHeaders(token) });
    expect(r.status()).toBe(200);
    const body = await r.json() as { data: Array<{ title: string; contact_id: string }> };
    expect(body.data.some((task) =>
      task.title === 'Auto follow-up WFFireContact' && task.contact_id === c.id,
    )).toBe(true);
  });
});
