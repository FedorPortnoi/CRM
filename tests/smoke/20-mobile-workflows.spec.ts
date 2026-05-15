import { APIRequestContext, expect, test } from '@playwright/test';

test.describe.configure({ timeout: 30000 });

type AuthOrg = {
  token: string;
  userId: string;
};

type RegisterResponse = {
  data: {
    token: string;
    user: {
      id: string;
    };
  };
};

type ContactRecord = {
  id: string;
  first_name: string;
};

type MessageChannel = 'sms' | 'in_app' | 'email';
type MessageDirection = 'inbound' | 'outbound';
type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

type MessageRecord = {
  id: string;
  contact_id: string;
  user_id: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  body: string;
  status: MessageStatus;
  created_at: string;
};

type ActivityItem = {
  type: 'message' | 'task' | 'meeting';
  id: string;
  summary: string;
  created_at: string;
};

type ActivityResponse = {
  data: {
    contact_id: string;
    items: ActivityItem[];
  };
};

type CalendarEventStatus = 'scheduled' | 'completed' | 'cancelled';

type CalendarEventRecord = {
  id: string;
  title: string;
  contact_id: string | null;
  start_time: string;
  end_time: string;
  status: CalendarEventStatus;
  notes: string | null;
  completed_at: string | null;
  post_meeting_prompted: boolean;
};

type DataResponse<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

type ListResponse<T> = {
  data: T[];
  meta: Record<string, unknown>;
};

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function futureEventWindow(daysFromNow: number): { startTime: string; endTime: string } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + daysFromNow);
  start.setUTCHours(14, 0, 0, 0);

  const end = new Date(start);
  end.setUTCHours(15, 0, 0, 0);

  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function dayBoundsFromIso(isoDate: string): { start: string; end: string } {
  const start = new Date(isoDate);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { start: start.toISOString(), end: end.toISOString() };
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<AuthOrg> {
  const unique = uniqueSuffix(suffix);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${unique}@example.com`,
      password: 'Password123!',
      name: `Mobile Smoke ${suffix}`,
      org_name: `Mobile Smoke ${unique}`,
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as RegisterResponse;
  return { token: body.data.token, userId: body.data.user.id };
}

async function createContact(
  request: APIRequestContext,
  token: string,
  firstName: string = `Mobile ${uniqueSuffix('contact')}`,
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: { first_name: firstName },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<ContactRecord>;
  return body.data;
}

async function createCalendarEvent(
  request: APIRequestContext,
  token: string,
  options: {
    title: string;
    contactId: string;
    startTime: string;
    endTime: string;
    notes?: string;
  },
): Promise<CalendarEventRecord> {
  const res = await request.post('/api/v1/calendar', {
    headers: authHeaders(token),
    data: {
      title: options.title,
      contact_id: options.contactId,
      start_time: options.startTime,
      end_time: options.endTime,
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<CalendarEventRecord>;
  return body.data;
}

async function listCalendarEventsForContact(
  request: APIRequestContext,
  token: string,
  contactId: string,
  bounds: { start: string; end: string },
  status?: CalendarEventStatus,
): Promise<CalendarEventRecord[]> {
  const params = new URLSearchParams({
    contact_id: contactId,
    start: bounds.start,
    end: bounds.end,
    per_page: '50',
  });

  if (status !== undefined) {
    params.set('status', status);
  }

  const res = await request.get(`/api/v1/calendar?${params.toString()}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);

  const body = (await res.json()) as ListResponse<CalendarEventRecord>;
  return body.data;
}

test('mobile messaging: an in-app note is returned in the contact conversation', async ({ request }) => {
  const org = await registerOrg(request, 'mobile-note');
  const contact = await createContact(request, org.token);
  const noteBody = `Mobile note ${uniqueSuffix('conversation')}`;

  const sendRes = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, body: noteBody },
  });
  expect(sendRes.status()).toBe(201);

  const sentBody = (await sendRes.json()) as DataResponse<MessageRecord>;
  expect(sentBody.data.contact_id).toBe(contact.id);
  expect(sentBody.data.user_id).toBe(org.userId);
  expect(sentBody.data.channel).toBe('in_app');
  expect(sentBody.data.direction).toBe('outbound');
  expect(sentBody.data.status).toBe('sent');
  expect(sentBody.data.body).toBe(noteBody);

  const conversationRes = await request.get(`/api/v1/messages/conversation/${contact.id}`, {
    headers: authHeaders(org.token),
  });
  expect(conversationRes.status()).toBe(200);

  const conversationBody = (await conversationRes.json()) as ListResponse<MessageRecord>;
  const message = conversationBody.data.find((item) => item.id === sentBody.data.id);
  expect(message).toBeDefined();
  expect(message?.body).toBe(noteBody);
  expect(message?.channel).toBe('in_app');
  expect(message?.contact_id).toBe(contact.id);
});

