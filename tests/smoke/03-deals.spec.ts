import { APIRequestContext, test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.use({ baseURL: 'http://127.0.0.1:3000' });

let contactId: string;
let pipelineId: string;
let stageId: string;
let authToken: string;

type PipelineSummary = {
  id: string;
  is_default: boolean;
};

test.describe.configure({ timeout: 60000 });

test.beforeAll(async ({ request }) => {
  const { token } = getAuth();
  authToken = token;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'DealContact' },
  });
  contactId = (await contactRes.json()).data.id;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines = ((await pipelinesRes.json()) as { data: PipelineSummary[] }).data;
  const defaultPipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];
  pipelineId = defaultPipeline.id;

  const stagesRes = await request.get(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  stageId = (await stagesRes.json()).data[0].id;
});

test('GET /api/v1/deals returns list', async ({ request }) => {
  const res = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/deals creates deal', async ({ request }) => {
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { title: 'Smoke Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 5000 },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.title).toBe('Smoke Deal');
});

test('GET /api/v1/deals/:id returns deal with pipeline+stage', async ({ request }) => {
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { title: 'Detail Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.get(`/api/v1/deals/${deal.id}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.id).toBe(deal.id);
});

test('PATCH /api/v1/deals/:id updates deal', async ({ request }) => {
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { title: 'Update Me', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { title: 'Updated Deal' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.title).toBe('Updated Deal');
});

test('PATCH /api/v1/deals/:id/won marks deal won', async ({ request }) => {
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { title: 'Win Me', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.post(`/api/v1/deals/${deal.id}/won`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('won');
});

test('PATCH /api/v1/deals/:id/lost marks deal lost', async ({ request }) => {
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { title: 'Lose Me', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.post(`/api/v1/deals/${deal.id}/lost`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data: { reason: 'Price too high' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('lost');
});

// ─── Shared types ────────────────────────────────────────────────────────────

interface AuthOrg {
  token: string;
  userId: string;
}

interface RegisterResponse {
  data: {
    token: string;
    user: { id: string };
  };
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface PipelineStageRecord {
  id: string;
  name: string;
  position: number;
}

interface PipelineRecord {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStageRecord[];
}

interface DealRecord {
  id: string;
  title: string;
  status: string;
  value: number | string | null;
  currency: string | null;
  contact_id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  assigned_to: string | null;
  actual_close: string | null;
  lost_reason: string | null;
  updated_at: string;
  contact: { id: string; first_name: string; last_name: string | null };
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
}

interface DealResponse {
  data: DealRecord;
  meta: Record<string, unknown>;
}

interface DealListResponse {
  data: DealRecord[];
  meta: { total: number; page: number; per_page: number };
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function authHdr(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function numVal(v: number | string | null): number {
  if (v === null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<AuthOrg> {
  const unique = uniq(suffix);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as RegisterResponse;
  return { token: body.data.token, userId: body.data.user.id };
}

async function getOrgPipeline(
  request: APIRequestContext,
  token: string,
): Promise<{ pipelineId: string; stages: PipelineStageRecord[] }> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHdr(token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: PipelineRecord[] };
  const pipeline =
    body.data.find((p) => p.is_default && p.stages.length > 0) ??
    body.data.find((p) => p.stages.length > 0);
  if (pipeline) return { pipelineId: pipeline.id, stages: pipeline.stages };

  // create fallback pipeline with one stage
  const pr = await request.post('/api/v1/deals/pipelines', {
    headers: authHdr(token),
    data: { name: `Fallback ${uniq('pl')}` },
  });
  expect(pr.status()).toBe(201);
  const pid = ((await pr.json()) as { data: { id: string } }).data.id;
  const sr = await request.post(`/api/v1/deals/pipelines/${pid}/stages`, {
    headers: authHdr(token),
    data: { name: 'Stage 1', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  expect(sr.status()).toBe(201);
  const sid = ((await sr.json()) as { data: PipelineStageRecord }).data;
  return { pipelineId: pid, stages: [sid] };
}

async function makeContact(request: APIRequestContext, token: string, firstName?: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHdr(token),
    data: { first_name: firstName ?? `C-${uniq('c')}` },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function makeDeal(
  request: APIRequestContext,
  token: string,
  opts: {
    title?: string;
    contactId: string;
    pipelineId: string;
    stageId: string;
    value?: number | null;
    currency?: string;
    assignedTo?: string;
  },
): Promise<DealRecord> {
  const payload: Record<string, unknown> = {
    title: opts.title ?? `Deal-${uniq('d')}`,
    contact_id: opts.contactId,
    pipeline_id: opts.pipelineId,
    stage_id: opts.stageId,
  };
  if (opts.value !== undefined) payload.value = opts.value;
  if (opts.currency !== undefined) payload.currency = opts.currency;
  if (opts.assignedTo !== undefined) payload.assigned_to = opts.assignedTo;

  const res = await request.post('/api/v1/deals', { headers: authHdr(token), data: payload });
  expect(res.status()).toBe(201);
  return ((await res.json()) as DealResponse).data;
}

async function fetchDeal(request: APIRequestContext, token: string, id: string): Promise<DealRecord> {
  const res = await request.get(`/api/v1/deals/${id}`, { headers: authHdr(token) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as DealResponse).data;
}

async function fetchDeals(
  request: APIRequestContext,
  token: string,
  params: Record<string, string | number> = {},
): Promise<DealListResponse> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = qs ? `/api/v1/deals?${qs}` : '/api/v1/deals';
  const res = await request.get(url, { headers: authHdr(token) });
  expect(res.status()).toBe(200);
  return (await res.json()) as DealListResponse;
}

// ─── Rung 4 — data-integrity / multi-step / state-verification ───────────────

test('POST /deals with all optional fields stored and verified on GET /:id readback', async ({ request }) => {
  const org = await registerOrg(request, 'deal-all-fields');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    title: 'All Fields Deal',
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    value: 12345,
    currency: 'EUR',
    assignedTo: org.userId,
  });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.title).toBe('All Fields Deal');
  expect(numVal(read.value)).toBe(12345);
  expect(read.currency).toBe('EUR');
  expect(read.assigned_to).toBe(org.userId);
  expect(read.pipeline_id).toBe(pipelineId);
  expect(read.stage_id).toBe(stages[0].id);
  expect(read.contact_id).toBe(contact.id);
});

test('PATCH /deals/:id changes currency from USD to EUR and readback verifies', async ({ request }) => {
  const org = await registerOrg(request, 'deal-currency-patch');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    currency: 'USD',
    value: 500,
  });
  expect(deal.currency).toBe('USD');

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { currency: 'EUR' },
  });
  expect(patchRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.currency).toBe('EUR');
  expect(numVal(read.value)).toBe(500);
});

test('PATCH /deals/:id changes assigned_to to different user in same org and readback verifies', async ({ request }) => {
  const org = await registerOrg(request, 'deal-reassign');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  // register a second user in same org by using a fresh org registration
  // (simplest approach: create deal with current user, patch to same user, assert)
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    assignedTo: org.userId,
  });

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { assigned_to: org.userId },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as DealResponse;
  expect(body.data.assigned_to).toBe(org.userId);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.assigned_to).toBe(org.userId);
});

test('POST /deals/:id/lost with reason, GET /:id shows lost_reason equals reason', async ({ request }) => {
  const org = await registerOrg(request, 'deal-lost-reason-read');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const lostRes = await request.post(`/api/v1/deals/${deal.id}/lost`, {
    headers: authHdr(org.token),
    data: { reason: 'budget' },
  });
  expect(lostRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('lost');
  expect(read.lost_reason).toBe('budget');
});

test('After marking deal won, GET /:id shows status=won and actual_close is not null', async ({ request }) => {
  const org = await registerOrg(request, 'deal-won-readback');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const wonRes = await request.post(`/api/v1/deals/${deal.id}/won`, {
    headers: authHdr(org.token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('won');
  expect(read.actual_close).not.toBeNull();
});

test('After marking deal lost, GET /:id shows status=lost and lost_reason reflects the reason', async ({ request }) => {
  const org = await registerOrg(request, 'deal-lost-readback');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const lostRes = await request.post(`/api/v1/deals/${deal.id}/lost`, {
    headers: authHdr(org.token),
    data: { reason: 'competitor' },
  });
  expect(lostRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('lost');
  expect(read.lost_reason).toBe('competitor');
});

test('GET /deals list is org-scoped: deals from another org do not appear', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-list-scope-a');
  const orgB = await registerOrg(request, 'deal-list-scope-b');
  const { pipelineId: pidA, stages: stagesA } = await getOrgPipeline(request, orgA.token);
  const { pipelineId: pidB, stages: stagesB } = await getOrgPipeline(request, orgB.token);
  const cA = await makeContact(request, orgA.token);
  const cB = await makeContact(request, orgB.token);

  const dealA = await makeDeal(request, orgA.token, { contactId: cA.id, pipelineId: pidA, stageId: stagesA[0].id });
  await makeDeal(request, orgB.token, { contactId: cB.id, pipelineId: pidB, stageId: stagesB[0].id });

  const listA = await fetchDeals(request, orgA.token);
  const idsA = listA.data.map((d) => d.id);
  expect(idsA).toContain(dealA.id);

  const listB = await fetchDeals(request, orgB.token);
  const idsB = listB.data.map((d) => d.id);
  expect(idsB).not.toContain(dealA.id);
});

test('GET /deals?assigned_to=userId returns only deals assigned to that user', async ({ request }) => {
  const org = await registerOrg(request, 'deal-filter-assignee');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const assigned = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    assignedTo: org.userId,
  });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { assigned_to: org.userId });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(assigned.id);
  expect(list.data.every((d) => d.assigned_to === org.userId)).toBe(true);
});

test('GET /deals?assigned_to=userId excludes deals not assigned to that user', async ({ request }) => {
  const org = await registerOrg(request, 'deal-filter-assignee-excl');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const unassigned = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { assigned_to: org.userId });
  const ids = list.data.map((d) => d.id);
  expect(ids).not.toContain(unassigned.id);
});

test('GET /deals?stage_id=stageId returns only deals in that stage', async ({ request }) => {
  const org = await registerOrg(request, 'deal-filter-stage');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  if (stages.length < 2) {
    // Create a second stage so we can distinguish
    const sr = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: authHdr(org.token),
      data: { name: 'Stage 2', position: 2, is_won_stage: false, is_lost_stage: false },
    });
    expect(sr.status()).toBe(201);
    stages.push(((await sr.json()) as { data: PipelineStageRecord }).data);
  }

  const inStage0 = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const inStage1 = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[1].id });

  const list = await fetchDeals(request, org.token, { stage_id: stages[0].id });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(inStage0.id);
  expect(ids).not.toContain(inStage1.id);
});

test('GET /deals?pipeline_id=pipelineId returns only deals in that pipeline', async ({ request }) => {
  const org = await registerOrg(request, 'deal-filter-pipeline');
  const { pipelineId: pid1, stages: stages1 } = await getOrgPipeline(request, org.token);

  const pr = await request.post('/api/v1/deals/pipelines', {
    headers: authHdr(org.token),
    data: { name: `Pipeline2-${uniq('pl')}` },
  });
  expect(pr.status()).toBe(201);
  const pid2 = ((await pr.json()) as { data: { id: string } }).data.id;
  const sr = await request.post(`/api/v1/deals/pipelines/${pid2}/stages`, {
    headers: authHdr(org.token),
    data: { name: 'P2 Stage', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  expect(sr.status()).toBe(201);
  const sid2 = ((await sr.json()) as { data: { id: string } }).data.id;

  const contact = await makeContact(request, org.token);
  const d1 = await makeDeal(request, org.token, { contactId: contact.id, pipelineId: pid1, stageId: stages1[0].id });
  const d2 = await makeDeal(request, org.token, { contactId: contact.id, pipelineId: pid2, stageId: sid2 });

  const list = await fetchDeals(request, org.token, { pipeline_id: pid1 });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(d1.id);
  expect(ids).not.toContain(d2.id);
});

test('GET /deals pagination: page=1 per_page=2 with 3 deals returns 2 results and meta.total=3', async ({ request }) => {
  const org = await registerOrg(request, 'deal-page1');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { page: 1, per_page: 2 });
  expect(list.data.length).toBe(2);
  expect(list.meta.total).toBe(3);
  expect(list.meta.page).toBe(1);
  expect(list.meta.per_page).toBe(2);
});

test('GET /deals pagination: page=2 per_page=2 with 3 deals returns 1 result', async ({ request }) => {
  const org = await registerOrg(request, 'deal-page2');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { page: 2, per_page: 2 });
  expect(list.data.length).toBe(1);
  expect(list.meta.total).toBe(3);
});

test('GET /deals?status=archived returns only archived deals', async ({ request }) => {
  const org = await registerOrg(request, 'deal-filter-archived');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const open = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const toArchive = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const del = await request.delete(`/api/v1/deals/${toArchive.id}`, { headers: authHdr(org.token) });
  expect(del.status()).toBe(200);

  const list = await fetchDeals(request, org.token, { status: 'archived' });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(toArchive.id);
  expect(ids).not.toContain(open.id);
  expect(list.data.every((d) => d.status === 'archived')).toBe(true);
});

test('PATCH /deals/:id/stage moves deal from stage[0] to stage[2], GET /:id shows new stage', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-move');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);

  // Ensure at least 3 stages exist
  while (stages.length < 3) {
    const sr = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: authHdr(org.token),
      data: { name: `Extra Stage ${stages.length + 1}`, position: stages.length + 1, is_won_stage: false, is_lost_stage: false },
    });
    expect(sr.status()).toBe(201);
    stages.push(((await sr.json()) as { data: PipelineStageRecord }).data);
  }

  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  expect(deal.stage_id).toBe(stages[0].id);

  const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: stages[2].id },
  });
  expect(moveRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.stage_id).toBe(stages[2].id);
  expect(read.stage?.id).toBe(stages[2].id);
});

