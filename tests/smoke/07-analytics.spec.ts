import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface RegisterResponse {
  data: {
    token: string;
    user: { id: string };
  };
}

interface AuthOrg {
  token: string;
  userId: string;
}

interface PipelineStageRecord {
  id: string;
  name: string;
  position: number;
}

interface PipelineRecord {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStageRecord[];
}

interface PipelineListResponse {
  data: PipelineRecord[];
}

interface ContactRecord {
  id: string;
  first_name: string;
}

interface DealRecord {
  id: string;
  title: string;
  status: string;
}

interface FunnelStageEntry {
  stage_id: string;
  open: number;
  won: number;
  lost: number;
  total: number;
  total_value: number;
  conversion_rate: number | null;
}

interface FunnelSummary {
  total_deals: number;
  total_won: number;
  total_lost: number;
  total_value: number;
  overall_conversion_rate: number | null;
}

interface FunnelResponse {
  data: {
    stages: FunnelStageEntry[];
    summary: FunnelSummary;
  };
  meta: Record<string, unknown>;
}

interface RevenueEntry {
  period: string;
  deal_count: number;
  revenue: number;
  avg_deal_value: number;
}

interface RevenueResponse {
  data: {
    periods: RevenueEntry[];
    summary: Record<string, unknown>;
  };
  meta: Record<string, unknown>;
}

interface TeamActivityEntry {
  user_id: string;
  name: string;
  messages: number;
  tasks: number;
  meetings: number;
  total: number;
}

interface RepPerformanceEntry {
  user_id: string;
  name: string;
  deals_total: number;
  deals_won: number;
  deals_lost: number;
  total_value: number;
  win_rate: number;
}

interface LeadSourceEntry {
  source: string;
  count: number;
  total_value: number;
}

interface WinLossResponse {
  data: {
    won: { count: number; total_value: number };
    lost: { count: number; total_value: number };
    reasons: unknown[];
  };
  meta: Record<string, unknown>;
}

interface DashboardResponse {
  data: {
    open_deals: { count: number; total_value: number };
    tasks_due_today: number;
    recent_activity: Array<{ type: string; id: string; summary: string; created_at: string }>;
    pipeline_health_score: number;
  };
  meta: Record<string, unknown>;
}

interface DataResponse<T> {
  data: T;
  meta: Record<string, unknown>;
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
  meta: Record<string, unknown>;
}

interface StageDurationEntry {
  stage_id: string;
  stage_name: string;
  pipeline_id: string;
  avg_days: number;
  deal_count: number;
}

interface StageDurationResponse {
  data: StageDurationEntry[];
  meta: { note: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10) + 'T12:00:00.000Z';
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

async function getDefaultPipeline(request: APIRequestContext, token: string): Promise<PipelineRecord> {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as PipelineListResponse;
  return body.data.find((p) => p.is_default) ?? body.data[0];
}

async function createContact(
  request: APIRequestContext,
  token: string,
  opts: { firstName?: string; source?: string } = {},
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: {
      first_name: opts.firstName ?? uniqueSuffix('Contact'),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<ContactRecord>;
  return body.data;
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  opts: {
    contactId: string;
    pipelineId: string;
    stageId: string;
    value?: number;
    title?: string;
    assignedTo?: string;
    source?: string;
  },
): Promise<DealRecord> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: {
      title: opts.title ?? uniqueSuffix('Deal'),
      contact_id: opts.contactId,
      pipeline_id: opts.pipelineId,
      stage_id: opts.stageId,
      ...(opts.value !== undefined ? { value: opts.value, currency: 'USD' } : {}),
      ...(opts.assignedTo !== undefined ? { assigned_to: opts.assignedTo } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<DealRecord>;
  return body.data;
}

async function markDealWon(request: APIRequestContext, token: string, dealId: string): Promise<void> {
  const res = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: authHeaders(token),
    data: {},
  });
  expect(res.status()).toBe(200);
}

async function markDealLost(request: APIRequestContext, token: string, dealId: string): Promise<void> {
  const res = await request.post(`/api/v1/deals/${dealId}/lost`, {
    headers: authHeaders(token),
    data: {},
  });
  expect(res.status()).toBe(200);
}

async function moveDealStage(
  request: APIRequestContext,
  token: string,
  dealId: string,
  stageId: string,
): Promise<void> {
  const res = await request.patch(`/api/v1/deals/${dealId}`, {
    headers: authHeaders(token),
    data: { stage_id: stageId },
  });
  expect(res.status()).toBe(200);
}

// ---------------------------------------------------------------------------
// Existing 10 tests (DO NOT MODIFY)
// ---------------------------------------------------------------------------

test('GET /api/v1/analytics/funnel returns funnel data', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/funnel', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    stages: expect.any(Array),
    summary: expect.any(Object),
  });
});

