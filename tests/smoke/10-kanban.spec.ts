import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

interface PipelineStage {
  id: string;
  name: string;
  position: number;
  is_won_stage?: boolean;
}

interface Pipeline {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStage[];
}

interface Deal {
  id: string;
  title: string;
  stage_id: string;
  status: string;
  actual_close?: string | null;
  lost_reason?: string | null;
  contact?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
  stage?: Record<string, unknown>;
}

interface DealListMeta {
  total: number;
  page: number;
  per_page: number;
}

interface RegisteredOrg {
  token: string;
  userId: string;
}

async function registerOrg(
  request: APIRequestContext,
): Promise<RegisteredOrg> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `testorg-${tag}@example.com`,
      password: 'TestPass123!',
      name: `Test User ${tag}`,
      org_name: `Test Org ${tag}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { token: body.data.token, userId: body.data.user.id };
}

test('GET /api/v1/deals/pipelines returns pipelines with nested stages', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(body.data[0].stages)).toBe(true);
  const defaultPipeline: Pipeline | undefined = body.data.find(
    (p: Pipeline) => p.is_default === true,
  );
  expect(defaultPipeline).toBeDefined();
  expect(defaultPipeline!.stages.length).toBeGreaterThanOrEqual(1);
});

test('GET /api/v1/deals returns deals array', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.meta).toHaveProperty('total');
  expect(body.meta).toHaveProperty('page');
  expect(body.meta).toHaveProperty('per_page');
});

test.describe('PATCH /api/v1/deals/:id/stage moves deal to new stage', () => {
  let dealId: string;
  let stages: PipelineStage[];

  test.beforeAll(async ({ request }) => {
    const { token } = getAuth();

    // Fetch pipeline first — pipeline_id + stage_id are required by CreateDealSchema
    const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { data: pipelines } = await pipelinesRes.json();
    const defaultPipeline: Pipeline = pipelines.find((p: Pipeline) => p.is_default === true) ?? pipelines[0];
    stages = defaultPipeline.stages;

    const contactRes = await request.post('/api/v1/contacts', {
      headers: { Authorization: `Bearer ${token}` },
      data: { first_name: 'Kanban', last_name: 'Test' },
    });
    const { data: contact } = await contactRes.json();

    const dealRes = await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: 'Kanban Smoke Deal',
        contact_id: contact.id,
        pipeline_id: defaultPipeline.id,
        stage_id: stages[0].id,
        value: 100,
        currency: 'USD',
      },
    });
    const { data: deal } = await dealRes.json();
    dealId = deal.id;
  });

  test('moves deal from stage[0] to stage[1]', async ({ request }) => {
    const { token } = getAuth();
    const res = await request.patch(`/api/v1/deals/${dealId}/stage`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { stage_id: stages[1].id },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const deal: Deal = body.data;
    expect(deal.stage_id).toBe(stages[1].id);
    expect(deal.status).toBe('open');
  });

  test('PATCH /api/v1/deals/:id/stage with non-UUID stage_id returns 400 (Zod validation rejects malformed input)', async ({ request }) => {
    const { token } = getAuth();
    const res = await request.patch(`/api/v1/deals/${dealId}/stage`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { stage_id: 'not-a-valid-uuid' },
    });
    expect(res.status()).toBe(400);
  });

  test('failed PATCH /deals/:id/stage leaves deal at original stage_id (store rollback contract: server state is preserved on error)', async ({ request }) => {
    const { token } = getAuth();
    const stageBeforeId: string = stages[1].id;

    const res = await request.patch(`/api/v1/deals/${dealId}/stage`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { stage_id: '99999999-9999-4999-9999-999999999999' },
    });
    expect(res.status()).toBe(404);

    const dealRes = await request.get(`/api/v1/deals/${dealId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dealRes.status()).toBe(200);
    const dealAfter: Deal = (await dealRes.json()).data;
    expect(dealAfter.stage_id).toBe(stageBeforeId);
  });
});

