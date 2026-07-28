import { AssistantMessageRole } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The assistant hands MCP tool results to YandexGPT and then persists them in
// AssistantMessage.content, which is plain TEXT. The contact tools return
// DECRYPTED email / phone / mobile, so without a projection in front of the
// provider the encrypted columns would be shipped to an external processor and
// written back to Postgres in cleartext.
//
// Everything below asserts the same two invariants for every result shape the
// tools actually produce (array, single object, nested contact, deep nesting):
//   1. the plaintext never appears in an outbound request body;
//   2. the plaintext never appears in anything handed to assistantMessage.create.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => {
  const assistantMessage = {
    findMany: vi.fn(),
    create: vi.fn(),
  };
  const assistantConversation = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  };
  const user = { findFirst: vi.fn() };

  return {
    assistantMessage,
    assistantConversation,
    user,
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ assistantMessage, assistantConversation }),
    ),
  };
});

const mcpMock = vi.hoisted(() => ({
  listMcpTools: vi.fn(),
  invokeMcpTool: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));
vi.mock('../../../backend/mcp/server', () => mcpMock);

import {
  PII_PLACEHOLDER,
  buildSystemPrompt,
  historyToAiMessages,
  identityHandle,
  redactToolResult,
  sendAssistantMessage,
  type AssistantCaller,
} from '../../../backend/services/assistant';
import { resetYandexGptState } from '../../../backend/services/yandex-gpt';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALLER: AssistantCaller = {
  sub: '00000000-0000-4000-a000-000000000001',
  org_id: '00000000-0000-4000-a000-000000000010',
  role: 'member',
  sid: '00000000-0000-4000-a000-000000000100',
};

// The tail of a v4 UUID is twelve digits, which is exactly what the shared
// phone mask treats as a subscriber number. The id must survive intact or the
// model can no longer chain get_contacts → get_contact.
const CONTACT_ID = '11111111-1111-4111-8111-111111111111';
const DEAL_ID = '22222222-2222-4222-8222-222222222222';

const RAW_EMAIL = 'ivan.petrov@romashka.ru';
const RAW_PHONE = '+7 916 123-45-67';
const RAW_MOBILE = '+79037654321';

/** A decrypted contact exactly as contact-domain's decryptContact() returns it. */
function decryptedContact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONTACT_ID,
    organization_id: CALLER.org_id,
    first_name: 'Иван',
    last_name: 'Петров',
    company: 'ООО Ромашка',
    email: RAW_EMAIL,
    phone: RAW_PHONE,
    mobile: RAW_MOBILE,
    type: 'lead',
    status: 'active',
    tags: ['vip'],
    notes: 'Обычный клиент',
    created_at: new Date('2026-01-15T09:00:00.000Z'),
    ...overrides,
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'get_contacts',
    description: 'List contacts for the authenticated org',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
];

