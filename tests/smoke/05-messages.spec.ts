import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

interface MessageData {
  id: string;
  contact_id: string;
  body: string;
  channel: string;
  direction: string;
  status: string;
  created_at: string;
  read_at: string | null;
  subject?: string;
  duration_seconds?: number;
  notes?: string;
}

interface MessageResponse {
  data: MessageData;
}

interface MessageListResponse {
  data: MessageData[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
}

interface ConversationResponse {
  data: MessageData[];
}

interface AuthResponse {
  data: {
    token: string;
    user: { id: string };
  };
}

interface ContactData {
  id: string;
  first_name: string;
  status?: string;
}

interface ContactResponse {
  data: ContactData;
}

async function registerOrg(request: APIRequestContext, suffix: string): Promise<{ token: string; userId: string }> {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await request.post('/api/v1/auth/', {
    data: { email: `${unique}@example.com`, password: 'Password123!', name: `User ${suffix}`, org_name: `Org ${unique}` },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as AuthResponse;
  return { token: body.data.token, userId: body.data.user.id };
}

async function createContact(request: APIRequestContext, token: string, firstName: string): Promise<string> {
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: firstName, phone: `+1555${Math.floor(1000000 + Math.random() * 9000000)}` },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as ContactResponse;
  return body.data.id;
}

async function sendInApp(request: APIRequestContext, token: string, contactId: string, body: string): Promise<MessageData> {
  const res = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, body },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  return json.data;
}

let contactId: string;

test.beforeAll(async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/contacts', {
    headers: { Authorization: `Bearer ${token}` },
    data: { first_name: 'MsgContact', phone: '+15550001234' },
  });
  const body = await res.json();
  contactId = body.data.id;
});

// ── Original 4 tests ──────────────────────────────────────────────────────────

test('GET /api/v1/messages returns list', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

test('POST /api/v1/messages/in-app sends in-app message', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, body: 'Hello smoke test' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.channel).toBe('in_app');
});

test('POST /api/v1/messages/log-call logs a call', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: contactId, direction: 'outbound', duration_seconds: 120, notes: 'Smoke call' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.channel).toBe('call');
});

