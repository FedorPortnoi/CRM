import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

type PipelineSummary = {
  id: string;
  name: string;
  is_default: boolean;
};

test('GET /api/v1/deals/pipelines returns default pipeline', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: PipelineSummary[] };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  const defaultPipeline = body.data.find((p) => p.is_default);
  if (!defaultPipeline) throw new Error('Default pipeline not found');
  expect(defaultPipeline.name).toBe('Sales Pipeline');
});

test('Default pipeline has exactly 4 stages in correct order', async ({ request }) => {
  const { token } = getAuth();
  const list = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { data: pipelines } = (await list.json()) as { data: PipelineSummary[] };
  const defaultPipeline = pipelines.find((p) => p.is_default);
  if (!defaultPipeline) throw new Error('Default pipeline not found');

  const res = await request.get(`/api/v1/deals/pipelines/${defaultPipeline.id}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(4);
  expect(body.data[0].name).toBe('Lead');
  expect(body.data[1].name).toBe('Qualified');
  expect(body.data[2].name).toBe('Proposal');
  expect(body.data[3].name).toBe('Closed Won');
  expect(body.data[3].is_won_stage).toBe(true);
});

test('POST /api/v1/deals/pipelines creates a pipeline', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Custom Pipeline', is_default: false },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.name).toBe('Custom Pipeline');
});

test('PATCH /api/v1/deals/pipelines/:id updates pipeline', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Temp Pipeline' },
  });
  const { data: pipeline } = await create.json();

  const res = await request.patch(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Renamed Pipeline' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.name).toBe('Renamed Pipeline');
});

test('POST /api/v1/deals/pipelines/:id/stages creates a stage', async ({ request }) => {
  const { token } = getAuth();
  const pipelineRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Stage Test Pipeline' },
  });
  const { data: pipeline } = await pipelineRes.json();

  const res = await request.post(`/api/v1/deals/pipelines/${pipeline.id}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'New Stage', position: 0 },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.name).toBe('New Stage');
});

test('DELETE /api/v1/deals/pipelines/:id deletes empty pipeline', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Delete Me Pipeline' },
  });
  const { data: pipeline } = await create.json();

  const res = await request.delete(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
});