test('GET /api/v1/analytics/revenue returns revenue data', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/revenue', {
    headers: { Authorization: `Bearer ${token}` },
    params: { period: 'month' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    periods: expect.any(Array),
    summary: expect.any(Object),
  });
});

test('GET /api/v1/analytics/team-activity returns per-user activity', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/team-activity', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/analytics/rep-performance returns per-rep deal metrics', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/rep-performance', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/analytics/lead-sources returns grouped lead source counts', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/lead-sources', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/v1/analytics/win-loss returns won/lost breakdown', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/win-loss', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    won: { count: expect.any(Number), total_value: expect.any(Number) },
    lost: { count: expect.any(Number), total_value: expect.any(Number) },
    reasons: expect.any(Array),
  });
});

test('GET /api/v1/analytics/dashboard returns home screen aggregates', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({
    open_deals: {
      count: expect.any(Number),
      total_value: expect.any(Number),
    },
    tasks_due_today: expect.any(Number),
    recent_activity: expect.any(Array),
    pipeline_health_score: expect.any(Number),
  });
  // recent_activity must be at most 5 items
  expect(body.data.recent_activity.length).toBeLessThanOrEqual(5);
  // pipeline_health_score must be >= 0 and <= 100
  expect(body.data.pipeline_health_score).toBeGreaterThanOrEqual(0);
  expect(body.data.pipeline_health_score).toBeLessThanOrEqual(100);
});

test('pipeline_health_score is 0 when org has no won, lost, or stalled deals (zero-guard)', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `phs-zero-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'PHS Zero User',
      org_name: 'PHS Zero Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.pipeline_health_score).toBe(0);
});

test('pipeline_health_score increases from 0 to non-zero after a deal is moved to won status', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `phs-recalc-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'PHS Recalc User',
      org_name: 'PHS Recalc Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const freshToken: string = (await regRes.json()).data.token;

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  const pipelines = (await pipelinesRes.json()).data;
  const pipeline = (pipelines as { is_default: boolean; id: string; stages: { id: string }[] }[]).find(
    (p) => p.is_default,
  ) ?? pipelines[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { first_name: 'PHSReCalc' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: {
      title: 'PHS Retest Deal',
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: pipeline.stages[0].id,
      value: 5000,
      currency: 'USD',
    },
  });
  expect(dealRes.status()).toBe(201);
  const dealId: string = (await dealRes.json()).data.id;

  const before = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect((await before.json()).data.pipeline_health_score).toBe(0);

  const wonRes = await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const after = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(after.status()).toBe(200);
  expect((await after.json()).data.pipeline_health_score).toBeGreaterThan(0);
});

test('dashboard recent_activity is capped at exactly 5 items when pool contains more than 5', async ({ request }) => {
  const regRes = await request.post('/api/v1/auth/', {
    data: {
      email: `phs-activity-${Date.now()}@test.com`,
      password: 'Test1234!',
      name: 'Activity Cap User',
      org_name: 'Activity Cap Org',
    },
  });
  expect(regRes.status()).toBe(201);
  const regBody = await regRes.json();
  const freshToken: string = regBody.data.token;
  const userId: string = regBody.data.user.id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${freshToken}` },
    data: { first_name: 'ActivityCapTest' },
  });
  const contactId: string = (await contactRes.json()).data.id;

  for (let i = 0; i < 3; i++) {
    await request.post('/api/v1/messages/in-app', {
      headers: { Authorization: `Bearer ${freshToken}` },
      data: { contact_id: contactId, body: `Cap test message ${i}` },
    });
  }

  for (let i = 0; i < 3; i++) {
    await request.post('/api/v1/tasks', {
      headers: { Authorization: `Bearer ${freshToken}` },
      data: { title: `Cap test task ${i}`, assigned_to: userId, contact_id: contactId },
    });
  }

  const res = await request.get('/api/v1/analytics/dashboard', {
    headers: { Authorization: `Bearer ${freshToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.recent_activity).toHaveLength(5);
});

// ---------------------------------------------------------------------------
// Rung 4 & 5 — 45 new tests
// ---------------------------------------------------------------------------

// --- Funnel ---

test('GET /api/v1/analytics/funnel for a fresh org returns all-zero stage counts', async ({ request }) => {
  const org = await registerOrg(request, 'funnel-fresh');
  const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as FunnelResponse;
  expect(Array.isArray(body.data.stages)).toBe(true);
  for (const stage of body.data.stages) {
    expect(stage.open).toBe(0);
    expect(stage.won).toBe(0);
    expect(stage.lost).toBe(0);
  }
  expect(body.data.summary.total_deals).toBe(0);
  expect(body.data.summary.total_won).toBe(0);
  expect(body.data.summary.total_lost).toBe(0);
});