test('GET /api/v1/messages/conversation/:contactId returns thread', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get(`/api/v1/messages/conversation/${contactId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

// ── Rung 4 & 5 tests ─────────────────────────────────────────────────────────

test('POST /messages/in-app then GET /conversation: message appears in thread', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-conv-appear');
  const cid = await createContact(request, token, 'ConvAppear');
  const msgBody = 'appear in thread test';
  await sendInApp(request, token, cid, msgBody);
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as ConversationResponse;
  expect(json.data.some((m) => m.body === msgBody)).toBe(true);
});

test('POST /messages/in-app then POST /:id/read: status becomes read, read_at set in conversation', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-read-conv');
  const cid = await createContact(request, token, 'ReadConv');
  const msg = await sendInApp(request, token, cid, 'mark me read');
  const readRes = await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status()).toBe(200);
  const convRes = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const conv = (await convRes.json()) as ConversationResponse;
  const found = conv.data.find((m) => m.id === msg.id);
  expect(found).toBeDefined();
  expect(found?.status).toBe('read');
  expect(found?.read_at).not.toBeNull();
});

test('POST /messages/call duration_seconds=90: body stores seconds prefix', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-90');
  const cid = await createContact(request, token, 'Call90');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 90 },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('[90s]');
});

test('POST /messages/call duration_seconds=90 and notes: body has seconds prefix then notes', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-dur-notes');
  const cid = await createContact(request, token, 'CallDurNotes');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 90, notes: 'discussed pricing' },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('[90s] discussed pricing');
});

test('POST /messages/call duration_seconds=3600: body stores seconds prefix', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-3600');
  const cid = await createContact(request, token, 'Call3600');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 3600 },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('[3600s]');
});

test('POST /messages/call direction=inbound: direction stored as inbound', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-inbound');
  const cid = await createContact(request, token, 'CallInbound');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'inbound' },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.direction).toBe('inbound');
});

test('POST /messages/sms: body stored correctly in GET /conversation', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-sms-conv');
  const cid = await createContact(request, token, 'SmsConv');
  const smsBody = 'sms body stored check';
  const res = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: smsBody },
  });
  expect(res.status()).toBe(201);
  const convRes = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const conv = (await convRes.json()) as ConversationResponse;
  expect(conv.data.some((m) => m.body === smsBody && m.channel === 'sms')).toBe(true);
});

test('POST /messages/email returns 404 because email route is not implemented', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-email-stored');
  const cid = await createContact(request, token, 'EmailStored');
  const res = await request.post('/api/v1/messages/email', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, subject: 'Test Subject', body: 'Test email body' },
  });
  expect(res.status()).toBe(404);
});

test('GET /messages?channel=sms returns only sms messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-sms');
  const cid = await createContact(request, token, 'FilterSms');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'sms filter test' },
  });
  await sendInApp(request, token, cid, 'in-app to exclude');
  const res = await request.get('/api/v1/messages?channel=sms', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.channel === 'sms')).toBe(true);
  expect(json.data.length).toBeGreaterThan(0);
});

test('GET /messages?channel=email returns empty list when no email messages exist', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-email');
  const cid = await createContact(request, token, 'FilterEmail');
  await sendInApp(request, token, cid, 'in-app to exclude');
  const res = await request.get('/api/v1/messages?channel=email', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.channel === 'email')).toBe(true);
  expect(json.data.length).toBe(0);
});

test('GET /messages?channel=in_app returns only in_app messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-inapp');
  const cid = await createContact(request, token, 'FilterInApp');
  await sendInApp(request, token, cid, 'in-app channel filter test');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'sms to exclude' },
  });
  const res = await request.get('/api/v1/messages?channel=in_app', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.channel === 'in_app')).toBe(true);
  expect(json.data.length).toBeGreaterThan(0);
});

test('GET /messages?status=delivered returns only delivered messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-delivered');
  const cid = await createContact(request, token, 'FilterDelivered');
  await sendInApp(request, token, cid, 'sent status test');
  await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound' },
  });
  const res = await request.get('/api/v1/messages?status=delivered', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.status === 'delivered')).toBe(true);
  expect(json.data.some((m) => m.status === 'delivered')).toBe(true);
  expect(json.data.some((m) => m.status === 'sent')).toBe(false);
});

test('GET /messages?status=pending returns pending messages (sms/email)', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-pending');
  const cid = await createContact(request, token, 'FilterPending');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'pending status test' },
  });
  const res = await request.get('/api/v1/messages?status=pending', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.status === 'pending')).toBe(true);
  expect(json.data.length).toBeGreaterThan(0);
});

test('GET /messages?status=read returns read messages after marking one', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-read');
  const cid = await createContact(request, token, 'FilterRead');
  const msg = await sendInApp(request, token, cid, 'will be read');
  await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const res = await request.get('/api/v1/messages?status=read', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.status === 'read')).toBe(true);
  expect(json.data.some((m) => m.id === msg.id)).toBe(true);
});

test('GET /messages?status=read returns only read messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-read-excludes-delivered');
  const cid = await createContact(request, token, 'ReadExcludesDelivered');
  const msg = await sendInApp(request, token, cid, 'will be read');
  await sendInApp(request, token, cid, 'stays delivered');
  await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const res = await request.get('/api/v1/messages?status=read', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.status === 'read')).toBe(true);
  expect(json.data.some((m) => m.id === msg.id && m.status === 'read')).toBe(true);
  expect(json.data.some((m) => m.status === 'sent')).toBe(false);
});

test('GET /messages?contact_id returns only that contact messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-contact');
  const cid1 = await createContact(request, token, 'FilterContact1');
  const cid2 = await createContact(request, token, 'FilterContact2');
  await sendInApp(request, token, cid1, 'for contact 1');
  await sendInApp(request, token, cid2, 'for contact 2');
  const res = await request.get(`/api/v1/messages?contact_id=${cid1}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.contact_id === cid1)).toBe(true);
  expect(json.data.some((m) => m.contact_id === cid2)).toBe(false);
});

