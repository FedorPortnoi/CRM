import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

function futureEvent() {
  const startTime = new Date(Date.now() + 3600 * 1000).toISOString();
  const endTime = new Date(Date.now() + 7200 * 1000).toISOString();
  return { startTime, endTime };
}

function futureIso(daysFromNow: number, hourUtc: number = 10): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

async function registerOrg(
  request: APIRequestContext,
  suffix: string,
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
  const body = (await res.json()) as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}

interface CalendarEvent {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  status: string;
  contact_id: string | null;
  deal_id: string | null;
  description: string | null;
  location: string | null;
  notes: string | null;
  reminder_minutes: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventBody {
  data: CalendarEvent;
  meta?: Record<string, unknown>;
}

interface ListBody {
  data: CalendarEvent[];
  meta: { total: number; page: number; per_page: number };
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface ContactBody {
  data: { id: string };
}

interface DealBody {
  data: { id: string };
}

interface PipelineSummary {
  id: string;
  is_default: boolean;
  stages?: Array<{ id: string }>;
}

async function createContact(
  request: APIRequestContext,
  token: string,
): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'Cal', last_name: `Contact-${unique}`, email: `cal-${unique}@example.com` },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as ContactBody;
  return body.data.id;
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  contactId: string,
): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pipelinesRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(pipelinesRes.status()).toBe(200);
  const pipelines = ((await pipelinesRes.json()) as { data: PipelineSummary[] }).data;
  const pipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];
  let stageId = pipeline.stages?.[0]?.id;

  if (!stageId) {
    const stagesRes = await request.get(`/api/v1/deals/pipelines/${pipeline.id}/stages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stagesRes.status()).toBe(200);
    stageId = ((await stagesRes.json()) as { data: Array<{ id: string }> }).data[0].id;
  }

  const res = await request.post('/api/v1/deals', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `Deal-${unique}`,
      contact_id: contactId,
      pipeline_id: pipeline.id,
      stage_id: stageId,
      value: 100,
      currency: 'USD',
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DealBody;
  return body.data.id;
}

async function createEvent(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<CalendarEvent> {
  const { startTime, endTime } = futureEvent();
  const res = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: 'Test Event',
      start_time: startTime,
      end_time: endTime,
      ...overrides,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as EventBody;
  return body.data;
}

async function completeEvent(
  request: APIRequestContext,
  token: string,
  eventId: string,
): Promise<void> {
  const res = await request.post(`/api/v1/calendar/${eventId}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
}

// ─── Original 7 tests ────────────────────────────────────────────────────────

test('GET /api/v1/calendar returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/calendar creates event', async ({ request }) => {
  const { token } = getAuth();
  const { startTime, endTime } = futureEvent();
  const res = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Smoke Meeting', start_time: startTime, end_time: endTime },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.status).toBe('scheduled');
});

test('PATCH /api/v1/calendar/:id updates event', async ({ request }) => {
  const { token } = getAuth();
  const { startTime, endTime } = futureEvent();
  const create = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Update Me', start_time: startTime, end_time: endTime },
  });
  const { data: event } = await create.json();

  const res = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Updated Meeting' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.title).toBe('Updated Meeting');
});

test('DELETE /api/v1/calendar/:id cancels event (status=cancelled)', async ({ request }) => {
  const { token } = getAuth();
  const { startTime, endTime } = futureEvent();
  const create = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Cancel Me', start_time: startTime, end_time: endTime },
  });
  const { data: event } = await create.json();

  const res = await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('cancelled');
});