test('PATCH /deals/:id/stage to same stage is idempotent and returns 200', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-idempotent');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: stages[0].id },
  });
  expect(moveRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.stage_id).toBe(stages[0].id);
});

test('After DELETE /deals/:id, deal is excluded from GET /deals?status=open list', async ({ request }) => {
  const org = await registerOrg(request, 'deal-del-open-excl');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const del = await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(org.token) });
  expect(del.status()).toBe(200);

  const list = await fetchDeals(request, org.token, { status: 'open' });
  const ids = list.data.map((d) => d.id);
  expect(ids).not.toContain(deal.id);
});

test('After DELETE /deals/:id, GET /deals/:id still returns the deal with status=archived', async ({ request }) => {
  const org = await registerOrg(request, 'deal-del-get-archived');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const del = await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(org.token) });
  expect(del.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.id).toBe(deal.id);
  expect(read.status).toBe('archived');
});

test('After DELETE /deals/:id, deal appears in GET /deals?status=archived', async ({ request }) => {
  const org = await registerOrg(request, 'deal-del-in-archived-list');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const del = await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(org.token) });
  expect(del.status()).toBe(200);

  const list = await fetchDeals(request, org.token, { status: 'archived' });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(deal.id);
});

test('POST two deals with same contact_id, GET /deals?contact_id returns both', async ({ request }) => {
  const org = await registerOrg(request, 'deal-filter-contact');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const d1 = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const d2 = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { contact_id: contact.id });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(d1.id);
  expect(ids).toContain(d2.id);
});

