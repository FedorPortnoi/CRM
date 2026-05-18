import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = suffix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const res = await request.post('/api/v1/auth/', {
    data: { email: unique + '@example.com', password: 'Password123!', name: 'User ' + suffix, org_name: 'Org ' + unique },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

function authHeaders(token: string) { return { Authorization: 'Bearer ' + token }; }

async function createContact(request: APIRequestContext, token: string, name: string): Promise<{ id: string }> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: name },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

interface BulkAssignResult { data: { assigned_count: number; assigned_to: string; contact_ids: string[] }; meta: Record<string, unknown> }
interface BulkTagResult { data: { tagged_count: number; contact_ids: string[]; tags: string[]; mode: string }; meta: Record<string, unknown> }
interface BulkArchiveResult { data: { archived_count: number; contact_ids: string[] }; meta: Record<string, unknown> }
interface ContactGet { data: { id: string; tags: string[] | null }; meta: Record<string, unknown> }
interface ContactList { data: Array<{ id: string }>; meta: { total: number } }

test.describe.configure({ timeout: 30000 });

// ─── Group 1: POST /contacts/bulk-assign (completely untested) ─────────────────

test('bulk-assign 36: happy path → 200 with assigned_count and contact_ids', async ({ request }) => {
  const org = await registerOrg(request, 'ba36-happy');
  const c1 = await createContact(request, org.token, 'Alice');
  const c2 = await createContact(request, org.token, 'Bob');
  const r = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c1.id, c2.id], assigned_to: org.userId },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BulkAssignResult;
  expect(body.data.assigned_count).toBe(2);
  expect(body.data.assigned_to).toBe(org.userId);
  expect(body.data.contact_ids).toHaveLength(2);
});

test('bulk-assign 36: assigned user from another org → 403 FORBIDDEN', async ({ request }) => {
  const orgA = await registerOrg(request, 'ba36-forbidden-a');
  const orgB = await registerOrg(request, 'ba36-forbidden-b');
  const c = await createContact(request, orgA.token, 'Charlie');
  const r = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(orgA.token),
    data: { contact_ids: [c.id], assigned_to: orgB.userId },
  });
  expect(r.status()).toBe(403);
  const body = await r.json() as { error: { code: string } };
  expect(body.error.code).toBe('FORBIDDEN');
});

test('bulk-assign 36: contact IDs belonging to another org → 404 NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'ba36-xcontact-a');
  const orgB = await registerOrg(request, 'ba36-xcontact-b');
  const c = await createContact(request, orgA.token, 'Dave');
  const r = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(orgB.token),
    data: { contact_ids: [c.id], assigned_to: orgB.userId },
  });
  expect(r.status()).toBe(404);
  const body = await r.json() as { error: { code: string } };
  expect(body.error.code).toBe('NOT_FOUND');
});

test('bulk-assign 36: without auth → 401', async ({ request }) => {
  const r = await request.post('/api/v1/contacts/bulk-assign', {
    data: { contact_ids: ['00000000-0000-0000-0000-000000000001'], assigned_to: '00000000-0000-0000-0000-000000000002' },
  });
  expect(r.status()).toBe(401);
});

// ─── Group 2: POST /contacts/bulk-tag (completely untested) ────────────────────

test('bulk-tag 36: append mode adds tags without removing existing ones', async ({ request }) => {
  const org = await registerOrg(request, 'bt36-append');
  const createRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'Eve', tags: ['vip'] },
  });
  expect(createRes.status()).toBe(201);
  const c = ((await createRes.json()) as { data: { id: string } }).data;

  const r = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id], tags: ['hot-lead'], mode: 'append' },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BulkTagResult;
  expect(body.data.tagged_count).toBe(1);
  expect(body.data.mode).toBe('append');

  const getRes = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const contact = ((await getRes.json()) as ContactGet).data;
  expect(contact.tags).toContain('vip');
  expect(contact.tags).toContain('hot-lead');
});

test('bulk-tag 36: replace mode replaces all existing tags', async ({ request }) => {
  const org = await registerOrg(request, 'bt36-replace');
  const createRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(org.token),
    data: { first_name: 'Frank', tags: ['old-tag', 'stale'] },
  });
  expect(createRes.status()).toBe(201);
  const c = ((await createRes.json()) as { data: { id: string } }).data;

  const r = await request.post('/api/v1/contacts/bulk-tag', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id], tags: ['new-only'], mode: 'replace' },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BulkTagResult;
  expect(body.data.mode).toBe('replace');

  const getRes = await request.get(`/api/v1/contacts/${c.id}`, { headers: authHeaders(org.token) });
  const contact = ((await getRes.json()) as ContactGet).data;
  expect(contact.tags).toEqual(['new-only']);
});

test('bulk-tag 36: without auth → 401', async ({ request }) => {
  const r = await request.post('/api/v1/contacts/bulk-tag', {
    data: { contact_ids: ['00000000-0000-0000-0000-000000000001'], tags: ['x'] },
  });
  expect(r.status()).toBe(401);
});

// ─── Group 3: POST /contacts/bulk-archive (completely untested) ────────────────

test('bulk-archive 36: happy path → 200 with archived_count 2', async ({ request }) => {
  const org = await registerOrg(request, 'ba36-arch');
  const c1 = await createContact(request, org.token, 'Greg');
  const c2 = await createContact(request, org.token, 'Hana');
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c1.id, c2.id] },
  });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as BulkArchiveResult;
  expect(body.data.archived_count).toBe(2);
  expect(body.data.contact_ids).toHaveLength(2);
});

test('bulk-archive 36: archived contacts excluded from default GET /contacts', async ({ request }) => {
  const org = await registerOrg(request, 'ba36-excluded');
  const c = await createContact(request, org.token, 'Ivan');
  await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id] },
  });
  const listRes = await request.get('/api/v1/contacts', { headers: authHeaders(org.token) });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ContactList;
  const ids = listBody.data.map(x => x.id);
  expect(ids).not.toContain(c.id);
});

test('bulk-archive 36: contact already archived → 404 NOT_FOUND on second call', async ({ request }) => {
  const org = await registerOrg(request, 'ba36-already');
  const c = await createContact(request, org.token, 'Julia');
  await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id] },
  });
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [c.id] },
  });
  expect(r.status()).toBe(404);
  const body = await r.json() as { error: { code: string } };
  expect(body.error.code).toBe('NOT_FOUND');
});

test('bulk-archive 36: contact IDs from another org → 404 NOT_FOUND', async ({ request }) => {
  const orgA = await registerOrg(request, 'ba36-xorg-a');
  const orgB = await registerOrg(request, 'ba36-xorg-b');
  const c = await createContact(request, orgA.token, 'Karl');
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(orgB.token),
    data: { contact_ids: [c.id] },
  });
  expect(r.status()).toBe(404);
});

test('bulk-archive 36: empty contact_ids array → 400 validation error', async ({ request }) => {
  const org = await registerOrg(request, 'ba36-empty');
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [] },
  });
  expect(r.status()).toBe(400);
});

test('bulk-archive 36: without auth → 401', async ({ request }) => {
  const r = await request.post('/api/v1/contacts/bulk-archive', {
    data: { contact_ids: ['00000000-0000-0000-0000-000000000001'] },
  });
  expect(r.status()).toBe(401);
});