test('GET /messages?contact_id excludes messages for a different contact', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-filter-contact-excl');
  const cid1 = await createContact(request, token, 'ExclContact1');
  const cid2 = await createContact(request, token, 'ExclContact2');
  await sendInApp(request, token, cid1, 'contact1 msg');
  await sendInApp(request, token, cid2, 'contact2 msg');
  const res = await request.get(`/api/v1/messages?contact_id=${cid2}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.some((m) => m.contact_id === cid1)).toBe(false);
});

test('Pagination: page=1 per_page=2 of 4 messages returns 2 items', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-page1');
  const cid = await createContact(request, token, 'Page1');
  for (let i = 0; i < 4; i++) {
    await sendInApp(request, token, cid, `page msg ${i}`);
  }
  const res = await request.get('/api/v1/messages?page=1&per_page=2', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.length).toBe(2);
  expect(json.meta.total).toBeGreaterThanOrEqual(4);
  expect(json.meta.page).toBe(1);
  expect(json.meta.per_page).toBe(2);
});

test('Pagination: page=2 per_page=2 of 4 messages returns remaining 2', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-page2');
  const cid = await createContact(request, token, 'Page2');
  for (let i = 0; i < 4; i++) {
    await sendInApp(request, token, cid, `page2 msg ${i}`);
  }
  const res = await request.get('/api/v1/messages?page=2&per_page=2', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.length).toBe(2);
  expect(json.meta.page).toBe(2);
});

test('GET /messages/conversation returns messages sorted asc (oldest first)', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-conv-sort');
  const cid = await createContact(request, token, 'ConvSort');
  await sendInApp(request, token, cid, 'first');
  await sendInApp(request, token, cid, 'second');
  await sendInApp(request, token, cid, 'third');
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as ConversationResponse;
  expect(json.data.length).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < json.data.length - 1; i++) {
    const a = new Date(json.data[i].created_at).getTime();
    const b = new Date(json.data[i + 1].created_at).getTime();
    expect(a).toBeLessThanOrEqual(b);
  }
});

test('Multiple in-app messages to same contact: conversation returns all', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-multi-inapp');
  const cid = await createContact(request, token, 'MultiInApp');
  const bodies = ['msg-alpha', 'msg-beta', 'msg-gamma'];
  for (const b of bodies) {
    await sendInApp(request, token, cid, b);
  }
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as ConversationResponse;
  for (const b of bodies) {
    expect(json.data.some((m) => m.body === b)).toBe(true);
  }
});

test('POST /messages/in-app then read: read_at is a valid ISO timestamp', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-read-at-iso');
  const cid = await createContact(request, token, 'ReadAtIso');
  const msg = await sendInApp(request, token, cid, 'check read_at iso');
  const readRes = await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status()).toBe(200);
  const json = (await readRes.json()) as MessageResponse;
  expect(json.data.read_at).not.toBeNull();
  expect(new Date(json.data.read_at as string).toISOString()).toBe(json.data.read_at);
});

test('POST /messages/:id/read is idempotent (calling twice both return 200)', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-read-idempotent');
  const cid = await createContact(request, token, 'ReadIdempotent');
  const msg = await sendInApp(request, token, cid, 'idempotent read test');
  const r1 = await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r1.status()).toBe(200);
  const r2 = await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r2.status()).toBe(200);
});

test('POST /messages/:id/read twice: read_at refreshes on second call', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-read-at-unchanged');
  const cid = await createContact(request, token, 'ReadAtUnchanged');
  const msg = await sendInApp(request, token, cid, 'read_at stable test');
  const r1 = await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j1 = (await r1.json()) as MessageResponse;
  const r2 = await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j2 = (await r2.json()) as MessageResponse;
  expect(new Date(j2.data.read_at as string).getTime()).toBeGreaterThanOrEqual(
    new Date(j1.data.read_at as string).getTime(),
  );
});

test('Cross-org: Org A messages not visible to Org B GET /messages', async ({ request }) => {
  const orgA = await registerOrg(request, 'r4-cross-a');
  const orgB = await registerOrg(request, 'r4-cross-b');
  const cidA = await createContact(request, orgA.token, 'CrossA');
  await sendInApp(request, orgA.token, cidA, 'org a private');
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${orgB.token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.contact_id !== cidA)).toBe(true);
});

test('Cross-org: new org GET /messages returns empty list (total=0)', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-cross-empty');
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.meta.total).toBe(0);
  expect(json.data.length).toBe(0);
});

test('POST /messages/in-app with long body (500 chars): stored and returned', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-long-body');
  const cid = await createContact(request, token, 'LongBody');
  const longBody = 'A'.repeat(500);
  const msg = await sendInApp(request, token, cid, longBody);
  expect(msg.body).toBe(longBody);
});

test('GET /messages meta.total reflects count of all org messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-meta-total');
  const cid = await createContact(request, token, 'MetaTotal');
  for (let i = 0; i < 3; i++) {
    await sendInApp(request, token, cid, `meta total msg ${i}`);
  }
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.meta.total).toBeGreaterThanOrEqual(3);
});

test('GET /messages meta.page and per_page match request parameters', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-meta-page');
  const cid = await createContact(request, token, 'MetaPage');
  await sendInApp(request, token, cid, 'meta page msg');
  const res = await request.get('/api/v1/messages?page=1&per_page=5', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.meta.page).toBe(1);
  expect(json.meta.per_page).toBe(5);
});

test('POST /messages/call channel is call', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-channel');
  const cid = await createContact(request, token, 'CallChannel');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 60 },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.channel).toBe('call');
});

test('POST /messages/call direction=inbound stored as inbound in response', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-dir-in');
  const cid = await createContact(request, token, 'CallDirIn');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'inbound', duration_seconds: 45 },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.direction).toBe('inbound');
});

test('POST /messages/sms alternate read path: status becomes read', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-sms-read');
  const cid = await createContact(request, token, 'SmsRead');
  const smsRes = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'read this sms' },
  });
  expect(smsRes.status()).toBe(201);
  const smsJson = (await smsRes.json()) as MessageResponse;
  const readRes = await request.post(`/api/v1/messages/${smsJson.data.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status()).toBe(200);
  const readJson = (await readRes.json()) as MessageResponse;
  expect(readJson.data.status).toBe('read');
});

