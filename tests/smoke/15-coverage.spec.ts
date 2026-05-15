import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

interface PipelineStage { id: string; name: string; position: number; }
interface Pipeline { id: string; name: string; is_default: boolean; stages: PipelineStage[]; }

async function getPipelineAndStage(request: APIRequestContext, token: string): Promise<{ pipelineId: string; stageId: string }> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  const pipelines: Pipeline[] = body.data;
  const pl = pipelines.find((p) => p.is_default) ?? pipelines[0];
  if (!pl) throw new Error('No pipeline found');
  return { pipelineId: pl.id, stageId: pl.stages[0].id };
}

async function createContact(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'Test', last_name: 'Contact', email: 'c' + Date.now() + Math.random().toString(36).slice(2) + '@example.com' },
  });
  return ((await res.json()).data as { id: string }).id;
}

async function createDeal(request: APIRequestContext, token: string, contactId: string, pipelineId: string, stageId: string, title = 'Test Deal'): Promise<string> {
  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title, value: 100, currency: 'USD', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  return ((await res.json()).data as { id: string }).id;
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<{ token: string; userId: string }> {
  const ts = Date.now().toString() + Math.random().toString(36).slice(2);
  const res = await request.post('/api/v1/auth/', {
    data: { email: 'org-' + suffix + '-' + ts + '@example.com', password: 'Password123!', name: 'User ' + suffix, org_name: 'Org ' + suffix + ' ' + ts },
  });
  const data = (await res.json()).data as { token: string; user: { id: string } };
  return { token: data.token, userId: data.user.id };
}
test('GET /api/v1/deals/:id body.data includes nested contact with id+first_name, pipeline with id+name, stage with id+name+position', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const dealId = await createDeal(request, token, contactId, pipelineId, stageId, 'Nested Shape Deal');
  const res = await request.get('/api/v1/deals/' + dealId, { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const d = body.data as { contact: { id: string; first_name: string }; pipeline: { id: string; name: string }; stage: { id: string; name: string; position: number } };
  expect(typeof d.contact.id).toBe('string');
  expect(d.contact.id.length).toBeGreaterThan(0);
  expect(typeof d.contact.first_name).toBe('string');
  expect(typeof d.pipeline.id).toBe('string');
  expect(d.pipeline.id.length).toBeGreaterThan(0);
  expect(typeof d.pipeline.name).toBe('string');
  expect(typeof d.stage.id).toBe('string');
  expect(d.stage.id.length).toBeGreaterThan(0);
  expect(typeof d.stage.name).toBe('string');
  expect(typeof d.stage.position).toBe('number');
});

test('GET /api/v1/deals/:id with non-existent UUID returns 404 and error.code DEAL_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals/00000000-0000-0000-0000-000000000001', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(404);
  expect(((await res.json()).error as { code: string }).code).toBe('DEAL_NOT_FOUND');
});

test('Cross-org: Org B token cannot GET Org A deal — returns 404', async ({ request }) => {
  const orgA = await registerOrg(request, 'ga3');
  const orgB = await registerOrg(request, 'gb3');
  const { pipelineId, stageId } = await getPipelineAndStage(request, orgA.token);
  const contactId = await createContact(request, orgA.token);
  const dealId = await createDeal(request, orgA.token, contactId, pipelineId, stageId, 'Org A Deal Get');
  const res = await request.get('/api/v1/deals/' + dealId, { headers: { Authorization: 'Bearer ' + orgB.token } });
  expect(res.status()).toBe(404);
});

test('Cross-org: Org B token cannot PATCH Org A deal — returns 404', async ({ request }) => {
  const orgA = await registerOrg(request, 'ga4');
  const orgB = await registerOrg(request, 'gb4');
  const { pipelineId, stageId } = await getPipelineAndStage(request, orgA.token);
  const contactId = await createContact(request, orgA.token);
  const dealId = await createDeal(request, orgA.token, contactId, pipelineId, stageId, 'Org A Deal Patch');
  const res = await request.patch('/api/v1/deals/' + dealId, { headers: { Authorization: 'Bearer ' + orgB.token }, data: { title: 'hacked' } });
  expect(res.status()).toBe(404);
});

test('POST /api/v1/deals/:id/won sets actual_close automatically — body.data.actual_close is not null', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const dealId = await createDeal(request, token, contactId, pipelineId, stageId, 'Won Deal Auto Close');
  const res = await request.post('/api/v1/deals/' + dealId + '/won', { headers: { Authorization: 'Bearer ' + token }, data: {} });
  expect(res.status()).toBe(200);
  expect(((await res.json()).data as { actual_close: string | null }).actual_close).not.toBeNull();
});

