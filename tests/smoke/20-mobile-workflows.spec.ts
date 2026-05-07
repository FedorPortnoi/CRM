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
  expect(callBody.data.channel).toBe('in_app');
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
