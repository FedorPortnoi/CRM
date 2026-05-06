import { APIRequestContext, test, expect } from '@playwright/test';

interface AuthOrg {
  token: string;
  userId: string;
}

interface RegisterResponse {
  data: {
    token: string;
    user: {
      id: string;
    };
  };
}

interface ContactRecord {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: string;
}

interface ContactListResponse {
  data: ContactRecord[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
}

interface PipelineStage {
  id: string;
  name: string;
  position: number;
}

interface Pipeline {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStage[];
}

interface DealRecord {
  id: string;
  title: string;
  status: string;
  value: number | string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  contact: { id: string; first_name: string; last_name: string | null };
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
}

interface DealResponse {
  data: DealRecord;
  meta: Record<string, unknown>;
}

interface DashboardResponse {
  data: {
    open_deals: {
      count: number;
      total_value: number;
    };
    tasks_due_today: number;
    recent_activity: Array<{ type: string; id: string; summary: string; created_at: string }>;
    pipeline_health_score: number;
  };
  meta: Record<string, unknown>;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

test.describe.configure({ timeout: 30000 });

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function numericValue(value: number | string | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function todayNoonIso(): string {
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  return today.toISOString();
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<AuthOrg> {
  const unique = uniqueSuffix(suffix);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `User ${suffix}`,
      org_name: `Org ${unique}`,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as RegisterResponse;
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
  const body = (await res.json()) as { data: Pipeline[]; meta: Record<string, unknown> };
  const pipeline = body.data.find((p) => p.is_default && p.stages.length > 0)
    ?? body.data.find((p) => p.stages.length > 0);

  if (pipeline) {
    return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  }

  const pipelineRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
    data: { name: `Pipeline ${uniqueSuffix('auto')}` },
  });
  expect(pipelineRes.status()).toBe(201);
  const pipelineBody = (await pipelineRes.json()) as { data: { id: string } };

  const stageRes = await request.post(`/api/v1/deals/pipelines/${pipelineBody.data.id}/stages`, {
    headers: authHeaders(token),
    data: { name: 'Auto Stage', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  expect(stageRes.status()).toBe(201);
  const stageBody = (await stageRes.json()) as { data: { id: string } };

  return { pipelineId: pipelineBody.data.id, stageId: stageBody.data.id };
}

async function createSecondPipelineStage(request: APIRequestContext, token: string): Promise<string> {
  const pipelineRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
    data: { name: `Secondary Pipeline ${uniqueSuffix('pipeline')}` },
  });
  expect(pipelineRes.status()).toBe(201);
  const pipelineBody = (await pipelineRes.json()) as { data: { id: string } };

  const stageRes = await request.post(`/api/v1/deals/pipelines/${pipelineBody.data.id}/stages`, {
    headers: authHeaders(token),
    data: { name: 'Other Stage', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  expect(stageRes.status()).toBe(201);
  const stageBody = (await stageRes.json()) as { data: { id: string } };
  return stageBody.data.id;
}

async function createContact(
  request: APIRequestContext,
  token: string,
  fields: Partial<Pick<ContactRecord, 'first_name' | 'last_name' | 'company' | 'email' | 'phone' | 'notes'>> = {},
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: {
      first_name: fields.first_name ?? `Contact ${uniqueSuffix('contact')}`,
      ...(fields.last_name !== undefined ? { last_name: fields.last_name } : {}),
      ...(fields.company !== undefined ? { company: fields.company } : {}),
      ...(fields.email !== undefined ? { email: fields.email } : {}),
      ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
      ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: ContactRecord };
  return body.data;
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  options: { contactId: string; pipelineId: string; stageId: string; title: string; value?: number },
): Promise<DealRecord> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: {
      title: options.title,
      contact_id: options.contactId,
      pipeline_id: options.pipelineId,
      stage_id: options.stageId,
      ...(options.value !== undefined ? { value: options.value } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DealResponse;
  return body.data;
}

async function getDashboard(request: APIRequestContext, token: string): Promise<DashboardResponse> {
  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as DashboardResponse;
}

async function getDeal(request: APIRequestContext, token: string, dealId: string): Promise<DealRecord> {
  const res = await request.get(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealResponse;
  return body.data;
}

test('GET /analytics/dashboard open_deals.count decreases and total_value excludes the deal after it is marked won', async ({ request }) => {
  const org = await registerOrg(request, 'dash-won');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token);
  const wonLater = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Will Be Won',
    value: 100,
  });
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Still Open',
    value: 200,
  });

  const before = await getDashboard(request, org.token);
  expect(before.data.open_deals.count).toBe(2);
  expect(before.data.open_deals.total_value).toBe(300);

  const wonRes = await request.post(`/api/v1/deals/${wonLater.id}/won`, {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const after = await getDashboard(request, org.token);
  expect(after.data.open_deals.count).toBe(1);
  expect(after.data.open_deals.total_value).toBe(200);
});

test('GET /analytics/dashboard open_deals.total_value sums only open deals and ignores won and lost values', async ({ request }) => {
  const org = await registerOrg(request, 'dash-open-value');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Only Open Value',
    value: 123.45,
  });
  const wonDeal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Won Value Excluded',
    value: 999,
  });
  const lostDeal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Lost Value Excluded',
    value: 888,
  });

