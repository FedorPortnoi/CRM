import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

// Helper functions

function futureEvent(): { start_time: string; end_time: string } {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start_time: start.toISOString(), end_time: end.toISOString() };
}

async function registerOrg(
  request: APIRequestContext,
  suffix: string
): Promise<{ token: string; userId: string }> {
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
  const body = (await res.json()) as {
    data: { token: string; user: { id: string } };
  };
  return { token: body.data.token, userId: body.data.user.id };
}

// Calendar tests

test('GET /calendar/:id returns the event for the creating org', async ({ request }) => {
  const { token } = getAuth();
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Test Event', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string; status: string } };
  const eventId = createBody.data.id;

  const getRes = await request.get(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  const getBody = (await getRes.json()) as { data: { id: string; status: string } };
  expect(getBody.data.id).toBe(eventId);
  expect(getBody.data.status).toBe('scheduled');
});

test('GET /calendar/:id with an unknown UUID returns 404 EVENT_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar/00000000-0000-0000-0000-000000000001', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('EVENT_NOT_FOUND');
});

test("PATCH /calendar/:id using a different org\'s token returns 404 (event not found in other org\'s scope)", async ({ request }) => {
  const orgA = await registerOrg(request, 'orgA-patch');
  const orgB = await registerOrg(request, 'orgB-patch');

  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${orgA.token}` },
    data: { title: 'OrgA Event', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const eventId = createBody.data.id;

  const patchRes = await request.patch(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${orgB.token}` },
    data: { title: 'hijack' },
  });
  expect(patchRes.status()).toBe(404);
});

test('PATCH /calendar/:id on a cancelled event returns 422 EVENT_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'To Cancel', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const eventId = createBody.data.id;

  const deleteRes = await request.delete(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleteRes.status()).toBe(200);

  const patchRes = await request.patch(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Updated' },
  });
  expect(patchRes.status()).toBe(422);
  const body = (await patchRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('EVENT_CANCELLED');
});

test('DELETE /calendar/:id called twice on the same event returns 422 EVENT_ALREADY_CANCELLED on second call', async ({ request }) => {
  const { token } = getAuth();
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Double Cancel', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const eventId = createBody.data.id;

  const firstDelete = await request.delete(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(firstDelete.status()).toBe(200);

  const secondDelete = await request.delete(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(secondDelete.status()).toBe(422);
  const body = (await secondDelete.json()) as { error: { code: string } };
  expect(body.error.code).toBe('EVENT_ALREADY_CANCELLED');
});

test("DELETE /calendar/:id using a different org\'s token returns 404", async ({ request }) => {
  const orgA = await registerOrg(request, 'orgA-delete');
  const orgB = await registerOrg(request, 'orgB-delete');

  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${orgA.token}` },
    data: { title: 'OrgA Event Del', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const eventId = createBody.data.id;

  const deleteRes = await request.delete(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${orgB.token}` },
  });
  expect(deleteRes.status()).toBe(404);
});

test('POST /calendar/:id/complete on a cancelled event returns 422 EVENT_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Complete Cancelled', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const eventId = createBody.data.id;

  const deleteRes = await request.delete(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(deleteRes.status()).toBe(200);

  const completeRes = await request.post(`/api/v1/calendar/${eventId}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(completeRes.status()).toBe(422);
  const body = (await completeRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('EVENT_CANCELLED');
});

test('POST /calendar/:id/notes on a scheduled event returns 422 EVENT_NOT_COMPLETED', async ({ request }) => {
  const { token } = getAuth();
  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Notes Scheduled', ...futureEvent() },
  });
  expect(createRes.status()).toBe(201);
  const createBody = (await createRes.json()) as { data: { id: string } };
  const eventId = createBody.data.id;

  const notesRes = await request.post(`/api/v1/calendar/${eventId}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: 'agenda' },
  });
  expect(notesRes.status()).toBe(422);
  const body = (await notesRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('EVENT_NOT_COMPLETED');
});

// Messages tests