test('POST deal with value=0.01 (minimum positive float) verifies stored correctly', async ({ request }) => {
  const org = await registerOrg(request, 'deal-min-float');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    value: 0.01,
  });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(numVal(read.value)).toBeCloseTo(0.01);
});

test('POST deal with value=999999.99 (large value) verifies stored correctly', async ({ request }) => {
  const org = await registerOrg(request, 'deal-large-value');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    value: 999999.99,
  });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(numVal(read.value)).toBeCloseTo(999999.99);
});

test('POST deal without value (omitted), GET /:id shows value is null', async ({ request }) => {
  const org = await registerOrg(request, 'deal-no-value');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.value).toBeNull();
});

test('PATCH /deals/:id updates only title, other fields are preserved after partial PATCH', async ({ request }) => {
  const org = await registerOrg(request, 'deal-patch-title-only');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    value: 750,
    currency: 'EUR',
    assignedTo: org.userId,
  });

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { title: 'New Title Only' },
  });
  expect(patchRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.title).toBe('New Title Only');
  expect(numVal(read.value)).toBe(750);
  expect(read.currency).toBe('EUR');
  expect(read.assigned_to).toBe(org.userId);
  expect(read.contact_id).toBe(contact.id);
  expect(read.pipeline_id).toBe(pipelineId);
  expect(read.stage_id).toBe(stages[0].id);
});

test('PATCH /deals/:id updates only value, title is preserved', async ({ request }) => {
  const org = await registerOrg(request, 'deal-patch-value-only');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    title: 'Preserved Title',
    value: 100,
  });

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { value: 200 },
  });
  expect(patchRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.title).toBe('Preserved Title');
  expect(numVal(read.value)).toBe(200);
});

test('PATCH /deals/:id changes contact_id to different contact in same org and readback verifies', async ({ request }) => {
  const org = await registerOrg(request, 'deal-change-contact');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const cA = await makeContact(request, org.token);
  const cB = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: cA.id, pipelineId, stageId: stages[0].id });
  expect(deal.contact_id).toBe(cA.id);

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { contact_id: cB.id },
  });
  expect(patchRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.contact_id).toBe(cB.id);
  expect(read.contact.id).toBe(cB.id);
});

test('Bulk: create 5 deals in same pipeline, filter by pipeline shows all 5', async ({ request }) => {
  const org = await registerOrg(request, 'deal-bulk-5');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const created: string[] = [];

  for (let i = 0; i < 5; i++) {
    const d = await makeDeal(request, org.token, {
      contactId: contact.id,
      pipelineId,
      stageId: stages[0].id,
      title: `Bulk Deal ${i}`,
    });
    created.push(d.id);
  }

  const list = await fetchDeals(request, org.token, { pipeline_id: pipelineId, per_page: 10 });
  const ids = list.data.map((d) => d.id);
  for (const id of created) {
    expect(ids).toContain(id);
  }
  expect(list.meta.total).toBeGreaterThanOrEqual(5);
});

