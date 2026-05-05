import { test, expect } from '@playwright/test';
import { getAuth } from './helpers/auth';

test('GET /api/v1/analytics/funnel returns funnel data', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/funnel', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    stages: expect.any(Array),
    summary: expect.any(Object),
  });
});

test('GET /api/v1/analytics/revenue returns revenue data', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/revenue', {
    headers: { Authorization: `Bearer ${token}` },
    params: { period: 'month' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    periods: expect.any(Array),
    summary: expect.any(Object),
  });
});

test('GET /api/v1/analytics/team-activity returns per-user activity', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/team-activity', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/analytics/rep-performance returns per-rep deal metrics', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/rep-performance', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/analytics/lead-sources returns grouped lead source counts', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/lead-sources', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/analytics/win-loss returns won/lost breakdown', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/win-loss', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    won: { count: expect.any(Number), total_value: expect.any(Number) },
    lost: { count: expect.any(Number), total_value: expect.any(Number) },
    reasons: expect.any(Array),
  });
});

test('GET /api/v1/analytics/dashboard returns home screen aggregates', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    open_deals: {
      count: expect.any(Number),
      total_value: expect.any(Number),
    },
    tasks_due_today: expect.any(Number),
    recent_activity: expect.any(Array),
    pipeline_health_score: expect.any(Number),
  });
  // recent_activity must be at most 5 items
  expect(body.data.recent_activity.length).toBeLessThanOrEqual(5);
  // pipeline_health_score must be >= 0 and <= 100
  expect(body.data.pipeline_health_score).toBeGreaterThanOrEqual(0);
  expect(body.data.pipeline_health_score).toBeLessThanOrEqual(100);
});

test('pipeline_health_score is 0 when org has no won, lost, or stalled deals (zero-guard)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `phs-zero-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'PHS Zero User',
      org_name: 'PHS Zero Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.pipeline_health_score).toBe(0);
});

test('pipeline_health_score increases from 0 to non-zero after a deal is moved to won status', { timeout: 30000 }, async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `phs-recalc-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'PHS Recalc User',
      org_name: 'PHS Recalc Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  const pipelines = (await pipelinesRes.json()).data;
  const pipeline = (pipelines as { is_default: boolean; id: string; stages: { id: string }[] }[]).find(
    (p) => p.is_default,
  ) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { first_name: 'PHSReCalc' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: {
      title: 'PHS Retest Deal',
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      value: 5000,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const before = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect((await before.json()).data.pipeline_health_score).toBe(0);

  const wonRes = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const after = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(after.status()).toBe(200);
  expect((await after.json()).data.pipeline_health_score).toBeGreaterThan(0);
});

test('dashboard recent_activity is capped at exactly 5 items when pool contains more than 5', { timeout: 30000 }, async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `phs-activity-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Activity Cap User',
      org_name: 'Activity Cap Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { first_name: 'ActivityCapTest' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  for (let i = 0; i < 3; i++) {
    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${freshToken}` },
      data: { contact_id: contactId, body: `Cap test message ${i}` },
    });
  }

  for (let i = 0; i < 3; i++) {
    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${freshToken}` },
      data: { title: `Cap test task ${i}`, assigned_to: userId, contact_id: contactId },
    });
  }

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.recent_activity).toHaveLength(5);
});
