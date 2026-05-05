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
