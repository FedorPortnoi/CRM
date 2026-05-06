import { APIRequestContext, APIResponse, expect, test } from '@playwright/test';

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

interface ErrorResponse {
  error: {
    code: string;
    message: string;
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
  assigned_to: string | null;
  created_at: string;
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
  contact_id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  assigned_to: string | null;
  status: string;
  value: number | string | null;
  contact: { id: string; first_name: string; last_name: string | null };
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
}

interface DealResponse {
  data: DealRecord;
  meta: Record<string, unknown>;
}

interface TaskRecord {
  id: string;
  title: string;
  assigned_to: string;
  contact_id: string | null;
  deal_id: string | null;
  status: string;
}

interface CalendarEventRecord {
  id: string;
  title: string;
  contact_id: string | null;
  deal_id: string | null;
  status: string;
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

type ContactFields = Partial<
  Pick<ContactRecord, 'first_name' | 'last_name' | 'company' | 'email' | 'phone' | 'notes' | 'assigned_to'>
>;

test.describe.configure({ timeout: 30000 });

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function todayNoonIso(): string {
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  return today.toISOString();
}

function futureIso(daysFromNow: number, hourUtc: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString();
}

function dayBounds(daysFromNow: number): { start: string; end: string } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + daysFromNow);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function expectError(response: APIResponse, status: number, code: string): Promise<ErrorResponse> {
  expect(response.status()).toBe(status);
  const body = (await response.json()) as ErrorResponse;
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  return body;
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

async function createContact(
  request: APIRequestContext,
  token: string,
  fields: ContactFields = {},
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
      ...(fields.assigned_to !== undefined ? { assigned_to: fields.assigned_to } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: ContactRecord };
  return body.data;
}

async function getContact(request: APIRequestContext, token: string, contactId: string): Promise<ContactRecord> {
  const res = await request.get(`/api/v1/contacts/${contactId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: ContactRecord };
  return body.data;
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
  const pipeline = body.data.find((candidate) => candidate.is_default && candidate.stages.length > 0)
    ?? body.data.find((candidate) => candidate.stages.length > 0);

  if (pipeline) {
    return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  }

  return createPipelineWithStage(request, token, 'Auto Pipeline');
}

async function createPipelineWithStage(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ pipelineId: string; stageId: string }> {
  const pipelineRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
    data: { name: `${name} ${uniqueSuffix('pipeline')}` },
  });
  expect(pipelineRes.status()).toBe(201);
  const pipelineBody = (await pipelineRes.json()) as { data: { id: string } };

  const stageRes = await request.post(`/api/v1/deals/pipelines/${pipelineBody.data.id}/stages`, {
    headers: authHeaders(token),
    data: { name: 'Coverage Stage', position: 1, is_won_stage: false, is_lost_stage: false },
  });
  expect(stageRes.status()).toBe(201);
  const stageBody = (await stageRes.json()) as { data: { id: string } };

  return { pipelineId: pipelineBody.data.id, stageId: stageBody.data.id };
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  options: {
    contactId: string;
    pipelineId: string;
    stageId: string;
    title?: string;
    value?: number;
    assignedTo?: string;
  },
): Promise<DealRecord> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: {
      title: options.title ?? `Deal ${uniqueSuffix('deal')}`,
      contact_id: options.contactId,
      pipeline_id: options.pipelineId,
      stage_id: options.stageId,
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.assignedTo !== undefined ? { assigned_to: options.assignedTo } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DealResponse;
  return body.data;
}

async function createBasicDealForOrg(
  request: APIRequestContext,
  org: AuthOrg,
  title?: string,
  value?: number,
): Promise<DealRecord> {
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const contact = await createContact(request, org.token);
  return createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    title,
    value,
  });
}

async function getDeal(request: APIRequestContext, token: string, dealId: string): Promise<DealRecord> {
  const res = await request.get(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealResponse;
  return body.data;
}

async function createTask(
  request: APIRequestContext,
  token: string,
  options: {
    assignedTo: string;
    title?: string;
    contactId?: string;
    dealId?: string;
    dueDate?: string;
  },
): Promise<TaskRecord> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(token),
    data: {
      title: options.title ?? `Task ${uniqueSuffix('task')}`,
      assigned_to: options.assignedTo,
      ...(options.contactId !== undefined ? { contact_id: options.contactId } : {}),
      ...(options.dealId !== undefined ? { deal_id: options.dealId } : {}),
      ...(options.dueDate !== undefined ? { due_date: options.dueDate } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: TaskRecord; meta: Record<string, unknown> };
  return body.data;
}

async function getTask(request: APIRequestContext, token: string, taskId: string): Promise<TaskRecord> {
  const res = await request.get(`/api/v1/tasks/${taskId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: TaskRecord; meta: Record<string, unknown> };
  return body.data;
}

async function createCalendarEvent(
  request: APIRequestContext,
  token: string,
  options: {
    title?: string;
    contactId?: string;
    dealId?: string;
    daysFromNow?: number;
  } = {},
): Promise<CalendarEventRecord> {
  const daysFromNow = options.daysFromNow ?? 1;
  const res = await request.post('/api/v1/calendar', {
    headers: authHeaders(token),
    data: {
      title: options.title ?? `Event ${uniqueSuffix('event')}`,
      start_time: futureIso(daysFromNow, 15),
      end_time: futureIso(daysFromNow, 16),
      ...(options.contactId !== undefined ? { contact_id: options.contactId } : {}),
      ...(options.dealId !== undefined ? { deal_id: options.dealId } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: CalendarEventRecord; meta: Record<string, unknown> };
  return body.data;
}

async function getCalendarEvent(
  request: APIRequestContext,
  token: string,
  eventId: string,
): Promise<CalendarEventRecord> {
  const res = await request.get(`/api/v1/calendar/${eventId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: CalendarEventRecord; meta: Record<string, unknown> };
  return body.data;
}

async function listCalendarEventsForDay(
  request: APIRequestContext,
  token: string,
  daysFromNow: number,
): Promise<CalendarEventRecord[]> {
  const bounds = dayBounds(daysFromNow);
  const res = await request.get(
    `/api/v1/calendar?start=${encodeURIComponent(bounds.start)}&end=${encodeURIComponent(bounds.end)}&per_page=50`,
    { headers: authHeaders(token) },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: CalendarEventRecord[]; meta: Record<string, unknown> };
  return body.data;
}

test('POST /contacts with assigned_to from another org returns 403 FORBIDDEN and leaves the contact out of the requester list', async ({ request }) => {
  const orgA = await registerOrg(request, 'contact-post-assignee-a');
  const orgB = await registerOrg(request, 'contact-post-assignee-b');
  const firstName = uniqueSuffix('CrossAssignedContact');

  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(orgA.token),
    data: { first_name: firstName, assigned_to: orgB.userId },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const listRes = await request.get(`/api/v1/contacts?q=${encodeURIComponent(firstName)}&per_page=10`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ContactListResponse;
  expect(listBody.data).toHaveLength(0);
});

test('PATCH /contacts/:id with assigned_to from another org returns 403 FORBIDDEN and preserves the original assignee', async ({ request }) => {
  const orgA = await registerOrg(request, 'contact-patch-assignee-a');
  const orgB = await registerOrg(request, 'contact-patch-assignee-b');
  const contact = await createContact(request, orgA.token, { assigned_to: orgA.userId });

  const res = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: authHeaders(orgA.token),
    data: { assigned_to: orgB.userId },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const unchanged = await getContact(request, orgA.token, contact.id);
  expect(unchanged.assigned_to).toBe(orgA.userId);
});

test('PATCH /contacts/:id clears optional text fields including email by storing empty strings', async ({ request }) => {
  const org = await registerOrg(request, 'contact-clear-fields');
  const contact = await createContact(request, org.token, {
    first_name: 'Clearable',
    last_name: 'Person',
    company: 'ClearCo',
    email: `${uniqueSuffix('clear-email')}@example.com`,
    phone: '+15550180000',
    notes: 'Clear this note',
  });

  const res = await request.patch(`/api/v1/contacts/${contact.id}`, {
    headers: authHeaders(org.token),
    data: { last_name: '', company: '', email: '', phone: '', notes: '' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: ContactRecord };
  expect(body.data.last_name).toBe('');
  expect(body.data.company).toBe('');
  expect(body.data.email).toBe('');
  expect(body.data.phone).toBe('');
  expect(body.data.notes).toBe('');
});

test('PATCH /contacts/:id permits duplicate email in the same org and both contacts are searchable by that email', async ({ request }) => {
  const org = await registerOrg(request, 'contact-patch-duplicate-email');
  const email = `${uniqueSuffix('shared-email')}@example.com`;
  const first = await createContact(request, org.token, { first_name: 'DuplicatePatchA', email });
  const second = await createContact(request, org.token, {
    first_name: 'DuplicatePatchB',
    email: `${uniqueSuffix('other-email')}@example.com`,
  });

  const patchRes = await request.patch(`/api/v1/contacts/${second.id}`, {
    headers: authHeaders(org.token),
    data: { email },
  });
  expect(patchRes.status()).toBe(200);

  const listRes = await request.get(`/api/v1/contacts?q=${encodeURIComponent(email)}&per_page=20`, {
    headers: authHeaders(org.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ContactListResponse;
  const ids = listBody.data.map((item) => item.id);
  expect(ids).toContain(first.id);
  expect(ids).toContain(second.id);
});

test('GET /contacts sorted by created_at desc returns the newest matching contacts first for dashboard usage', async ({ request }) => {
  const org = await registerOrg(request, 'contact-sort-created');
  const prefix = uniqueSuffix('ContactSort');
  const oldest = await createContact(request, org.token, { first_name: `${prefix} Oldest` });
  await delay(50);
  const middle = await createContact(request, org.token, { first_name: `${prefix} Middle` });
  await delay(50);
  const newest = await createContact(request, org.token, { first_name: `${prefix} Newest` });

  const res = await request.get(
    `/api/v1/contacts?q=${encodeURIComponent(prefix)}&sort=created_at&order=desc&per_page=3`,
    { headers: authHeaders(org.token) },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ContactListResponse;
  expect(body.data.map((contact) => contact.id)).toEqual([newest.id, middle.id, oldest.id]);
});

test('POST /deals with contact_id from another org returns 403 FORBIDDEN and does not create the deal', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-post-contact-a');
  const orgB = await registerOrg(request, 'deal-post-contact-b');
  const { pipelineId, stageId } = await getPipelineAndStage(request, orgA.token);
  const otherContact = await createContact(request, orgB.token);
  const title = uniqueSuffix('CrossOrgContactDeal');

  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(orgA.token),
    data: { title, contact_id: otherContact.id, pipeline_id: pipelineId, stage_id: stageId },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const listRes = await request.get(`/api/v1/deals?q=${encodeURIComponent(title)}`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: DealRecord[]; meta: Record<string, unknown> };
  expect(listBody.data).toHaveLength(0);
});

test('POST /deals with pipeline_id and stage_id from another org returns 404 PIPELINE_NOT_FOUND and does not create the deal', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-post-pipeline-a');
  const orgB = await registerOrg(request, 'deal-post-pipeline-b');
  const contact = await createContact(request, orgA.token);
  const otherPipeline = await getPipelineAndStage(request, orgB.token);
  const title = uniqueSuffix('CrossOrgPipelineDeal');

  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(orgA.token),
    data: {
      title,
      contact_id: contact.id,
      pipeline_id: otherPipeline.pipelineId,
      stage_id: otherPipeline.stageId,
    },
  });
  await expectError(res, 404, 'PIPELINE_NOT_FOUND');

  const listRes = await request.get(`/api/v1/deals?q=${encodeURIComponent(title)}`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: DealRecord[]; meta: Record<string, unknown> };
  expect(listBody.data).toHaveLength(0);
});

test('POST /deals with assigned_to from another org returns 403 FORBIDDEN and does not create the deal', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-post-assignee-a');
  const orgB = await registerOrg(request, 'deal-post-assignee-b');
  const { pipelineId, stageId } = await getPipelineAndStage(request, orgA.token);
  const contact = await createContact(request, orgA.token);
  const title = uniqueSuffix('CrossOrgAssigneeDeal');

  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(orgA.token),
    data: {
      title,
      contact_id: contact.id,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: orgB.userId,
    },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const listRes = await request.get(`/api/v1/deals?q=${encodeURIComponent(title)}`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: DealRecord[]; meta: Record<string, unknown> };
  expect(listBody.data).toHaveLength(0);
});

test('PATCH /deals/:id with assigned_to from another org returns 403 FORBIDDEN and preserves the original assignee', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-patch-assignee-a');
  const orgB = await registerOrg(request, 'deal-patch-assignee-b');
  const { pipelineId, stageId } = await getPipelineAndStage(request, orgA.token);
  const contact = await createContact(request, orgA.token);
  const deal = await createDeal(request, orgA.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
    assignedTo: orgA.userId,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(orgA.token),
    data: { assigned_to: orgB.userId },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const unchanged = await getDeal(request, orgA.token, deal.id);
  expect(unchanged.assigned_to).toBe(orgA.userId);
});

test('PATCH /deals/:id changing pipeline_id and stage_id together succeeds when the stage belongs to the new pipeline', async ({ request }) => {
  const org = await registerOrg(request, 'deal-patch-pipeline-stage');
  const originalPipeline = await getPipelineAndStage(request, org.token);
  const nextPipeline = await createPipelineWithStage(request, org.token, 'Next Pipeline');
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: originalPipeline.pipelineId,
    stageId: originalPipeline.stageId,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { pipeline_id: nextPipeline.pipelineId, stage_id: nextPipeline.stageId },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DealResponse;
  expect(body.data.pipeline_id).toBe(nextPipeline.pipelineId);
  expect(body.data.stage_id).toBe(nextPipeline.stageId);
  expect(body.data.pipeline?.id).toBe(nextPipeline.pipelineId);
  expect(body.data.stage?.id).toBe(nextPipeline.stageId);
});

test('PATCH /deals/:id changing pipeline_id without a matching stage_id returns STAGE_PIPELINE_MISMATCH and preserves pipeline and stage', async ({ request }) => {
  const org = await registerOrg(request, 'deal-patch-pipeline-only');
  const originalPipeline = await getPipelineAndStage(request, org.token);
  const nextPipeline = await createPipelineWithStage(request, org.token, 'Pipeline Only Target');
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: originalPipeline.pipelineId,
    stageId: originalPipeline.stageId,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(org.token),
    data: { pipeline_id: nextPipeline.pipelineId },
  });
  await expectError(res, 400, 'STAGE_PIPELINE_MISMATCH');

  const unchanged = await getDeal(request, org.token, deal.id);
  expect(unchanged.pipeline_id).toBe(originalPipeline.pipelineId);
  expect(unchanged.stage_id).toBe(originalPipeline.stageId);
});

test('PATCH /deals/:id with contact_id from another org returns 403 FORBIDDEN and preserves the existing contact', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-patch-contact-a');
  const orgB = await registerOrg(request, 'deal-patch-contact-b');
  const { pipelineId, stageId } = await getPipelineAndStage(request, orgA.token);
  const originalContact = await createContact(request, orgA.token);
  const otherContact = await createContact(request, orgB.token);
  const deal = await createDeal(request, orgA.token, {
    contactId: originalContact.id,
    pipelineId,
    stageId,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(orgA.token),
    data: { contact_id: otherContact.id },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const unchanged = await getDeal(request, orgA.token, deal.id);
  expect(unchanged.contact_id).toBe(originalContact.id);
  expect(unchanged.contact.id).toBe(originalContact.id);
});

test('PATCH /deals/:id with pipeline_id from another org returns 404 PIPELINE_NOT_FOUND and preserves pipeline and stage', async ({ request }) => {
  const orgA = await registerOrg(request, 'deal-patch-pipeline-a');
  const orgB = await registerOrg(request, 'deal-patch-pipeline-b');
  const originalPipeline = await getPipelineAndStage(request, orgA.token);
  const otherPipeline = await getPipelineAndStage(request, orgB.token);
  const contact = await createContact(request, orgA.token);
  const deal = await createDeal(request, orgA.token, {
    contactId: contact.id,
    pipelineId: originalPipeline.pipelineId,
    stageId: originalPipeline.stageId,
  });

  const res = await request.patch(`/api/v1/deals/${deal.id}`, {
    headers: authHeaders(orgA.token),
    data: { pipeline_id: otherPipeline.pipelineId },
  });
  await expectError(res, 404, 'PIPELINE_NOT_FOUND');

  const unchanged = await getDeal(request, orgA.token, deal.id);
  expect(unchanged.pipeline_id).toBe(originalPipeline.pipelineId);
  expect(unchanged.stage_id).toBe(originalPipeline.stageId);
});

test('POST /tasks with deal_id from another org returns 403 FORBIDDEN and does not create the task', async ({ request }) => {
  const orgA = await registerOrg(request, 'task-post-deal-a');
  const orgB = await registerOrg(request, 'task-post-deal-b');
  const otherDeal = await createBasicDealForOrg(request, orgB, 'Other Org Task Deal');
  const title = uniqueSuffix('CrossOrgDealTask');

  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(orgA.token),
    data: { title, assigned_to: orgA.userId, deal_id: otherDeal.id },
  });
  await expectError(res, 403, 'FORBIDDEN');

  const listRes = await request.get(`/api/v1/tasks?q=${encodeURIComponent(title)}`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as { data: TaskRecord[]; meta: Record<string, unknown> };
  expect(listBody.data).toHaveLength(0);
});

test('PATCH /tasks/:id rejects cross-org assigned_to, contact_id, and deal_id with 403 FORBIDDEN and preserves original task relations', async ({ request }) => {
  const orgA = await registerOrg(request, 'task-patch-rel-a');
  const orgB = await registerOrg(request, 'task-patch-rel-b');
  const originalDeal = await createBasicDealForOrg(request, orgA, 'Original Task Deal');
  const originalContact = await getContact(request, orgA.token, originalDeal.contact_id);
  const otherContact = await createContact(request, orgB.token);
  const otherDeal = await createBasicDealForOrg(request, orgB, 'Other Task Deal');
  const task = await createTask(request, orgA.token, {
    assignedTo: orgA.userId,
    contactId: originalContact.id,
    dealId: originalDeal.id,
  });

  const assigneeRes = await request.patch(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(orgA.token),
    data: { assigned_to: orgB.userId },
  });
  await expectError(assigneeRes, 403, 'FORBIDDEN');

  const contactRes = await request.patch(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(orgA.token),
    data: { contact_id: otherContact.id },
  });
  await expectError(contactRes, 403, 'FORBIDDEN');

  const dealRes = await request.patch(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(orgA.token),
    data: { deal_id: otherDeal.id },
  });
  await expectError(dealRes, 403, 'FORBIDDEN');

  const unchanged = await getTask(request, orgA.token, task.id);
  expect(unchanged.assigned_to).toBe(orgA.userId);
  expect(unchanged.contact_id).toBe(originalContact.id);
  expect(unchanged.deal_id).toBe(originalDeal.id);
});

test('POST /calendar rejects contact_id and deal_id from another org with 403 FORBIDDEN and leaves both event titles out of the requester calendar', async ({ request }) => {
  const orgA = await registerOrg(request, 'calendar-post-rel-a');
  const orgB = await registerOrg(request, 'calendar-post-rel-b');
  const otherContact = await createContact(request, orgB.token);
  const otherDeal = await createBasicDealForOrg(request, orgB, 'Other Calendar Deal');
  const contactTitle = uniqueSuffix('CrossOrgContactEvent');
  const dealTitle = uniqueSuffix('CrossOrgDealEvent');

  const contactRes = await request.post('/api/v1/calendar', {
    headers: authHeaders(orgA.token),
    data: {
      title: contactTitle,
      contact_id: otherContact.id,
      start_time: futureIso(2, 10),
      end_time: futureIso(2, 11),
    },
  });
  await expectError(contactRes, 403, 'FORBIDDEN');

  const dealRes = await request.post('/api/v1/calendar', {
    headers: authHeaders(orgA.token),
    data: {
      title: dealTitle,
      deal_id: otherDeal.id,
      start_time: futureIso(2, 12),
      end_time: futureIso(2, 13),
    },
  });
  await expectError(dealRes, 403, 'FORBIDDEN');

  const events = await listCalendarEventsForDay(request, orgA.token, 2);
  const titles = events.map((event) => event.title);
  expect(titles).not.toContain(contactTitle);
  expect(titles).not.toContain(dealTitle);
});

test('PATCH /calendar/:id rejects cross-org contact_id and deal_id with 403 FORBIDDEN and preserves original event relations', async ({ request }) => {
  const orgA = await registerOrg(request, 'calendar-patch-rel-a');
  const orgB = await registerOrg(request, 'calendar-patch-rel-b');
  const originalDeal = await createBasicDealForOrg(request, orgA, 'Original Calendar Deal');
  const originalContact = await getContact(request, orgA.token, originalDeal.contact_id);
  const otherContact = await createContact(request, orgB.token);
  const otherDeal = await createBasicDealForOrg(request, orgB, 'Other Calendar Deal');
  const event = await createCalendarEvent(request, orgA.token, {
    contactId: originalContact.id,
    dealId: originalDeal.id,
    daysFromNow: 3,
  });

  const contactRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(orgA.token),
    data: { contact_id: otherContact.id },
  });
  await expectError(contactRes, 403, 'FORBIDDEN');

  const dealRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(orgA.token),
    data: { deal_id: otherDeal.id },
  });
  await expectError(dealRes, 403, 'FORBIDDEN');

  const unchanged = await getCalendarEvent(request, orgA.token, event.id);
  expect(unchanged.contact_id).toBe(originalContact.id);
  expect(unchanged.deal_id).toBe(originalDeal.id);
});

test('GET /tasks/today returns pending and in-progress tasks while excluding done and cancelled tasks due today', async ({ request }) => {
  const org = await registerOrg(request, 'tasks-today-direct');
  const dueDate = todayNoonIso();
  const pending = await createTask(request, org.token, {
    assignedTo: org.userId,
    title: uniqueSuffix('TodayPending'),
    dueDate,
  });
  const inProgress = await createTask(request, org.token, {
    assignedTo: org.userId,
    title: uniqueSuffix('TodayProgress'),
    dueDate,
  });
  const done = await createTask(request, org.token, {
    assignedTo: org.userId,
    title: uniqueSuffix('TodayDone'),
    dueDate,
  });
  const cancelled = await createTask(request, org.token, {
    assignedTo: org.userId,
    title: uniqueSuffix('TodayCancelled'),
    dueDate,
  });

  const startRes = await request.post(`/api/v1/tasks/${inProgress.id}/start`, {
    headers: authHeaders(org.token),
  });
  expect(startRes.status()).toBe(200);
  const completeRes = await request.post(`/api/v1/tasks/${done.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);
  const cancelRes = await request.delete(`/api/v1/tasks/${cancelled.id}`, {
    headers: authHeaders(org.token),
  });
  expect(cancelRes.status()).toBe(200);

  const todayRes = await request.get('/api/v1/tasks/today', {
    headers: authHeaders(org.token),
  });
  expect(todayRes.status()).toBe(200);
  const todayBody = (await todayRes.json()) as { data: TaskRecord[]; meta: Record<string, unknown> };
  const ids = todayBody.data.map((task) => task.id);
  expect(ids).toContain(pending.id);
  expect(ids).toContain(inProgress.id);
  expect(ids).not.toContain(done.id);
  expect(ids).not.toContain(cancelled.id);
});

test('GET /analytics/dashboard keeps open deal totals and due-today task counts org-scoped when another org has noisy data', async ({ request }) => {
  const orgA = await registerOrg(request, 'dashboard-scope-a');
  const orgB = await registerOrg(request, 'dashboard-scope-b');
  const orgADeal = await createBasicDealForOrg(request, orgA, 'Org A Dashboard Deal', 10);
  await createTask(request, orgA.token, {
    assignedTo: orgA.userId,
    title: 'Org A Dashboard Task',
    dealId: orgADeal.id,
    dueDate: todayNoonIso(),
  });
  const orgBDeal = await createBasicDealForOrg(request, orgB, 'Org B Dashboard Noise Deal', 999);
  await createTask(request, orgB.token, {
    assignedTo: orgB.userId,
    title: 'Org B Dashboard Noise Task',
    dealId: orgBDeal.id,
    dueDate: todayNoonIso(),
  });

  const dashboardRes = await request.get('/api/v1/analytics/dashboard', {
    headers: authHeaders(orgA.token),
  });
  expect(dashboardRes.status()).toBe(200);
  const dashboard = (await dashboardRes.json()) as DashboardResponse;
  expect(dashboard.data.open_deals.count).toBe(1);
  expect(dashboard.data.open_deals.total_value).toBe(10);
  expect(dashboard.data.tasks_due_today).toBe(1);
});
