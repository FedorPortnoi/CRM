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