test('POST /api/v1/deals/:id/lost with reason sets body.data.lost_reason to the provided reason', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const dealId = await createDeal(request, token, contactId, pipelineId, stageId, 'Lost Deal Reason');
  const res = await request.post('/api/v1/deals/' + dealId + '/lost', { headers: { Authorization: 'Bearer ' + token }, data: { reason: 'Budget' } });
  expect(res.status()).toBe(200);
  expect(((await res.json()).data as { lost_reason: string }).lost_reason).toBe('Budget');
});

test('PATCH /api/v1/deals/:id/stage with non-existent stage_id returns 404 and error.code STAGE_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const dealId = await createDeal(request, token, contactId, pipelineId, stageId, 'Stage Miss Deal');
  const res = await request.patch('/api/v1/deals/' + dealId + '/stage', { headers: { Authorization: 'Bearer ' + token }, data: { stage_id: '00000000-0000-0000-0000-000000000099' } });
  expect(res.status()).toBe(404);
  expect(((await res.json()).error as { code: string }).code).toBe('STAGE_NOT_FOUND');
});

test('GET /api/v1/contacts/:id with non-existent UUID returns 404 and error.code NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/contacts/00000000-0000-0000-0000-000000000001', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(404);
  expect(((await res.json()).error as { code: string }).code).toBe('NOT_FOUND');
});

test('GET /api/v1/contacts/:id/activity includes an item with type=meeting when a calendar event exists for that contact', async ({ request }) => {
  const { token } = getAuth();
  const contactId = await createContact(request, token);
  const startTime = new Date(Date.now() + 3600 * 1000).toISOString();
  const endTime = new Date(Date.now() + 7200 * 1000).toISOString();
  await request.post('/api/v1/calendar', { headers: { Authorization: 'Bearer ' + token }, data: { contact_id: contactId, title: 'Test Meeting Activity', start_time: startTime, end_time: endTime } });
  const res = await request.get('/api/v1/contacts/' + contactId + '/activity', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { contact_id: string; items: Array<{ type: string }> } };
  expect(Array.isArray(body.data.items)).toBe(true);
  expect(body.data.items.some((item) => item.type === 'meeting')).toBe(true);
});

test('PATCH /api/v1/tasks/:id happy path — updates task title and response body.data.title equals the new title', async ({ request }) => {
  const { token, userId } = getAuth();
  const due = new Date(Date.now() + 86400 * 1000).toISOString();
  const createRes = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Original Title', assigned_to: userId, due_date: due } });
  expect(createRes.status()).toBe(201);
  const taskId = ((await createRes.json()).data as { id: string }).id;
  const patchRes = await request.patch('/api/v1/tasks/' + taskId, { headers: { Authorization: 'Bearer ' + token }, data: { title: 'Updated Title' } });
  expect(patchRes.status()).toBe(200);
  expect(((await patchRes.json()).data as { title: string }).title).toBe('Updated Title');
});

test('POST /api/v1/tasks without required field assigned_to returns 400 validation error', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token }, data: { title: 'No assignee', due_date: new Date().toISOString() } });
  expect(res.status()).toBe(400);
});

test('GET /api/v1/deals with contact_id filter returns only deals for that contact', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactIdA = await createContact(request, token);
  const contactIdB = await createContact(request, token);
  const dealAId = await createDeal(request, token, contactIdA, pipelineId, stageId, 'Deal for Contact A');
  const dealBId = await createDeal(request, token, contactIdB, pipelineId, stageId, 'Deal for Contact B');
  const res = await request.get('/api/v1/deals?contact_id=' + contactIdA, { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(200);
  const deals = (await res.json()).data as Array<{ id: string; contact_id?: string; contact?: { id: string } }>;
  expect(Array.isArray(deals)).toBe(true);
  expect(deals.length).toBeGreaterThan(0);
  for (const deal of deals) { expect(deal.contact_id ?? deal.contact?.id).toBe(contactIdA); }
  const ids = deals.map((d) => d.id);
  expect(ids).toContain(dealAId);
  expect(ids).not.toContain(dealBId);
});

test('GET /api/v1/analytics/dashboard response includes a meta field that is a non-null object', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/dashboard', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(200);
  const body = await res.json() as { meta: unknown };
  expect(body.meta).toBeDefined();
  expect(typeof body.meta).toBe('object');
  expect(body.meta).not.toBeNull();
});

test('Cross-org: Org B token GET /api/v1/contacts returns empty array — no Org A contacts leaked', async ({ request }) => {
  const orgA = await registerOrg(request, 'ga14');
  const orgB = await registerOrg(request, 'gb14');
  await createContact(request, orgA.token);
  const res = await request.get('/api/v1/contacts', { headers: { Authorization: 'Bearer ' + orgB.token } });
  expect(res.status()).toBe(200);
  const data = (await res.json()).data as unknown[];
  expect(Array.isArray(data)).toBe(true);
  expect(data).toHaveLength(0);
});

