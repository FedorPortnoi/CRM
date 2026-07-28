import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
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
  MAX_TOOL_ROUNDS,
  buildSystemPrompt,
  getAssistantConversation,
  identityHandle,
  sanitizeToolArguments,
  sendAssistantMessage,
  type AssistantCaller,
} from '../../../backend/services/assistant';
import {
  createCompletion,
  isYandexGptConfigured,
  resetYandexGptState,
} from '../../../backend/services/yandex-gpt';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALLER: AssistantCaller = {
  sub: '00000000-0000-4000-a000-000000000001',
  org_id: '00000000-0000-4000-a000-000000000010',
  role: 'member',
  sid: '00000000-0000-4000-a000-000000000100',
};

const OTHER_ORG = '00000000-0000-4000-a000-0000000000ff';

const TOOL_DEFINITIONS = [
  {
    name: 'get_contacts',
    description: 'List contacts for the authenticated org',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
];

type FetchInit = { signal?: AbortSignal; body?: string };

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

function primeDbForNewConversation(): void {
  dbMock.user.findFirst.mockResolvedValue({
    name: 'Иван Петров',
    organization: { name: 'ООО Ромашка' },
  });
  dbMock.assistantConversation.create.mockResolvedValue({
    id: 'conv-1',
    title: 'Сколько сделок?',
  });
  dbMock.assistantMessage.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: `msg-${String(args.data.role)}`,
    role: args.data.role,
    content: args.data.content,
    tool_calls: args.data.tool_calls ?? null,
    created_at: new Date('2026-07-25T10:00:00.000Z'),
  }));
}

const originalApiKey = process.env.YANDEX_API_KEY;
const originalFolderId = process.env.YANDEX_FOLDER_ID;

beforeEach(() => {
  vi.clearAllMocks();
  resetYandexGptState();
  process.env.YANDEX_API_KEY = 'test-api-key';
  process.env.YANDEX_FOLDER_ID = 'test-folder';
  delete process.env.YANDEX_GPT_MODEL;
  delete process.env.YANDEX_GPT_TIMEOUT_MS;
  mcpMock.listMcpTools.mockResolvedValue(TOOL_DEFINITIONS);
  mcpMock.invokeMcpTool.mockResolvedValue({ ok: true, result: { data: [], meta: { total: 0 } } });
  primeDbForNewConversation();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.YANDEX_API_KEY;
  else process.env.YANDEX_API_KEY = originalApiKey;
  if (originalFolderId === undefined) delete process.env.YANDEX_FOLDER_ID;
  else process.env.YANDEX_FOLDER_ID = originalFolderId;
});

// ---------------------------------------------------------------------------
// Configuration gate
// ---------------------------------------------------------------------------

describe('config gate', () => {
  it('reports unconfigured when either Yandex env var is missing', () => {
    delete process.env.YANDEX_API_KEY;
    expect(isYandexGptConfigured()).toBe(false);

    process.env.YANDEX_API_KEY = 'test-api-key';
    delete process.env.YANDEX_FOLDER_ID;
    expect(isYandexGptConfigured()).toBe(false);
  });

  it('resolves (never throws) with SERVICE_NOT_CONFIGURED when the API key is missing', async () => {
    delete process.env.YANDEX_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendAssistantMessage(CALLER, { message: 'Сколько сделок в работе?' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'SERVICE_NOT_CONFIGURED',
        message:
          'AI assistant is not configured: YANDEX_API_KEY and YANDEX_FOLDER_ID must both be set',
      },
    });
    // Nothing reached the network, the model, or the database.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mcpMock.invokeMcpTool).not.toHaveBeenCalled();
    expect(dbMock.assistantMessage.create).not.toHaveBeenCalled();
  });

  it('resolves with SERVICE_NOT_CONFIGURED when the folder id is missing', async () => {
    delete process.env.YANDEX_FOLDER_ID;
    vi.stubGlobal('fetch', vi.fn());

    const result = await sendAssistantMessage(CALLER, { message: 'Привет' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SERVICE_NOT_CONFIGURED');
  });

  it('createCompletion returns the structured error instead of throwing', async () => {
    delete process.env.YANDEX_FOLDER_ID;

    await expect(
      createCompletion({ messages: [{ role: 'user', text: 'привет' }] }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'SERVICE_NOT_CONFIGURED' } });
  });
});