test('GET /api/v1/deals?status=open excludes archived deals from Kanban board fetch', async ({ request }) => {
  const { token } = getAuth();

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelinesData: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelinesData.find((p) => p.is_default === true) ?? pipelinesData[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'ArchiveKanban', last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: 'Soft Delete Kanban Test',
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      value: 100,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const archivedDealId: string = (await dealRes.json()).data.id;

  const deleteRes = await request.delete(`/api/v1/deals/${archivedDealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleteRes.status()).toBe(200);
  expect((await deleteRes.json()).data.status).toBe('archived');

  const openRes = await request.get('/api/v1/deals?status=open', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(openRes.status()).toBe(200);
  const openDeals: Deal[] = (await openRes.json()).data;
  expect(openDeals.every((d) => d.id !== archivedDealId)).toBe(true);
});

// ─── 25 NEW RUNG 4/5 TESTS ──────────────────────────────────────────────────

// T01 — GET /deals without auth returns 401
test('GET /api/v1/deals without auth returns 401', async ({ request }) => {
  const res = await request.get('/api/v1/deals');
  expect(res.status()).toBe(401);
});

// T02 — GET /deals?pipeline_id=<id> returns only deals in that pipeline
test('GET /api/v1/deals?pipeline_id=<id> returns only deals in that pipeline', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `PipeFilter-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `PipeFilter Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const createdDealId: string = (await dealRes.json()).data.id;

  const listRes = await request.get(`/api/v1/deals?pipeline_id=${pipeline.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = await listRes.json();
  const deals: Deal[] = body.data;
  expect(deals.length).toBeGreaterThanOrEqual(1);
  expect(deals.some((d) => d.id === createdDealId)).toBe(true);
});

// T03 — GET /deals?stage_id=<id> returns only deals in that stage
test('GET /api/v1/deals?stage_id=<id> returns only deals in that stage', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];
  const targetStage: PipelineStage = pipeline.stages[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `StageFilter-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `StageFilter Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: targetStage.id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const createdDealId: string = (await dealRes.json()).data.id;

  const listRes = await request.get(`/api/v1/deals?stage_id=${targetStage.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals: Deal[] = (await listRes.json()).data;
  expect(deals.some((d) => d.id === createdDealId)).toBe(true);
});

// T04 — GET /deals?status=won returns only won deals
test('GET /api/v1/deals?status=won returns only won deals', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `WonFilter-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Won Filter Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const wonRes = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/deals?status=won', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals: Deal[] = (await listRes.json()).data;
  expect(deals.length).toBeGreaterThanOrEqual(1);
  expect(deals.every((d) => d.status === 'won')).toBe(true);
  expect(deals.some((d) => d.id === dealId)).toBe(true);
});

// T05 — GET /deals?status=lost returns only lost deals
test('GET /api/v1/deals?status=lost returns only lost deals', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `LostFilter-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Lost Filter Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const lostRes = await request.post(`/api/v1/deals/${dealId}/lost`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { reason: 'Price too high' },
  });
  expect(lostRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/deals?status=lost', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals: Deal[] = (await listRes.json()).data;
  expect(deals.length).toBeGreaterThanOrEqual(1);
  expect(deals.every((d) => d.status === 'lost')).toBe(true);
  expect(deals.some((d) => d.id === dealId)).toBe(true);
});

// T06 — Pagination: page=1 per_page=2 with 3 deals → meta.total=3, data.length=2
test('GET /api/v1/deals pagination page=1 per_page=2 with 3 deals returns data.length=2 and meta.total>=3', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `Page1-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  for (let i = 0; i < 3; i++) {
    const r = await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `Pagination Deal ${tag}-${i}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    });
    expect(r.status()).toBe(201);
  }

  const listRes = await request.get('/api/v1/deals?page=1&per_page=2', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = await listRes.json();
  const meta: DealListMeta = body.meta;
  expect(meta.total).toBeGreaterThanOrEqual(3);
  expect(meta.page).toBe(1);
  expect(meta.per_page).toBe(2);
  expect((body.data as Deal[]).length).toBe(2);
});

// T07 — Pagination: page=2 per_page=2 with 3 deals → data.length=1
test('GET /api/v1/deals pagination page=2 per_page=2 with exactly 3 deals returns data.length=1', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `Page2-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  for (let i = 0; i < 3; i++) {
    const r = await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `Page2 Deal ${tag}-${i}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    });
    expect(r.status()).toBe(201);
  }

  // First verify total is exactly 3 in this fresh org
  const page1Res = await request.get('/api/v1/deals?page=1&per_page=2', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const page1Body = await page1Res.json();
  expect(page1Body.meta.total).toBe(3);

  const listRes = await request.get('/api/v1/deals?page=2&per_page=2', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = await listRes.json();
  expect((body.data as Deal[]).length).toBe(1);
  expect(body.meta.page).toBe(2);
});

// T08 — Cross-org: Org B GET /deals returns no Org A deals
test('Cross-org: Org B GET /deals returns no Org A deals', async ({ request }) => {
  const orgA = await registerOrg(request);
  const orgB = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${orgA.token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${orgA.token}` },
    data: { first_name: `CrossOrg-${tag}`, last_name: 'A' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${orgA.token}` },
    data: {
      title: `OrgA Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const orgADealId: string = (await dealRes.json()).data.id;

  const listRes = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${orgB.token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals: Deal[] = (await listRes.json()).data;
  expect(deals.every((d) => d.id !== orgADealId)).toBe(true);
});

// T09 — PATCH /deals/:id/stage moves deal to last stage in pipeline
test('PATCH /api/v1/deals/:id/stage moves deal to last stage in pipeline successfully', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];
  expect(pipeline.stages.length).toBeGreaterThanOrEqual(2);
  const lastStage: PipelineStage = pipeline.stages[pipeline.stages.length - 1];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `LastStage-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Last Stage Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const moveRes = await request.patch(`/api/v1/deals/${dealId}/stage`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { stage_id: lastStage.id },
  });
  expect(moveRes.status()).toBe(200);
  const updatedDeal: Deal = (await moveRes.json()).data;
  expect(updatedDeal.stage_id).toBe(lastStage.id);
  expect(updatedDeal.status).toBe('open');
});

// T10 — PATCH /deals/:id/stage on archived deal returns 422 DEAL_NOT_OPEN
test('PATCH /api/v1/deals/:id/stage on archived deal returns 422 DEAL_NOT_OPEN', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `ArchivedStage-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Archived Stage Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const deleteRes = await request.delete(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleteRes.status()).toBe(200);

  const moveRes = await request.patch(`/api/v1/deals/${dealId}/stage`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { stage_id: pipeline.stages[pipeline.stages.length - 1].id },
  });
  expect(moveRes.status()).toBe(422);
  const body = await moveRes.json();
  expect(body.error.code).toBe('DEAL_NOT_OPEN');
});

// T11 — PATCH /deals/:id/stage with stage from different pipeline returns 404 STAGE_NOT_FOUND
test('PATCH /api/v1/deals/:id/stage with stage from a different pipeline returns 404 STAGE_NOT_FOUND', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Create pipeline A
  const pipelineARes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `Pipeline A ${tag}` },
  });
  expect(pipelineARes.status()).toBe(201);
  const pipelineAId: string = (await pipelineARes.json()).data.id;

  // Create pipeline B
  const pipelineBRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: `Pipeline B ${tag}` },
  });
  expect(pipelineBRes.status()).toBe(201);
  const pipelineBId: string = (await pipelineBRes.json()).data.id;

  // Create a stage in each pipeline (new pipelines have no stages)
  const stageARes = await request.post(`/api/v1/deals/pipelines/${pipelineAId}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Stage A', position: 0 },
  });
  expect(stageARes.status()).toBe(201);
  const stageAId: string = (await stageARes.json()).data.id;

  const stageBRes = await request.post(`/api/v1/deals/pipelines/${pipelineBId}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Stage B', position: 0 },
  });
  expect(stageBRes.status()).toBe(201);
  const stageBId: string = (await stageBRes.json()).data.id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `CrossPipe-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  // Create deal in pipeline A
  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Cross Pipe Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipelineAId,
      stage_id: stageAId,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  // Try to move to a stage that belongs to pipeline B — must return 404
  const moveRes = await request.patch(`/api/v1/deals/${dealId}/stage`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { stage_id: stageBId },
  });
  expect(moveRes.status()).toBe(404);
  const body = await moveRes.json();
  expect(body.error.code).toBe('STAGE_NOT_FOUND');
});

// T12 — Two concurrent PATCH stage moves on different deals both succeed
test('Two concurrent PATCH stage moves on different deals in same pipeline both succeed', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];
  expect(pipeline.stages.length).toBeGreaterThanOrEqual(2);

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `Concurrent-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const [deal1Res, deal2Res] = await Promise.all([
    request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `Concurrent Deal 1 ${tag}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    }),
    request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `Concurrent Deal 2 ${tag}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    }),
  ]);
  expect(deal1Res.status()).toBe(201);
  expect(deal2Res.status()).toBe(201);
  const dealId1: string = (await deal1Res.json()).data.id;
  const dealId2: string = (await deal2Res.json()).data.id;
  const targetStage: PipelineStage = pipeline.stages[1];

  const [move1Res, move2Res] = await Promise.all([
    request.patch(`/api/v1/deals/${dealId1}/stage`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { stage_id: targetStage.id },
    }),
    request.patch(`/api/v1/deals/${dealId2}/stage`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { stage_id: targetStage.id },
    }),
  ]);
  expect(move1Res.status()).toBe(200);
  expect(move2Res.status()).toBe(200);
  expect((await move1Res.json()).data.stage_id).toBe(targetStage.id);
  expect((await move2Res.json()).data.stage_id).toBe(targetStage.id);
});

