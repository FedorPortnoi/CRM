import { AssistantMessageRole, type Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// STORED CONVERSATIONS REPLAY. THE OPERATOR'S ФИО MUST NOT REPLAY WITH THEM.
//
// projectModelFacing() sits at the MCP boundary, so it shapes a tool result on
// its way OUT of a tool call. It never saw the second route to the same prompt:
// backend/services/assistant.ts reads the stored AssistantMessage rows back on
// every turn and rebuilds them into AiMessages. Rows written before that
// projection existed still hold `assignee: { id, name }` exactly as Prisma
// returned it, and replaying one puts the name back in front of the provider —
// no tool call involved, so nothing at the MCP boundary is in the path.
//
// Three surfaces come back out of those rows and two of them are now projected:
//
//   1. tool-result rows        redactStoredToolContent  — covered here
//   2. stored tool_calls args  parseStoredToolCalls     — covered here
//   3. assistant prose         replayed as stored       — KNOWN RESIDUAL
//
// (3) is asserted rather than pretended away: a bare string has no object shape
// for the projection to decide on, and the alternative — matching User.name
// against free text — is the design decision 002 rejects. The test below pins
// the limit so nobody reads silence as coverage.
//
// Both directions matter. Stripping the name everywhere would be an easy way to
// make the first half of this file pass and would break the product: the
// transcript UI renders these same rows, and get_rep_performance is allowed to
// name people by an explicit, recorded decision. The second half fails loudly if
// that happens.
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

  return {
    assistantMessage,
    assistantConversation,
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
  getAssistantConversation,
  historyToAiMessages,
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

const OPERATOR_ID = '88888888-8888-4888-8888-00000000000b';
const TASK_ID = '88888888-8888-4888-8888-000000000001';
const CONTACT_ID = '88888888-8888-4888-8888-000000000002';

/**
 * Invented, and distinctive on purpose: this string exists nowhere else in the
 * repository, so a hit anywhere in an outbound body is always a real leak and
 * never a fixture bleeding in from another file.
 */
const OPERATOR_FIO = 'Евлампий Заозёрский-Тучков';

/** The CUSTOMER. A surname the model is supposed to see and search on. */
const CUSTOMER_LAST_NAME = 'Иванов';

const RAW_EMAIL = 'i.ivanov@example.com';

type StoredRow = {
  role: AssistantMessageRole;
  content: string;
  tool_calls: Prisma.JsonValue | null;
};

/** A tool row exactly as sendAssistantMessage persists one: [{ name, content }]. */
function toolRow(name: string, payload: unknown): StoredRow {
  return {
    role: AssistantMessageRole.tool,
    content: JSON.stringify([{ name, content: JSON.stringify(payload) }]),
    tool_calls: null,
  };
}

function assistantRow(content: string, toolCalls: unknown = null): StoredRow {
  return {
    role: AssistantMessageRole.assistant,
    content,
    tool_calls: toolCalls as Prisma.JsonValue | null,
  };
}

/** get_task as it came back BEFORE the projection existed: assignee ФИО inline. */
function legacyTaskPayload(): unknown {
  return {
    data: {
      id: TASK_ID,
      title: 'Перезвонить по КП',
      assigned_to: OPERATOR_ID,
      assignee: { id: OPERATOR_ID, name: OPERATOR_FIO },
      contact: {
        id: CONTACT_ID,
        first_name: 'Иван',
        last_name: CUSTOMER_LAST_NAME,
        email: RAW_EMAIL,
      },
    },
  };
}

function replayed(rows: StoredRow[]): string {
  return JSON.stringify(historyToAiMessages(rows));
}

const TOOL_DEFINITIONS = [
  {
    name: 'get_tasks',
    description: 'List tasks for the authenticated org',
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

let fetchMock: ReturnType<typeof vi.fn>;

/** Everything that left the process towards the provider. */
function outboundPayload(): string {
  return fetchMock.mock.calls
    .map((call) => (call[1] as FetchInit | undefined)?.body ?? '')
    .join('\n');
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
// Direction 1 — the model must not get the name back
// ---------------------------------------------------------------------------

describe('replayed tool rows lose the operator ФИО', () => {
  it('strips a legacy get_task row and keeps everything the model chains on', () => {
    const serialized = replayed([toolRow('get_task', legacyTaskPayload())]);

    expect(serialized).not.toContain(OPERATOR_FIO);
    expect(serialized).not.toContain('Заозёрский');
    // The identifier survives: it is a uuid, the model filters «мои задачи» on
    // it, and dropping it would break the agent loop for no privacy gain.
    expect(serialized).toContain(OPERATOR_ID);
    expect(serialized).toContain(TASK_ID);
    expect(serialized).toContain('Перезвонить по КП');
  });

  it('strips it at depth, inside arrays, under every user-relation key', () => {
    const serialized = replayed([
      toolRow('get_tasks', {
        data: [
          { id: TASK_ID, assignee: { id: OPERATOR_ID, name: OPERATOR_FIO } },
          { id: TASK_ID, creator: { id: OPERATOR_ID, full_name: OPERATOR_FIO } },
          { id: TASK_ID, completer: { id: OPERATOR_ID, name: OPERATOR_FIO } },
          { id: TASK_ID, deal: { pipeline: { owner: { id: OPERATOR_ID, name: OPERATOR_FIO } } } },
        ],
        meta: { total: 4 },
      }),
    ]);

    expect(serialized).not.toContain(OPERATOR_FIO);
    expect(serialized).toContain(OPERATOR_ID);
  });

  it('composes with the PII projection instead of replacing it', () => {
    // One row, two different problems: the encrypted contact column is masked
    // and the operator name is deleted. Neither projection may shadow the other.
    const serialized = replayed([toolRow('get_task', legacyTaskPayload())]);

    expect(serialized).not.toContain(OPERATOR_FIO);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).toContain(PII_PLACEHOLDER);
  });

  it('strips it from stored tool_call arguments, which replay onto the wire', () => {
    // yandex-gpt's toWireMessage puts `arguments` back verbatim, so a stored
    // call is a model-facing surface even though no tool runs on replay.
    const serialized = replayed([
      assistantRow('Сейчас посмотрю.', [
        {
          id: 'call-1',
          name: 'update_task',
          arguments: { task_id: TASK_ID, assignee: { id: OPERATOR_ID, name: OPERATOR_FIO } },
        },
      ]),
    ]);

    expect(serialized).not.toContain(OPERATOR_FIO);
    expect(serialized).toContain(TASK_ID);
    expect(serialized).toContain(OPERATOR_ID);
  });

  it('never reaches the provider on a real turn that replays a legacy row', async () => {
    dbMock.assistantConversation.findFirst.mockResolvedValue({ id: 'conv-9', title: 'Старый диалог' });
    dbMock.assistantMessage.findMany.mockResolvedValue([
      { role: 'user', content: 'Кто отвечает за задачу?', tool_calls: null },
      assistantRow('', [{ id: 'call-1', name: 'get_task', arguments: { task_id: TASK_ID } }]),
      toolRow('get_task', legacyTaskPayload()),
    ]);

    fetchMock = vi.fn(async () => jsonResponse(textCompletion('Задача в работе.')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendAssistantMessage(CALLER, {
      message: 'А срок какой?',
      conversation_id: 'conv-9',
    });

    expect(result.ok).toBe(true);
    // The history really did replay — it is the projected form that crossed.
    expect(outboundPayload()).toContain(TASK_ID);
    expect(outboundPayload()).not.toContain(OPERATOR_FIO);
    expect(outboundPayload()).not.toContain(RAW_EMAIL);
  });
});

// ---------------------------------------------------------------------------
// Direction 2 — the names that are supposed to be there must still be there
// ---------------------------------------------------------------------------

describe('the replay projection does not spread past the model', () => {
  it('leaves the stored transcript untouched for the app that renders it', async () => {
    // src/utils/assistantTranscript.ts parses these same rows for the chat UI,
    // and the operator reading their own history is not an external processor.
    // Scrubbing on this read would be an over-correction, so it is pinned.
    dbMock.assistantConversation.findFirst.mockResolvedValue({
      id: 'conv-9',
      title: 'Старый диалог',
      created_at: new Date('2026-07-25T10:00:00.000Z'),
      updated_at: new Date('2026-07-25T10:00:00.000Z'),
    });
    dbMock.assistantMessage.findMany.mockResolvedValue([
      {
        id: 'msg-1',
        ...toolRow('get_task', legacyTaskPayload()),
        created_at: new Date('2026-07-25T10:00:00.000Z'),
      },
    ]);

    const conversation = await getAssistantConversation(CALLER, 'conv-9');

    expect(conversation).not.toBeNull();
    expect(JSON.stringify(conversation)).toContain(OPERATOR_FIO);
  });

  it('keeps the get_rep_performance names the live path is allowed to send', () => {
    // decision 002 grants that one tool `operatorNames: 'allowed'` because the
    // name IS the answer to «кто лучший менеджер». Its `{ user_id, name, … }`
    // rows sit under `data`, not under a user container, so the projection does
    // not reach them — on replay exactly as on the live call. If that ever
    // changes it has to change in one place, deliberately, not drift apart here.
    const serialized = replayed([
      toolRow('get_rep_performance', {
        data: [{ user_id: OPERATOR_ID, name: OPERATOR_FIO, deals_won: 7, win_rate: 41.18 }],
        meta: {},
      }),
    ]);

    expect(serialized).toContain(OPERATOR_FIO);
  });

  it('keeps the customer, the pipeline and the stage — none of them are operators', () => {
    const serialized = replayed([
      toolRow('get_deals', {
        data: [
          {
            id: TASK_ID,
            pipeline: { id: 'p-1', name: 'Основная воронка' },
            stage: { id: 's-1', name: 'Переговоры' },
            contact: { id: CONTACT_ID, first_name: 'Иван', last_name: CUSTOMER_LAST_NAME },
          },
        ],
      }),
    ]);

    expect(serialized).toContain('Основная воронка');
    expect(serialized).toContain('Переговоры');
    expect(serialized).toContain(CUSTOMER_LAST_NAME);
    expect(serialized).toContain('Иван');
  });

  it('keeps a customer surname the model searched on in stored arguments', () => {
    // The honest boundary of the tool_calls projection: it decides by object
    // shape, and a surname in a flat search string has no shape to decide on.
    // It is also indistinguishable from the query the tool exists to serve, so
    // an over-correction that scrubbed it would delete the feature.
    const serialized = replayed([
      assistantRow('', [
        { id: 'call-1', name: 'get_contacts', arguments: { q: CUSTOMER_LAST_NAME } },
      ]),
    ]);

    expect(serialized).toContain(CUSTOMER_LAST_NAME);
  });
});

// ---------------------------------------------------------------------------
// The residual, stated out loud
// ---------------------------------------------------------------------------

describe('assistant prose is a documented residual, not a covered path', () => {
  it('replays a ФИО the model itself wrote into an old answer', () => {
    // Not an assertion that this is FINE — an assertion that it is KNOWN.
    // projectModelFacing works on object shape and prose has none; the only
    // thing that would catch this is matching User.name against free text,
    // which fails open on inflected Russian surnames (Иванов / Иванова /
    // Иванову) and would also have to spare the sentences get_rep_performance
    // is allowed to produce. If a later change closes this properly, flip the
    // expectation here — do not delete the case.
    const serialized = replayed([assistantRow(`Ответственный — ${OPERATOR_FIO}.`)]);

    expect(serialized).toContain(OPERATOR_FIO);
  });
});
