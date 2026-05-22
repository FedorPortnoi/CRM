import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

async function defaultPipeline(
  request: APIRequestContext,
  token: string,
): Promise<{ id: string; stages: Array<{ id: string }> }> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: Array<{ id: string; is_default: boolean; stages: Array<{ id: string }> }> };
  return body.data.find((pipeline) => pipeline.is_default) ?? body.data[0]!;
}

async function createContact(
  request: APIRequestContext,
  token: string,
  firstName: string,
  phone?: string,
): Promise<{ id: string }> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName, ...(phone ? { phone } : {}) },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  contactId: string,
  pipelineId: string,
  stageId: string,
): Promise<{ id: string }> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: {
      title: 'Completion stale deal',
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      currency: 'USD',
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

test.describe.configure({ timeout: 30000 });

test('completion: stale deal scan fires deal_stale workflow once per deal', async ({ request }) => {
  const org = await registerOrg(request, 's40-stale');
  const pipeline = await defaultPipeline(request, org.token);
  const contact = await createContact(request, org.token, 'StaleTarget');
  const deal = await createDeal(request, org.token, contact.id, pipeline.id, pipeline.stages[0]!.id);

  const workflowRes = await request.post('/api/v1/workflows', {
    headers: authHeaders(org.token),
    data: {
      name: 'Stale deal follow-up',
      trigger: 'deal_stale',
      actions: [{ type: 'create_task', title: 'Review stale {{title}}', due_in_days: 0 }],
      status: 'active',
    },
  });
  expect(workflowRes.status()).toBe(201);
  const workflow = (await workflowRes.json()) as { data: { id: string } };

  const firstScan = await request.post('/api/v1/deals/stale/evaluate?threshold_days=0', {
    headers: authHeaders(org.token),
  });
  expect(firstScan.status()).toBe(200);
  const scanBody = await firstScan.json() as { data: Array<{ id: string; stale_days: number }>; meta: { total: number } };
  expect(scanBody.meta.total).toBeGreaterThanOrEqual(1);
  expect(scanBody.data.some((item) => item.id === deal.id && item.stale_days >= 0)).toBe(true);

  const secondScan = await request.post('/api/v1/deals/stale/evaluate?threshold_days=0', {
    headers: authHeaders(org.token),
  });
  expect(secondScan.status()).toBe(200);

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${contact.id}`, { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = await tasksRes.json() as { data: Array<{ title: string; contact_id: string }> };
  expect(tasks.data.filter((task) => task.title === 'Review stale Completion stale deal')).toHaveLength(1);

  const runsRes = await request.get(`/api/v1/workflows/${workflow.data.id}/runs`, { headers: authHeaders(org.token) });
  expect(runsRes.status()).toBe(200);
  const runs = await runsRes.json() as { data: Array<{ trigger_record_id: string; status: string }> };
  expect(runs.data.filter((run) => run.trigger_record_id === deal.id && run.status === 'success')).toHaveLength(1);
});

test('completion: create-contact from pending capture logs activity and creates follow-up task', async ({ request }) => {
  const org = await registerOrg(request, 's40-capture-create');
  const phone = '+79004000040';
  const captureRes = await request.post('/api/v1/captures', {
    headers: authHeaders(org.token),
    data: {
      type: 'sms',
      raw_data: { from: phone, body: 'Captured SMS body', first_name: 'CapturedLead' },
      phone_number: phone,
    },
  });
  expect(captureRes.status()).toBe(201);
  const capture = (await captureRes.json()) as { data: { id: string } };

  const createRes = await request.post(`/api/v1/captures/${capture.data.id}/create-contact`, {
    headers: authHeaders(org.token),
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json() as { data: { id: string; first_name: string }; meta: { follow_up_task_created: boolean } };
  expect(created.data.first_name).toBe('CapturedLead');
  expect(created.meta.follow_up_task_created).toBe(true);

  const messagesRes = await request.get(`/api/v1/messages?contact_id=${created.data.id}`, {
    headers: authHeaders(org.token),
  });
  expect(messagesRes.status()).toBe(200);
  const messages = await messagesRes.json() as { data: Array<{ body: string; channel: string }> };
  expect(messages.data.some((message) => message.channel === 'sms' && message.body === 'Captured SMS body')).toBe(true);

  const tasksRes = await request.get(`/api/v1/tasks?contact_id=${created.data.id}`, { headers: authHeaders(org.token) });
  expect(tasksRes.status()).toBe(200);
  const tasks = await tasksRes.json() as { data: Array<{ title: string; contact_id: string }> };
  expect(tasks.data.some((task) => task.title === 'Follow up: CapturedLead')).toBe(true);
});