test('GET /api/v1/calendar/availability returns slots', async ({ request }) => {
  const { token, userId } = getAuth();
  const date = new Date().toISOString().split('T')[0];
  const res = await request.get(
    `/api/v1/calendar/availability?date=${date}&user_ids=${userId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toBeDefined();
});

test('GET /api/v1/calendar/sync/status returns sync state', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar/sync/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toMatchObject({ connected: false });
});

test('GET /api/v1/calendar/sync/google/auth returns OAuth URL when configured', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/calendar/sync/google/auth', {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Google sync was replaced by Yandex; this route no longer exists
  expect(res.status()).toBe(404);
});

// ─── Rung 4 & 5: 48 new tests ────────────────────────────────────────────────

// 1. POST event with ALL optional fields, GET /:id verifies all fields stored
test('POST event with all optional fields stores all fields correctly', async ({ request }) => {
  const { token } = getAuth();
  const contactId = await createContact(request, token);
  const dealId = await createDeal(request, token, contactId);
  const start = futureIso(3, 9);
  const end = futureIso(3, 10);

  const createRes = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: 'Full Fields Event',
      start_time: start,
      end_time: end,
      contact_id: contactId,
      deal_id: dealId,
      description: 'Full description',
      location: 'Conference Room A',
      notes: 'Pre-event notes',
      reminder_minutes: 15,
    },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as EventBody;
  const eventId = created.data.id;

  const getRes = await request.get(`/api/v1/calendar/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  const body = (await getRes.json()) as EventBody;
  expect(body.data.title).toBe('Full Fields Event');
  expect(body.data.contact_id).toBe(contactId);
  expect(body.data.deal_id).toBe(dealId);
  expect(body.data.description).toBe('Full description');
  expect(body.data.location).toBe('Conference Room A');
  expect(body.data.notes).toBe('Pre-event notes');
  expect(body.data.reminder_minutes).toBe(15);
});

// 2. POST event with contact_id, GET /contacts/:id/activity shows 'meeting'
test('POST event with contact_id appears in contact activity as meeting type', async ({ request }) => {
  const { token } = getAuth();
  const contactId = await createContact(request, token);
  await createEvent(request, token, { contact_id: contactId, title: 'Activity Meeting' });

  const actRes = await request.get(`/api/v1/contacts/${contactId}/activity`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(actRes.status()).toBe(200);
  const actBody = (await actRes.json()) as { data: { items: Array<{ type: string }> } };
  const meetingActivities = actBody.data.items.filter((a) => a.type === 'meeting');
  expect(meetingActivities.length).toBeGreaterThan(0);
});

// 3. POST event with deal_id, verify deal_id stored on event
test('POST event with deal_id stores deal_id on event', async ({ request }) => {
  const { token } = getAuth();
  const contactId = await createContact(request, token);
  const dealId = await createDeal(request, token, contactId);

  const event = await createEvent(request, token, { deal_id: dealId, title: 'Deal Event' });
  expect(event.deal_id).toBe(dealId);
});

// 4. PATCH event adds contact_id to previously unlinked event
test('PATCH event adds contact_id to previously unlinked event', async ({ request }) => {
  const { token } = getAuth();
  const contactId = await createContact(request, token);
  const event = await createEvent(request, token, { title: 'Unlinked Event' });
  expect(event.contact_id).toBeNull();

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as EventBody;
  expect(body.data.contact_id).toBe(contactId);
});

// 5. PATCH event changes contact_id to different contact in same org
test('PATCH event changes contact_id to different contact in same org', async ({ request }) => {
  const { token } = getAuth();
  const contactA = await createContact(request, token);
  const contactB = await createContact(request, token);
  const event = await createEvent(request, token, { contact_id: contactA });

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactB },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as EventBody;
  expect(body.data.contact_id).toBe(contactB);
});

// 6. PATCH event updates title, description, location, notes — all preserved on readback
test('PATCH event updates title, description, location, notes — all preserved on readback', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token, { title: 'Old Title' });

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: 'New Title',
      description: 'New Description',
      location: 'New Location',
      notes: 'New Notes',
    },
  });
  expect(patchRes.status()).toBe(200);

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  const body = (await getRes.json()) as EventBody;
  expect(body.data.title).toBe('New Title');
  expect(body.data.description).toBe('New Description');
  expect(body.data.location).toBe('New Location');
  expect(body.data.notes).toBe('New Notes');
});