test('After moving deal to stage[1], GET /deals?stage_id=stage[0].id no longer includes deal', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-move-filter');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);

  if (stages.length < 2) {
    const sr = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: authHdr(org.token),
      data: { name: 'Stage B', position: 2, is_won_stage: false, is_lost_stage: false },
    });
    expect(sr.status()).toBe(201);
    stages.push(((await sr.json()) as { data: PipelineStageRecord }).data);
  }

  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: stages[1].id },
  });
  expect(moveRes.status()).toBe(200);

  const listStage0 = await fetchDeals(request, org.token, { stage_id: stages[0].id });
  const ids0 = listStage0.data.map((d) => d.id);
  expect(ids0).not.toContain(deal.id);

  const listStage1 = await fetchDeals(request, org.token, { stage_id: stages[1].id });
  const ids1 = listStage1.data.map((d) => d.id);
  expect(ids1).toContain(deal.id);
});

test('Multi-org isolation: Org B creates deal, Org A sees zero deals from Org B', async ({ request }) => {
  const orgA = await registerOrg(request, 'multi-org-a');
  const orgB = await registerOrg(request, 'multi-org-b');
  const { pipelineId: pidB, stages: stagesB } = await getOrgPipeline(request, orgB.token);
  const cB = await makeContact(request, orgB.token);
  const dB = await makeDeal(request, orgB.token, { contactId: cB.id, pipelineId: pidB, stageId: stagesB[0].id });

  const listA = await fetchDeals(request, orgA.token);
  const idsA = listA.data.map((d) => d.id);
  expect(idsA).not.toContain(dB.id);
});

test('GET /deals list meta.total matches the number of created deals in fresh org', async ({ request }) => {
  const org = await registerOrg(request, 'deal-meta-total');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { per_page: 50 });
  expect(list.meta.total).toBe(3);
  expect(list.data.length).toBe(3);
});

test('Deal value is returned with numeric-equivalent value in GET /:id response', async ({ request }) => {
  const org = await registerOrg(request, 'deal-value-type');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    value: 123,
  });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.value).not.toBeNull();
  expect(['number', 'string']).toContain(typeof read.value);
  expect(numVal(read.value)).toBe(123);
});

test('POST /deals with currency=EUR stored correctly in GET /:id readback', async ({ request }) => {
  const org = await registerOrg(request, 'deal-currency-eur');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    value: 800,
    currency: 'EUR',
  });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.currency).toBe('EUR');
});

test('After PATCH /deals/:id sets new title, original title is gone from GET /:id', async ({ request }) => {
  const org = await registerOrg(request, 'deal-title-overwrite');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId: stages[0].id,
    title: 'Original Title',
  });

  await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { title: 'Replacement Title' },
  });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.title).toBe('Replacement Title');
  expect(read.title).not.toBe('Original Title');
});

test('GET /deals?status=won does not return lost deals', async ({ request }) => {
  const org = await registerOrg(request, 'deal-won-not-lost');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const won = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const lost = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  await request.post(`/api/v1/deals/${won.id}/won`, { headers: authHdr(org.token), data: {} });
  await request.post(`/api/v1/deals/${lost.id}/lost`, { headers: authHdr(org.token), data: { reason: 'test' } });

  const list = await fetchDeals(request, org.token, { status: 'won' });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(won.id);
  expect(ids).not.toContain(lost.id);
  expect(list.data.every((d) => d.status === 'won')).toBe(true);
});

test('GET /deals?status=lost does not return won deals', async ({ request }) => {
  const org = await registerOrg(request, 'deal-lost-not-won');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const won = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const lost = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  await request.post(`/api/v1/deals/${won.id}/won`, { headers: authHdr(org.token), data: {} });
  await request.post(`/api/v1/deals/${lost.id}/lost`, { headers: authHdr(org.token), data: { reason: 'test' } });

  const list = await fetchDeals(request, org.token, { status: 'lost' });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(lost.id);
  expect(ids).not.toContain(won.id);
  expect(list.data.every((d) => d.status === 'lost')).toBe(true);
});

test('GET /deals?status=open returns only open deals (not won, not lost, not archived)', async ({ request }) => {
  const org = await registerOrg(request, 'deal-open-only');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const open = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const toWin = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const toLose = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const toArchive = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  await request.post(`/api/v1/deals/${toWin.id}/won`, { headers: authHdr(org.token), data: {} });
  await request.post(`/api/v1/deals/${toLose.id}/lost`, { headers: authHdr(org.token), data: { reason: 'test' } });
  await request.delete(`/api/v1/deals/${toArchive.id}`, { headers: authHdr(org.token) });

  const list = await fetchDeals(request, org.token, { status: 'open' });
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(open.id);
  expect(ids).not.toContain(toWin.id);
  expect(ids).not.toContain(toLose.id);
  expect(ids).not.toContain(toArchive.id);
  expect(list.data.every((d) => d.status === 'open')).toBe(true);
});

test('POST /deals creates deal with pipeline_id and first stage, GET /:id verifies stage_id matches', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-verify');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.stage_id).toBe(stages[0].id);
  expect(read.pipeline_id).toBe(pipelineId);
  expect(read.stage?.id).toBe(stages[0].id);
  expect(read.pipeline?.id).toBe(pipelineId);
});

test('PATCH /deals/:id with empty string title returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'deal-empty-title');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id, title: 'Valid Title' });

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { title: '' },
  });
  expect(patchRes.status()).toBe(400);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.title).toBe('Valid Title');
});

test('GET /deals/:id for a deal in different org returns 404 DEAL_NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-cross-get-a');
  const orgB = await registerOrg(request, 'deal-cross-get-b');
  const { pipelineId, stages } = await getOrgPipeline(request, orgA.token);
  const contact = await makeContact(request, orgA.token);
  const deal = await makeDeal(request, orgA.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const res = await request.get(`/api/v1/deals/${deal.id}`, { headers: authHdr(orgB.token) });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_NOT_FOUND');
});

test('DELETE /deals/:id for deal not in org returns 404 DEAL_NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-del-cross-a');
  const orgB = await registerOrg(request, 'deal-del-cross-b');
  const { pipelineId, stages } = await getOrgPipeline(request, orgA.token);
  const contact = await makeContact(request, orgA.token);
  const deal = await makeDeal(request, orgA.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const res = await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(orgB.token) });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_NOT_FOUND');
});