test('mobile messaging: logging a call creates a message activity item', async ({ request }) => {
  const org = await registerOrg(request, 'mobile-call');
  const contact = await createContact(request, org.token);
  const callNotes = `Call summary ${uniqueSuffix('activity')}`;

  const callRes = await request.post('/api/v1/messages/call', {
    headers: authHeaders(org.token),
    data: {
      contact_id: contact.id,
      direction: 'outbound',
      duration_seconds: 345,
      notes: callNotes,
    },
  });
  expect(callRes.status()).toBe(201);

  const callBody = (await callRes.json()) as DataResponse<MessageRecord>;
  expect(callBody.data.contact_id).toBe(contact.id);
  expect(callBody.data.direction).toBe('outbound');
  expect(callBody.data.channel).toBe('call');
  expect(callBody.data.status).toBe('delivered');
  expect(callBody.data.body).toBe(`[345s] ${callNotes}`);

  const activityRes = await request.get(`/api/v1/contacts/${contact.id}/activity`, {
    headers: authHeaders(org.token),
  });
  expect(activityRes.status()).toBe(200);

  const activityBody = (await activityRes.json()) as ActivityResponse;
  const item = activityBody.data.items.find((candidate) => candidate.id === callBody.data.id);
  expect(activityBody.data.contact_id).toBe(contact.id);
  expect(item).toBeDefined();
  expect(item?.type).toBe('message');
  expect(item?.summary).toBe(callBody.data.body);
});

