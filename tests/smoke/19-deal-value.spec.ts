import { test, expect, APIRequestContext } from '@playwright/test';

test.describe.configure({ timeout: 30000 });

type AuthOrg = {
  token: string;
  userId: string;
};

type PipelineStage = {
  id: string;
};

type Pipeline = {
  id: string;
  is_default: boolean;
  stages: PipelineStage[];
};

type ContactRecord = {
  id: string;
};

type DealRecord = {
  id: string;
  value: number | string | null;
};

type DealResponse = {
  data: DealRecord;
};

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerOrg(request: APIRequestContext): Promise<AuthOrg> {
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: uniqueEmail('deal-clear-value'),
      password: 'Test1234!',
      name: 'Deal Clear Value User',
      org_name: 'Deal Clear Value Org',
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as {
    data: { token: string; user: { id: string } };
  };
  return { token: body.data.token, userId: body.data.user.id };
}

async function getPipelineAndStage(
  request: APIRequestContext,
  token: string,
): Promise<{ pipelineId: string; stageId: string }> {
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: Pipeline[] };
  const pipeline = body.data.find((p) => p.is_default) ?? body.data[0];
  if (!pipeline || pipeline.stages.length === 0) {
    throw new Error('Default pipeline or stage not found');
  }
  return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
}

async function createContact(request: APIRequestContext, token: string): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'DealValueContact' },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: ContactRecord };
  return body.data;
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  contactId: string,
  pipelineId: string,
  stageId: string,
): Promise<DealRecord> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: {
      title: 'Clearable Value Deal',
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      value: 123,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DealResponse;
  return body.data;
}

async function getDeal(
  request: APIRequestContext,
  token: string,
  dealId: string,
): Promise<DealRecord> {
  const res = await request.get(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealResponse;
  return body.data;
}

test('PATCH /deals/:id with value null clears the deal value and preserves null on readback', async ({ request }) => {
  const org = await registerOrg(request);
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, contact.id, pipelineId, stageId);

  const clearRes = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { value: null },
  });
  expect(clearRes.status()).toBe(200);
  const clearedBody = (await clearRes.json()) as DealResponse;
  expect(clearedBody.data.value).toBeNull();

  const readBack = await getDeal(request, org.token, deal.id);
  expect(readBack.value).toBeNull();
});

// --- New tests appended below ---

test('POST /deals with value=500.99 stores decimal and readback confirms it', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'DecimalContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Decimal Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 500.99 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as DealResponse;
  const dealId = dealBody.data.id;

  const readBack = await getDeal(request, token, dealId);
  expect(Number(readBack.value)).toBeCloseTo(500.99, 2);
});

test('POST /deals with currency="EUR" stores currency and readback confirms it', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'EurContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'EUR Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, currency: 'EUR' },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as { data: { id: string; currency: string } };

  const readRes = await request.get(`/api/v1/deals/${dealBody.data.id}`, { headers: authHeaders(token) });
  expect(readRes.status()).toBe(200);
  const readBody = (await readRes.json()) as { data: { currency: string } };
  expect(readBody.data.currency).toBe('EUR');
});

test('PATCH /deals/:id with value=999 updates deal value and readback confirms it', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'PatchValueContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Patch Value Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 1 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as DealResponse;
  const dealId = dealBody.data.id;

  const patchRes = await request.patch(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(token),
    data: { value: 999 },
  });
  expect(patchRes.status()).toBe(200);

  const readBack = await getDeal(request, token, dealId);
  expect(Number(readBack.value)).toBe(999);
});

test('PATCH /deals/:id with currency="GBP" updates currency and readback confirms it', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'GbpContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'GBP Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as { data: { id: string } };
  const dealId = dealBody.data.id;

  const patchRes = await request.patch(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(token),
    data: { currency: 'GBP' },
  });
  expect(patchRes.status()).toBe(200);

  const readRes = await request.get(`/api/v1/deals/${dealId}`, { headers: authHeaders(token) });
  expect(readRes.status()).toBe(200);
  const readBody = (await readRes.json()) as { data: { currency: string } };
  expect(readBody.data.currency).toBe('GBP');
});