test('GET /api/v1/analytics/funnel response has correct structure: array of stage objects with numeric counts', async ({ request }) => {
  const org = await registerOrg(request, 'funnel-structure');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });

  const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as FunnelResponse;
  expect(Array.isArray(body.data.stages)).toBe(true);
  expect(body.data.stages.length).toBeGreaterThan(0);
  const s = body.data.stages[0];
  expect(typeof s.stage_id).toBe('string');
  expect(typeof s.open).toBe('number');
  expect(typeof s.won).toBe('number');
  expect(typeof s.lost).toBe('number');
  expect(typeof s.total).toBe('number');
  expect(typeof s.total_value).toBe('number');
  expect(s.conversion_rate === null || typeof s.conversion_rate === 'number').toBe(true);
});

test('GET /api/v1/analytics/funnel after creating a deal reflects open count increment in the deal\'s stage', async ({ request }) => {
  const org = await registerOrg(request, 'funnel-open-count');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const stageId = pipeline.stages[0].id;

  const before = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  const beforeBody = (await before.json()) as FunnelResponse;
  const openBefore = beforeBody.data.stages.find((s) => s.stage_id === stageId)?.open ?? 0;

  await createDeal(request, org.token, { contactId: contact.id, pipelineId: pipeline.id, stageId });

  const after = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(after.status()).toBe(200);
  const afterBody = (await after.json()) as FunnelResponse;
  const openAfter = afterBody.data.stages.find((s) => s.stage_id === stageId)?.open ?? 0;
  expect(openAfter).toBe(openBefore + 1);
});

test('GET /api/v1/analytics/funnel after marking a deal won reflects won count in the correct stage', async ({ request }) => {
  const org = await registerOrg(request, 'funnel-won-count');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const stageId = pipeline.stages[0].id;
  const deal = await createDeal(request, org.token, { contactId: contact.id, pipelineId: pipeline.id, stageId });
  await markDealWon(request, org.token, deal.id);

  const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as FunnelResponse;
  const stage = body.data.stages.find((s) => s.stage_id === stageId);
  expect(stage).toBeDefined();
  if (stage !== undefined) {
    expect(stage.won).toBeGreaterThan(0);
  }
});

test('GET /api/v1/analytics/funnel is org-scoped: Org B funnel unaffected by Org A deals', async ({ request }) => {
  const orgA = await registerOrg(request, 'funnel-scope-a');
  const orgB = await registerOrg(request, 'funnel-scope-b');

  const pipeline = await getDefaultPipeline(request, orgA.token);
  const contact = await createContact(request, orgA.token);
  await createDeal(request, orgA.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 9999,
  });

  const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(orgB.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as FunnelResponse;
  const totalOpen = body.data.stages.reduce((sum, s) => sum + s.open, 0);
  expect(totalOpen).toBe(0);
});

// --- Revenue ---