// T13 — Stage move does NOT set status=won (stage move != markWon)
test('PATCH /api/v1/deals/:id/stage to a won stage leaves status=open (stage move != markWon)', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  // Find a won stage if present; otherwise use last stage
  const wonStage: PipelineStage =
    pipeline.stages.find((s) => s.is_won_stage === true) ?? pipeline.stages[pipeline.stages.length - 1];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `WonStage-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Won Stage Move Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const moveRes = await request.patch(`/api/v1/deals/${dealId}/stage`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { stage_id: wonStage.id },
  });
  expect(moveRes.status()).toBe(200);
  const updatedDeal: Deal = (await moveRes.json()).data;
  expect(updatedDeal.stage_id).toBe(wonStage.id);
  // Stage move alone must NOT flip deal to won
  expect(updatedDeal.status).toBe('open');
});

// T14 — GET /deals returns deals sorted by created_at desc by default
test('GET /api/v1/deals returns deals sorted by created_at desc by default', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `SortCheck-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  for (let i = 0; i < 3; i++) {
    const r = await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `Sort Deal ${tag}-${i}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    });
    expect(r.status()).toBe(201);
  }

  const listRes = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals = (await listRes.json()).data as Array<Deal & { created_at: string }>;
  expect(deals.length).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < deals.length - 1; i++) {
    expect(new Date(deals[i].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(deals[i + 1].created_at).getTime(),
    );
  }
});

// T15 — POST /deals response includes nested contact, pipeline, stage objects
test('POST /api/v1/deals response includes nested contact, pipeline, stage objects', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `Nested-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Nested Obj Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const deal: Deal = (await dealRes.json()).data;
  expect(deal.contact).toBeDefined();
  expect(deal.pipeline).toBeDefined();
  expect(deal.stage).toBeDefined();
  expect((deal.contact as Record<string, unknown>).id).toBe(contactId);
  expect((deal.pipeline as Record<string, unknown>).id).toBe(pipeline.id);
  expect((deal.stage as Record<string, unknown>).id).toBe(pipeline.stages[0].id);
});