type FetchInit = { body?: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textCompletion(text: string): unknown {
  return {
    result: {
      alternatives: [{ message: { role: 'assistant', text }, status: 'ALTERNATIVE_STATUS_FINAL' }],
      usage: { inputTextTokens: '10', completionTokens: '5', totalTokens: '15' },
      modelVersion: '23.10.2024',
    },
  };
}

function toolCallCompletion(name: string, args: Record<string, unknown>): unknown {
  return {
    result: {
      alternatives: [
        {
          message: {
            role: 'assistant',
            text: '',
            toolCallList: { toolCalls: [{ functionCall: { name, arguments: args } }] },
          },
          status: 'ALTERNATIVE_STATUS_TOOL_CALLS',
        },
      ],
      usage: { inputTextTokens: '10', completionTokens: '5', totalTokens: '15' },
      modelVersion: '23.10.2024',
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** One tool round, then a plain answer. Every request body is captured. */
function stubModelWithOneToolRound(toolName = 'get_contacts'): void {
  let served = false;
  fetchMock = vi.fn(async () => {
    if (!served) {
      served = true;
      return jsonResponse(toolCallCompletion(toolName, { q: 'Иванов' }));
    }
    return jsonResponse(textCompletion('У контакта заполнены телефон и email — смотрите карточку.'));
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Everything that left the process towards llm.foundationmodels.yandex.net. */
function outboundPayload(): string {
  return fetchMock.mock.calls
    .map((call) => (call[1] as FetchInit | undefined)?.body ?? '')
    .join('\n');
}

/** Everything handed to assistantMessage.create — i.e. what lands in plain TEXT. */
function persistedPayload(): string {
  return dbMock.assistantMessage.create.mock.calls
    .map((call) => JSON.stringify((call[0] as { data: unknown }).data))
    .join('\n');
}

function expectNoPlaintextPii(): void {
  for (const sink of [outboundPayload(), persistedPayload()]) {
    expect(sink).not.toContain(RAW_EMAIL);
    expect(sink).not.toContain(RAW_PHONE);
    expect(sink).not.toContain(RAW_MOBILE);
    // The mask must not be defeated by JSON escaping or by a normalized form.
    expect(sink).not.toContain('ivan.petrov');
    expect(sink).not.toContain('79161234567');
  }
}

const originalApiKey = process.env.YANDEX_API_KEY;
const originalFolderId = process.env.YANDEX_FOLDER_ID;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetYandexGptState();
  process.env.YANDEX_API_KEY = 'test-api-key';
  process.env.YANDEX_FOLDER_ID = 'test-folder';
  delete process.env.YANDEX_GPT_MODEL;
  delete process.env.YANDEX_GPT_TIMEOUT_MS;

  mcpMock.listMcpTools.mockResolvedValue(TOOL_DEFINITIONS);
  dbMock.user.findFirst.mockResolvedValue({
    name: 'Иван Петров',
    organization: { name: 'ООО Ромашка' },
  });
  dbMock.assistantConversation.create.mockResolvedValue({ id: 'conv-1', title: 'Дай телефон Иванова' });
  dbMock.assistantMessage.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: `msg-${String(args.data.role)}`,
    role: args.data.role,
    content: args.data.content,
    tool_calls: args.data.tool_calls ?? null,
    created_at: new Date('2026-07-25T10:00:00.000Z'),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.YANDEX_API_KEY;
  else process.env.YANDEX_API_KEY = originalApiKey;
  if (originalFolderId === undefined) delete process.env.YANDEX_FOLDER_ID;
  else process.env.YANDEX_FOLDER_ID = originalFolderId;
});

// ---------------------------------------------------------------------------
// The shapes the MCP tools actually return
// ---------------------------------------------------------------------------

describe('tool results never carry decrypted PII to the model or to Postgres', () => {
  it('array-shaped result (get_contacts) — every row is masked', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: true,
      result: {
        data: [
          decryptedContact(),
          decryptedContact({
            id: '33333333-3333-4333-8333-333333333333',
            first_name: 'Пётр',
            email: 'petr@romashka.ru',
            phone: '+7 495 000-11-22',
            mobile: null,
          }),
        ],
        meta: { total: 2, page: 1, per_page: 20 },
      },
    });
    stubModelWithOneToolRound();

    const result = await sendAssistantMessage(CALLER, { message: 'Дай телефон Иванова' });

    expect(result.ok).toBe(true);
    expectNoPlaintextPii();
    for (const sink of [outboundPayload(), persistedPayload()]) {
      expect(sink).not.toContain('petr@romashka.ru');
      expect(sink).not.toContain('+7 495 000-11-22');
      // Still useful: the model sees who the contact is and that a phone exists.
      expect(sink).toContain(PII_PLACEHOLDER);
      expect(sink).toContain('Ромашка');
      expect(sink).toContain(CONTACT_ID);
    }
  });

  it('single-object result (get_contact) — masked, ids and business fields intact', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({ ok: true, result: { data: decryptedContact() } });
    stubModelWithOneToolRound('get_contact');

    await sendAssistantMessage(CALLER, { message: 'Покажи карточку Иванова' });

    expectNoPlaintextPii();

    const toolRow = dbMock.assistantMessage.create.mock.calls
      .map((call) => (call[0] as { data: { role: string; content: string } }).data)
      .find((data) => data.role === 'tool');

    expect(toolRow).toBeDefined();
    const stored = JSON.parse(toolRow!.content) as Array<{ name: string; content: string }>;
    const payload = JSON.parse(stored[0].content) as { data: Record<string, unknown> };

    expect(payload.data.email).toBe(PII_PLACEHOLDER);
    expect(payload.data.phone).toBe(PII_PLACEHOLDER);
    expect(payload.data.mobile).toBe(PII_PLACEHOLDER);
    expect(payload.data.first_name).toBe('Иван');
    expect(payload.data.id).toBe(CONTACT_ID);
  });

  it('nested contact inside a deal (get_deals) — masked at depth', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: true,
      result: {
        data: [
          {
            id: DEAL_ID,
            title: 'Поставка оборудования',
            value: '1200000.00',
            currency: 'RUB',
            contact: {
              id: CONTACT_ID,
              first_name: 'Иван',
              last_name: 'Петров',
              email: RAW_EMAIL,
              phone: RAW_PHONE,
              mobile: RAW_MOBILE,
            },
          },
        ],
        meta: { total: 1, page: 1, per_page: 20 },
      },
    });
    stubModelWithOneToolRound('get_deals');

    await sendAssistantMessage(CALLER, { message: 'Сделки Иванова' });

    expectNoPlaintextPii();
    for (const sink of [outboundPayload(), persistedPayload()]) {
      // Deal values are business data, not encrypted PII — deliberately kept.
      expect(sink).toContain('1200000.00');
      expect(sink).toContain('Поставка оборудования');
      expect(sink).toContain(DEAL_ID);
    }
  });

  it('arbitrarily nested arrays and objects — masked at every level', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: true,
      result: {
        data: {
          groups: [
            {
              stage: 'Переговоры',
              deals: [
                {
                  id: DEAL_ID,
                  participants: [
                    { role: 'client', contact: decryptedContact() },
                    { role: 'cc', contact: { id: CONTACT_ID, email: RAW_EMAIL } },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    stubModelWithOneToolRound('get_analytics');

    await sendAssistantMessage(CALLER, { message: 'Воронка по Иванову' });

    expectNoPlaintextPii();
    // The result did reach the payload — it is the masked form that is there.
    expect(outboundPayload()).toContain(PII_PLACEHOLDER);
    expect(persistedPayload()).toContain('Переговоры');
  });

  it('keeps null apart from masked, so the model can say a field is empty', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: true,
      result: { data: decryptedContact({ phone: null, mobile: '' }) },
    });
    stubModelWithOneToolRound('get_contact');

    await sendAssistantMessage(CALLER, { message: 'Есть ли телефон у Иванова?' });

    const toolRow = dbMock.assistantMessage.create.mock.calls
      .map((call) => (call[0] as { data: { role: string; content: string } }).data)
      .find((data) => data.role === 'tool');
    const stored = JSON.parse(toolRow!.content) as Array<{ content: string }>;
    const payload = JSON.parse(stored[0].content) as { data: Record<string, unknown> };

    expect(payload.data.phone).toBeNull();
    expect(payload.data.mobile).toBe('');
    expect(payload.data.email).toBe(PII_PLACEHOLDER);
  });

  it('scrubs a contact detail typed into free text (notes)', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: true,
      result: {
        data: decryptedContact({
          email: null,
          phone: null,
          mobile: null,
          notes: `Звонить на ${RAW_PHONE}, писать на ${RAW_EMAIL}`,
        }),
      },
    });
    stubModelWithOneToolRound('get_contact');

    await sendAssistantMessage(CALLER, { message: 'Что известно про Иванова?' });

    expectNoPlaintextPii();
    expect(outboundPayload()).toContain('Звонить на');
  });

  it('scrubs a tool error message that quotes the value that failed', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: `Контакт с email ${RAW_EMAIL} уже существует` },
    });
    stubModelWithOneToolRound('create_contact');

    const result = await sendAssistantMessage(CALLER, { message: 'Создай контакт' });

    expect(result.ok).toBe(true);
    expectNoPlaintextPii();
    expect(outboundPayload()).toContain('уже существует');
  });

  it('persists exactly the redacted string that was sent to the provider', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({ ok: true, result: { data: [decryptedContact()] } });
    stubModelWithOneToolRound();

    await sendAssistantMessage(CALLER, { message: 'Найди Иванова' });

    const toolRow = dbMock.assistantMessage.create.mock.calls
      .map((call) => (call[0] as { data: { role: string; content: string } }).data)
      .find((data) => data.role === 'tool');
    const stored = JSON.parse(toolRow!.content) as Array<{ name: string; content: string }>;

    // The second request carries the tool result back to the model. It is a JSON
    // string inside a JSON body, so compare against its escaped form.
    const secondBody = (fetchMock.mock.calls[1]?.[1] as FetchInit | undefined)?.body ?? '';
    expect(secondBody).toContain(JSON.stringify(stored[0].content).slice(1, -1));
  });
});