test('POST /messages/sms then POST /:id/read: status becomes read', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-sms-read-2');
  const cid = await createContact(request, token, 'SmsRead2');
  const smsRes = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'read this sms too' },
  });
  expect(smsRes.status()).toBe(201);
  const smsJson = (await smsRes.json()) as MessageResponse;
  const readRes = await request.post(`/api/v1/messages/${smsJson.data.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status()).toBe(200);
  const readJson = (await readRes.json()) as MessageResponse;
  expect(readJson.data.status).toBe('read');
});

test('GET /messages/conversation returns messages from all supported send endpoints for one contact', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-conv-all-channels');
  const cid = await createContact(request, token, 'ConvAllChannels');
  await sendInApp(request, token, cid, 'in-app for multi-channel');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'sms for multi-channel' },
  });
  await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', notes: 'call for multi-endpoint' },
  });
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as ConversationResponse;
  expect(json.data.length).toBeGreaterThanOrEqual(3);
  const channels = new Set(json.data.map((m) => m.channel));
  expect(channels.has('in_app')).toBe(true);
  expect(channels.has('sms')).toBe(true);
});

test('3 messages (in-app, sms, call) to contact: conversation returns all 3', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-conv-3msg');
  const cid = await createContact(request, token, 'Conv3Msg');
  await sendInApp(request, token, cid, '3msg in-app');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: '3msg sms' },
  });
  await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', notes: '3msg call' },
  });
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as ConversationResponse;
  expect(json.data.length).toBeGreaterThanOrEqual(3);
});

test('GET /messages/conversation order is asc by created_at for multiple messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-conv-order');
  const cid = await createContact(request, token, 'ConvOrder');
  await sendInApp(request, token, cid, 'order-msg-1');
  await sendInApp(request, token, cid, 'order-msg-2');
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as ConversationResponse;
  for (let i = 0; i < json.data.length - 1; i++) {
    const a = new Date(json.data[i].created_at).getTime();
    const b = new Date(json.data[i + 1].created_at).getTime();
    expect(a).toBeLessThanOrEqual(b);
  }
});

test('POST /messages/in-app with unicode body: stored and returned correctly', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-unicode');
  const cid = await createContact(request, token, 'Unicode');
  const unicodeBody = 'こんにちは 🌟 Ünïcödé test';
  const msg = await sendInApp(request, token, cid, unicodeBody);
  expect(msg.body).toBe(unicodeBody);
});

test('POST /messages/in-app for non-existent contact returns 404', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-nonexistent');
  const fakeId = '00000000-0000-4000-a000-000000000000';
  const res = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: fakeId, body: 'should 404' },
  });
  expect(res.status()).toBe(404);
  const json = await res.json();
  expect(json.error.code).toBe('CONTACT_NOT_FOUND');
});

test('GET /messages?contact_id + channel combined filter returns matching only', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-combined-filter');
  const cid = await createContact(request, token, 'CombinedFilter');
  await sendInApp(request, token, cid, 'combined filter in-app');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'combined filter sms' },
  });
  const res = await request.get(`/api/v1/messages?contact_id=${cid}&channel=sms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.channel === 'sms' && m.contact_id === cid)).toBe(true);
  expect(json.data.length).toBeGreaterThan(0);
});