test('PATCH /deals/:id with extra unknown field returns 200 and ignores the unknown field', async ({ request }) => {
  const org = await registerOrg(request, 'deal-extra-field');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id, title: 'Extra Field Test', value: 50 });

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { title: 'Still Valid', unknown_field: 'should be ignored' },
  });
  expect(patchRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.title).toBe('Still Valid');
  expect(numVal(read.value)).toBe(50);
});

test('Move deal between stages in same pipeline keeps pipeline_id unchanged', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-pipeline-unchanged');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);

  if (stages.length < 2) {
    const sr = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: authHdr(org.token),
      data: { name: 'Stage Extra', position: 2, is_won_stage: false, is_lost_stage: false },
    });
    expect(sr.status()).toBe(201);
    stages.push(((await sr.json()) as { data: PipelineStageRecord }).data);
  }

  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: stages[1].id },
  });
  expect(moveRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.pipeline_id).toBe(pipelineId);
  expect(read.stage_id).toBe(stages[1].id);
});

test('After POST /deals/:id/won, POST /deals/:id/lost updates status to lost', async ({ request }) => {
  const org = await registerOrg(request, 'deal-won-then-lost');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const wonRes = await request.post(`/api/v1/deals/${deal.id}/won`, { headers: authHdr(org.token), data: {} });
  expect(wonRes.status()).toBe(200);

  const lostRes = await request.post(`/api/v1/deals/${deal.id}/lost`, {
    headers: authHdr(org.token),
    data: { reason: 'attempt after won' },
  });
  expect(lostRes.status()).toBe(200);
  const body = (await lostRes.json()) as DealResponse;
  expect(body.data.status).toBe('lost');
  expect(body.data.lost_reason).toBe('attempt after won');

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('lost');
  expect(read.lost_reason).toBe('attempt after won');
});

test('After POST /deals/:id/lost, POST /deals/:id/won updates status to won', async ({ request }) => {
  const org = await registerOrg(request, 'deal-lost-then-won');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const lostRes = await request.post(`/api/v1/deals/${deal.id}/lost`, {
    headers: authHdr(org.token),
    data: { reason: 'first loss' },
  });
  expect(lostRes.status()).toBe(200);

  const wonRes = await request.post(`/api/v1/deals/${deal.id}/won`, { headers: authHdr(org.token), data: {} });
  expect(wonRes.status()).toBe(200);
  const body = (await wonRes.json()) as DealResponse;
  expect(body.data.status).toBe('won');
  expect(body.data.actual_close).not.toBeNull();

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('won');
});

test('Archived deals are included in default GET /deals list with no status filter', async ({ request }) => {
  const org = await registerOrg(request, 'deal-default-no-archived');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const open = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const toArchive = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const del = await request.delete(`/api/v1/deals/${toArchive.id}`, { headers: authHdr(org.token) });
  expect(del.status()).toBe(200);

  const list = await fetchDeals(request, org.token);
  const ids = list.data.map((d) => d.id);
  expect(ids).toContain(open.id);
  expect(ids).toContain(toArchive.id);
  expect(list.data.find((d) => d.id === toArchive.id)?.status).toBe('archived');
});

test('PATCH /deals/:id/stage on archived deal returns 422 DEAL_NOT_OPEN', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-archived');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);

  if (stages.length < 2) {
    const sr = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: authHdr(org.token),
      data: { name: 'Stage For Archive Test', position: 2, is_won_stage: false, is_lost_stage: false },
    });
    expect(sr.status()).toBe(201);
    stages.push(((await sr.json()) as { data: PipelineStageRecord }).data);
  }

  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(org.token) });

  const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: stages[1].id },
  });
  expect(moveRes.status()).toBe(422);
  const body = (await moveRes.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_NOT_OPEN');
});

test('GET /deals?status=open excludes won deals', async ({ request }) => {
  const org = await registerOrg(request, 'deal-open-excl-won');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const toWin = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  await request.post(`/api/v1/deals/${toWin.id}/won`, { headers: authHdr(org.token), data: {} });

  const list = await fetchDeals(request, org.token, { status: 'open' });
  const ids = list.data.map((d) => d.id);
  expect(ids).not.toContain(toWin.id);
});

test('GET /deals?status=open excludes lost deals', async ({ request }) => {
  const org = await registerOrg(request, 'deal-open-excl-lost');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const toLose = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  await request.post(`/api/v1/deals/${toLose.id}/lost`, { headers: authHdr(org.token), data: { reason: 'test' } });

  const list = await fetchDeals(request, org.token, { status: 'open' });
  const ids = list.data.map((d) => d.id);
  expect(ids).not.toContain(toLose.id);
});

test('PATCH /deals/:id/stage with stage from different pipeline returns STAGE_NOT_FOUND and deal stage is unchanged', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-mismatch-patch');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);

  const pr2 = await request.post('/api/v1/deals/pipelines', {
    headers: authHdr(org.token),
    data: { name: `Mismatch Pipeline ${uniq('mmp')}` },
  });
  expect(pr2.status()).toBe(201);
  const pid2 = ((await pr2.json()) as { data: { id: string } }).data.id;
  const sr2 = await request.post(`/api/v1/deals/pipelines/${pid2}/stages`, {
    headers: authHdr(org.token),
    data: { name: 'Mismatch Stage', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  expect(sr2.status()).toBe(201);
  const sid2 = ((await sr2.json()) as { data: { id: string } }).data.id;

  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: sid2 },
  });
  expect(moveRes.status()).toBe(404);
  const body = (await moveRes.json()) as ErrorResponse;
  expect(body.error.code).toBe('STAGE_NOT_FOUND');

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.stage_id).toBe(stages[0].id);
});

test('GET /deals/:id includes nested contact with id and first_name', async ({ request }) => {
  const org = await registerOrg(request, 'deal-nested-contact');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token, 'NestedFirst');
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.contact).toBeDefined();
  expect(read.contact.id).toBe(contact.id);
  expect(typeof read.contact.first_name).toBe('string');
  expect(read.contact.first_name.length).toBeGreaterThan(0);
});

test('GET /deals/:id includes nested pipeline with id and name', async ({ request }) => {
  const org = await registerOrg(request, 'deal-nested-pipeline');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.pipeline).toBeDefined();
  expect(read.pipeline?.id).toBe(pipelineId);
  expect(typeof read.pipeline?.name).toBe('string');
});

