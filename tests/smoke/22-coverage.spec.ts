import { APIRequestContext, expect, test } from '@playwright/test';
import { getAuth } from './helpers/auth';

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
  assigned_to: string | null;
  status: string;
};

type TaskRecord = {
  id: string;
  title: string;
  contact_id: string | null;
  deal_id: string | null;
  assigned_to: string;
  due_date: string | null;
  priority: string;
  status: string;
};

type CalendarEventRecord = {
  id: string;
  title: string;
  description: string | null;
  contact_id: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
  notes: string | null;
  reminder_minutes: number;
  status: string;
};

type Pipeline = {
  id: string;
  is_default: boolean;
  stages: { id: string }[];
};

type DealRecord = {
  id: string;
  contact_id: string;
};

type ErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

type ContactListResponse = {
  data: ContactRecord[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
};

type MessageListResponse = {
  data: { id: string; body: string; contact_id: string }[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
};

type DataResponse<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

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

async function createContact(
  request: APIRequestContext,
  token: string,
  fields: { firstName?: string; assignedTo?: string } = {},
): Promise<ContactRecord> {
  const res = await request.post('/api/v1/contacts', {
    headers: authHeaders(token),
    data: {
      first_name: fields.firstName ?? uniqueSuffix('Contact'),
      ...(fields.assignedTo !== undefined ? { assigned_to: fields.assignedTo } : {}),
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<ContactRecord>;
  return body.data;
}

async function getContact(
  request: APIRequestContext,
  token: string,
  contactId: string,
): Promise<ContactRecord> {
  const res = await request.get(`/api/v1/contacts/${contactId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);

  const body = (await res.json()) as DataResponse<ContactRecord>;
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

  if (!pipeline) {
    throw new Error('No pipeline with stages found');
  }

  return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
}

async function createDeal(
  request: APIRequestContext,
  token: string,
  options: { contactId: string; pipelineId: string; stageId: string },
): Promise<DealRecord> {
  const res = await request.post('/api/v1/deals', {
    headers: authHeaders(token),
    data: {
      title: uniqueSuffix('Session22Deal'),
      contact_id: options.contactId,
      pipeline_id: options.pipelineId,
      stage_id: options.stageId,
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<DealRecord>;
  return body.data;
}

async function createTask(
  request: APIRequestContext,
  token: string,
  options: {
    assignedTo: string;
    contactId: string;
    dealId: string;
    dueDate: string;
    priority: string;
  },
): Promise<TaskRecord> {
  const res = await request.post('/api/v1/tasks', {
    headers: authHeaders(token),
    data: {
      title: uniqueSuffix('Session22Task'),
      assigned_to: options.assignedTo,
      contact_id: options.contactId,
      deal_id: options.dealId,
      due_date: options.dueDate,
      priority: options.priority,
    },
  });
  expect(res.status()).toBe(201);

  const body = (await res.json()) as DataResponse<TaskRecord>;
  return body.data;
}

async function getTask(
  request: APIRequestContext,
  token: string,
  taskId: string,
): Promise<TaskRecord> {
  const res = await request.get(`/api/v1/tasks/${taskId}`, {
    headers: authHeaders(token),
  });
  expect(res.status()).toBe(200);

  const body = (await res.json()) as DataResponse<TaskRecord>;
  return body.data;
}

async function createCalendarEvent(
  request: APIRequestContext,
  token: string,
  options: {
    title?: string;
    contactId?: string;
    startTime?: string;
    endTime?: string;
    description?: string;
    location?: string;
    notes?: string;
    reminderMinutes?: number;
  } = {},
): Promise<CalendarEventRecord> {
  const res = await request.post('/api/v1/calendar', {
    headers: authHeaders(token),
    data: {
      title: options.title ?? uniqueSuffix('Session22Event'),
      start_time: options.startTime ?? futureIso(2, 14),
      end_time: options.endTime ?? futureIso(2, 15),
      ...(options.contactId !== undefined ? { contact_id: options.contactId } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.location !== undefined ? { location: options.location } : {}),
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
      ...(options.reminderMinutes !== undefined ? { reminder_minutes: options.reminderMinutes } : {}),
    },
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

async function expectCsvHeader(
  request: APIRequestContext,
  report: string,
  expectedHeader: string,
): Promise<void> {
  const { token } = getAuth();
  const res = await request.post('/api/v1/analytics/export', {
    headers: authHeaders(token),
    data: { format: 'csv', report, period: 'month' },
  });
  expect(res.status()).toBe(200);

  const text = await res.text();
  expect(text.split('\n')[0]).toBe(expectedHeader);
}

test('PATCH /api/v1/tasks/:id updates only provided fields and preserves existing task metadata', async ({ request }) => {
  const org = await registerOrg(request, 'task-partial-preserve');
  const contact = await createContact(request, org.token);
  const { pipelineId, stageId } = await getPipelineAndStage(request, org.token);
  const deal = await createDeal(request, org.token, {
    contactId: contact.id,
    pipelineId,
    stageId,
  });
  const dueDate = futureIso(4, 12);
  const task = await createTask(request, org.token, {
    assignedTo: org.userId,
    contactId: contact.id,
    dealId: deal.id,
    dueDate,
    priority: 'high',
  });

  const startRes = await request.post(`/api/v1/tasks/${task.id}/start`, {
    headers: authHeaders(org.token),
  });
  expect(startRes.status()).toBe(200);

  const patchRes = await request.patch(`/api/v1/tasks/${task.id}`, {
    headers: authHeaders(org.token),
    data: { title: 'Session 22 partial task update' },
  });
  expect(patchRes.status()).toBe(200);
  const patchBody = (await patchRes.json()) as DataResponse<TaskRecord>;
  expect(patchBody.data.title).toBe('Session 22 partial task update');
  expect(patchBody.data.due_date).toBe(dueDate);
  expect(patchBody.data.contact_id).toBe(contact.id);
  expect(patchBody.data.deal_id).toBe(deal.id);
  expect(patchBody.data.priority).toBe('high');
  expect(patchBody.data.status).toBe('in_progress');
  expect(patchBody.data.assigned_to).toBe(org.userId);

  const stored = await getTask(request, org.token, task.id);
  expect(stored.due_date).toBe(dueDate);
  expect(stored.contact_id).toBe(contact.id);
  expect(stored.deal_id).toBe(deal.id);
  expect(stored.priority).toBe('high');
  expect(stored.status).toBe('in_progress');
  expect(stored.assigned_to).toBe(org.userId);
});

test('PATCH /api/v1/calendar/:id updates start and end times while preserving unrelated fields', async ({ request }) => {
  const org = await registerOrg(request, 'calendar-time-update');
  const contact = await createContact(request, org.token);
  const event = await createCalendarEvent(request, org.token, {
    title: 'Session 22 calendar preserve',
    contactId: contact.id,
    description: 'Original description',
    location: 'Original room',
    notes: 'Original notes',
    reminderMinutes: 45,
    startTime: futureIso(3, 9),
    endTime: futureIso(3, 10),
  });
  const nextStart = futureIso(5, 16);
  const nextEnd = futureIso(5, 17);

  const patchRes = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
    data: { start_time: nextStart, end_time: nextEnd },
  });
  expect(patchRes.status()).toBe(200);

  const body = (await patchRes.json()) as DataResponse<CalendarEventRecord>;
  expect(body.data.start_time).toBe(nextStart);
  expect(body.data.end_time).toBe(nextEnd);
  expect(body.data.title).toBe('Session 22 calendar preserve');
  expect(body.data.description).toBe('Original description');
  expect(body.data.contact_id).toBe(contact.id);
  expect(body.data.location).toBe('Original room');
  expect(body.data.notes).toBe('Original notes');
  expect(body.data.reminder_minutes).toBe(45);
  expect(body.data.status).toBe('scheduled');
});

test('PATCH /api/v1/calendar/:id rejects end_time before start_time with status 400', async ({ request }) => {
  const org = await registerOrg(request, 'calendar-invalid-window');
  const originalStart = futureIso(2, 12);
  const originalEnd = futureIso(2, 13);
  const event = await createCalendarEvent(request, org.token, {
    startTime: originalStart,
    endTime: originalEnd,
  });

  const res = await request.patch(`/api/v1/calendar/${event.id}`, {
    headers: authHeaders(org.token),
    data: { start_time: futureIso(6, 15), end_time: futureIso(6, 14) },
  });
  expect(res.status()).toBe(400);

  const stored = await getCalendarEvent(request, org.token, event.id);
  expect(stored.start_time).toBe(originalStart);
  expect(stored.end_time).toBe(originalEnd);
});

test('POST /api/v1/contacts/bulk-archive archives selected contacts and removes them from the default list', async ({ request }) => {
  const org = await registerOrg(request, 'bulk-archive-success');
  const prefix = uniqueSuffix('BulkArchive');
  const first = await createContact(request, org.token, { firstName: `${prefix} One` });
  const second = await createContact(request, org.token, { firstName: `${prefix} Two` });

  const res = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(org.token),
    data: { contact_ids: [first.id, second.id] },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<{ archived_count: number; contact_ids: string[] }>;
  expect(body.data.archived_count).toBe(2);
  expect(body.data.contact_ids).toEqual([first.id, second.id]);

  const archivedFirst = await getContact(request, org.token, first.id);
  const archivedSecond = await getContact(request, org.token, second.id);
  expect(archivedFirst.status).toBe('archived');
  expect(archivedSecond.status).toBe('archived');

  const listRes = await request.get(`/api/v1/contacts?q=${encodeURIComponent(prefix)}&per_page=10`, {
    headers: authHeaders(org.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ContactListResponse;
  expect(listBody.data.map((contact) => contact.id)).not.toContain(first.id);
  expect(listBody.data.map((contact) => contact.id)).not.toContain(second.id);
});

test('POST /api/v1/contacts/bulk-archive rejects another-org contact_id without archiving requester contacts', async ({ request }) => {
  const orgA = await registerOrg(request, 'bulk-archive-a');
  const orgB = await registerOrg(request, 'bulk-archive-b');
  const prefix = uniqueSuffix('BulkArchiveReject');
  const requesterFirst = await createContact(request, orgA.token, { firstName: `${prefix} One` });
  const requesterSecond = await createContact(request, orgA.token, { firstName: `${prefix} Two` });
  const otherOrgContact = await createContact(request, orgB.token);

  const res = await request.post('/api/v1/contacts/bulk-archive', {
    headers: authHeaders(orgA.token),
    data: { contact_ids: [requesterFirst.id, otherOrgContact.id] },
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('NOT_FOUND');

  const listRes = await request.get(`/api/v1/contacts?q=${encodeURIComponent(prefix)}&per_page=10`, {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ContactListResponse;
  const ids = listBody.data.map((contact) => contact.id);
  expect(ids).toContain(requesterFirst.id);
  expect(ids).toContain(requesterSecond.id);
});

test('POST /api/v1/contacts/bulk-assign assigns multiple contacts to the current-org user and persists assigned_to', async ({ request }) => {
  const org = await registerOrg(request, 'bulk-assign-success');
  const first = await createContact(request, org.token);
  const second = await createContact(request, org.token);

  const res = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(org.token),
    data: { contact_ids: [first.id, second.id], assigned_to: org.userId },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as DataResponse<{ assigned_count: number; assigned_to: string; contact_ids: string[] }>;
  expect(body.data.assigned_count).toBe(2);
  expect(body.data.assigned_to).toBe(org.userId);
  expect(body.data.contact_ids).toEqual([first.id, second.id]);

  const storedFirst = await getContact(request, org.token, first.id);
  const storedSecond = await getContact(request, org.token, second.id);
  expect(storedFirst.assigned_to).toBe(org.userId);
  expect(storedSecond.assigned_to).toBe(org.userId);
});

test('POST /api/v1/contacts/bulk-assign rejects assigned_to from another org and preserves contacts', async ({ request }) => {
  const orgA = await registerOrg(request, 'bulk-assign-a');
  const orgB = await registerOrg(request, 'bulk-assign-b');
  const first = await createContact(request, orgA.token, { assignedTo: orgA.userId });
  const second = await createContact(request, orgA.token, { assignedTo: orgA.userId });

  const res = await request.post('/api/v1/contacts/bulk-assign', {
    headers: authHeaders(orgA.token),
    data: { contact_ids: [first.id, second.id], assigned_to: orgB.userId },
  });
  expect(res.status()).toBe(403);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('FORBIDDEN');

  const storedFirst = await getContact(request, orgA.token, first.id);
  const storedSecond = await getContact(request, orgA.token, second.id);
  expect(storedFirst.assigned_to).toBe(orgA.userId);
  expect(storedSecond.assigned_to).toBe(orgA.userId);
});

test('GET /api/v1/messages?contact_id=<other-org-contact> returns an empty org-scoped list with total 0', async ({ request }) => {
  const orgA = await registerOrg(request, 'messages-list-a');
  const orgB = await registerOrg(request, 'messages-list-b');
  const otherContact = await createContact(request, orgB.token);

  const messageRes = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(orgB.token),
    data: { contact_id: otherContact.id, body: 'Other org message' },
  });
  expect(messageRes.status()).toBe(201);

  const res = await request.get(`/api/v1/messages?contact_id=${otherContact.id}`, {
    headers: authHeaders(orgA.token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as MessageListResponse;
  expect(body.data).toHaveLength(0);
  expect(body.meta.total).toBe(0);
});

test('POST /api/v1/messages/in-app with another-org contact returns 404 CONTACT_NOT_FOUND and creates no requester message', async ({ request }) => {
  const orgA = await registerOrg(request, 'messages-create-a');
  const orgB = await registerOrg(request, 'messages-create-b');
  const otherContact = await createContact(request, orgB.token);

  const res = await request.post('/api/v1/messages/in-app', {
    headers: authHeaders(orgA.token),
    data: { contact_id: otherContact.id, body: 'Should not be created' },
  });
  expect(res.status()).toBe(404);
  const body = (await res.json()) as ErrorResponse;
  expect(body.error.code).toBe('CONTACT_NOT_FOUND');

  const listRes = await request.get('/api/v1/messages', {
    headers: authHeaders(orgA.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as MessageListResponse;
  expect(listBody.data).toHaveLength(0);
  expect(listBody.meta.total).toBe(0);
});

test('GET /api/v1/analytics/stage-duration for a brand-new org returns an empty data array and a meta.note string', async ({ request }) => {
  const org = await registerOrg(request, 'stage-duration-empty');

  const res = await request.get('/api/v1/analytics/stage-duration', {
    headers: authHeaders(org.token),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: unknown[]; meta: { note: string } };
  expect(body.data).toEqual([]);
  expect(typeof body.meta.note).toBe('string');
  expect(body.meta.note.length).toBeGreaterThan(0);
});

test('POST /api/v1/analytics/export report=revenue returns CSV revenue header', async ({ request }) => {
  await expectCsvHeader(request, 'revenue', 'period,deal_count,revenue,avg_deal_value');
});

test('POST /api/v1/analytics/export report=team_activity returns CSV team activity header', async ({ request }) => {
  await expectCsvHeader(request, 'team_activity', 'user_id,name,messages,tasks,meetings,total');
});

test('POST /api/v1/analytics/export report=win_loss returns CSV win-loss header', async ({ request }) => {
  await expectCsvHeader(request, 'win_loss', 'status,count,total_value,lost_reason,reason_count');
});

test('POST /api/v1/analytics/export report=lead_sources returns CSV lead sources header', async ({ request }) => {
  await expectCsvHeader(request, 'lead_sources', 'source,count,total_value');
});

test('GET /api/v1/auth/users returns 200 with requester org user, excludes another org user, reports total, and omits password_hash', async ({ request }) => {
  type AuthUserListItem = {
    id: string;
    email: string;
    name: string;
    role: string;
  };

  type AuthUsersListResponse = {
    data: AuthUserListItem[];
    meta: {
      total: number;
    };
  };

  const orgA = await registerOrg(request, 'auth-users-a');
  const orgB = await registerOrg(request, 'auth-users-b');

  const res = await request.get('/api/v1/auth/users', {
    headers: authHeaders(orgA.token),
  });
  expect(res.status()).toBe(200);

  const body = (await res.json()) as AuthUsersListResponse;
  expect(body.data.some((user) => user.id === orgA.userId)).toBe(true);
  expect(body.data.some((user) => user.id === orgB.userId)).toBe(false);
  expect(body.meta.total).toBe(body.data.length);
  expect(body.data.some((user) => 'password_hash' in user)).toBe(false);
});

test('POST /api/v1/contacts/import-csv with two JSON row objects returns 201/imported_count 2 and lists imported contacts with expected fields', async ({ request }) => {
  type ImportedContactRecord = {
    id: string;
    first_name: string;
    last_name: string | null;
    company: string | null;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    source: string | null;
    notes: string | null;
    type: string;
  };

  type ImportedContactListResponse = {
    data: ImportedContactRecord[];
    meta: {
      total: number;
      page: number;
      per_page: number;
    };
  };

  const org = await registerOrg(request, 'contacts-import-csv-success');
  const prefix = uniqueSuffix('ImportCsv');
  const aliceEmail = `alice.${prefix.toLowerCase()}@example.com`;

  const res = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(org.token),
    data: [
      {
        first_name: ` ${prefix} Alice `,
        last_name: ' Anderson ',
        company: ' Acme Import Co ',
        email: ` ${aliceEmail} `,
        phone: ' 555-0100 ',
        mobile: ' ',
        source: ' Mobile CSV ',
        notes: ' First imported row ',
        type: 'lead',
      },
      {
        first_name: `${prefix} Bob`,
        company: `${prefix} Beta LLC`,
        email: '',
        phone: ' 555-0101 ',
        type: 'customer',
      },
    ],
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DataResponse<{ imported_count: number }>;
  expect(body.data.imported_count).toBe(2);
  expect(body.meta).toEqual({});

  const listRes = await request.get(`/api/v1/contacts?q=${encodeURIComponent(prefix)}&per_page=10`, {
    headers: authHeaders(org.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ImportedContactListResponse;
  expect(listBody.meta.total).toBe(2);

  const alice = listBody.data.find((contact) => contact.first_name === `${prefix} Alice`);
  const bob = listBody.data.find((contact) => contact.first_name === `${prefix} Bob`);
  expect(alice).toBeDefined();
  expect(bob).toBeDefined();

  if (alice === undefined || bob === undefined) {
    throw new Error('Imported contacts were not returned by the contacts list');
  }

  expect(alice.last_name).toBe('Anderson');
  expect(alice.company).toBe('Acme Import Co');
  expect(alice.email).toBe(aliceEmail);
  expect(alice.phone).toBe('555-0100');
  expect(alice.mobile).toBeNull();
  expect(alice.source).toBe('Mobile CSV');
  expect(alice.notes).toBe('First imported row');
  expect(alice.type).toBe('lead');
  expect(bob.company).toBe(`${prefix} Beta LLC`);
  expect(bob.email).toBeNull();
  expect(bob.phone).toBe('555-0101');
  expect(bob.type).toBe('customer');
});

test('POST /api/v1/contacts/import-csv with an empty array returns 400 and creates no contacts matching a unique prefix', async ({ request }) => {
  const org = await registerOrg(request, 'contacts-import-csv-empty');
  const prefix = uniqueSuffix('ImportCsvEmpty');

  const res = await request.post('/api/v1/contacts/import-csv', {
    headers: authHeaders(org.token),
    data: [],
  });
  expect(res.status()).toBe(400);

  const listRes = await request.get(`/api/v1/contacts?q=${encodeURIComponent(prefix)}&per_page=10`, {
    headers: authHeaders(org.token),
  });
  expect(listRes.status()).toBe(200);
  const listBody = (await listRes.json()) as ContactListResponse;
  expect(listBody.data).toHaveLength(0);
  expect(listBody.meta.total).toBe(0);
});