test('GET /api/v1/analytics/revenue for a fresh org returns zero-revenue summary', async ({ request }) => {
  const org = await registerOrg(request, 'revenue-fresh');
  const res = await request.get('/api/v1/analytics/revenue', {
    headers: authHeaders(org.token),
    params: { period: 'month' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as RevenueResponse;
  expect(Array.isArray(body.data.periods)).toBe(true);
  const totalRevenue = body.data.periods.reduce((sum, p) => sum + p.revenue, 0);
  expect(totalRevenue).toBe(0);
});

test('GET /api/v1/analytics/revenue periods include required fields: period, deal_count, revenue, avg_deal_value', async ({ request }) => {
  const org = await registerOrg(request, 'revenue-fields');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 1000,
  });
  await markDealWon(request, org.token, deal.id);

  const res = await request.get('/api/v1/analytics/revenue', {
    headers: authHeaders(org.token),
    params: { period: 'month' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as RevenueResponse;
  expect(Array.isArray(body.data.periods)).toBe(true);
  const wonPeriod = body.data.periods.find((p) => p.deal_count > 0);
  expect(wonPeriod).toBeDefined();
  if (wonPeriod !== undefined) {
    expect(typeof wonPeriod.period).toBe('string');
    expect(typeof wonPeriod.deal_count).toBe('number');
    expect(typeof wonPeriod.revenue).toBe('number');
    expect(typeof wonPeriod.avg_deal_value).toBe('number');
    expect(wonPeriod.revenue).toBeGreaterThan(0);
  }
});

test('GET /api/v1/analytics/revenue after winning a deal reflects revenue increase', async ({ request }) => {
  const org = await registerOrg(request, 'revenue-after-won');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);

  const beforeRes = await request.get('/api/v1/analytics/revenue', {
    headers: authHeaders(org.token),
    params: { period: 'month' },
  });
  const beforeBody = (await beforeRes.json()) as RevenueResponse;
  const revenueBefore = beforeBody.data.periods.reduce((sum, p) => sum + p.revenue, 0);

  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 2500,
  });
  await markDealWon(request, org.token, deal.id);

  const afterRes = await request.get('/api/v1/analytics/revenue', {
    headers: authHeaders(org.token),
    params: { period: 'month' },
  });
  expect(afterRes.status()).toBe(200);
  const afterBody = (await afterRes.json()) as RevenueResponse;
  const revenueAfter = afterBody.data.periods.reduce((sum, p) => sum + p.revenue, 0);
  expect(revenueAfter).toBeGreaterThan(revenueBefore);
});

test('GET /api/v1/analytics/revenue is org-scoped: Org B revenue unaffected by Org A won deals', async ({ request }) => {
  const orgA = await registerOrg(request, 'revenue-scope-a');
  const orgB = await registerOrg(request, 'revenue-scope-b');

  const pipeline = await getDefaultPipeline(request, orgA.token);
  const contact = await createContact(request, orgA.token);
  const deal = await createDeal(request, orgA.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 5000,
  });
  await markDealWon(request, orgA.token, deal.id);

  const res = await request.get('/api/v1/analytics/revenue', {
    headers: authHeaders(orgB.token),
    params: { period: 'month' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as RevenueResponse;
  const totalRevenue = body.data.periods.reduce((sum, p) => sum + p.revenue, 0);
  expect(totalRevenue).toBe(0);
});

// --- Team Activity ---

test('GET /api/v1/analytics/team-activity for a fresh org returns an array (empty or with zero-count user row)', async ({ request }) => {
  const org = await registerOrg(request, 'team-activity-fresh');
  const res = await request.get('/api/v1/analytics/team-activity', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<TeamActivityEntry[]>;
  expect(Array.isArray(body.data)).toBe(true);
  if (body.data.length > 0) {
    const allZero = body.data.every((u) => u.messages === 0 && u.tasks === 0 && u.meetings === 0);
    expect(allZero).toBe(true);
  }
});

test('GET /api/v1/analytics/team-activity after creating a message reflects incremented message count for the user', async ({ request }) => {
  const org = await registerOrg(request, 'team-activity-msg');
  const contact = await createContact(request, org.token);
  await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, body: 'Team activity message test' },
  });

  const res = await request.get('/api/v1/analytics/team-activity', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<TeamActivityEntry[]>;
  expect(body.data.length).toBeGreaterThan(0);
  const userRow = body.data.find((u) => u.user_id === org.userId);
  expect(userRow).toBeDefined();
  if (userRow !== undefined) {
    expect(userRow.messages).toBeGreaterThan(0);
  }
});

test('GET /api/v1/analytics/team-activity is org-scoped: Org B activity not visible in Org A results', async ({ request }) => {
  const orgA = await registerOrg(request, 'team-activity-scope-a');
  const orgB = await registerOrg(request, 'team-activity-scope-b');
  const contactB = await createContact(request, orgB.token);
  await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(orgB.token),
    data: { contact_id: contactB.id, body: 'Org B only message' },
  });

  const res = await request.get('/api/v1/analytics/team-activity', { headers: authHeaders(orgA.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<TeamActivityEntry[]>;
  const orgBRow = body.data.find((u) => u.user_id === orgB.userId);
  expect(orgBRow).toBeUndefined();
});

// --- Rep Performance ---

test('GET /api/v1/analytics/rep-performance shows the current user\'s metrics in the result set', async ({ request }) => {
  const org = await registerOrg(request, 'rep-perf-current-user');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 3000,
    assignedTo: org.userId,
  });
  await markDealWon(request, org.token, deal.id);

  const res = await request.get('/api/v1/analytics/rep-performance', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<RepPerformanceEntry[]>;
  expect(Array.isArray(body.data)).toBe(true);
  const myRow = body.data.find((r) => r.user_id === org.userId);
  expect(myRow).toBeDefined();
  if (myRow !== undefined) {
    expect(myRow.deals_won).toBeGreaterThan(0);
    expect(myRow.total_value).toBeGreaterThan(0);
  }
});

test('GET /api/v1/analytics/rep-performance is org-scoped: Org B user not present in Org A results', async ({ request }) => {
  const orgA = await registerOrg(request, 'rep-perf-scope-a');
  const orgB = await registerOrg(request, 'rep-perf-scope-b');

  const res = await request.get('/api/v1/analytics/rep-performance', { headers: authHeaders(orgA.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<RepPerformanceEntry[]>;
  const orgBRow = body.data.find((r) => r.user_id === orgB.userId);
  expect(orgBRow).toBeUndefined();
});

// --- Lead Sources ---

test('GET /api/v1/analytics/lead-sources for a fresh org returns an empty array', async ({ request }) => {
  const org = await registerOrg(request, 'lead-sources-fresh');
  const res = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<LeadSourceEntry[]>;
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBe(0);
});

test('GET /api/v1/analytics/lead-sources after creating deals with a source field reflects that source', async ({ request }) => {
  const org = await registerOrg(request, 'lead-sources-data');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token, { firstName: 'LeadSrcContact' });
  await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, source: 'website',
  });
  await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, source: 'website',
  });
  await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, source: 'referral',
  });

  const res = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<LeadSourceEntry[]>;
  expect(Array.isArray(body.data)).toBe(true);
  const websiteRow = body.data.find((s) => s.source === 'website');
  expect(websiteRow).toBeDefined();
  if (websiteRow !== undefined) {
    expect(websiteRow.count).toBe(2);
  }
  const referralRow = body.data.find((s) => s.source === 'referral');
  expect(referralRow).toBeDefined();
  if (referralRow !== undefined) {
    expect(referralRow.count).toBe(1);
  }
});