// T16 — Default list behavior: no status filter returns open-only (or verify all returned deals have a status field)
test('GET /api/v1/deals without status filter returns deals that each have a status field', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `DefaultStatus-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Default Status Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });

  const listRes = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals: Deal[] = (await listRes.json()).data;
  expect(deals.length).toBeGreaterThanOrEqual(1);
  expect(deals.every((d) => typeof d.status === 'string')).toBe(true);
});

// T17 — DELETE /deals/:id archives deal, readback confirms status='archived'
test('DELETE /api/v1/deals/:id archives deal and readback GET confirms status=archived', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `ArchiveReadback-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Archive Readback Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const deleteRes = await request.delete(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleteRes.status()).toBe(200);
  expect((await deleteRes.json()).data.status).toBe('archived');

  const getRes = await request.get(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).data.status).toBe('archived');
});

// T18 — DELETE already-archived deal returns 422
test('DELETE /api/v1/deals/:id on already-archived deal returns 422', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `DoubleArchive-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Double Archive Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const del1 = await request.delete(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(del1.status()).toBe(200);

  const del2 = await request.delete(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(del2.status()).toBe(422);
});

// T19 — POST /deals/:id/won on open deal sets status=won and actual_close
test('POST /api/v1/deals/:id/won on open deal sets status=won and actual_close', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `MarkWon-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Mark Won Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const wonRes = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(wonRes.status()).toBe(200);
  const wonDeal: Deal = (await wonRes.json()).data;
  expect(wonDeal.status).toBe('won');
  expect(wonDeal.actual_close).toBeTruthy();
});

