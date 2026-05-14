import { test, expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

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

interface EmptyMeta {
  [key: string]: never;
}

interface DataResponse<T> {
  data: T;
  meta: EmptyMeta;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

interface PipelineRecord {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  stages: PipelineStageRecord[];
}

interface PipelineStageRecord {
  id: string;
  name: string;
  position: number;
}

interface ConversionRateTransition {
  from_stage_id: string;
  from_stage_name: string;
  from_stage_position: number;
  to_stage_id: string;
  to_stage_name: string;
  to_stage_position: number;
  entered_count: number;
  progressed_count: number;
  conversion_rate: number;
}

interface ConversionRatePipeline {
  pipeline_id: string;
  pipeline_name: string;
  transitions: ConversionRateTransition[];
  note: string;
}

interface ConversionRatesResponse {
  data: ConversionRatePipeline[];
  meta: EmptyMeta;
}

interface CalendarEventRecord {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  status: string;
  completed_at: string | null;
  notes: string | null;
}

interface TaskRecord {
  id: string;
  title: string;
  assigned_to: string;
  due_date: string | null;
  status: string;
  completed_at: string | null;
}

interface TaskListResponse {
  data: TaskRecord[];
  meta: EmptyMeta;
}

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function futureIso(daysFromNow: number, hourUtc: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString();
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<AuthOrg> {
  const unique = uniqueSuffix(suffix);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `Session 22 ${suffix}`,
      org_name: `Session 22 ${unique}`,
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as RegisterResponse;
  return { token: body.data.token, userId: body.data.user.id };
}

async function createPipeline(
  request: APIRequestContext,
  token: string,
): Promise<PipelineRecord> {
  const res = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(token),
    data: { name: 'TestPipeline', is_default: false },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<PipelineRecord>;
  return body.data;
}

async function createCalendarEvent(
  request: APIRequestContext,
  token: string,
  title: string,
  startTime: string = futureIso(1, 10),
  endTime: string = futureIso(1, 11),
): Promise<CalendarEventRecord> {
  const res = await request.post('/api/v1/calendar/', {
    headers: authHeaders(token),
    data: { title, start_time: startTime, end_time: endTime },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<CalendarEventRecord>;
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

  const body = (await res.json()) as DataResponse<CalendarEventRecord>;
  return body.data;
}

async function createTask(
  request: APIRequestContext,
  org: AuthOrg,
  title: string,
  dueDate: string,
): Promise<TaskRecord> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title, assigned_to: org.userId, due_date: dueDate },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<TaskRecord>;
  return body.data;
}

test('G1: POST /api/v1/contacts/import-csv rejects an empty first_name', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(token),
    data: [{ first_name: '' }],
  });

  expect(res.status()).toBe(400);
});

test('G2: POST /api/v1/contacts/import-csv rejects an unsupported contact type', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(token),
    data: [{ first_name: 'Alice', type: 'vendor' }],
  });

  expect(res.status()).toBe(400);
});

test('G4: GET /api/v1/analytics/conversion-rates returns an empty transition set for a pipeline with no stages', async ({ request }) => {
  const org = await registerOrg(request, 'g4-conversion-rates');
  const pipeline = await createPipeline(request, org.token);

  const res = await request.get(`/api/v1/analytics/conversion-rates?pipeline_id=${pipeline.id}`, {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ConversionRatesResponse;
  expect(body.data).toHaveLength(1);
  expect(body.data[0].pipeline_id).toBe(pipeline.id);
  expect(body.data[0].transitions).toEqual([]);
  expect(typeof body.data[0].note).toBe('string');
  expect(body.data[0].note.length).toBeGreaterThan(0);
});

test('G8: GET /api/v1/tasks/overdue returns an empty list for a fresh org', async ({ request }) => {
  const org = await registerOrg(request, 'g8-overdue-empty');

  const res = await request.get('/api/v1/tasks/overdue', {
    headers: authHeaders(org.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as TaskListResponse;
  expect(body).toEqual({ data: [], meta: {} });
});

test('G9: GET /api/v1/tasks/overdue excludes completed and cancelled overdue tasks', async ({ request }) => {
  const org = await registerOrg(request, 'g9-overdue-statuses');
  const dueDate = new Date(Date.now() - 2 * 86400000).toISOString();
  const taskA = await createTask(request, org, 'G9 Task A', dueDate);
  const taskB = await createTask(request, org, 'G9 Task B', dueDate);
  const taskC = await createTask(request, org, 'G9 Task C', dueDate);

  const completeRes = await request.post(`/api/v1/tasks/${taskB.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);

  const cancelRes = await request.delete(`/api/v1/tasks/${taskC.id}`, {
    headers: authHeaders(org.token),
  });
  expect(cancelRes.status()).toBe(200);

  const res = await request.get('/api/v1/tasks/overdue', {
    headers: authHeaders(org.token),
  });
  expect(res.status()).toBe(200);

  const body = (await res.json()) as TaskListResponse;
  const overdueIds = body.data.map((task) => task.id);
  expect(overdueIds).toContain(taskA.id);
  expect(overdueIds).not.toContain(taskB.id);
  expect(overdueIds).not.toContain(taskC.id);
});

test('G11: GET /api/v1/analytics/conversion-rates is scoped to the requester org', async ({ request }) => {
  const orgA = await registerOrg(request, 'g11-org-a');
  const pipelineA = await createPipeline(request, orgA.token);
  const orgB = await registerOrg(request, 'g11-org-b');

  const res = await request.get('/api/v1/analytics/conversion-rates', {
    headers: authHeaders(orgB.token),
  });

  expect(res.status()).toBe(200);
  const body = (await res.json()) as ConversionRatesResponse;
  expect(body.data.some((pipeline) => pipeline.pipeline_id === pipelineA.id)).toBe(false);
});

test('G12: POST /api/v1/contacts/import-csv rejects a whitespace-only first_name', async ({ request }) => {
  const { token } = getAuth();

  const res = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(token),
    data: [{ first_name: '   ' }],
  });

  expect(res.status()).toBe(400);
});

void playwrightRequest;