test('GET /api/v1/analytics/lead-sources is org-scoped: Org B source data not visible in Org A results', async ({ request }) => {
  const orgA = await registerOrg(request, 'lead-sources-scope-a');
  const orgB = await registerOrg(request, 'lead-sources-scope-b');
  await createContact(request, orgB.token, { firstName: 'OrgBContact', source: 'cold_call' });

  const res = await request.get('/api/v1/analytics/lead-sources', { headers: authHeaders(orgA.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<LeadSourceEntry[]>;
  const coldCallRow = body.data.find((s) => s.source === 'cold_call');
  expect(coldCallRow).toBeUndefined();
});

test('POST /api/v1/analytics/export lead_sources CSV contains a data row when deals have source field set', async ({ request }) => {
  const org = await registerOrg(request, 'export-lead-sources-data');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token, { firstName: 'ExportSrcContact' });
  await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, source: 'social_media',
  });

  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(org.token),
    data: { format: 'csv', report: 'lead_sources', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  // Must have header plus at least one data row
  expect(lines.length).toBeGreaterThan(1);
  expect(lines[0]).toBe('source,count,total_value');
  const hasSocialMedia = lines.some((l) => l.startsWith('social_media,'));
  expect(hasSocialMedia).toBe(true);
});

// --- Win-Loss ---

test('GET /api/v1/analytics/win-loss for a fresh org returns zero counts for won and lost', async ({ request }) => {
  const org = await registerOrg(request, 'win-loss-fresh');
  const res = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as WinLossResponse;
  expect(body.data.won.count).toBe(0);
  expect(body.data.won.total_value).toBe(0);
  expect(body.data.lost.count).toBe(0);
  expect(body.data.lost.total_value).toBe(0);
});

test('GET /api/v1/analytics/win-loss after winning and losing deals reflects correct breakdown', async ({ request }) => {
  const org = await registerOrg(request, 'win-loss-counts');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const stageId = pipeline.stages[0].id;

  const wonDeal = await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId, value: 1000,
  });
  const lostDeal = await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId, value: 500,
  });
  await markDealWon(request, org.token, wonDeal.id);
  await markDealLost(request, org.token, lostDeal.id);

  const res = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as WinLossResponse;
  expect(body.data.won.count).toBe(1);
  expect(body.data.lost.count).toBe(1);
  expect(body.data.won.total_value).toBeGreaterThan(0);
  expect(body.data.lost.total_value).toBeGreaterThan(0);
});

test('GET /api/v1/analytics/win-loss is org-scoped: Org B closed deals not counted in Org A win-loss', async ({ request }) => {
  const orgA = await registerOrg(request, 'win-loss-scope-a');
  const orgB = await registerOrg(request, 'win-loss-scope-b');

  const pipeline = await getDefaultPipeline(request, orgB.token);
  const contact = await createContact(request, orgB.token);
  const deal = await createDeal(request, orgB.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, value: 9000,
  });
  await markDealWon(request, orgB.token, deal.id);

  const res = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(orgA.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as WinLossResponse;
  expect(body.data.won.count).toBe(0);
  expect(body.data.lost.count).toBe(0);
});