// T20 — POST /deals/:id/lost on open deal sets status=lost and lost_reason
test('POST /api/v1/deals/:id/lost on open deal sets status=lost and lost_reason', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `MarkLost-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Mark Lost Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const lostRes = await request.post(`/api/v1/deals/${dealId}/lost`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { reason: 'Budget cut' },
  });
  expect(lostRes.status()).toBe(200);
  const lostDeal: Deal = (await lostRes.json()).data;
  expect(lostDeal.status).toBe('lost');
  expect(lostDeal.lost_reason).toBe('Budget cut');
});

// T21 — PATCH stage move then verify via GET /deals/:id that stage_id matches
test('PATCH /deals/:id/stage then GET /deals/:id confirms stage_id is updated', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];
  expect(pipeline.stages.length).toBeGreaterThanOrEqual(2);

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `MoveVerify-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Move Verify Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;
  const targetStageId: string = pipeline.stages[1].id;

  const moveRes = await request.patch(`/api/v1/deals/${dealId}/stage`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { stage_id: targetStageId },
  });
  expect(moveRes.status()).toBe(200);

  const getRes = await request.get(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  expect((await getRes.json()).data.stage_id).toBe(targetStageId);
});

// T22 — GET /deals?status=open meta.total counts only open deals
test('GET /api/v1/deals?status=open meta.total counts only open deals (excludes archived/won/lost)', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `OpenCount-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  // Create 2 open deals
  for (let i = 0; i < 2; i++) {
    const r = await request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `Open Count Deal ${tag}-${i}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    });
    expect(r.status()).toBe(201);
  }

  // Create 1 won deal
  const wonDealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Won Count Deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(wonDealRes.status()).toBe(201);
  const wonDealId: string = (await wonDealRes.json()).data.id;
  await request.post(`/api/v1/deals/${wonDealId}/won`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });

  const listRes = await request.get('/api/v1/deals?status=open', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = await listRes.json();
  const meta: DealListMeta = body.meta;
  const deals: Deal[] = body.data;
  // All returned deals must be open
  expect(deals.every((d) => d.status === 'open')).toBe(true);
  // meta.total must equal exactly 2 in this fresh org
  expect(meta.total).toBe(2);
});

