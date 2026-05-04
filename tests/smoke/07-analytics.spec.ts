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