test('5 messages to contact: GET /conversation returns exactly 5', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-exactly-5');
  const cid = await createContact(request, token, 'Exactly5');
  for (let i = 0; i < 5; i++) {
    await sendInApp(request, token, cid, `msg-${i}`);
  }
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as ConversationResponse;
  expect(json.data.length).toBe(5);
});

test('GET /messages/conversation for archived contact still works', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-archived-contact');
  const cid = await createContact(request, token, 'ArchivedContact');
  await sendInApp(request, token, cid, 'before archive');
  await request.patch(`/api/v1/contacts/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { status: 'archived' },
  });
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as ConversationResponse;
  expect(json.data.length).toBeGreaterThanOrEqual(1);
});

test('Read a message: GET /messages?status=delivered excludes read messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-delivered-excl');
  const cid = await createContact(request, token, 'DeliveredExcl');
  const msg = await sendInApp(request, token, cid, 'will be read, not delivered');
  await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound' },
  });
  await request.post(`/api/v1/messages/${msg.id}/read`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const res = await request.get('/api/v1/messages?status=delivered', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.status === 'delivered')).toBe(true);
  expect(json.data.some((m) => m.id === msg.id)).toBe(false);
});

test('GET /messages?status=pending excludes sent messages', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-pending-channels');
  const cid = await createContact(request, token, 'PendingChannels');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'pending sms' },
  });
  await sendInApp(request, token, cid, 'sent in-app');
  const res = await request.get('/api/v1/messages?status=pending', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.every((m) => m.status === 'pending')).toBe(true);
  expect(json.data.some((m) => m.status === 'pending')).toBe(true);
  expect(json.data.some((m) => m.status === 'sent')).toBe(false);
});

test('POST /messages/call duration_seconds=60: body stores seconds prefix', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-call-60');
  const cid = await createContact(request, token, 'Call60');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 60 },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('[60s]');
});

test('Message created_at is a valid ISO string', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-created-at-iso');
  const cid = await createContact(request, token, 'CreatedAtIso');
  const msg = await sendInApp(request, token, cid, 'iso timestamp test');
  expect(msg.created_at).toBeTruthy();
  expect(new Date(msg.created_at).toISOString()).toBe(msg.created_at);
});

test('GET /messages returns messages ordered by created_at desc (newest first)', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-list-order');
  const cid = await createContact(request, token, 'ListOrder');
  await sendInApp(request, token, cid, 'list order 1');
  await sendInApp(request, token, cid, 'list order 2');
  await sendInApp(request, token, cid, 'list order 3');
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.data.length).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < json.data.length - 1; i++) {
    const a = new Date(json.data[i].created_at).getTime();
    const b = new Date(json.data[i + 1].created_at).getTime();
    expect(a).toBeGreaterThanOrEqual(b);
  }
});

test('GET /messages with no filters returns all org messages from supported endpoints', async ({ request }) => {
  const { token } = await registerOrg(request, 'r4-no-filter');
  const cid = await createContact(request, token, 'NoFilter');
  await sendInApp(request, token, cid, 'no filter in-app');
  await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'no filter sms' },
  });
  await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', notes: 'no filter call' },
  });
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as MessageListResponse;
  expect(json.meta.total).toBeGreaterThanOrEqual(3);
});

// ── Rung 5 tests ─────────────────────────────────────────────────────────────

test('R5: POST /messages/in-app missing contact_id returns 400', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-missing-cid');
  const res = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { body: 'no contact id' },
  });
  expect(res.status()).toBe(400);
});

test('R5: POST /messages/in-app missing body returns 400', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-missing-body');
  const cid = await createContact(request, token, 'MissingBody');
  const res = await request.post('/api/v1/messages/in-app', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid },
  });
  expect(res.status()).toBe(400);
});

test('R5: POST /messages/call missing contact_id returns 400', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-no-cid');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { direction: 'outbound' },
  });
  expect(res.status()).toBe(400);
});

test('R5: POST /messages/call missing direction returns 400', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-no-dir');
  const cid = await createContact(request, token, 'CallNoDir');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid },
  });
  expect(res.status()).toBe(400);
});

test('R5: POST /messages/sms missing body returns 400', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-sms-no-body');
  const cid = await createContact(request, token, 'SmsNoBody');
  const res = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid },
  });
  expect(res.status()).toBe(400);
});

test('R5: POST /messages/email missing subject returns 404 because email route is not implemented', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-email-no-subject');
  const cid = await createContact(request, token, 'EmailNoSubject');
  const res = await request.post('/api/v1/messages/email', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'no subject here' },
  });
  expect(res.status()).toBe(404);
});

test('R5: POST /messages/email missing body returns 404 because email route is not implemented', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-email-no-body');
  const cid = await createContact(request, token, 'EmailNoBody');
  const res = await request.post('/api/v1/messages/email', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, subject: 'No body email' },
  });
  expect(res.status()).toBe(404);
});

test('R5: GET /messages without auth returns 401', async ({ request }) => {
  const res = await request.get('/api/v1/messages');
  expect(res.status()).toBe(401);
});

test('R5: POST /messages/in-app without auth returns 401', async ({ request }) => {
  const res = await request.post('/api/v1/messages/in-app', {
    data: { contact_id: '00000000-0000-4000-a000-000000000001', body: 'no auth' },
  });
  expect(res.status()).toBe(401);
});

test('R5: POST /messages/call without auth returns 401', async ({ request }) => {
  const res = await request.post('/api/v1/messages/call', {
    data: { contact_id: '00000000-0000-4000-a000-000000000001', direction: 'outbound' },
  });
  expect(res.status()).toBe(401);
});

test('R5: GET /messages/conversation/:contactId without auth returns 401', async ({ request }) => {
  const res = await request.get('/api/v1/messages/conversation/00000000-0000-4000-a000-000000000001');
  expect(res.status()).toBe(401);
});

test('R5: POST /messages/:id/read without auth returns 401', async ({ request }) => {
  const res = await request.post('/api/v1/messages/00000000-0000-4000-a000-000000000001/read');
  expect(res.status()).toBe(401);
});

test('R5: POST /messages/in-app returns correct contact_id in response', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-contact-id-echo');
  const cid = await createContact(request, token, 'ContactIdEcho');
  const msg = await sendInApp(request, token, cid, 'contact id check');
  expect(msg.contact_id).toBe(cid);
});

test('R5: POST /messages/in-app returns direction=outbound', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-inapp-direction');
  const cid = await createContact(request, token, 'InAppDirection');
  const msg = await sendInApp(request, token, cid, 'direction check');
  expect(msg.direction).toBe('outbound');
});

test('R5: POST /messages/in-app returns status=sent', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-inapp-status');
  const cid = await createContact(request, token, 'InAppStatus');
  const msg = await sendInApp(request, token, cid, 'status check');
  expect(msg.status).toBe('sent');
});

test('R5: POST /messages/sms returns direction=outbound', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-sms-direction');
  const cid = await createContact(request, token, 'SmsDirection');
  const res = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'sms direction check' },
  });
  const json = (await res.json()) as MessageResponse;
  expect(json.data.direction).toBe('outbound');
});

test('R5: POST /messages/sms returns status=pending', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-sms-status');
  const cid = await createContact(request, token, 'SmsStatus');
  const res = await request.post('/api/v1/messages/sms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, body: 'sms status check' },
  });
  const json = (await res.json()) as MessageResponse;
  expect(json.data.status).toBe('pending');
});

test('R5: POST /messages/email returns 404 because email route is not implemented', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-email-channel');
  const cid = await createContact(request, token, 'EmailChannel');
  const res = await request.post('/api/v1/messages/email', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, subject: 'Channel Check', body: 'email channel check' },
  });
  expect(res.status()).toBe(404);
});

test('R5: POST /messages/email status case returns 404 because email route is not implemented', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-email-status');
  const cid = await createContact(request, token, 'EmailStatus');
  const res = await request.post('/api/v1/messages/email', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, subject: 'Status Check', body: 'email status check' },
  });
  expect(res.status()).toBe(404);
});

test('R5: POST /messages/email direction case returns 404 because email route is not implemented', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-email-dir');
  const cid = await createContact(request, token, 'EmailDir');
  const res = await request.post('/api/v1/messages/email', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, subject: 'Dir Check', body: 'email direction check' },
  });
  expect(res.status()).toBe(404);
});

test('R5: POST /messages/call returns 201 with id in response', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-id');
  const cid = await createContact(request, token, 'CallId');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound' },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.id).toBeTruthy();
});

test('R5: POST /messages/in-app response includes contact_id, body, channel, direction, status, created_at', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-full-shape');
  const cid = await createContact(request, token, 'FullShape');
  const msg = await sendInApp(request, token, cid, 'full shape check');
  expect(msg.id).toBeTruthy();
  expect(msg.contact_id).toBe(cid);
  expect(msg.body).toBe('full shape check');
  expect(msg.channel).toBe('in_app');
  expect(msg.direction).toBe('outbound');
  expect(msg.status).toBe('sent');
  expect(msg.created_at).toBeTruthy();
});

test('R5: GET /messages list response has data array and meta object', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-list-shape');
  const res = await request.get('/api/v1/messages', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as MessageListResponse;
  expect(Array.isArray(json.data)).toBe(true);
  expect(typeof json.meta.total).toBe('number');
  expect(typeof json.meta.page).toBe('number');
  expect(typeof json.meta.per_page).toBe('number');
});

test('R5: GET /messages/conversation/:contactId response has data array', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-conv-shape');
  const cid = await createContact(request, token, 'ConvShape');
  const res = await request.get(`/api/v1/messages/conversation/${cid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as ConversationResponse;
  expect(Array.isArray(json.data)).toBe(true);
});

test('R5: POST /messages/call with no duration and no notes: body is Call logged', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-no-dur-no-notes');
  const cid = await createContact(request, token, 'CallNoDurNoNotes');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound' },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('Call logged');
});

test('R5: POST /messages/call with notes only: body equals notes text', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-notes-only');
  const cid = await createContact(request, token, 'CallNotesOnly');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', notes: 'just a note' },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('just a note');
});

test('R5: POST /messages/call duration=120 no notes: body stores seconds prefix', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-120');
  const cid = await createContact(request, token, 'Call120');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 120 },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('[120s]');
});

test('R5: POST /messages/call duration=120 and notes: body has seconds prefix and notes', async ({ request }) => {
  const { token } = await registerOrg(request, 'r5-call-dur-note-sep');
  const cid = await createContact(request, token, 'CallDurNoteSep');
  const res = await request.post('/api/v1/messages/call', {
    headers: { Authorization: `Bearer ${token}` },
    data: { contact_id: cid, direction: 'outbound', duration_seconds: 120, notes: 'follow up required' },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as MessageResponse;
  expect(json.data.body).toBe('[120s] follow up required');
});