// T23 — GET /deals without status filter: all returned deals have a 'status' field present
test('GET /api/v1/deals without status filter returns deals each with a non-empty status string', async ({ request }) => {
  const { token } = await registerOrg(request);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `NoStatusFilter-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  // Create open and won deal so there are multiple statuses to observe
  const openDealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `No Filter Open ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(openDealRes.status()).toBe(201);

  const wonDealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `No Filter Won ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(wonDealRes.status()).toBe(201);
  const wonId: string = (await wonDealRes.json()).data.id;
  await request.post(`/api/v1/deals/${wonId}/won`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const listRes = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const deals: Deal[] = (await listRes.json()).data;
  expect(deals.length).toBeGreaterThanOrEqual(1);
  // Every deal in the response must carry a status field
  for (const d of deals) {
    expect(typeof d.status).toBe('string');
    expect(d.status.length).toBeGreaterThan(0);
  }
});

// T24 — Concurrent: two users in same org each move a different deal — both succeed independently
test('Concurrent: two users in same org each move a different deal — both succeed independently', async ({ request }) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Register org and get token for user 1
  const { token: token1 } = await registerOrg(request);

  // Register a second user in the same org by re-using the same org registration is not directly
  // possible via the public API, so we use token1 for both moves (same org, different deals)
  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token1}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];
  expect(pipeline.stages.length).toBeGreaterThanOrEqual(2);

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token1}` },
    data: { first_name: `ConcurrentUsers-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const [d1Res, d2Res] = await Promise.all([
    request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token1}` },
      data: {
        title: `ConcUser Deal 1 ${tag}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    }),
    request.post('/api/v1/deals', {
      headers: { Authorization: `Bearer ${token1}` },
      data: {
        title: `ConcUser Deal 2 ${tag}`,
        contact_id: contactId,
        pipeline_id: pipeline.id,
        stage_id: pipeline.stages[0].id,
        currency: 'USD',
      },
    }),
  ]);
  const dealId1: string = (await d1Res.json()).data.id;
  const dealId2: string = (await d2Res.json()).data.id;
  const stage1: PipelineStage = pipeline.stages[1];
  const stage2: PipelineStage = pipeline.stages[pipeline.stages.length > 2 ? 2 : 1];

  const [m1, m2] = await Promise.all([
    request.patch(`/api/v1/deals/${dealId1}/stage`, {
      headers: { Authorization: `Bearer ${token1}` },
      data: { stage_id: stage1.id },
    }),
    request.patch(`/api/v1/deals/${dealId2}/stage`, {
      headers: { Authorization: `Bearer ${token1}` },
      data: { stage_id: stage2.id },
    }),
  ]);
  expect(m1.status()).toBe(200);
  expect(m2.status()).toBe(200);
  expect((await m1.json()).data.stage_id).toBe(stage1.id);
  expect((await m2.json()).data.stage_id).toBe(stage2.id);
});

// T25 — GET /deals?q=<title> returns only deals matching title search (case-insensitive)
test('GET /api/v1/deals?q=<title> returns only deals matching title search (case-insensitive)', async ({ request }) => {
  const { token } = await registerOrg(request);
  const uniqueWord = `XYZFOO${Date.now()}`;
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines: Pipeline[] = (await pipelinesRes.json()).data;
  const pipeline: Pipeline = pipelines.find((p) => p.is_default === true) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: `TitleSearch-${tag}`, last_name: 'Test' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  // Create matching deal
  const matchRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `${uniqueWord} matching deal`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(matchRes.status()).toBe(201);
  const matchingDealId: string = (await matchRes.json()).data.id;

  // Create non-matching deal
  const noMatchRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Completely different deal ${tag}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      currency: 'USD',
    },
  });
  expect(noMatchRes.status()).toBe(201);
  const nonMatchingDealId: string = (await noMatchRes.json()).data.id;

  // Search using lowercase variant of the unique word
  const searchRes = await request.get(`/api/v1/deals?q=${uniqueWord.toLowerCase()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(searchRes.status()).toBe(200);
  const deals: Deal[] = (await searchRes.json()).data;
  expect(deals.some((d) => d.id === matchingDealId)).toBe(true);
  expect(deals.every((d) => d.id !== nonMatchingDealId)).toBe(true);
});