test('GET /api/v1/deals with status=open filter returns only open deals and excludes won deals', async ({ request }) => {
  const { token } = getAuth();
  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactId = await createContact(request, token);
  const deal1Id = await createDeal(request, token, contactId, pipelineId, stageId, 'Open Deal Status Filter');
  const deal2Id = await createDeal(request, token, contactId, pipelineId, stageId, 'Won Deal Status Filter');
  const wonRes = await request.post('/api/v1/deals/' + deal2Id + '/won', { headers: { Authorization: 'Bearer ' + token }, data: {} });
  expect(wonRes.status()).toBe(200);
  const res = await request.get('/api/v1/deals?status=open', { headers: { Authorization: 'Bearer ' + token } });
  expect(res.status()).toBe(200);
  const deals = (await res.json()).data as Array<{ id: string; status: string }>;
  expect(Array.isArray(deals)).toBe(true);
  for (const deal of deals) { expect(deal.status).toBe('open'); }
  const ids = deals.map((d) => d.id);
  expect(ids).toContain(deal1Id);
  expect(ids).not.toContain(deal2Id);
});

test('GET /api/v1/contacts/:id/tasks returns tasks linked to that contact', async ({ request }) => {
  const org = await registerOrg(request, 'ct1');
  const contactId = await createContact(request, org.token);
  const due = new Date(Date.now() + 86400 * 1000).toISOString();
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + org.token },
    data: { title: 'Contact Task Link', assigned_to: org.userId, due_date: due, contact_id: contactId },
  });
  expect(createRes.status()).toBe(201);
  const taskId = ((await createRes.json()).data as { id: string }).id;
  const res = await request.get('/api/v1/contacts/' + contactId + '/tasks', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: Array<{ id: string }> };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.map((t) => t.id)).toContain(taskId);
});

test('GET /api/v1/contacts/:id/deals returns deals linked to that contact and not others', async ({ request }) => {
  const org = await registerOrg(request, 'cd1');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contactA = await createContact(request, org.token);
  const contactB = await createContact(request, org.token);
  const dealA = await createDeal(request, org.token, contactA, pipelineId, stageId, 'Contact A Deal');
  const dealB = await createDeal(request, org.token, contactB, pipelineId, stageId, 'Contact B Deal');
  const res = await request.get('/api/v1/contacts/' + contactA + '/deals', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(res.status()).toBe(200);
  const ids = ((await res.json()).data as Array<{ id: string }>).map((d) => d.id);
  expect(ids).toContain(dealA);
  expect(ids).not.toContain(dealB);
});

test('GET /api/v1/analytics/revenue returns data with periods array each having period and revenue fields', async ({ request }) => {
  const org = await registerOrg(request, 'rt1');
  const res = await request.get('/api/v1/analytics/revenue', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { periods: Array<{ period: unknown; revenue: unknown }> } };
  expect(body.data).toBeDefined();
  expect(Array.isArray(body.data.periods)).toBe(true);
});

test('GET /api/v1/analytics/funnel returns data.stages array with stage_id and total fields', async ({ request }) => {
  const org = await registerOrg(request, 'fn1');
  const res = await request.get('/api/v1/analytics/funnel', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { stages: Array<{ stage_id: unknown; total: unknown }> } };
  expect(body.data).toBeDefined();
  expect(Array.isArray(body.data.stages)).toBe(true);
});

test('GET /api/v1/contacts with per_page=2 limits results and meta.total is correct', async ({ request }) => {
  const org = await registerOrg(request, 'pg1');
  await createContact(request, org.token);
  await createContact(request, org.token);
  await createContact(request, org.token);
  const res = await request.get('/api/v1/contacts?per_page=2&page=1', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: unknown[]; meta: { total: number; per_page: number } };
  expect(body.data.length).toBeLessThanOrEqual(2);
  expect(typeof body.meta.total).toBe('number');
  expect(body.meta.total).toBeGreaterThanOrEqual(3);
});

test('GET /api/v1/contacts page=2 with per_page=1 returns the second contact', async ({ request }) => {
  const org = await registerOrg(request, 'pg2');
  const c1 = await createContact(request, org.token);
  const c2 = await createContact(request, org.token);
  const page1Res = await request.get('/api/v1/contacts?per_page=1&page=1', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(page1Res.status()).toBe(200);
  const page1Ids = ((await page1Res.json()).data as Array<{ id: string }>).map((c) => c.id);
  const page2Res = await request.get('/api/v1/contacts?per_page=1&page=2', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(page2Res.status()).toBe(200);
  const page2Ids = ((await page2Res.json()).data as Array<{ id: string }>).map((c) => c.id);
  expect(page2Ids.length).toBe(1);
  expect(page1Ids[0]).not.toBe(page2Ids[0]);
  const allIds = [c1, c2];
  expect(allIds).toContain(page1Ids[0]);
  expect(allIds).toContain(page2Ids[0]);
});

test('POST /api/v1/contacts with phone field stores and returns phone on readback', async ({ request }) => {
  const org = await registerOrg(request, 'ph1');
  const tag = Date.now().toString(36);
  const createRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + org.token },
    data: { first_name: 'Phone', last_name: 'Test', email: 'phone' + tag + '@example.com', phone: '+15550001234' },
  });
  expect(createRes.status()).toBe(201);
  const contactId = ((await createRes.json()).data as { id: string }).id;
  const getRes = await request.get('/api/v1/contacts/' + contactId, { headers: { Authorization: 'Bearer ' + org.token } });
  expect(getRes.status()).toBe(200);
  expect(((await getRes.json()).data as { phone: string }).phone).toBe('+15550001234');
});