// ---------------------------------------------------------------------------
// Replay of already-stored rows
// ---------------------------------------------------------------------------

describe('history replay', () => {
  it('re-redacts a legacy tool row written before the projection existed', async () => {
    dbMock.assistantConversation.findFirst.mockResolvedValue({ id: 'conv-9', title: 'Старый диалог' });
    dbMock.assistantMessage.findMany.mockResolvedValue([
      {
        role: 'tool',
        content: JSON.stringify([
          {
            name: 'get_contact',
            content: JSON.stringify({ data: decryptedContact() }),
          },
        ]),
        tool_calls: null,
      },
      { role: 'user', content: 'Кто такой Иванов?', tool_calls: null },
    ]);
    mcpMock.invokeMcpTool.mockResolvedValue({ ok: true, result: { data: [] } });

    fetchMock = vi.fn(async () => jsonResponse(textCompletion('Иван Петров, ООО Ромашка.')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendAssistantMessage(CALLER, {
      message: 'А телефон?',
      conversation_id: 'conv-9',
    });

    expect(result.ok).toBe(true);
    expect(outboundPayload()).not.toContain(RAW_EMAIL);
    expect(outboundPayload()).not.toContain(RAW_PHONE);
    expect(outboundPayload()).toContain(PII_PLACEHOLDER);
  });

  it('historyToAiMessages redacts a stored tool payload directly', () => {
    const messages = historyToAiMessages([
      {
        role: AssistantMessageRole.tool,
        content: JSON.stringify([
          { name: 'get_contacts', content: JSON.stringify({ data: [decryptedContact()] }) },
        ]),
        tool_calls: null,
      },
    ]);

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).not.toContain(RAW_PHONE);
    expect(serialized).toContain(PII_PLACEHOLDER);
  });

  it('falls back to a free-text scrub for an unparsable legacy row', () => {
    const messages = historyToAiMessages([
      {
        role: AssistantMessageRole.tool,
        content: JSON.stringify([
          { name: 'get_contact', content: `{"data":{"email":"${RAW_EMAIL}","phone":"${RAW_PHONE}"` },
        ]),
        tool_calls: null,
      },
    ]);

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).not.toContain(RAW_PHONE);
  });
});