test('GET /messages/conversation/:contactId returns an empty array when the contact has no messages', async ({ request }) => {
  const { token } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'NoMsg' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const convRes = await request.get(`/api/v1/messages/conversation/${contactId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(convRes.status()).toBe(200);
  const convBody = (await convRes.json()) as { data: unknown[] };
  expect(Array.isArray(convBody.data)).toBe(true);
  expect(convBody.data.length).toBe(0);
});

test('GET /messages/conversation/:contactId returns 404 CONTACT_NOT_FOUND when the contact belongs to a different org', async ({ request }) => {
  const orgA = await registerOrg(request, 'orgA-conv');
  const orgB = await registerOrg(request, 'orgB-conv');

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${orgA.token}` },
    data: { first_name: 'OrgAContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const convRes = await request.get(`/api/v1/messages/conversation/${contactId}`, {
    headers: { Authorization: `Bearer ${orgB.token}` },
  });
  expect(convRes.status()).toBe(404);
  const body = (await convRes.json()) as { error: { code: string } };
  expect(body.error.code).toBe('CONTACT_NOT_FOUND');
});

test("POST /messages/call with no duration_seconds and no notes sets body to the literal string \'Call logged\'", async ({ request }) => {
  const { token } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'CallNoNotes' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const callRes = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, direction: 'outbound' },
  });
  expect(callRes.status()).toBe(201);
  const callBody = (await callRes.json()) as {
    data: { body: string; channel: string; status: string };
  };
  expect(callBody.data.body).toBe('Call logged');
  expect(callBody.data.channel).toBe('in_app');
  expect(callBody.data.status).toBe('delivered');
});

test('POST /messages/call with no duration_seconds but with notes sets body to the notes text without a duration prefix', async ({ request }) => {
  const { token } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'CallWithNotes' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const callRes = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, direction: 'outbound', notes: 'Follow up on proposal' },
  });
  expect(callRes.status()).toBe(201);
  const callBody = (await callRes.json()) as { data: { body: string } };
  expect(callBody.data.body).toBe('Follow up on proposal');
});

test('POST /messages/sms returns 201 with channel sms, direction outbound, and status pending', async ({ request }) => {
  const { token } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'SmsContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const smsRes = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, body: 'SMS smoke test' },
  });
  expect(smsRes.status()).toBe(201);
  const smsBody = (await smsRes.json()) as {
    data: { channel: string; direction: string; status: string; contact_id: string };
  };
  expect(smsBody.data.channel).toBe('sms');
  expect(smsBody.data.direction).toBe('outbound');
  expect(smsBody.data.status).toBe('pending');
  expect(smsBody.data.contact_id).toBe(contactId);
});

test('POST /messages/:id/read marks the message status as read and sets read_at to a non-null timestamp', async ({ request }) => {
  const { token } = getAuth();
  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'ReadContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const msgRes = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, body: 'to be read' },
  });
  expect(msgRes.status()).toBe(201);
  const msgBody = (await msgRes.json()) as { data: { id: string } };
  const messageId = msgBody.data.id;

  const readRes = await request.post(`/api/v1/messages/${messageId}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status()).toBe(200);
  const readBody = (await readRes.json()) as { data: { status: string; read_at: string | null } };
  expect(readBody.data.status).toBe('read');
  expect(readBody.data.read_at).not.toBeNull();
});

// Deals tests

test('PATCH /deals/:id with value -1 returns 400 (Zod rejects non-positive numbers)', async ({ request }) => {
  const org = await registerOrg(request, 'deals-neg');

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(pipelinesRes.status()).toBe(200);
  const pipelinesBody = (await pipelinesRes.json()) as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = pipelinesBody.data[0];
  const stageId = pipeline.stages[0].id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { first_name: 'DealContact' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { title: 'Test Deal', pipeline_id: pipeline.id, stage_id: stageId, contact_id: contactId, value: 100 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as { data: { id: string } };
  const dealId = dealBody.data.id;

  const patchRes = await request.patch(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { value: -1 },
  });
  expect(patchRes.status()).toBe(400);
});

test('PATCH /deals/:id with value 0 returns 400 (z.number().positive() requires strictly greater than zero)', async ({ request }) => {
  const org = await registerOrg(request, 'deals-zero');

  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(pipelinesRes.status()).toBe(200);
  const pipelinesBody = (await pipelinesRes.json()) as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = pipelinesBody.data[0];
  const stageId = pipeline.stages[0].id;

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { first_name: 'DealContactZero' },
  });
  expect(contactRes.status()).toBe(201);
  const contactBody = (await contactRes.json()) as { data: { id: string } };
  const contactId = contactBody.data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { title: 'Zero Deal', pipeline_id: pipeline.id, stage_id: stageId, contact_id: contactId, value: 100 },
  });
  expect(dealRes.status()).toBe(201);
  const dealBody = (await dealRes.json()) as { data: { id: string } };
  const dealId = dealBody.data.id;

  const patchRes = await request.patch(`/api/v1/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { value: 0 },
  });
  expect(patchRes.status()).toBe(400);
});