test('mobile calendar: event create, list, complete, notes, and cancel lifecycle', async ({ request }) => {
  const org = await registerOrg(request, 'mobile-calendar');
  const contact = await createContact(request, org.token);
  const title = `Mobile calendar ${uniqueSuffix('event')}`;
  const initialNotes = 'Agenda before meeting';
  const postMeetingNotes = `Post meeting notes ${uniqueSuffix('notes')}`;
  const { startTime, endTime } = futureEventWindow(5);
  const bounds = dayBoundsFromIso(startTime);

  const event = await createCalendarEvent(request, org.token, {
    title,
    contactId: contact.id,
    startTime,
    endTime,
    notes: initialNotes,
  });
  expect(event.title).toBe(title);
  expect(event.contact_id).toBe(contact.id);
  expect(event.start_time).toBe(startTime);
  expect(event.end_time).toBe(endTime);
  expect(event.status).toBe('scheduled');
  expect(event.notes).toBe(initialNotes);
  expect(event.completed_at).toBeNull();

  const scheduledEvents = await listCalendarEventsForContact(request, org.token, contact.id, bounds);
  const listed = scheduledEvents.find((candidate) => candidate.id === event.id);
  expect(listed).toBeDefined();
  expect(listed?.status).toBe('scheduled');
  expect(listed?.notes).toBe(initialNotes);

  const completeRes = await request.post(`/api/v1/calendar/${event.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);
  const completedBody = (await completeRes.json()) as DataResponse<CalendarEventRecord>;
  expect(completedBody.data.status).toBe('completed');
  expect(completedBody.data.completed_at).not.toBeNull();

  const notesRes = await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: authHeaders(org.token),
    data: { notes: postMeetingNotes },
  });
  expect(notesRes.status()).toBe(200);
  const notesBody = (await notesRes.json()) as DataResponse<CalendarEventRecord>;
  expect(notesBody.data.status).toBe('completed');
  expect(notesBody.data.notes).toBe(postMeetingNotes);
  expect(notesBody.data.post_meeting_prompted).toBe(true);

  const cancelRes = await request.delete(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
  });
  expect(cancelRes.status()).toBe(200);
  const cancelBody = (await cancelRes.json()) as DataResponse<CalendarEventRecord>;
  expect(cancelBody.data.status).toBe('cancelled');
  expect(cancelBody.data.notes).toBe(postMeetingNotes);

  const activeEvents = await listCalendarEventsForContact(request, org.token, contact.id, bounds);
  expect(activeEvents.some((candidate) => candidate.id === event.id)).toBe(false);

  const cancelledEvents = await listCalendarEventsForContact(request, org.token, contact.id, bounds, 'cancelled');
  const cancelled = cancelledEvents.find((candidate) => candidate.id === event.id);
  expect(cancelled).toBeDefined();
  expect(cancelled?.status).toBe('cancelled');
  expect(cancelled?.notes).toBe(postMeetingNotes);
});

// ── Ring 4/5 gap tests ────────────────────────────────────────────────────────

test('mobile messaging: POST /messages/in-app with body exceeding 5000 chars returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'msg-body-too-long');
  const contact = await createContact(request, org.token);
  const oversizedBody = 'x'.repeat(5001);

  const res = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, body: oversizedBody },
  });
  expect(res.status()).toBe(400);
});

test('mobile messaging: POST /messages/in-app with missing body field returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'msg-no-body');
  const contact = await createContact(request, org.token);

  const res = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id },
  });
  expect(res.status()).toBe(400);
});

test('mobile messaging: POST /messages/in-app with missing contact_id returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'msg-no-contact');

  const res = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { body: 'No contact provided' },
  });
  expect(res.status()).toBe(400);
});

test('mobile messaging: POST /messages/call with missing direction field returns 400', async ({ request }) => {
  const org = await registerOrg(request, 'call-no-dir');
  const contact = await createContact(request, org.token);

  const res = await request.post('/api/v1/messages/call', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, duration_seconds: 120, notes: 'Missing direction' },
  });
  expect(res.status()).toBe(400);
});

test('mobile messaging: GET /messages?contact_id returns only messages for that contact', async ({ request }) => {
  const org = await registerOrg(request, 'msg-isolation');
  const contactA = await createContact(request, org.token);
  const contactB = await createContact(request, org.token);

  const bodyA = `Contact A note ${uniqueSuffix('iso')}`;
  const bodyB = `Contact B note ${uniqueSuffix('iso')}`;

  const resA = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contactA.id, body: bodyA },
  });
  expect(resA.status()).toBe(201);

  const resB = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contactB.id, body: bodyB },
  });
  expect(resB.status()).toBe(201);

  const listRes = await request.get(`/api/v1/messages?contact_id=${contactA.id}`, {
    headers: authHeaders(org.token),
  });
  expect(listRes.status()).toBe(200);

  const listBody = (await listRes.json()) as ListResponse<MessageRecord>;
  expect(listBody.data.every((m) => m.contact_id === contactA.id)).toBe(true);
  expect(listBody.data.some((m) => m.body === bodyA)).toBe(true);
  expect(listBody.data.some((m) => m.contact_id === contactB.id)).toBe(false);
});

test('mobile messaging: GET /messages?channel=in_app returns only in_app channel messages', async ({ request }) => {
  const org = await registerOrg(request, 'msg-channel-filter');
  const contact = await createContact(request, org.token);

  const inAppBody = `In-app note ${uniqueSuffix('chan')}`;
  const inAppRes = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, body: inAppBody },
  });
  expect(inAppRes.status()).toBe(201);

  // also log a call so there is at least one non-sms message of a different subtype
  const callRes = await request.post('/api/v1/messages/call', {
    headers: authHeaders(org.token),
    data: { contact_id: contact.id, direction: 'inbound', duration_seconds: 60, notes: 'quick check' },
  });
  expect(callRes.status()).toBe(201);

  const listRes = await request.get(
    `/api/v1/messages?contact_id=${contact.id}&channel=in_app`,
    { headers: authHeaders(org.token) },
  );
  expect(listRes.status()).toBe(200);

  const listBody = (await listRes.json()) as ListResponse<MessageRecord>;
  expect(listBody.data.length).toBeGreaterThan(0);
  expect(listBody.data.every((m) => m.channel === 'in_app')).toBe(true);
});

test('mobile calendar: GET /calendar?contact_id filter returns only events for that contact', async ({ request }) => {
  const org = await registerOrg(request, 'cal-contact-filter');
  const contactA = await createContact(request, org.token);
  const contactB = await createContact(request, org.token);

  const { startTime: startA, endTime: endA } = futureEventWindow(3);
  const { startTime: startB, endTime: endB } = futureEventWindow(4);
  const titleA = `Cal filter A ${uniqueSuffix('ev')}`;
  const titleB = `Cal filter B ${uniqueSuffix('ev')}`;

  const eventA = await createCalendarEvent(request, org.token, {
    title: titleA,
    contactId: contactA.id,
    startTime: startA,
    endTime: endA,
  });
  await createCalendarEvent(request, org.token, {
    title: titleB,
    contactId: contactB.id,
    startTime: startB,
    endTime: endB,
  });

  const bounds = { start: futureEventWindow(1).startTime, end: futureEventWindow(10).endTime };
  const eventsForA = await listCalendarEventsForContact(request, org.token, contactA.id, bounds);

  expect(eventsForA.some((e) => e.id === eventA.id)).toBe(true);
  expect(eventsForA.every((e) => e.contact_id === contactA.id)).toBe(true);
});

test('mobile calendar: PATCH title update is confirmed on readback', async ({ request }) => {
  const org = await registerOrg(request, 'cal-patch-title');
  const contact = await createContact(request, org.token);
  const { startTime, endTime } = futureEventWindow(6);
  const originalTitle = `Original title ${uniqueSuffix('patch')}`;
  const updatedTitle = `Updated title ${uniqueSuffix('patch')}`;

  const event = await createCalendarEvent(request, org.token, {
    title: originalTitle,
    contactId: contact.id,
    startTime,
    endTime,
  });

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
    data: { title: updatedTitle },
  });
  expect(patchRes.status()).toBe(200);

  const patchBody = (await patchRes.json()) as DataResponse<CalendarEventRecord>;
  expect(patchBody.data.title).toBe(updatedTitle);
  expect(patchBody.data.id).toBe(event.id);
});

test('mobile calendar: POST /calendar/:id/notes on a completed event stores notes', async ({ request }) => {
  const org = await registerOrg(request, 'cal-completed-notes');
  const contact = await createContact(request, org.token);
  const { startTime, endTime } = futureEventWindow(7);
  const title = `Notes on completed ${uniqueSuffix('ev')}`;
  const postNotes = `Post-event notes ${uniqueSuffix('notes')}`;

  const event = await createCalendarEvent(request, org.token, {
    title,
    contactId: contact.id,
    startTime,
    endTime,
  });

  const completeRes = await request.post(`/api/v1/calendar/${event.id}/complete`, {
    headers: authHeaders(org.token),
  });
  expect(completeRes.status()).toBe(200);

  const notesRes = await request.post(`/api/v1/calendar/${event.id}/notes`, {
    headers: authHeaders(org.token),
    data: { notes: postNotes },
  });
  expect(notesRes.status()).toBe(200);

  const notesBody = (await notesRes.json()) as DataResponse<CalendarEventRecord>;
  expect(notesBody.data.status).toBe('completed');
  expect(notesBody.data.notes).toBe(postNotes);
  expect(notesBody.data.post_meeting_prompted).toBe(true);
  expect(notesBody.data.id).toBe(event.id);
});

test('mobile messaging: 3 concurrent in-app messages to same contact all return 201 with unique ids', async ({ request }) => {
  const org = await registerOrg(request, 'msg-concurrent');
  const contact = await createContact(request, org.token);

  const payloads = [
    `Concurrent note 1 ${uniqueSuffix('c')}`,
    `Concurrent note 2 ${uniqueSuffix('c')}`,
    `Concurrent note 3 ${uniqueSuffix('c')}`,
  ];

  const results = await Promise.all(
    payloads.map((body) =>
      request.post('/api/v1/messages/in-app', {
        headers: authHeaders(org.token),
        data: { contact_id: contact.id, body },
      }),
    ),
  );

  for (const res of results) {
    expect(res.status()).toBe(201);
  }

  const ids = await Promise.all(
    results.map(async (res) => {
      const body = (await res.json()) as DataResponse<MessageRecord>;
      return body.data.id;
    }),
  );

  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(3);
});