// ---------------------------------------------------------------------------
// The projection itself
// ---------------------------------------------------------------------------

describe('redactToolResult', () => {
  it('masks the encrypted columns and everything derived from them', () => {
    const redacted = redactToolResult({
      id: CONTACT_ID,
      email: RAW_EMAIL,
      email_bidx: 'a3f1c0deadbeef',
      phone: RAW_PHONE,
      phone_bidx: 'b4e2d1c0',
      mobile: RAW_MOBILE,
      mobile_bidx: 'c5f3e2d1',
      unsubscribe_token: 'tok_9f8e7d6c',
    }) as Record<string, unknown>;

    expect(redacted).toEqual({
      id: CONTACT_ID,
      email: PII_PLACEHOLDER,
      email_bidx: PII_PLACEHOLDER,
      phone: PII_PLACEHOLDER,
      phone_bidx: PII_PLACEHOLDER,
      mobile: PII_PLACEHOLDER,
      mobile_bidx: PII_PLACEHOLDER,
      unsubscribe_token: PII_PLACEHOLDER,
    });
  });

  it('is case-insensitive about the key', () => {
    const redacted = redactToolResult({ Email: RAW_EMAIL, PHONE: RAW_PHONE }) as Record<string, unknown>;
    expect(redacted).toEqual({ Email: PII_PLACEHOLDER, PHONE: PII_PLACEHOLDER });
  });

  it('leaves record ids intact even though a UUID tail looks like a phone number', () => {
    const redacted = redactToolResult({
      id: CONTACT_ID,
      contact_id: CONTACT_ID,
      note: `Сделка ${DEAL_ID} по контакту ${CONTACT_ID}`,
    }) as Record<string, unknown>;

    expect(redacted.id).toBe(CONTACT_ID);
    expect(redacted.contact_id).toBe(CONTACT_ID);
    expect(redacted.note).toBe(`Сделка ${DEAL_ID} по контакту ${CONTACT_ID}`);
  });

  it('passes Date and Decimal-like values through untouched', () => {
    const at = new Date('2026-02-03T04:05:06.000Z');
    const decimal = { toJSON: () => '1200000', s: 1, e: 6, d: [1200000] };
    Object.setPrototypeOf(decimal, { constructor: function Decimal() {} });

    const redacted = redactToolResult({ created_at: at, value: decimal }) as Record<string, unknown>;

    expect(redacted.created_at).toBe(at);
    expect(redacted.value).toBe(decimal);
  });

  it('does not mutate the object it was given', () => {
    const source = { data: [decryptedContact()] };
    redactToolResult(source);
    expect(source.data[0].email).toBe(RAW_EMAIL);
  });

  it('is idempotent', () => {
    const once = redactToolResult({ data: decryptedContact() });
    expect(redactToolResult(once)).toEqual(once);
  });

  it('handles primitives, null and arrays at the top level', () => {
    expect(redactToolResult(null)).toBeNull();
    expect(redactToolResult(42)).toBe(42);
    expect(redactToolResult([{ email: RAW_EMAIL }])).toEqual([{ email: PII_PLACEHOLDER }]);
  });
});