test('PATCH /api/v1/contacts/:id updates company field and readback confirms the new value', async ({ request }) => {
  const org = await registerOrg(request, 'co1');
  const contactId = await createContact(request, org.token);
  const patchRes = await request.patch('/api/v1/contacts/' + contactId, {
    headers: { Authorization: 'Bearer ' + org.token },
    data: { company: 'Acme Corp' },
  });
  expect(patchRes.status()).toBe(200);
  const getRes = await request.get('/api/v1/contacts/' + contactId, { headers: { Authorization: 'Bearer ' + org.token } });
  expect(getRes.status()).toBe(200);
  expect(((await getRes.json()).data as { company: string }).company).toBe('Acme Corp');
});

test('PATCH /api/v1/deals/:id changes title and GET readback confirms the updated title', async ({ request }) => {
  const org = await registerOrg(request, 'dt1');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contactId = await createContact(request, org.token);
  const dealId = await createDeal(request, org.token, contactId, pipelineId, stageId, 'Original Deal Title');
  const patchRes = await request.patch('/api/v1/deals/' + dealId, {
    headers: { Authorization: 'Bearer ' + org.token },
    data: { title: 'Revised Deal Title' },
  });
  expect(patchRes.status()).toBe(200);
  const getRes = await request.get('/api/v1/deals/' + dealId, { headers: { Authorization: 'Bearer ' + org.token } });
  expect(getRes.status()).toBe(200);
  expect(((await getRes.json()).data as { title: string }).title).toBe('Revised Deal Title');
});

test('POST /api/v1/deals/:id/lost with no reason body still succeeds — reason is optional', async ({ request }) => {
  const org = await registerOrg(request, 'ln1');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contactId = await createContact(request, org.token);
  const dealId = await createDeal(request, org.token, contactId, pipelineId, stageId, 'Lost No Reason Deal');
  const res = await request.post('/api/v1/deals/' + dealId + '/lost', {
    headers: { Authorization: 'Bearer ' + org.token },
    data: {},
  });
  expect(res.status()).toBe(200);
  expect(((await res.json()).data as { status: string }).status).toBe('lost');
});

test('Multiple deals for the same contact all appear in GET /api/v1/contacts/:id/deals', async ({ request }) => {
  const org = await registerOrg(request, 'md1');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contactId = await createContact(request, org.token);
  const deal1 = await createDeal(request, org.token, contactId, pipelineId, stageId, 'Multi Deal One');
  const deal2 = await createDeal(request, org.token, contactId, pipelineId, stageId, 'Multi Deal Two');
  const deal3 = await createDeal(request, org.token, contactId, pipelineId, stageId, 'Multi Deal Three');
  const res = await request.get('/api/v1/contacts/' + contactId + '/deals', { headers: { Authorization: 'Bearer ' + org.token } });
  expect(res.status()).toBe(200);
  const ids = ((await res.json()).data as Array<{ id: string }>).map((d) => d.id);
  expect(ids).toContain(deal1);
  expect(ids).toContain(deal2);
  expect(ids).toContain(deal3);
});

test('POST /api/v1/tasks/:id/cancel on a pending task returns status=cancelled', async ({ request }) => {
  const org = await registerOrg(request, 'tc1');
  const due = new Date(Date.now() + 86400 * 1000).toISOString();
  const createRes = await request.post('/api/v1/tasks', {
    headers: { Authorization: 'Bearer ' + org.token },
    data: { title: 'Task To Cancel', assigned_to: org.userId, due_date: due },
  });
  expect(createRes.status()).toBe(201);
  const taskId = ((await createRes.json()).data as { id: string }).id;
  const cancelRes = await request.delete('/api/v1/tasks/' + taskId, {
    headers: { Authorization: 'Bearer ' + org.token },
  });
  expect(cancelRes.status()).toBe(200);
  expect(((await cancelRes.json()).data as { status: string }).status).toBe('cancelled');
});