  const wonRes = await request.post(`/api/v1/deals/${wonDeal.id}/won`, {
    headers: authHeaders(org.token),
    data: {},
  });
  expect(wonRes.status()).toBe(200);
  const lostRes = await request.post(`/api/v1/deals/${lostDeal.id}/lost`, {
    headers: authHeaders(org.token),
    data: { reason: 'Coverage test' },
  });
  expect(lostRes.status()).toBe(200);

  const dashboard = await getDashboard(request, org.token);
  expect(dashboard.data.open_deals.count).toBe(1);
  expect(dashboard.data.open_deals.total_value).toBe(123.45);
});

test('GET /analytics/dashboard tasks_due_today counts pending and in-progress tasks but excludes done and cancelled tasks', async ({ request }) => {
  const org = await registerOrg(request, 'dash-tasks');
  const dueDate = todayNoonIso();

  const pendingRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'Dashboard Pending Today', assigned_to: org.userId, due_date: dueDate },
  });
  expect(pendingRes.status()).toBe(201);

  const progressRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'Dashboard Progress Today', assigned_to: org.userId, due_date: dueDate },
  });
  expect(progressRes.status()).toBe(201);
  const progressTask = (await progressRes.json()) as { data: { id: string } };
  const startRes = await request.post(`/api/v1/tasks/${progressTask.data.id}/start`, {
    headers: authHeaders(org.token),
  });
  expect(startRes.status()).toBe(200);

  const doneRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'Dashboard Done Today', assigned_to: org.userId, due_date: dueDate },
  });
  expect(doneRes.status()).toBe(201);
  const doneTask = (await doneRes.json()) as { data: { id: string } };
  const completeRes = await request.post(`/api/v1/tasks/${doneTask.data.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);

  const cancelledRes = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'Dashboard Cancelled Today', assigned_to: org.userId, due_date: dueDate },
  });
  expect(cancelledRes.status()).toBe(201);
  const cancelledTask = (await cancelledRes.json()) as { data: { id: string } };
  const deleteRes = await request.delete(`/api/v1/tasks/${cancelledTask.data.id}`, {
    headers: authHeaders(org.token),
  });
  expect(deleteRes.status()).toBe(200);

  const dashboard = await getDashboard(request, org.token);
  expect(dashboard.data.tasks_due_today).toBe(2);
});

test('PATCH /contacts/:id partial update changes only provided fields and leaves other contact fields unchanged', async ({ request }) => {
  const org = await registerOrg(request, 'contact-partial');
  const contact = await createContact(request, org.token, {
    first_name: 'Original',
    last_name: 'Still',
    company: 'KeepCo',
    email: `${uniqueSuffix('partial')}@example.com`,
    phone: '+15550170000',
    notes: 'Preserve this note',
  });

  const res = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: authHeaders(org.token),
    data: { first_name: 'Updated' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: ContactRecord };
  expect(body.data.first_name).toBe('Updated');
  expect(body.data.last_name).toBe('Still');
  expect(body.data.company).toBe('KeepCo');
  expect(body.data.email).toBe(contact.email);
  expect(body.data.phone).toBe('+15550170000');
  expect(body.data.notes).toBe('Preserve this note');
});

test('PATCH /contacts/:id for a missing contact returns 404 NOT_FOUND with an error envelope', async ({ request }) => {
  const org = await registerOrg(request, 'contact-missing');
  const res = await request.patch('/api/v1/contacts/00000000-0000-4000-8000-000000000017', {
    headers: authHeaders(org.token),
    data: { first_name: 'Nobody' },
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NOT_FOUND');
  expect(body.error.message.length).toBeGreaterThan(0);
});

test('GET /contacts search excludes an archived contact that matches the query while returning the active match', async ({ request }) => {
  const org = await registerOrg(request, 'contact-search-active');
  const query = uniqueSuffix('SearchActive');
  const active = await createContact(request, org.token, { first_name: query, last_name: 'Active' });
  const archived = await createContact(request, org.token, { first_name: query, last_name: 'Archived' });

  const deleteRes = await request.delete(`/api/v1/contacts/${archived.id}`, {
    headers: authHeaders(org.token),
  });
  expect(deleteRes.status()).toBe(200);

  const res = await request.get(`/api/v1/contacts?q=${encodeURIComponent(query)}&per_page=20`, {
    headers: authHeaders(org.token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  const ids = body.data.map((contact) => contact.id);
  expect(ids).toContain(active.id);
  expect(ids).not.toContain(archived.id);
});

test('GET /contacts search with status=archived returns the archived match and excludes the active match', async ({ request }) => {
  const org = await registerOrg(request, 'contact-search-archived');
  const query = uniqueSuffix('SearchArchived');
  const active = await createContact(request, org.token, { first_name: query, last_name: 'Active' });
  const archived = await createContact(request, org.token, { first_name: query, last_name: 'Archived' });

  const deleteRes = await request.delete(`/api/v1/contacts/${archived.id}`, {
    headers: authHeaders(org.token),
  });
  expect(deleteRes.status()).toBe(200);

  const res = await request.get(`/api/v1/contacts?q=${encodeURIComponent(query)}&status=archived&per_page=20`, {
    headers: authHeaders(org.token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  const ids = body.data.map((contact) => contact.id);
  expect(ids).toContain(archived.id);
  expect(ids).not.toContain(active.id);
  expect(body.data.every((contact) => contact.status === 'archived')).toBe(true);
});

test('POST /contacts permits duplicate email in the same org and both contacts are searchable by that email', async ({ request }) => {
  const org = await registerOrg(request, 'contact-duplicate-email');
  const email = `${uniqueSuffix('duplicate-contact')}@example.com`;
  const first = await createContact(request, org.token, { first_name: 'DuplicateA', email });
  const second = await createContact(request, org.token, { first_name: 'DuplicateB', email });

  expect(first.email).toBe(email);
  expect(second.email).toBe(email);
  expect(second.id).not.toBe(first.id);

  const res = await request.get(`/api/v1/contacts?q=${encodeURIComponent(email)}&per_page=20`, {
    headers: authHeaders(org.token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  const ids = body.data.map((contact) => contact.id);
  expect(ids).toContain(first.id);
  expect(ids).toContain(second.id);
});

test('PATCH /deals/:id with a negative value returns 400 and preserves the previous deal value', async ({ request }) => {
  const org = await registerOrg(request, 'deal-negative-value');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Negative Patch Guard',
    value: 55,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { value: -1 },
  });
  expect(res.status()).toBe(400);

  const unchanged = await getDeal(request, org.token, deal.id);
  expect(numericValue(unchanged.value)).toBe(55);
});

test('PATCH /deals/:id with value 0 returns 400 and preserves the previous positive deal value', async ({ request }) => {
  const org = await registerOrg(request, 'deal-zero-value');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Zero Patch Guard',
    value: 66,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { value: 0 },
  });
  expect(res.status()).toBe(400);

  const unchanged = await getDeal(request, org.token, deal.id);
  expect(numericValue(unchanged.value)).toBe(66);
});

test('PATCH /deals/:id with a stage from another pipeline returns STAGE_PIPELINE_MISMATCH and leaves the stage unchanged', async ({ request }) => {
  const org = await registerOrg(request, 'deal-stage-mismatch');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const otherStageId = await createSecondPipelineStage(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Patch Stage Mismatch',
    value: 77,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { stage_id: otherStageId },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('STAGE_PIPELINE_MISMATCH');

  const unchanged = await getDeal(request, org.token, deal.id);
  expect(unchanged.stage_id).toBe(stageId);
});

test('PATCH /deals/:id happy path updates title and value while returning contact, pipeline, and stage details', async ({ request }) => {
  const org = await registerOrg(request, 'deal-patch-happy');
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token, { first_name: 'DealPatchContact' });
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title: 'Patch Happy Original',
    value: 70,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { title: 'Patch Happy Updated', value: 75 },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealResponse;
  expect(body.data.title).toBe('Patch Happy Updated');
  expect(numericValue(body.data.value)).toBe(75);
  expect(body.data.contact.id).toBe(contact.id);
  expect(body.data.pipeline?.id).toBe(pipelineId);
  expect(body.data.stage?.id).toBe(stageId);
});

test('POST /tasks with a contact_id from another org returns 403 FORBIDDEN and does not create the task in the requesting org', async ({ request }) => {
  const orgA = await registerOrg(request, 'task-org-a');
  const orgB = await registerOrg(request, 'task-org-b');
  const orgBContact = await createContact(request, orgB.token, { first_name: 'OtherOrgContact' });
  const title = `Cross Org Task ${uniqueSuffix('forbidden')}`;

  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(orgA.token),
    data: { title, assigned_to: orgA.userId, contact_id: orgBContact.id },
  });
  expect(res.status()).toBe(403);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('FORBIDDEN');

  const listRes = await request.get(`/api/v1/tasks?q=${encodeURIComponent(title)}`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: Array<{ id: string; title: string }> };
  expect(listBody.data).toHaveLength(0);
});