// ---------------------------------------------------------------------------
// The model is told why it cannot see contact details
// ---------------------------------------------------------------------------

describe('system prompt', () => {
  it('explains the placeholder so the model answers instead of hallucinating a number', () => {
    const prompt = buildSystemPrompt({
      orgId: CALLER.org_id,
      userId: CALLER.sub,
      role: 'member',
    });

    expect(prompt).toContain(PII_PLACEHOLDER);
    expect(prompt).toContain('карточке контакта');
  });
});

// ---------------------------------------------------------------------------
// The system prompt is the widest exposure in this module: it is sent on EVERY
// turn, including turns that call no tool at all, so redactToolResult() — which
// only ever runs inside serializeToolResult() — never sees it. It used to
// interpolate the organisation's real name and the operator's real ФИО, which
// is personal data crossing the border on 100% of requests while the
// Roskomnadzor filing is still open (ФЗ-152 ст. 5 ч. 5 и ст. 12).
//
// Masking is by opaque one-way handle, not by a reversible vault: nothing here
// matches names in text, so nothing can fail open on an inflected surname.
// ---------------------------------------------------------------------------

/** A name no fixture in this file uses, so a hit is always a real leak. */
const REAL_ORG_NAME = 'ООО «Северная Звезда-77»';
const REAL_USER_NAME = 'Достоевский Фёдор Михайлович';
const OTHER_ORG_ID = '00000000-0000-4000-a000-0000000000ff';

function stubModelWithPlainAnswer(): void {
  fetchMock = vi.fn(async () => jsonResponse(textCompletion('В работе 4 сделки.')));
  vi.stubGlobal('fetch', fetchMock);
}