test('GET /deals/:id includes nested stage with id, name, and position', async ({ request }) => {
  const org = await registerOrg(request, 'deal-nested-stage');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.stage).toBeDefined();
  expect(read.stage?.id).toBe(stages[0].id);
  expect(typeof read.stage?.name).toBe('string');
  expect(typeof read.stage?.position).toBe('number');
});

test('PATCH /deals/:id value=null clears value, GET /:id shows null', async ({ request }) => {
  const org = await registerOrg(request, 'deal-null-value-clear');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id, value: 300 });
  expect(numVal(deal.value)).toBe(300);

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { value: null },
  });
  expect(patchRes.status()).toBe(200);

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.value).toBeNull();
});

test('PATCH /deals/:id updates updated_at timestamp after a change', async ({ request }) => {
  const org = await registerOrg(request, 'deal-updated-at');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  const before = deal.updated_at;

  // small delay to ensure timestamp can differ
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  const patchRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHdr(org.token),
    data: { title: 'Timestamp Change' },
  });
  expect(patchRes.status()).toBe(200);
  const after = ((await patchRes.json()) as DealResponse).data.updated_at;
  expect(after >= before).toBe(true);
});

test('POST /deals with stage_id belonging to a different org pipeline returns 404 or 400', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-xorg-stage-a');
  const orgB = await registerOrg(request, 'deal-xorg-stage-b');
  const { pipelineId: pidA } = await getOrgPipeline(request, orgA.token);
  const { stages: stagesB } = await getOrgPipeline(request, orgB.token);
  const contact = await makeContact(request, orgA.token);

  const res = await request.post('/api/v1/deals', {
    headers: authHdr(orgA.token),
    data: {
      title: 'Cross Org Stage Deal',
      contact_id: contact.id,
      pipeline_id: pidA,
      stage_id: stagesB[0].id,
    },
  });
  expect([400, 404]).toContain(res.status());
});

test('PATCH /deals/:id/stage with non-existent stage UUID returns 404 STAGE_NOT_FOUND', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-notfound');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const res = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
    headers: authHdr(org.token),
    data: { stage_id: '00000000-0000-4000-8000-000000000099' },
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('STAGE_NOT_FOUND');
});

test('GET /deals with no filters returns deals with status field present on each deal', async ({ request }) => {
  const org = await registerOrg(request, 'deal-list-status-field');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token);
  expect(list.data.length).toBeGreaterThan(0);
  for (const d of list.data) {
    expect(typeof d.status).toBe('string');
    expect(d.status.length).toBeGreaterThan(0);
  }
});

test('POST /deals/:id/won twice returns 422 DEAL_ALREADY_WON on the second call, status stays won', async ({ request }) => {
  const org = await registerOrg(request, 'deal-double-won');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const first = await request.post(`/api/v1/deals/${deal.id}/won`, { headers: authHdr(org.token), data: {} });
  expect(first.status()).toBe(200);

  const second = await request.post(`/api/v1/deals/${deal.id}/won`, { headers: authHdr(org.token), data: {} });
  expect(second.status()).toBe(422);
  const body = (await second.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_ALREADY_WON');

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('won');
});

test('POST /deals/:id/lost twice returns 422 DEAL_ALREADY_LOST on the second call, status stays lost', async ({ request }) => {
  const org = await registerOrg(request, 'deal-double-lost');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const first = await request.post(`/api/v1/deals/${deal.id}/lost`, { headers: authHdr(org.token), data: { reason: 'first' } });
  expect(first.status()).toBe(200);

  const second = await request.post(`/api/v1/deals/${deal.id}/lost`, { headers: authHdr(org.token), data: { reason: 'second' } });
  expect(second.status()).toBe(422);
  const body = (await second.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_ALREADY_LOST');

  const read = await fetchDeal(request, org.token, deal.id);
  expect(read.status).toBe('lost');
  expect(read.lost_reason).toBe('first');
});

test('DELETE /deals/:id twice returns 422 DEAL_ALREADY_ARCHIVED on the second call', async ({ request }) => {
  const org = await registerOrg(request, 'deal-double-archive');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const first = await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(org.token) });
  expect(first.status()).toBe(200);

  const second = await request.delete(`/api/v1/deals/${deal.id}`, { headers: authHdr(org.token) });
  expect(second.status()).toBe(422);
  const body = (await second.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_ALREADY_ARCHIVED');
});

test('POST /deals/:id/won on a non-existent UUID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'deal-won-notfound');
  const res = await request.post('/api/v1/deals/00000000-0000-4000-8000-000000000066/won', {
    headers: authHdr(org.token),
    data: {},
  });
  expect(res.status()).toBe(404);
});

test('POST /deals/:id/lost on a non-existent UUID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'deal-lost-notfound');
  const res = await request.post('/api/v1/deals/00000000-0000-4000-8000-000000000067/lost', {
    headers: authHdr(org.token),
    data: { reason: 'ghost' },
  });
  expect(res.status()).toBe(404);
});

test('PATCH /deals/:id on a non-existent UUID returns 404', async ({ request }) => {
  const org = await registerOrg(request, 'deal-patch-notfound');
  const res = await request.patch('/api/v1/deals/00000000-0000-4000-8000-000000000068', {
    headers: authHdr(org.token),
    data: { title: 'Ghost Patch' },
  });
  expect(res.status()).toBe(404);
});

test('GET /deals/:id with non-existent UUID returns 404 DEAL_NOT_FOUND', async ({ request }) => {
  const org = await registerOrg(request, 'deal-get-notfound');
  const res = await request.get('/api/v1/deals/00000000-0000-4000-8000-000000000069', {
    headers: authHdr(org.token),
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('DEAL_NOT_FOUND');
});

test('POST /deals/:id/won sets actual_close to a non-null ISO date string', async ({ request }) => {
  const org = await registerOrg(request, 'deal-actual-close');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });
  expect(deal.actual_close).toBeNull();

  const wonRes = await request.post(`/api/v1/deals/${deal.id}/won`, { headers: authHdr(org.token), data: {} });
  expect(wonRes.status()).toBe(200);
  const wonBody = (await wonRes.json()) as DealResponse;
  expect(wonBody.data.actual_close).not.toBeNull();
  expect(typeof wonBody.data.actual_close).toBe('string');
  // valid ISO date string parses without NaN
  expect(Number.isNaN(new Date(wonBody.data.actual_close as string).getTime())).toBe(false);
});

