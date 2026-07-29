import { test, expect, APIRequestContext } from '@playwright/test';
import { registerVerifiedOrg } from './helpers/auth';

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
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
  const org = await registerVerifiedOrg(request, 's40-stale');
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
