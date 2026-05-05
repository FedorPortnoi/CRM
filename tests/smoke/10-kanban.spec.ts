import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

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
});