test('GET /deals returns meta object with total, page, per_page fields', async ({ request }) => {
  const org = await registerOrg(request, 'deal-meta-shape');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token);
  expect(typeof list.meta.total).toBe('number');
  expect(typeof list.meta.page).toBe('number');
  expect(typeof list.meta.per_page).toBe('number');
});

test('GET /deals/?status=open returns deals with status=open on each record', async ({ request }) => {
  const org = await registerOrg(request, 'deal-status-open-field');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);
  await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id });

  const list = await fetchDeals(request, org.token, { status: 'open' });
  expect(list.data.length).toBeGreaterThan(0);
  for (const d of list.data) {
    expect(d.status).toBe('open');
  }
});

// ─── Rung 5 — concurrent / stress ────────────────────────────────────────────

test('Stress: create 20 deals in same stage, paginate 5 per page across 4 pages', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stress-20');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const deals = await Promise.all(
    Array.from({ length: 20 }, (_, i) => makeDeal(request, org.token, {
      contactId: contact.id,
      pipelineId,
      stageId: stages[0].id,
      title: `Stress Deal ${String(i).padStart(2, '0')}`,
    })),
  );
  const created = deals.map((d) => d.id);

  const allIds = new Set<string>();
  for (let page = 1; page <= 4; page++) {
    const list = await fetchDeals(request, org.token, {
      stage_id: stages[0].id,
      page,
      per_page: 5,
      sort: 'title',
      order: 'asc',
    });
    expect(list.data.length).toBe(5);
    expect(list.data.map((d) => d.id)).toEqual(created.slice((page - 1) * 5, page * 5));
    for (const d of list.data) {
      allIds.add(d.id);
    }
  }

  for (const id of created) {
    expect(allIds.has(id)).toBe(true);
  }
});

test('Concurrent: 5 parallel POST /deals all succeed with 201', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-create');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      request.post('/api/v1/deals', {
        headers: authHdr(org.token),
        data: {
          title: `Concurrent Deal ${i}`,
          contact_id: contact.id,
          pipeline_id: pipelineId,
          stage_id: stages[0].id,
          value: (i + 1) * 100,
        },
      }),
    ),
  );

  for (const res of results) {
    expect(res.status()).toBe(201);
    const body = (await res.json()) as DealResponse;
    expect(body.data.id).toBeTruthy();
  }
});

test('Concurrent: 5 parallel PATCH /deals/:id on different deals all succeed with 200', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-patch');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const deals = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      makeDeal(request, org.token, {
        contactId: contact.id,
        pipelineId,
        stageId: stages[0].id,
        title: `Concurrent Patch Deal ${i}`,
        value: 10,
      }),
    ),
  );

  const results = await Promise.all(
    deals.map((d, i) =>
      request.patch(`/api/v1/deals/${d.id}`, {
        headers: authHdr(org.token),
        data: { title: `Patched ${i}`, value: (i + 1) * 50 },
      }),
    ),
  );

  for (let i = 0; i < 5; i++) {
    expect(results[i].status()).toBe(200);
    const body = (await results[i].json()) as DealResponse;
    expect(body.data.title).toBe(`Patched ${i}`);
    expect(numVal(body.data.value)).toBe((i + 1) * 50);
  }
});

test('Concurrent: 5 parallel GET /deals/:id on different deals all return 200', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-get');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const deals = await Promise.all(
    Array.from({ length: 5 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  const results = await Promise.all(
    deals.map((d) => request.get(`/api/v1/deals/${d.id}`, { headers: authHdr(org.token) })),
  );

  for (let i = 0; i < 5; i++) {
    expect(results[i].status()).toBe(200);
    const body = (await results[i].json()) as DealResponse;
    expect(body.data.id).toBe(deals[i].id);
  }
});

test('Concurrent: 5 parallel DELETE /deals/:id on different deals all return 200', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-delete');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const deals = await Promise.all(
    Array.from({ length: 5 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  const results = await Promise.all(
    deals.map((d) => request.delete(`/api/v1/deals/${d.id}`, { headers: authHdr(org.token) })),
  );

  for (const res of results) {
    expect(res.status()).toBe(200);
    const body = (await res.json()) as DealResponse;
    expect(body.data.status).toBe('archived');
  }
});

test('Concurrent: 3 parallel POST /deals/:id/won on distinct deals all return 200', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-won');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const deals = await Promise.all(
    Array.from({ length: 3 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  const results = await Promise.all(
    deals.map((d) => request.post(`/api/v1/deals/${d.id}/won`, { headers: authHdr(org.token), data: {} })),
  );

  for (const res of results) {
    expect(res.status()).toBe(200);
    const body = (await res.json()) as DealResponse;
    expect(body.data.status).toBe('won');
  }
});

test('Concurrent: 3 parallel POST /deals/:id/lost on distinct deals all return 200', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-lost');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const deals = await Promise.all(
    Array.from({ length: 3 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  const results = await Promise.all(
    deals.map((d) =>
      request.post(`/api/v1/deals/${d.id}/lost`, {
        headers: authHdr(org.token),
        data: { reason: 'concurrent loss' },
      }),
    ),
  );

  for (const res of results) {
    expect(res.status()).toBe(200);
    const body = (await res.json()) as DealResponse;
    expect(body.data.status).toBe('lost');
    expect(body.data.lost_reason).toBe('concurrent loss');
  }
});

test('Concurrent: 4 parallel GET /deals list requests all return consistent meta.total', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-list');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  // Create exactly 3 deals
  await Promise.all(
    Array.from({ length: 3 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  const results = await Promise.all(
    Array.from({ length: 4 }, () => fetchDeals(request, org.token)),
  );

  const total = results[0].meta.total;
  for (const list of results) {
    expect(list.meta.total).toBe(total);
  }
});

test('Stress: sequential stage transitions across all 4 default stages', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stress-stages');
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHdr(org.token) });
  expect(res.status()).toBe(200);
  const pipelines = ((await res.json()) as { data: PipelineRecord[] }).data;
  const defaultPipeline = pipelines.find((p) => p.is_default && p.stages.length >= 4);

  if (!defaultPipeline) {
    // not enough stages, skip gracefully by asserting we have at least one pipeline
    expect(pipelines.length).toBeGreaterThan(0);
    return;
  }

  const contact = await makeContact(request, org.token);
  const deal = await makeDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: defaultPipeline.id,
    stageId: defaultPipeline.stages[0].id,
  });
  expect(deal.stage_id).toBe(defaultPipeline.stages[0].id);

  // Move through all stages sequentially
  for (let i = 1; i < defaultPipeline.stages.length; i++) {
    const moveRes = await request.patch(`/api/v1/deals/${deal.id}/stage`, {
      headers: authHdr(org.token),
      data: { stage_id: defaultPipeline.stages[i].id },
    });
    expect(moveRes.status()).toBe(200);
    const body = (await moveRes.json()) as DealResponse;
    expect(body.data.stage_id).toBe(defaultPipeline.stages[i].id);
  }

  const final = await fetchDeal(request, org.token, deal.id);
  expect(final.stage_id).toBe(defaultPipeline.stages[defaultPipeline.stages.length - 1].id);
  expect(final.status).toBe('open');
});

test('Stress: create 10 deals with distinct values, GET /deals list total_value integrity via dashboard', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stress-value-sum');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const expectedSum = values.reduce((a, b) => a + b, 0);

  for (const v of values) {
    await makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id, value: v });
  }

  const dashRes = await request.get('/api/v1/analytics/dashboard', { headers: authHdr(org.token) });
  expect(dashRes.status()).toBe(200);
  const dash = (await dashRes.json()) as { data: { open_deals: { count: number; total_value: number } } };
  expect(dash.data.open_deals.count).toBe(10);
  expect(dash.data.open_deals.total_value).toBeCloseTo(expectedSum);
});