test('POST /deals without value field results in null value on readback', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'NoValueContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'No Value Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as DealResponse;

  const readBack = await getDeal(request, token, dealBody.data.id);
  expect(readBack.value).toBeNull();
});

test('POST /deals without currency field defaults to USD', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'DefaultCurrencyContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Default Currency Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as { data: { id: string; currency: string } };

  const readRes = await request.get(`/api/v1/deals/${dealBody.data.id}`, { headers: authHeaders(token) });
  expect(readRes.status()).toBe(200);
  const readBody = (await readRes.json()) as { data: { currency: string } };
  expect(readBody.data.currency).toBe('USD');
});

test('Deal value persists after stage move via PATCH /deals/:id/stage', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const plRes = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(plRes.status()).toBe(200);
  const plBody = (await plRes.json()) as { data: Array<{ id: string; is_default: boolean; stages: Array<{ id: string }> }> };
  const pipeline = plBody.data.find((p) => p.is_default) ?? plBody.data[0];
  if (!pipeline || pipeline.stages.length < 2) {
    test.skip(true, 'Pipeline has fewer than 2 stages — stage move test skipped');
    return;
  }
  const [firstStage, secondStage] = pipeline.stages;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'StageMoveContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Stage Move Deal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: firstStage.id, value: 777 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as DealResponse;
  const dealId = dealBody.data.id;

  const moveRes = await request.patch(`/api/v1/deals/${dealId}/stage`, {
    headers: authHeaders(token),
    data: { stage_id: secondStage.id },
  });
  expect(moveRes.status()).toBe(200);

  const readBack = await getDeal(request, token, dealId);
  expect(Number(readBack.value)).toBe(777);
});

test('Deal value persists after marking won via POST /deals/:id/won', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'WonContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Won Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 888 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as DealResponse;
  const dealId = dealBody.data.id;

  const wonRes = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: authHeaders(token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const listRes = await request.get('/api/v1/deals?status=won', { headers: authHeaders(token) });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: Array<{ id: string; value: number | string | null }> };
  const found = listBody.data.find((d) => d.id === dealId);
  expect(found).toBeDefined();
  expect(Number(found!.value)).toBe(888);
});

test('POST /deals with value=0 succeeds and stores zero as a valid boundary', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'ZeroValueContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Zero Value Deal', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: 0 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as DealResponse;
  expect(Number(dealBody.data.value)).toBe(0);
});

test('Two deals with same value both appear in GET /deals list with correct values', async ({ request }) => {
  const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const regRes = await request.post('/api/v1/auth/', {
    data: { email: `t${tag}@x.com`, password: 'Test1234!', name: 'T', org_name: `Org${tag}` },
  });
  expect(regRes.status()).toBe(201);
  const regBody = (await regRes.json()) as { data: { token: string; user: { id: string } } };
  const token = regBody.data.token;

  const { pipelineId, stageId } = await getPipelineAndStage(request, token);
  const contactRes = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: 'DuoContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const sharedValue = 250;

  const deal1Res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Duo Deal A', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: sharedValue },
  });
  expect(deal1Res.status()).toBe(201);
  const deal1Body = (await deal1Res.json()) as DealResponse;

  const deal2Res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: { title: 'Duo Deal B', contact_id: contactId, pipeline_id: pipelineId, stage_id: stageId, value: sharedValue },
  });
  expect(deal2Res.status()).toBe(201);
  const deal2Body = (await deal2Res.json()) as DealResponse;

  const listRes = await request.get('/api/v1/deals', { headers: authHeaders(token) });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: Array<{ id: string; value: number | string | null }> };

  const foundDeal1 = listBody.data.find((d) => d.id === deal1Body.data.id);
  const foundDeal2 = listBody.data.find((d) => d.id === deal2Body.data.id);

  expect(foundDeal1).toBeDefined();
  expect(foundDeal2).toBeDefined();
  expect(Number(foundDeal1!.value)).toBe(sharedValue);
  expect(Number(foundDeal2!.value)).toBe(sharedValue);
});