// Analytics: conversionRates (Task 2)

test('GET /analytics/conversion-rates returns 200 with pipeline array and zero counts for org with no deals', async ({ request }) => {
  const org = await registerOrg(request, 'cvr-empty');
  const res = await request.get('/api/v1/analytics/conversion-rates', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: {
      pipeline_id: string;
      pipeline_name: string;
      transitions: { entered_count: number; progressed_count: number; conversion_rate: number }[];
      note: string;
    }[];
    meta: Record<string, unknown>;
  };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThan(0);
  expect(typeof body.data[0].pipeline_id).toBe('string');
  expect(typeof body.data[0].pipeline_name).toBe('string');
  expect(Array.isArray(body.data[0].transitions)).toBe(true);
  expect(typeof body.data[0].note).toBe('string');
  for (const t of body.data[0].transitions) {
    expect(t.entered_count).toBe(0);
    expect(t.progressed_count).toBe(0);
    expect(t.conversion_rate).toBe(0);
  }
});

test('GET /analytics/conversion-rates with pipeline_id filter returns only that pipeline', async ({ request }) => {
  const org = await registerOrg(request, 'cvr-filter');
  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(pipelinesRes.status()).toBe(200);
  const pipelinesBody = (await pipelinesRes.json()) as { data: { id: string }[] };
  const pipelineId = pipelinesBody.data[0].id;

  const res = await request.get(`/api/v1/analytics/conversion-rates?pipeline_id=${pipelineId}`, {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { pipeline_id: string }[] };
  expect(body.data.length).toBe(1);
  expect(body.data[0].pipeline_id).toBe(pipelineId);
});

test('GET /analytics/conversion-rates counts a won deal as entered and progressed through all stage transitions', async ({ request }) => {
  const org = await registerOrg(request, 'cvr-won');
  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  const pipelinesBody = (await pipelinesRes.json()) as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = pipelinesBody.data[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { first_name: 'WonDealContact' },
  });
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;

  const dealRes = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { title: 'Won Deal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: pipeline.stages[0].id, value: 500 },
  });
  expect(dealRes.status()).toBe(201);
  const dealId = ((await dealRes.json()) as { data: { id: string } }).data.id;

  await request.post(`/api/v1/deals/${dealId}/won`, {
    headers: { Authorization: `Bearer ${org.token}` },
    data: {},
  });

  const res = await request.get('/api/v1/analytics/conversion-rates', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { transitions: { entered_count: number; progressed_count: number; conversion_rate: number }[] }[] };
  const transitions = body.data[0].transitions;
  expect(transitions.length).toBeGreaterThan(0);
  for (const t of transitions) {
    expect(t.entered_count).toBeGreaterThan(0);
    expect(t.progressed_count).toBeGreaterThan(0);
    expect(t.conversion_rate).toBeGreaterThan(0);
  }
});

// Analytics: stageDuration (Task 3)