// ---------------------------------------------------------------------------
// Yandex error mapping
// ---------------------------------------------------------------------------

describe('Yandex error mapping', () => {
  it('maps a 401 onto AI_UNAUTHORIZED without leaking the wire format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { grpcCode: 16, httpCode: 401, message: 'The request is unauthenticated.' } }, 401),
      ),
    );

    const result = await createCompletion({ messages: [{ role: 'user', text: 'привет' }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AI_UNAUTHORIZED');
    expect(result.error.status).toBe(401);
    expect(result.error.message).toBe('The request is unauthenticated.');
  });

  it('maps a 403 from a service account without ai.languageModels.user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 403)));

    const result = await createCompletion({ messages: [{ role: 'user', text: 'привет' }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AI_UNAUTHORIZED');
    expect(result.error.message).toContain('ai.languageModels.user');
  });

  it('surfaces a 401 through the assistant without persisting a half-written exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { httpCode: 401, message: 'nope' } }, 401)));

    const result = await sendAssistantMessage(CALLER, { message: 'Покажи мои сделки' });

    expect(result).toEqual({ ok: false, error: { code: 'AI_UNAUTHORIZED', message: 'nope', status: 401 } });
    expect(dbMock.assistantConversation.create).not.toHaveBeenCalled();
    expect(dbMock.assistantMessage.create).not.toHaveBeenCalled();
  });

  it('maps 429 and 5xx onto distinct codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'too many' }, 429)));
    await expect(createCompletion({ messages: [{ role: 'user', text: 'x' }] })).resolves.toMatchObject({
      ok: false,
      error: { code: 'AI_RATE_LIMITED' },
    });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'boom' }, 503)));
    await expect(createCompletion({ messages: [{ role: 'user', text: 'x' }] })).resolves.toMatchObject({
      ok: false,
      error: { code: 'AI_UNAVAILABLE' },
    });
  });

  it('maps a non-JSON body onto AI_BAD_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })));

    await expect(createCompletion({ messages: [{ role: 'user', text: 'x' }] })).resolves.toMatchObject({
      ok: false,
      error: { code: 'AI_BAD_RESPONSE' },
    });
  });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe('timeouts', () => {
  it('aborts the request and resolves with AI_TIMEOUT instead of hanging the worker', async () => {
    let capturedSignal: AbortSignal | undefined;

    const fetchMock = vi.fn(
      (_url: unknown, init?: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal;
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createCompletion({
      messages: [{ role: 'user', text: 'привет' }],
      timeout_ms: 20,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AI_TIMEOUT');
    expect(result.error.message).toContain('20ms');
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('propagates the timeout through the assistant as a structured error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: FetchInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );
    process.env.YANDEX_GPT_TIMEOUT_MS = '20';

    const result = await sendAssistantMessage(CALLER, { message: 'Сколько сделок?' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AI_TIMEOUT');
    expect(dbMock.assistantMessage.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tool-round cap
// ---------------------------------------------------------------------------

describe('tool-round cap', () => {
  it('stops after MAX_TOOL_ROUNDS even when the model keeps asking for tools', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: FetchInit) => {
      const payload = JSON.parse(init?.body ?? '{}') as { tools?: unknown[] };
      // The final call must be made with no tools on offer — that is what
      // guarantees termination.
      return payload.tools
        ? jsonResponse(toolCallCompletion('get_contacts', { q: 'ромашка' }))
        : jsonResponse(textCompletion('Нашёл 3 контакта.'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendAssistantMessage(CALLER, { message: 'Найди контакты' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.turn.rounds).toBe(MAX_TOOL_ROUNDS);
    expect(mcpMock.invokeMcpTool).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    // MAX_TOOL_ROUNDS calls offering tools + exactly one final call without them.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(result.turn.message.content).toBe('Нашёл 3 контакта.');
    expect(result.turn.tool_calls).toHaveLength(MAX_TOOL_ROUNDS);
  });

  it('answers without any tool round when the model replies directly', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(textCompletion('Привет! Чем помочь?')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendAssistantMessage(CALLER, { message: 'Привет' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.rounds).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mcpMock.invokeMcpTool).not.toHaveBeenCalled();
    expect(result.turn.conversation_id).toBe('conv-1');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('executes tools with the caller principal and strips org overrides the model invented', async () => {
    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!served) {
          served = true;
          return jsonResponse(
            toolCallCompletion('get_contacts', {
              q: 'ромашка',
              organization_id: OTHER_ORG,
              org_id: OTHER_ORG,
              jwt_token: 'forged.jwt.token',
            }),
          );
        }
        return jsonResponse(textCompletion('Готово.'));
      }),
    );

    const result = await sendAssistantMessage(CALLER, { message: 'Контакты другой компании' });

    expect(result.ok).toBe(true);
    expect(mcpMock.invokeMcpTool).toHaveBeenCalledTimes(1);

    const [toolName, toolArgs, principal] = mcpMock.invokeMcpTool.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(toolName).toBe('get_contacts');
    // Only the caller's own org and role ever reach the MCP layer.
    expect(principal).toEqual({
      sub: CALLER.sub,
      org_id: CALLER.org_id,
      role: CALLER.role,
      sid: CALLER.sid,
    });
    expect(toolArgs).toEqual({ q: 'ромашка' });
    expect(toolArgs).not.toHaveProperty('organization_id');
    expect(toolArgs).not.toHaveProperty('org_id');
    expect(toolArgs).not.toHaveProperty('jwt_token');
    expect(JSON.stringify(toolArgs)).not.toContain(OTHER_ORG);
  });

  it('sanitizeToolArguments drops every tenant-override key regardless of casing', () => {
    const { args, stripped } = sanitizeToolArguments({
      q: 'ромашка',
      ORG_ID: OTHER_ORG,
      OrganizationId: OTHER_ORG,
      organisation_id: OTHER_ORG,
      jwt_token: 'x',
      assigned_to: 'user-1',
    });

    expect(args).toEqual({ q: 'ромашка', assigned_to: 'user-1' });
    expect(stripped.sort()).toEqual(['ORG_ID', 'OrganizationId', 'jwt_token', 'organisation_id'].sort());
  });

  it('scopes a conversation lookup to the caller org AND the caller user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(textCompletion('ok'))));
    dbMock.assistantConversation.findFirst.mockResolvedValue(null);

    const result = await sendAssistantMessage(CALLER, {
      message: 'продолжай',
      conversation_id: '00000000-0000-4000-a000-0000000000aa',
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'CONVERSATION_NOT_FOUND', message: 'Диалог не найден' },
    });
    expect(dbMock.assistantConversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: '00000000-0000-4000-a000-0000000000aa',
        organization_id: CALLER.org_id,
        user_id: CALLER.sub,
      },
      select: { id: true, title: true },
    });
  });

  it('replays history scoped to the caller org', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(textCompletion('ok'))));
    dbMock.assistantConversation.findFirst.mockResolvedValue({ id: 'conv-9', title: 'Старый диалог' });
    dbMock.assistantMessage.findMany.mockResolvedValue([
      { role: 'assistant', content: 'Ранее ответил', tool_calls: null },
      { role: 'user', content: 'Ранее спросил', tool_calls: null },
    ]);

    const result = await sendAssistantMessage(CALLER, {
      message: 'продолжай',
      conversation_id: 'conv-9',
    });

    expect(result.ok).toBe(true);
    expect(dbMock.assistantMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversation_id: 'conv-9', organization_id: CALLER.org_id },
      }),
    );
    expect(dbMock.assistantConversation.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence + tool failures
// ---------------------------------------------------------------------------

describe('exchange persistence', () => {
  it('persists user, assistant tool-call, tool-result and answer messages in the caller org', async () => {
    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!served) {
          served = true;
          return jsonResponse(toolCallCompletion('get_contacts', { q: 'ромашка' }));
        }
        return jsonResponse(textCompletion('Один контакт найден.'));
      }),
    );

    const result = await sendAssistantMessage(CALLER, { message: 'Найди Ромашку' });

    expect(result.ok).toBe(true);
    expect(dbMock.assistantMessage.create).toHaveBeenCalledTimes(4);

    const roles = dbMock.assistantMessage.create.mock.calls.map(
      (call) => (call[0] as { data: { role: string; organization_id: string } }).data,
    );
    expect(roles.map((d) => d.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    for (const data of roles) {
      expect(data.organization_id).toBe(CALLER.org_id);
    }
  });

  it('feeds a tool failure back to the model rather than aborting the turn', async () => {
    mcpMock.invokeMcpTool.mockResolvedValue({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Viewer role cannot perform write operations' },
    });

    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!served) {
          served = true;
          return jsonResponse(toolCallCompletion('create_contact', { first_name: 'Иван' }));
        }
        return jsonResponse(textCompletion('Не хватает прав на создание контакта.'));
      }),
    );

    const result = await sendAssistantMessage(CALLER, { message: 'Создай контакт' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.tool_calls[0]).toMatchObject({
      name: 'create_contact',
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(result.turn.message.content).toBe('Не хватает прав на создание контакта.');
  });

  it('rejects an empty message before touching the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendAssistantMessage(CALLER, { message: '   ' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe('system prompt', () => {
  it('is in Russian and frames the model as a CRM assistant for a Russian sales team', () => {
    const prompt = buildSystemPrompt({
      orgId: CALLER.org_id,
      userId: CALLER.sub,
      role: 'member',
    });

    expect(prompt).toContain('ИИ-ассистент CRM');
    expect(prompt).toContain('российского отдела продаж');
    expect(prompt).toContain('Отвечай всегда на русском языке');
    // The organisation is named by its handle, never by its name.
    expect(prompt).toContain(identityHandle('org', CALLER.org_id));
    expect(prompt).toContain('RUB');
    // No Latin-only instruction lines slipped in.
    expect(/[а-яё]/i.test(prompt)).toBe(true);
  });

  it('tells a viewer the assistant is read-only for them', () => {
    const prompt = buildSystemPrompt({
      orgId: CALLER.org_id,
      userId: CALLER.sub,
      role: 'viewer',
    });

    expect(prompt).toContain('наблюдатель');
    expect(prompt).toContain('только чтение');
  });

  it('still hands the model the caller uuid for «мои сделки» filters', () => {
    const prompt = buildSystemPrompt({
      orgId: CALLER.org_id,
      userId: CALLER.sub,
      role: 'member',
    });

    expect(prompt).toContain(CALLER.sub);
    expect(prompt).toContain('мои сделки');
  });
});

// ---------------------------------------------------------------------------
// Replay ordering
//
// One turn writes all of its rows (user, assistant-with-tool_calls, tool result,
// answer) inside a single db.$transaction, so PostgreSQL stamps every one of them
// with the SAME CURRENT_TIMESTAMP and the primary key is a random
// gen_random_uuid(). Ordering by created_at therefore returns an arbitrary
// intra-turn order — which OpenAI rejects, because a tool message must follow the
// assistant tool call it correlates with. AssistantMessage.seq (BIGSERIAL) is the
// only column that carries insertion order, so these two reads must use it.
// ---------------------------------------------------------------------------

describe('replay ordering', () => {
  it('reads turn history by seq, newest first — never by created_at', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(textCompletion('ok'))));
    dbMock.assistantConversation.findFirst.mockResolvedValue({ id: 'conv-9', title: 'Диалог' });
    dbMock.assistantMessage.findMany.mockResolvedValue([]);

    await sendAssistantMessage(CALLER, { message: 'продолжай', conversation_id: 'conv-9' });

    const args = dbMock.assistantMessage.findMany.mock.calls[0]?.[0] as {
      orderBy: unknown;
      select: Record<string, boolean>;
    };
    expect(args.orderBy).toEqual({ seq: 'desc' });
    // Prisma maps BigInt to a JS bigint and JSON.stringify throws on it, so seq
    // must never be selected into anything that reaches a response body.
    expect(args.select).not.toHaveProperty('seq');
  });

  it('reads a stored conversation by seq, oldest first — never by created_at', async () => {
    dbMock.assistantConversation.findFirst.mockResolvedValue({
      id: 'conv-9',
      title: 'Диалог',
      created_at: new Date('2026-07-25T10:00:00.000Z'),
      updated_at: new Date('2026-07-25T10:00:00.000Z'),
    });
    dbMock.assistantMessage.findMany.mockResolvedValue([]);

    await getAssistantConversation(CALLER, 'conv-9');

    const args = dbMock.assistantMessage.findMany.mock.calls[0]?.[0] as {
      orderBy: unknown;
      select: Record<string, boolean>;
    };
    expect(args.orderBy).toEqual({ seq: 'asc' });
    expect(args.select).not.toHaveProperty('seq');
  });
});