function expectNoRealIdentityNames(): void {
  for (const sink of [outboundPayload(), persistedPayload()]) {
    expect(sink).not.toContain(REAL_ORG_NAME);
    expect(sink).not.toContain(REAL_USER_NAME);
    // Fragments too: a leak that merely dropped the quotes or the patronymic
    // would still be a disclosure.
    expect(sink).not.toContain('Северная Звезда');
    expect(sink).not.toContain('Достоевский');
  }
}

describe('the system prompt carries no real names across the border', () => {
  beforeEach(() => {
    // The profile row still exists and still has the real names on it. If any
    // future edit reads them back into the prompt, these tests fail.
    dbMock.user.findFirst.mockResolvedValue({
      name: REAL_USER_NAME,
      organization: { name: REAL_ORG_NAME },
    });
  });

  it('masks both identities on a turn that calls no tool at all', async () => {
    stubModelWithPlainAnswer();

    const result = await sendAssistantMessage(CALLER, { message: 'Сколько сделок в работе?' });

    expect(result.ok).toBe(true);
    expect(mcpMock.invokeMcpTool).not.toHaveBeenCalled();
    expectNoRealIdentityNames();
    // What crossed instead.
    expect(outboundPayload()).toContain(identityHandle('org', CALLER.org_id));
    expect(outboundPayload()).toContain(identityHandle('user', CALLER.sub));
  });

  it('masks both identities on a turn that runs a tool round', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({ ok: true, result: { data: [], meta: { total: 0 } } });
    stubModelWithOneToolRound();

    await sendAssistantMessage(CALLER, { message: 'Найди контакты' });

    // The prompt is re-sent with every request in the agent loop, so both
    // request bodies are checked, not just the first.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expectNoRealIdentityNames();
  });

  it('never reads the names out of Postgres in the first place', async () => {
    stubModelWithPlainAnswer();

    await sendAssistantMessage(CALLER, { message: 'Привет' });

    // Structural, not incidental: with the prompt built from ids there is no
    // reason to select User.name / Organization.name, so the plaintext never
    // leaves the database on this path.
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the organisation id itself out of the prompt', () => {
    // A distinctive uuid on purpose: CALLER's fixture ids share a long run of
    // zeroes with the caller uuid that legitimately stays in the prompt.
    const orgId = 'a1b2c3d4-9e8f-4a7b-8c6d-5e4f3a2b1c09';
    const prompt = buildSystemPrompt({ orgId, userId: CALLER.sub, role: 'member' });

    // Rule 2 forbids the model from supplying an org id and the MCP layer
    // strips it anyway, so the handle must not be a fragment of the uuid.
    expect(prompt).not.toContain(orgId);
    expect(prompt).not.toContain('a1b2c3d4');
    expect(prompt).toMatch(/ORG-[0-9a-f]{12}\b/);
    expect(prompt).toMatch(/USER-[0-9a-f]{12}\b/);
  });

  it('produces a handle that is stable per identity and distinct across them', () => {
    // Stable: the model can refer to one organisation across turns without a
    // vault ever being consulted.
    expect(identityHandle('org', CALLER.org_id)).toBe(identityHandle('org', CALLER.org_id));
    // Distinct: another org, and the same uuid read as a user, both differ.
    expect(identityHandle('org', CALLER.org_id)).not.toBe(identityHandle('org', OTHER_ORG_ID));
    expect(identityHandle('org', CALLER.org_id)).not.toBe(identityHandle('user', CALLER.org_id));
  });

  it('leaves the viewer read-only note and the tool rules exactly as they were', () => {
    const viewer = buildSystemPrompt({
      orgId: CALLER.org_id,
      userId: CALLER.sub,
      role: 'viewer',
    });
    const member = buildSystemPrompt({
      orgId: CALLER.org_id,
      userId: CALLER.sub,
      role: 'member',
    });

    expect(viewer).toContain('наблюдатель');
    expect(viewer).toContain('только чтение');
    expect(member).toContain('задай уточняющий вопрос вместо вызова инструмента');
    for (const prompt of [viewer, member]) {
      expect(prompt).toContain('ТОЛЬКО через инструменты');
      // The caller uuid is still there: the tools filter «мои сделки» on it.
      expect(prompt).toContain(CALLER.sub);
    }
  });
});