test('GET /analytics/stage-duration returns 200 with correct structure and meta note', async ({ request }) => {
  const org = await registerOrg(request, 'sd-struct');
  const res = await request.get('/api/v1/analytics/stage-duration', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: unknown[];
    meta: { note: string };
  };
  expect(Array.isArray(body.data)).toBe(true);
  expect(typeof body.meta.note).toBe('string');
  expect(body.meta.note.length).toBeGreaterThan(0);
});

test('GET /analytics/stage-duration returns a stage entry with avg_days and deal_count when deals exist', async ({ request }) => {
  const org = await registerOrg(request, 'sd-data');
  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  const pipelinesBody = (await pipelinesRes.json()) as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = pipelinesBody.data[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { first_name: 'SDContact' },
  });
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;

  await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { title: 'SD Deal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: pipeline.stages[0].id },
  });

  const res = await request.get('/api/v1/analytics/stage-duration', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: { stage_id: string; stage_name: string; pipeline_id: string; avg_days: number; deal_count: number }[];
  };
  expect(body.data.length).toBeGreaterThan(0);
  const entry = body.data[0];
  expect(typeof entry.stage_id).toBe('string');
  expect(typeof entry.stage_name).toBe('string');
  expect(typeof entry.avg_days).toBe('number');
  expect(entry.avg_days).toBeGreaterThanOrEqual(0);
  expect(entry.deal_count).toBe(1);
});

test('GET /analytics/stage-duration with pipeline_id filter returns only deals from that pipeline', async ({ request }) => {
  const org = await registerOrg(request, 'sd-filter');
  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  const pipelinesBody = (await pipelinesRes.json()) as { data: { id: string; stages: { id: string }[] }[] };
  const pipeline = pipelinesBody.data[0];

  const contactRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { first_name: 'SDFilterContact' },
  });
  const contactId = ((await contactRes.json()) as { data: { id: string } }).data.id;

  await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${org.token}` },
    data: { title: 'SD Filter Deal', contact_id: contactId, pipeline_id: pipeline.id, stage_id: pipeline.stages[0].id },
  });

  const res = await request.get(`/api/v1/analytics/stage-duration?pipeline_id=${pipeline.id}`, {
    headers: { Authorization: `Bearer ${org.token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { pipeline_id: string }[] };
  for (const entry of body.data) {
    expect(entry.pipeline_id).toBe(pipeline.id);
  }
});

// Analytics: exportReport (Task 4)

test('POST /analytics/export with format=pdf returns 501 PDF_NOT_IMPLEMENTED', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: { Authorization: `Bearer ${token}` },
    data: { format: 'pdf', report: 'funnel', period: 'month' },
  });
  expect(res.status()).toBe(501);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('PDF_NOT_IMPLEMENTED');
});

test('POST /analytics/export with format=csv and report=lead_sources returns 200 text/csv with Content-Disposition attachment', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: { Authorization: `Bearer ${token}` },
    data: { format: 'csv', report: 'lead_sources', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType).toContain('text/csv');
  const disposition = res.headers()['content-disposition'] ?? '';
  expect(disposition).toContain('attachment');
  expect(disposition).toContain('lead_sources');
});

test('POST /analytics/export with format=csv and report=funnel returns CSV with correct header row', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: { Authorization: `Bearer ${token}` },
    data: { format: 'csv', report: 'funnel', period: 'month' },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const firstLine = text.split('\n')[0];
  expect(firstLine).toBe('stage_id,open,won,lost,total,total_value,conversion_rate');
});

// Analytics: exportStatus + exportDownload (Task 5)

test('GET /analytics/export/:job_id/status returns 501 ASYNC_EXPORT_NOT_IMPLEMENTED', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/export/00000000-0000-0000-0000-000000000001/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(501);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('ASYNC_EXPORT_NOT_IMPLEMENTED');
  expect(body.error.message).toBe('Async export not implemented for MVP');
});

test('GET /analytics/export/:job_id/download returns 501 ASYNC_EXPORT_NOT_IMPLEMENTED', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/analytics/export/00000000-0000-0000-0000-000000000001/download', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(501);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('ASYNC_EXPORT_NOT_IMPLEMENTED');
  expect(body.error.message).toBe('Async export not implemented for MVP');
});