// --- Dashboard ---

test('GET /api/v1/analytics/dashboard open_deals.count is 0 for a fresh org', async ({ request }) => {
  const org = await registerOrg(request, 'dash-fresh-count');
  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.open_deals.count).toBe(0);
});

test('GET /api/v1/analytics/dashboard open_deals.total_value is 0 for a fresh org', async ({ request }) => {
  const org = await registerOrg(request, 'dash-fresh-value');
  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.open_deals.total_value).toBe(0);
});

test('GET /api/v1/analytics/dashboard tasks_due_today is 0 for a fresh org with no tasks', async ({ request }) => {
  const org = await registerOrg(request, 'dash-fresh-tasks');
  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.tasks_due_today).toBe(0);
});

test('GET /api/v1/analytics/dashboard recent_activity.items is empty for a fresh org', async ({ request }) => {
  const org = await registerOrg(request, 'dash-fresh-activity');
  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.recent_activity).toHaveLength(0);
});

test('GET /api/v1/analytics/dashboard after creating one open deal, open_deals.count is 1', async ({ request }) => {
  const org = await registerOrg(request, 'dash-open-count-1');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });

  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.open_deals.count).toBe(1);
});

test('GET /api/v1/analytics/dashboard after creating a deal with value 500, open_deals.total_value equals 500', async ({ request }) => {
  const org = await registerOrg(request, 'dash-open-value-500');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 500,
  });

  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(Number(body.data.open_deals.total_value)).toBe(500);
});

test('GET /api/v1/analytics/dashboard after marking the only open deal won, open_deals.total_value decreases to 0', async ({ request }) => {
  const org = await registerOrg(request, 'dash-value-decrease');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 1200,
  });

  const before = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect((await before.json() as DashboardResponse).data.open_deals.count).toBe(1);

  await markDealWon(request, org.token, deal.id);

  const after = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(after.status()).toBe(200);
  const afterBody = (await after.json()) as DashboardResponse;
  expect(afterBody.data.open_deals.count).toBe(0);
  expect(Number(afterBody.data.open_deals.total_value)).toBe(0);
});

test('GET /api/v1/analytics/dashboard after creating a task due today, tasks_due_today count is at least 1', async ({ request }) => {
  const org = await registerOrg(request, 'dash-task-today');
  await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'Due today task', assigned_to: org.userId, due_date: todayIso() },
  });

  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.tasks_due_today).toBeGreaterThanOrEqual(1);
});

test('GET /api/v1/analytics/dashboard recent_activity items have required fields: type, id, summary, created_at', async ({ request }) => {
  const org = await registerOrg(request, 'dash-activity-fields');
  const contact = await createContact(request, org.token);
  await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, body: 'Activity field test message' },
  });

  const res = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DashboardResponse;
  expect(body.data.recent_activity.length).toBeGreaterThan(0);
  for (const item of body.data.recent_activity) {
    expect(typeof item.type).toBe('string');
    expect(typeof item.id).toBe('string');
    expect(typeof item.summary).toBe('string');
    expect(typeof item.created_at).toBe('string');
  }
});

// --- Conversion Rates ---

test('GET /api/v1/analytics/conversion-rates: moving a deal from stage[0] to stage[1] increments transition conversion data', async ({ request }) => {
  const org = await registerOrg(request, 'cvr-move-stage');
  const pipeline = await getDefaultPipeline(request, org.token);
  if (pipeline.stages.length < 2) {
    // Pipeline has only one stage — skip the move assertion, just verify structure
    const res = await request.get('/api/v1/analytics/conversion-rates', { headers: authHeaders(org.token) });
    expect(res.status()).toBe(200);
    return;
  }

  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });
  await moveDealStage(request, org.token, deal.id, pipeline.stages[1].id);

  const res = await request.get(
    `/api/v1/analytics/conversion-rates?pipeline_id=${pipeline.id}`,
    { headers: authHeaders(org.token) },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ConversionRatesResponse;
  expect(body.data.length).toBe(1);
  const pipelineData = body.data[0];
  expect(pipelineData.transitions.length).toBeGreaterThan(0);
  const firstTransition = pipelineData.transitions[0];
  expect(firstTransition.entered_count).toBeGreaterThan(0);
});