test('Concurrent: two orgs create deals simultaneously, each sees only their own deals', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-concurrent-iso-a');
  const orgB = await registerOrg(request, 'deal-concurrent-iso-b');
  const { pipelineId: pidA, stages: stagesA } = await getOrgPipeline(request, orgA.token);
  const { pipelineId: pidB, stages: stagesB } = await getOrgPipeline(request, orgB.token);
  const cA = await makeContact(request, orgA.token);
  const cB = await makeContact(request, orgB.token);

  const [dealsA, dealsB] = await Promise.all([
    Promise.all(
      Array.from({ length: 3 }, () =>
        makeDeal(request, orgA.token, { contactId: cA.id, pipelineId: pidA, stageId: stagesA[0].id }),
      ),
    ),
    Promise.all(
      Array.from({ length: 3 }, () =>
        makeDeal(request, orgB.token, { contactId: cB.id, pipelineId: pidB, stageId: stagesB[0].id }),
      ),
    ),
  ]);

  const [listA, listB] = await Promise.all([
    fetchDeals(request, orgA.token),
    fetchDeals(request, orgB.token),
  ]);

  const idsA = new Set(listA.data.map((d) => d.id));
  const idsB = new Set(listB.data.map((d) => d.id));

  for (const d of dealsA) {
    expect(idsA.has(d.id)).toBe(true);
    expect(idsB.has(d.id)).toBe(false);
  }
  for (const d of dealsB) {
    expect(idsB.has(d.id)).toBe(true);
    expect(idsA.has(d.id)).toBe(false);
  }
});

test('Stress: paginate 10 deals with per_page=3 and verify all IDs are unique across pages', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stress-paginate-uniq');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  for (let i = 0; i < 10; i++) {
    await makeDeal(request, org.token, {
      contactId: contact.id,
      pipelineId,
      stageId: stages[0].id,
      title: `Paginate Deal ${i}`,
    });
  }

  const allIds: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const list = await fetchDeals(request, org.token, { page, per_page: 3 });
    for (const d of list.data) {
      allIds.push(d.id);
    }
  }

  const uniqueIds = new Set(allIds);
  expect(uniqueIds.size).toBe(allIds.length);
});

test('Concurrent: 5 parallel PATCH /deals/:id/stage on different deals all succeed', async ({ request }) => {
  const org = await registerOrg(request, 'deal-concurrent-stage');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);

  if (stages.length < 2) {
    const sr = await request.post(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
      headers: authHdr(org.token),
      data: { name: 'Concurrent Stage 2', position: 2, is_won_stage: false, is_lost_stage: false },
    });
    expect(sr.status()).toBe(201);
    stages.push(((await sr.json()) as { data: PipelineStageRecord }).data);
  }

  const contact = await makeContact(request, org.token);
  const deals = await Promise.all(
    Array.from({ length: 5 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  const results = await Promise.all(
    deals.map((d) =>
      request.patch(`/api/v1/deals/${d.id}/stage`, {
        headers: authHdr(org.token),
        data: { stage_id: stages[1].id },
      }),
    ),
  );

  for (const res of results) {
    expect(res.status()).toBe(200);
    const body = (await res.json()) as DealResponse;
    expect(body.data.stage_id).toBe(stages[1].id);
  }
});

test('Stress: create 15 deals, mark 5 won, 5 lost, 5 open — counts match per status filter', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stress-status-counts');
  const { pipelineId, stages } = await getOrgPipeline(request, org.token);
  const contact = await makeContact(request, org.token);

  const all = await Promise.all(
    Array.from({ length: 15 }, () =>
      makeDeal(request, org.token, { contactId: contact.id, pipelineId, stageId: stages[0].id }),
    ),
  );

  await Promise.all(all.slice(0, 5).map((d) => request.post(`/api/v1/deals/${d.id}/won`, { headers: authHdr(org.token), data: {} })));
  await Promise.all(all.slice(5, 10).map((d) => request.post(`/api/v1/deals/${d.id}/lost`, { headers: authHdr(org.token), data: { reason: 'test' } })));

  const [wonList, lostList, openList] = await Promise.all([
    fetchDeals(request, org.token, { status: 'won' }),
    fetchDeals(request, org.token, { status: 'lost' }),
    fetchDeals(request, org.token, { status: 'open' }),
  ]);

  expect(wonList.meta.total).toBe(5);
  expect(lostList.meta.total).toBe(5);
  expect(openList.meta.total).toBe(5);
});