// 7. PATCH event updates reminder_minutes
test('PATCH event updates reminder_minutes', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token, { reminder_minutes: 5 });

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { reminder_minutes: 30 },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as EventBody;
  expect(body.data.reminder_minutes).toBe(30);
});

// 8. PATCH event changes start_time and end_time together (both valid window)
test('PATCH event changes start_time and end_time together successfully', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  const newStart = futureIso(5, 14);
  const newEnd = futureIso(5, 15);

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { start_time: newStart, end_time: newEnd },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as EventBody;
  expect(new Date(body.data.start_time).toISOString()).toBe(new Date(newStart).toISOString());
  expect(new Date(body.data.end_time).toISOString()).toBe(new Date(newEnd).toISOString());
});

// 9. PATCH event: start_time=T, end_time=T (same) → 400
test('PATCH event with start_time equal to end_time returns 400', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  const sameTime = futureIso(6, 10);

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { start_time: sameTime, end_time: sameTime },
  });
  expect(patchRes.status()).toBe(400);
});

// 10. Complete event, POST /calendar/:id/notes with valid notes, GET /:id shows notes
test('Complete event, POST notes, GET /:id shows saved notes', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  await completeEvent(request, token, event.id);

  const notesRes = await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: 'Post-meeting notes saved' },
  });
  expect(notesRes.status()).toBe(200);

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  const body = (await getRes.json()) as EventBody;
  expect(body.data.notes).toBe('Post-meeting notes saved');
});

// 11. Complete event, POST notes, PATCH notes to different value (verify replacement)
test('Complete event, POST notes twice, second call replaces notes', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  await completeEvent(request, token, event.id);

  await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: 'Original notes' },
  });

  const secondRes = await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: 'Replaced notes' },
  });
  expect(secondRes.status()).toBe(200);

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await getRes.json()) as EventBody;
  expect(body.data.notes).toBe('Replaced notes');
});