test('GET /api/v1/analytics/conversion-rates after multiple stage moves reflects incremented transition counts', async ({ request }) => {
  const org = await registerOrg(request, 'cvr-multi-move');
  const pipeline = await getDefaultPipeline(request, org.token);
  if (pipeline.stages.length < 2) {
    const res = await request.get('/api/v1/analytics/conversion-rates', { headers: authHeaders(org.token) });
    expect(res.status()).toBe(200);
    return;
  }

  const contact = await createContact(request, org.token);
  const dealA = await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id,
  });
  const dealB = await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id,
  });
  await moveDealStage(request, org.token, dealA.id, pipeline.stages[1].id);
  await moveDealStage(request, org.token, dealB.id, pipeline.stages[1].id);

  const res = await request.get(
    `/api/v1/analytics/conversion-rates?pipeline_id=${pipeline.id}`,
    { headers: authHeaders(org.token) },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ConversionRatesResponse;
  const firstTransition = body.data[0].transitions[0];
  expect(firstTransition.entered_count).toBeGreaterThanOrEqual(2);
});

// --- Stage Duration ---

test('GET /api/v1/analytics/stage-duration deal_count increments when a deal is placed in a stage', async ({ request }) => {
  const org = await registerOrg(request, 'stage-dur-count');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const stageId = pipeline.stages[0].id;
  await createDeal(request, org.token, { contactId: contact.id, pipelineId: pipeline.id, stageId });

  const res = await request.get('/api/v1/analytics/stage-duration', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as StageDurationResponse;
  const stageEntry = body.data.find((e) => e.stage_id === stageId);
  expect(stageEntry).toBeDefined();
  if (stageEntry !== undefined) {
    expect(stageEntry.deal_count).toBeGreaterThanOrEqual(1);
    expect(stageEntry.avg_days).toBeGreaterThanOrEqual(0);
  }
});

test('GET /api/v1/analytics/stage-duration pipeline_id filter returns only stages from that pipeline', async ({ request }) => {
  const org = await registerOrg(request, 'stage-dur-pipeline-filter');
  const pipeline = await getDefaultPipeline(request, org.token);

  // Create a second pipeline to ensure filter excludes it
  const pipelineBRes = await request.post('/api/v1/deals/pipelines', {
    headers: authHeaders(org.token),
    data: { name: uniqueSuffix('SecondPipeline'), is_default: false },
  });
  const pipelineBBody = (await pipelineBRes.json()) as DataResponse<PipelineRecord>;
  const pipelineB = pipelineBBody.data;

  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });

  const res = await request.get(
    `/api/v1/analytics/stage-duration?pipeline_id=${pipeline.id}`,
    { headers: authHeaders(org.token) },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as StageDurationResponse;
  for (const entry of body.data) {
    expect(entry.pipeline_id).toBe(pipeline.id);
    expect(entry.pipeline_id).not.toBe(pipelineB.id);
  }
});

// --- Export ---

test('POST /api/v1/analytics/export with unknown report type returns 400 validation error', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'unknown_report_xyz', period: 'month' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/analytics/export with missing format returns 400 validation error', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { report: 'funnel', period: 'month' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/analytics/export with missing report returns 400 validation error', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', period: 'month' },
  });
  expect(res.status()).toBe(400);
});

test('POST /api/v1/analytics/export with missing period uses default month period', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'funnel' },
  });
  expect(res.status()).toBe(200);
});

test('POST /api/v1/analytics/export with format=csv and report=revenue returns 200 with correct column headers in body', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'revenue', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType).toContain('text/csv');
  const text = await res.text();
  const firstLine = text.split('\n')[0];
  expect(firstLine).toBe('period,deal_count,revenue,avg_deal_value');
});

test('POST /api/v1/analytics/export with period=quarter returns 200', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'funnel', period: 'quarter' },
  });
  expect(res.status()).toBe(200);
});

test('POST /api/v1/analytics/export with period=year returns 200', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'funnel', period: 'year' },
  });
  expect(res.status()).toBe(200);
});

test('POST /api/v1/analytics/export funnel CSV has multiple rows when deals exist in different stages', async ({ request }) => {
  const org = await registerOrg(request, 'export-funnel-rows');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);

  // Place a deal in the first stage
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
    value: 750,
  });

  // Place a deal in the last stage if multiple stages exist
  if (pipeline.stages.length > 1) {
    await createDeal(request, org.token, {
      contactId: contact.id,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[pipeline.stages.length - 1].id,
      value: 1500,
    });
  }

  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(org.token),
    data: { format: 'csv', report: 'funnel', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  // Header row + at least one data row
  expect(lines.length).toBeGreaterThan(1);
  expect(lines[0]).toBe('stage_id,open,won,lost,total,total_value,conversion_rate');
});

test('POST /api/v1/analytics/export with format=csv and report=funnel returns Content-Disposition: attachment with report name', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'funnel', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const disposition = res.headers()['content-disposition'] ?? '';
  expect(disposition).toContain('attachment');
  expect(disposition).toContain('funnel');
});

