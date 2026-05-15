import { test, expect } from '@playwright/test';

test('GET /health returns 200', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: 'ok' });
});

test('GET /health response body includes timestamp field as ISO 8601 string', async ({ request }) => {
  const res = await request.get('/health');
  const body = await res.json();
  expect(typeof body.timestamp).toBe('string');
  expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('GET /health response body has exactly two keys (status and timestamp — no sensitive data leaked)', async ({ request }) => {
  const res = await request.get('/health');
  const body = await res.json();
  const keys = Object.keys(body);
  expect(keys.sort()).toEqual(['status', 'timestamp']);
});

test('GET /health returns exactly status 200 (not 201 and not 204)', async ({ request }) => {
  const res = await request.get('/health');
  const code = res.status();
  expect(code).toBe(200);
  expect(code).not.toBe(201);
  expect(code).not.toBe(204);
});

test('GET /health succeeds with no Authorization header', async ({ request }) => {
  const res = await request.get('/health', { headers: {} });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});

test('GET /health succeeds with an invalid Authorization header (public route)', async ({ request }) => {
  const res = await request.get('/health', {
    headers: { Authorization: 'Bearer totally.invalid.token' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});

test('GET /health succeeds with a malformed Bearer value (garbage bytes)', async ({ request }) => {
  const res = await request.get('/health', {
    headers: { Authorization: 'Bearer !!!not-a-jwt!!!' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});

test('GET /health response Content-Type is application/json', async ({ request }) => {
  const res = await request.get('/health');
  const ct = res.headers()['content-type'] ?? '';
  expect(ct).toContain('application/json');
});

test('GET /health body.status is exactly the lowercase string ok (not OK or Ok)', async ({ request }) => {
  const res = await request.get('/health');
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body.status).not.toBe('OK');
  expect(body.status).not.toBe('Ok');
});

test('GET /health body.timestamp is parseable as a valid Date', async ({ request }) => {
  const res = await request.get('/health');
  const body = await res.json();
  const d = new Date(body.timestamp as string);
  expect(isNaN(d.getTime())).toBe(false);
});

test('GET /health sequential invariance — three calls all return { status: ok }', async ({ request }) => {
  for (let i = 0; i < 3; i++) {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  }
});

test('GET /health timestamp advances monotonically across sequential calls', async ({ request }) => {
  const first = await request.get('/health');
  const firstBody = await first.json();
  // Small sleep not needed — network round-trip + server Date.now() ensures advance;
  // but to be safe wait one tick via a resolved promise
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const second = await request.get('/health');
  const secondBody = await second.json();
  const t1 = new Date(firstBody.timestamp as string).getTime();
  const t2 = new Date(secondBody.timestamp as string).getTime();
  expect(t2).toBeGreaterThanOrEqual(t1);
});

test('POST /health returns 404 (method not allowed — route only supports GET)', async ({ request }) => {
  const res = await request.post('/health', { data: {} });
  expect(res.status()).toBe(404);
});

// Rung 5 — concurrent stress: 5 simultaneous requests
test('GET /health concurrent stress — 5 simultaneous requests all return 200 with consistent body', async ({ request }) => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => request.get('/health'))
  );
  for (const res of results) {
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['status', 'timestamp']);
  }
});

// Rung 5 — concurrent stress: 10 simultaneous requests
test('GET /health concurrent stress — 10 simultaneous requests all return 200 with valid ISO timestamps', async ({ request }) => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => request.get('/health'))
  );
  for (const res of results) {
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    const d = new Date(body.timestamp as string);
    expect(isNaN(d.getTime())).toBe(false);
  }
  // All timestamps must be plausible (within 10 seconds of each other)
  const timestamps = await Promise.all(
    results.map(async (res) => {
      const body = await res.json();
      return new Date(body.timestamp as string).getTime();
    })
  );
  const spread = Math.max(...timestamps) - Math.min(...timestamps);
  expect(spread).toBeLessThan(10_000);
});