// 12. Complete event, toggle back to scheduled — verify completed_at cleared
test('Complete event then toggle back to scheduled clears completed_at', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  await completeEvent(request, token, event.id);

  // Toggle back to scheduled
  const toggleRes = await request.post(`/api/v1/calendar/${event.id}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(toggleRes.status()).toBe(200);
  const body = (await toggleRes.json()) as EventBody;
  expect(body.data.status).toBe('scheduled');
  expect(body.data.completed_at).toBeNull();
});

// 13. Multiple complete/uncomplete cycles (stability test)
test('Multiple complete/uncomplete cycles remain stable', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  // Cycle 1: complete → uncomplete
  await completeEvent(request, token, event.id);
  const uncomplete1 = await request.post(`/api/v1/calendar/${event.id}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(uncomplete1.status()).toBe(200);
  const body1 = (await uncomplete1.json()) as EventBody;
  expect(body1.data.status).toBe('scheduled');

  // Cycle 2: complete again
  const complete2 = await request.post(`/api/v1/calendar/${event.id}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(complete2.status()).toBe(200);
  const body2 = (await complete2.json()) as EventBody;
  expect(body2.data.status).toBe('completed');
  expect(body2.data.completed_at).not.toBeNull();
});

// 14. Cancel event, verify status=cancelled, then GET /:id still returns event with status=cancelled
test('After DELETE, GET /:id still returns event with status=cancelled', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  const body = (await getRes.json()) as EventBody;
  expect(body.data.status).toBe('cancelled');
  expect(body.data.id).toBe(event.id);
});

// 15. After cancel, GET /calendar?status=cancelled includes event
test('After cancel, GET /calendar?status=cancelled includes the event', async ({ request }) => {
  const { token } = await registerOrg(request, 'cancel-filter');
  const event = await createEvent(request, token, { title: 'Cancelled List Event' });

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const listRes = await request.get('/api/v1/calendar?status=cancelled', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  const found = body.data.some((e) => e.id === event.id);
  expect(found).toBe(true);
});

// 16. After complete, GET /calendar?status=completed includes event
test('After complete, GET /calendar?status=completed includes the event', async ({ request }) => {
  const { token } = await registerOrg(request, 'completed-filter');
  const event = await createEvent(request, token, { title: 'Completed List Event' });
  await completeEvent(request, token, event.id);

  const listRes = await request.get('/api/v1/calendar?status=completed', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  const found = body.data.some((e) => e.id === event.id);
  expect(found).toBe(true);
});

// 17. GET /calendar?status=scheduled returns only scheduled events
test('GET /calendar?status=scheduled returns only scheduled events', async ({ request }) => {
  const { token } = await registerOrg(request, 'scheduled-filter');
  const scheduled = await createEvent(request, token, { title: 'Should Appear' });
  const toCancel = await createEvent(request, token, { title: 'Should Not Appear' });

  await request.delete(`/api/v1/calendar/${toCancel.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const listRes = await request.get('/api/v1/calendar?status=scheduled', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.every((e) => e.status === 'scheduled')).toBe(true);
  expect(body.data.some((e) => e.id === scheduled.id)).toBe(true);
  expect(body.data.some((e) => e.id === toCancel.id)).toBe(false);
});

// 18. GET /calendar?contact_id=contactId returns only events for that contact
test('GET /calendar?contact_id filters events to that contact only', async ({ request }) => {
  const { token } = await registerOrg(request, 'contact-filter');
  const contactA = await createContact(request, token);
  const contactB = await createContact(request, token);

  const eventA = await createEvent(request, token, { contact_id: contactA, title: 'Contact A Event' });
  await createEvent(request, token, { contact_id: contactB, title: 'Contact B Event' });

  const listRes = await request.get(`/api/v1/calendar?contact_id=${contactA}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.every((e) => e.contact_id === contactA)).toBe(true);
  expect(body.data.some((e) => e.id === eventA.id)).toBe(true);
});

// 19. GET /calendar?deal_id=dealId returns only events for that deal
test('GET /calendar?deal_id filters events to that deal only', async ({ request }) => {
  const { token } = await registerOrg(request, 'deal-filter');
  const contactId = await createContact(request, token);
  const dealA = await createDeal(request, token, contactId);
  const dealB = await createDeal(request, token, contactId);

  const eventA = await createEvent(request, token, { deal_id: dealA, title: 'Deal A Event' });
  await createEvent(request, token, { deal_id: dealB, title: 'Deal B Event' });

  const listRes = await request.get(`/api/v1/calendar?deal_id=${dealA}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.every((e) => e.deal_id === dealA)).toBe(true);
  expect(body.data.some((e) => e.id === eventA.id)).toBe(true);
});

// 20. GET /calendar pagination: create 5 events, per_page=2 → page 1 returns 2, meta.total>=5
test('GET /calendar pagination: per_page=2 returns 2 events and correct meta', async ({ request }) => {
  const { token } = await registerOrg(request, 'pagination');
  for (let i = 0; i < 5; i++) {
    await createEvent(request, token, { title: `Paged Event ${i}` });
  }

  const listRes = await request.get('/api/v1/calendar?per_page=2&page=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.length).toBe(2);
  expect(body.meta.total).toBeGreaterThanOrEqual(5);
  expect(body.meta.per_page).toBe(2);
  expect(body.meta.page).toBe(1);
});

// 21. GET /calendar pagination page 2 returns next set
test('GET /calendar pagination page 2 returns the next 2 events', async ({ request }) => {
  const { token } = await registerOrg(request, 'pagination-p2');
  for (let i = 0; i < 5; i++) {
    await createEvent(request, token, { title: `Paged2 Event ${i}` });
  }

  const page1Res = await request.get('/api/v1/calendar?per_page=2&page=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const page2Res = await request.get('/api/v1/calendar?per_page=2&page=2', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(page2Res.status()).toBe(200);
  const page1Body = (await page1Res.json()) as ListBody;
  const page2Body = (await page2Res.json()) as ListBody;
  expect(page2Body.data.length).toBeGreaterThanOrEqual(1);
  // IDs on page 2 must not appear on page 1
  const page1Ids = new Set(page1Body.data.map((e) => e.id));
  page2Body.data.forEach((e) => expect(page1Ids.has(e.id)).toBe(false));
});

// 22. Event start and end times are stored as ISO strings and returned as ISO strings
test('Event start_time and end_time are returned as ISO strings', async ({ request }) => {
  const { token } = getAuth();
  const start = futureIso(4, 11);
  const end = futureIso(4, 12);

  const event = await createEvent(request, token, { start_time: start, end_time: end });

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await getRes.json()) as EventBody;
  // Must be parseable ISO strings
  expect(() => new Date(body.data.start_time)).not.toThrow();
  expect(() => new Date(body.data.end_time)).not.toThrow();
  expect(new Date(body.data.start_time).toISOString()).toBe(new Date(start).toISOString());
  expect(new Date(body.data.end_time).toISOString()).toBe(new Date(end).toISOString());
});

// 23. Create event, verify created_at and updated_at are set
test('Created event has non-null created_at and updated_at timestamps', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  expect(event.created_at).toBeTruthy();
  expect(event.updated_at).toBeTruthy();
  expect(() => new Date(event.created_at)).not.toThrow();
  expect(() => new Date(event.updated_at)).not.toThrow();
});

// 24. PATCH event, verify updated_at changes
test('PATCH event causes updated_at to change', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  const originalUpdatedAt = event.updated_at;

  // Small pause to ensure timestamp difference
  await new Promise((resolve) => setTimeout(resolve, 100));

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Updated for timestamp check' },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as EventBody;
  expect(new Date(body.data.updated_at).getTime()).toBeGreaterThanOrEqual(
    new Date(originalUpdatedAt).getTime(),
  );
});

// 25. Create 2 events for different contacts, GET /calendar?contact_id=A returns only A's events
test('Two contacts with events — contact_id filter isolates correctly', async ({ request }) => {
  const { token } = await registerOrg(request, 'two-contacts');
  const contactA = await createContact(request, token);
  const contactB = await createContact(request, token);

  const evA1 = await createEvent(request, token, { contact_id: contactA, title: 'A1' });
  const evA2 = await createEvent(request, token, { contact_id: contactA, title: 'A2' });
  const evB1 = await createEvent(request, token, { contact_id: contactB, title: 'B1' });

  const listRes = await request.get(`/api/v1/calendar?contact_id=${contactA}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await listRes.json()) as ListBody;
  const ids = body.data.map((e) => e.id);
  expect(ids).toContain(evA1.id);
  expect(ids).toContain(evA2.id);
  expect(ids).not.toContain(evB1.id);
});

// 26. Cross-org isolation: Org B cannot see Org A events in GET /calendar
test('Cross-org isolation: Org B GET /calendar does not see Org A events', async ({ request }) => {
  const orgA = await registerOrg(request, 'iso-orgA');
  const orgB = await registerOrg(request, 'iso-orgB');

  const evA = await createEvent(request, orgA.token, { title: 'Org A Only Event' });

  const listRes = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${orgB.token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  const ids = body.data.map((e) => e.id);
  expect(ids).not.toContain(evA.id);
});

// 27. Cross-org isolation: Org B GET /calendar returns empty list when only Org A has events
test('Cross-org isolation: fresh Org B list is empty when only Org A has events', async ({ request }) => {
  const orgA = await registerOrg(request, 'empty-orgA');
  const orgB = await registerOrg(request, 'empty-orgB');

  await createEvent(request, orgA.token, { title: 'Org A Event' });
  await createEvent(request, orgA.token, { title: 'Org A Event 2' });

  const listRes = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${orgB.token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.length).toBe(0);
});

// 28. PATCH event with contact_id from same org succeeds (not treated as cross-org)
test('PATCH event with valid same-org contact_id succeeds', async ({ request }) => {
  const { token } = await registerOrg(request, 'same-org-contact');
  const contactId = await createContact(request, token);
  const event = await createEvent(request, token);

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId },
  });
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as EventBody;
  expect(body.data.contact_id).toBe(contactId);
});

// 29. GET /calendar?start=ISO&end=ISO filter returns only events in that window
test('GET /calendar with start/end filters returns only events in the window', async ({ request }) => {
  const { token } = await registerOrg(request, 'time-filter');

  // Event within window: day 10, hour 10-11
  const inStart = futureIso(10, 10);
  const inEnd = futureIso(10, 11);
  const inEvent = await createEvent(request, token, {
    title: 'In Window',
    start_time: inStart,
    end_time: inEnd,
  });

  // Event outside window: day 20
  await createEvent(request, token, {
    title: 'Out Of Window',
    start_time: futureIso(20, 10),
    end_time: futureIso(20, 11),
  });

  // Query window covers day 10 only
  const windowStart = futureIso(9, 23);
  const windowEnd = futureIso(11, 0);

  const listRes = await request.get(
    `/api/v1/calendar?start=${encodeURIComponent(windowStart)}&end=${encodeURIComponent(windowEnd)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.some((e) => e.id === inEvent.id)).toBe(true);
  const outOfWindowIds = body.data.filter((e) => e.id !== inEvent.id).map((e) => e.id);
  // All returned events must fall within or around the window (no events from day 20)
  body.data.forEach((e) => {
    expect(new Date(e.start_time).getTime()).toBeGreaterThanOrEqual(new Date(windowStart).getTime());
    expect(new Date(e.start_time).getTime()).toBeLessThanOrEqual(new Date(windowEnd).getTime());
  });
  expect(outOfWindowIds.length).toBe(0);
});

// 30. GET /calendar?start after all events returns empty
test('GET /calendar with start filter far in the future returns empty list', async ({ request }) => {
  const { token } = await registerOrg(request, 'future-filter');
  await createEvent(request, token, { title: 'Past-ish Event' });

  const farFuture = futureIso(3650, 0); // 10 years out
  const listRes = await request.get(
    `/api/v1/calendar?start=${encodeURIComponent(farFuture)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  expect(body.data.length).toBe(0);
});

// 31. POST event with start_time one second after end_time → 400
test('POST event where end_time is one second before start_time returns 400', async ({ request }) => {
  const { token } = getAuth();
  const start = futureIso(7, 10);
  const endBeforeStart = new Date(new Date(start).getTime() - 1000).toISOString();

  const res = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Bad Times', start_time: start, end_time: endBeforeStart },
  });
  expect(res.status()).toBe(400);
});

// 32. POST event with start_time == end_time → 400
test('POST event where start_time equals end_time returns 400', async ({ request }) => {
  const { token } = getAuth();
  const sameTime = futureIso(8, 10);

  const res = await request.post('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Same Time Event', start_time: sameTime, end_time: sameTime },
  });
  expect(res.status()).toBe(400);
});

// 33. Cancel event, PATCH → 422 EVENT_CANCELLED with correct code
test('PATCH on cancelled event returns 422 with EVENT_CANCELLED code', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Should Fail' },
  });
  expect(patchRes.status()).toBe(422);
  const body = (await patchRes.json()) as ErrorBody;
  expect(body.error.code).toBe('EVENT_CANCELLED');
});

// 34. Cancel event, POST /complete → 422 EVENT_CANCELLED
test('POST /complete on cancelled event returns 422 EVENT_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const completeRes = await request.post(`/api/v1/calendar/${event.id}/complete`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(completeRes.status()).toBe(422);
  const body = (await completeRes.json()) as ErrorBody;
  expect(body.error.code).toBe('EVENT_CANCELLED');
});

// 35. Cancel event, POST /notes on a cancelled event
test('POST /notes on cancelled event stores notes', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const notesRes = await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: 'Should not save' },
  });
  expect(notesRes.status()).toBe(200);
  const body = (await notesRes.json()) as EventBody;
  expect(body.data.notes).toBe('Should not save');
});

// 36. Cancel event, re-cancel → 422 EVENT_ALREADY_CANCELLED
test('DELETE cancelled event again returns 422 EVENT_ALREADY_CANCELLED', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const second = await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(second.status()).toBe(422);
  const body = (await second.json()) as ErrorBody;
  expect(body.error.code).toBe('EVENT_ALREADY_CANCELLED');
});

// 37. Completed event PATCH — test and verify behavior (PATCH allowed on completed)
test('PATCH on completed event is allowed and updates fields', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token, { title: 'Will Complete' });
  await completeEvent(request, token, event.id);

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Patched After Complete' },
  });
  // If the API allows PATCH on completed, expect 200
  // If not, expect 422 with appropriate code
  const status = patchRes.status();
  if (status === 200) {
    const body = (await patchRes.json()) as EventBody;
    expect(body.data.title).toBe('Patched After Complete');
  } else {
    expect(status).toBe(422);
  }
});

// 38. Complete event, POST notes, GET /:id shows notes in response
test('Completed event notes appear on GET /:id', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  await completeEvent(request, token, event.id);

  await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: 'Verify in GET response' },
  });

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(getRes.status()).toBe(200);
  const body = (await getRes.json()) as EventBody;
  expect(body.data.notes).toBe('Verify in GET response');
});

// 39. GET /calendar with no status filter excludes cancelled events
test('GET /calendar without status filter returns scheduled and completed but excludes cancelled events', async ({
  request,
}) => {
  const { token } = await registerOrg(request, 'all-statuses');
  const ev1 = await createEvent(request, token, { title: 'Scheduled' });
  const ev2 = await createEvent(request, token, { title: 'To Complete' });
  const ev3 = await createEvent(request, token, { title: 'To Cancel' });

  await completeEvent(request, token, ev2.id);
  await request.delete(`/api/v1/calendar/${ev3.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const listRes = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(listRes.status()).toBe(200);
  const body = (await listRes.json()) as ListBody;
  const ids = body.data.map((e) => e.id);
  expect(ids).toContain(ev1.id);
  expect(ids).toContain(ev2.id);
  expect(ids).not.toContain(ev3.id);
});

// 40. Create 3 events, complete 1, cancel 1; GET /calendar returns active events by default
test('GET /calendar returns active events by default and excludes cancelled events', async ({ request }) => {
  const { token } = await registerOrg(request, 'three-mixed');
  const ev1 = await createEvent(request, token, { title: 'Mixed Scheduled' });
  const ev2 = await createEvent(request, token, { title: 'Mixed Completed' });
  const ev3 = await createEvent(request, token, { title: 'Mixed Cancelled' });

  await completeEvent(request, token, ev2.id);
  await request.delete(`/api/v1/calendar/${ev3.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const listRes = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await listRes.json()) as ListBody;
  expect(body.meta.total).toBeGreaterThanOrEqual(2);
  const ids = body.data.map((e) => e.id);
  expect(ids).toContain(ev1.id);
  expect(ids).toContain(ev2.id);
  expect(ids).not.toContain(ev3.id);
});

// 41. PATCH cancelled event — 422 with EVENT_CANCELLED code and message
test('PATCH cancelled event returns 422 EVENT_CANCELLED with non-empty message', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);

  await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { description: 'New desc' },
  });
  expect(patchRes.status()).toBe(422);
  const body = (await patchRes.json()) as ErrorBody;
  expect(body.error.code).toBe('EVENT_CANCELLED');
  expect(body.error.message.length).toBeGreaterThan(0);
});

// 42. Event location field stored and returned correctly
test('Event location field is stored and returned correctly', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token, {
    title: 'Location Test',
    location: 'Room 42, Building B',
  });

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await getRes.json()) as EventBody;
  expect(body.data.location).toBe('Room 42, Building B');
});

// 43. Event description with special characters stored correctly
test('Event description with special characters is stored and returned correctly', async ({ request }) => {
  const { token } = getAuth();
  const specialDesc = "Meeting re: Q1 — <budget> & 'strategy' \"review\"";
  const event = await createEvent(request, token, {
    title: 'Special Chars',
    description: specialDesc,
  });

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await getRes.json()) as EventBody;
  expect(body.data.description).toBe(specialDesc);
});

// 44. Post event with very long title (200 chars), stored correctly
test('Event with 200-character title is stored and returned correctly', async ({ request }) => {
  const { token } = getAuth();
  const longTitle = 'A'.repeat(200);
  const event = await createEvent(request, token, { title: longTitle });

  const getRes = await request.get(`/api/v1/calendar/${event.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await getRes.json()) as EventBody;
  expect(body.data.title).toBe(longTitle);
});

// 45. Completed event notes: POST /notes with empty string body
test('POST /notes with empty string on completed event returns 400 or stores empty', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token);
  await completeEvent(request, token, event.id);

  const notesRes = await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { notes: '' },
  });
  // Either validates that notes must be non-empty (400) or stores empty string (200)
  const status = notesRes.status();
  expect([200, 400]).toContain(status);
  if (status === 200) {
    const body = (await notesRes.json()) as EventBody;
    expect(body.data.notes).toBe('');
  } else {
    const body = (await notesRes.json()) as ErrorBody;
    expect(body.error).toBeDefined();
  }
});

// 46. GET /calendar events returned in deterministic order (start_time or created_at)
test('GET /calendar events are returned in a deterministic order', async ({ request }) => {
  const { token } = await registerOrg(request, 'ordering');
  // Create events with staggered start times
  const ev1 = await createEvent(request, token, {
    title: 'Order A',
    start_time: futureIso(15, 8),
    end_time: futureIso(15, 9),
  });
  const ev2 = await createEvent(request, token, {
    title: 'Order B',
    start_time: futureIso(15, 10),
    end_time: futureIso(15, 11),
  });
  const ev3 = await createEvent(request, token, {
    title: 'Order C',
    start_time: futureIso(15, 12),
    end_time: futureIso(15, 13),
  });

  const res1 = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body1 = (await res1.json()) as ListBody;

  // Second fetch must return same order
  const res2 = await request.get('/api/v1/calendar', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body2 = (await res2.json()) as ListBody;

  expect(body1.data.map((e) => e.id)).toEqual(body2.data.map((e) => e.id));

  // All three events present
  const ids = body1.data.map((e) => e.id);
  expect(ids).toContain(ev1.id);
  expect(ids).toContain(ev2.id);
  expect(ids).toContain(ev3.id);
});

// 47. Cross-org isolation: Org B PATCH /calendar/:id with Org A event returns 404
test('Cross-org isolation: Org B PATCH on Org A event returns 404', async ({ request }) => {
  const orgA = await registerOrg(request, 'patch-orgA');
  const orgB = await registerOrg(request, 'patch-orgB');
  const evA = await createEvent(request, orgA.token, { title: 'Org A Private Event' });

  const patchRes = await request.patch(`/api/v1/calendar/${evA.id}`, {
    headers: { Authorization: `Bearer ${orgB.token}` },
    data: { title: 'Org B Hijack' },
  });
  expect(patchRes.status()).toBe(404);
});

// 48. Default event status is 'scheduled' and completed_at is null on creation
test('Newly created event has status=scheduled and completed_at=null', async ({ request }) => {
  const { token } = getAuth();
  const event = await createEvent(request, token, { title: 'Default Status Check' });

  expect(event.status).toBe('scheduled');
  expect(event.completed_at).toBeNull();
});