test('POST /api/v1/analytics/export with format=csv and report=team_activity returns Content-Disposition: attachment', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'team_activity', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const disposition = res.headers()['content-disposition'] ?? '';
  expect(disposition).toContain('attachment');
});

test('POST /api/v1/analytics/export with format=csv and report=win_loss returns Content-Disposition: attachment', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'win_loss', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const disposition = res.headers()['content-disposition'] ?? '';
  expect(disposition).toContain('attachment');
});

test('POST /api/v1/analytics/export with format=pdf and report=revenue returns a PDF attachment', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'pdf', report: 'revenue', period: 'quarter' },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  expect(res.headers()['content-disposition']).toContain('revenue');
});

test('POST /api/v1/analytics/export with format=csv and report=revenue Content-Type is text/csv', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report: 'revenue', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType).toContain('text/csv');
});

// --- Rung 5: cross-endpoint consistency and deeper invariants ---

test('GET /api/v1/analytics/funnel summary.total_deals matches sum of total across all stage entries', async ({ request }) => {
  const org = await registerOrg(request, 'funnel-summary-consistency');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });

  const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as FunnelResponse;
  const sumTotal = body.data.stages.reduce((acc, s) => acc + s.total, 0);
  expect(sumTotal).toBe(body.data.summary.total_deals);
});

test('GET /api/v1/analytics/funnel summary.total_won matches sum of won across all stage entries', async ({ request }) => {
  const org = await registerOrg(request, 'funnel-won-summary');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });
  await markDealWon(request, org.token, deal.id);

  const res = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as FunnelResponse;
  const sumWon = body.data.stages.reduce((acc, s) => acc + s.won, 0);
  expect(sumWon).toBe(body.data.summary.total_won);
});

test('GET /api/v1/analytics/win-loss won.count equals rep-performance total deals_won for assigned single-user org', async ({ request }) => {
  const org = await registerOrg(request, 'win-loss-vs-rep-perf');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);

  const dealA = await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, value: 100, assignedTo: org.userId,
  });
  const dealB = await createDeal(request, org.token, {
    contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, value: 200, assignedTo: org.userId,
  });
  await markDealWon(request, org.token, dealA.id);
  await markDealWon(request, org.token, dealB.id);

  const winLossRes = await request.get('/api/v1/analytics/win-loss', { headers: authHeaders(org.token) });
  const winLossBody = (await winLossRes.json()) as WinLossResponse;
  const winLossWonCount = winLossBody.data.won.count;

  const repRes = await request.get('/api/v1/analytics/rep-performance', { headers: authHeaders(org.token) });
  const repBody = (await repRes.json()) as DataResponse<RepPerformanceEntry[]>;
  const repWonTotal = repBody.data.reduce((sum, r) => sum + r.deals_won, 0);

  expect(winLossWonCount).toBe(repWonTotal);
});

test('GET /api/v1/analytics/dashboard open_deals.count equals sum of funnel open entries for a fresh org with one deal', async ({ request }) => {
  const org = await registerOrg(request, 'dash-funnel-consistency');
  const pipeline = await getDefaultPipeline(request, org.token);
  const contact = await createContact(request, org.token);
  await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0].id,
  });

  const dashRes = await request.get('/api/v1/analytics/dashboard', { headers: authHeaders(org.token) });
  const dashBody = (await dashRes.json()) as DashboardResponse;
  const dashOpenCount = dashBody.data.open_deals.count;

  const funnelRes = await request.get('/api/v1/analytics/funnel', { headers: authHeaders(org.token) });
  const funnelBody = (await funnelRes.json()) as FunnelResponse;
  const funnelOpenTotal = funnelBody.data.stages.reduce((sum, stage) => sum + stage.open, 0);

  expect(dashOpenCount).toBe(funnelOpenTotal);
});

test('GET /api/v1/analytics/team-activity total field equals sum of messages + tasks + meetings for each user row', async ({ request }) => {
  const org = await registerOrg(request, 'team-activity-total-sum');
  const contact = await createContact(request, org.token);
  await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, body: 'Team total sum msg' },
  });
  await request.post('/api/v1/tasks', {
    headers: authHeaders(org.token),
    data: { title: 'Team total sum task', assigned_to: org.userId },
  });

  const res = await request.get('/api/v1/analytics/team-activity', { headers: authHeaders(org.token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<TeamActivityEntry[]>;
  for (const row of body.data) {
    expect(row.total).toBe(row.messages + row.tasks + row.meetings);
  }
});
