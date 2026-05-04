import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

let contactId: string;
let pipelineId: string;
let stageId: string;

test.beforeAll(async ({ request }) => {
  const { token } = getAuth();

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'DealContact' },
  });
  contactId = (await contactRes.json()).data.id;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pipelines = (await pipelinesRes.json()).data;
  const defaultPipeline = pipelines.find((p: any) => p.is_default) ?? pipelines[0];
  pipelineId = defaultPipeline.id;

  const stagesRes = await request.get(`/api/v1/deals/pipelines/${pipelineId}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  stageId = (await stagesRes.json()).data[0].id;
});

test('GET /api/v1/deals returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/deals creates deal', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Smoke Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 5000 },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.title).toBe('Smoke Deal');
});

test('GET /api/v1/deals/:id returns deal with pipeline+stage', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Detail Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.get(`/api/v1/deals/${deal.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.id).toBe(deal.id);
});

test('PATCH /api/v1/deals/:id updates deal', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Update Me', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Updated Deal' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.title).toBe('Updated Deal');
});

test('PATCH /api/v1/deals/:id/won marks deal won', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Win Me', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.post(`/api/v1/deals/${deal.id}/won`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('won');
});

test('PATCH /api/v1/deals/:id/lost marks deal lost', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Lose Me', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  const { data: deal } = await create.json();

  const res = await request.post(`/api/v1/deals/${deal.id}/lost`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { reason: 'Price too high' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('lost');
});
