import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// POST /api/v1/tasks/suggest-contact
//
// Two things are under test here and they are not the same thing:
//
//  1. The silent-null contract. Every failure branch must answer
//     `{ data: { contact: null } }`. The client renders "no suggestion" and has
//     no branch for an error, so anything else is a broken screen.
//
//  2. That the endpoint reaches the model through the DOMESTIC seam
//     (backend/services/yandex-gpt) and constructs no request to
//     api.anthropic.com. This route used to ship up to 300 Russian customers'
//     full names to a US provider on every call — ст. 12 ФЗ-152 with no filing.
//     Nothing may quietly put that back.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({
  contact: { findMany: vi.fn() },
  task: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const yandexMock = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  isYandexGptConfigured: vi.fn(),
}));

vi.mock('../../../backend/services/yandex-gpt', () => yandexMock);

import { TasksController } from '../../../backend/api/controllers/tasks';

const ORG_ID = '00000000-0000-4000-a000-0000000000aa';
const USER_ID = '00000000-0000-4000-a000-000000000001';

const CONTACT_A = { id: '11111111-1111-4111-8111-111111111111', first_name: 'Иван', last_name: 'Петров' };
const CONTACT_B = { id: '22222222-2222-4222-8222-222222222222', first_name: 'Мария', last_name: null };

const CONTROLLER_SOURCE_PATH = fileURLToPath(
  new URL('../../../backend/api/controllers/tasks.ts', import.meta.url).href,
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type SentPayload = { data: { contact: unknown } };

function makeReply() {
  const sent: SentPayload[] = [];
  const reply = {
    sent,
    status: vi.fn(() => reply),
    send: vi.fn((payload: SentPayload) => {
      sent.push(payload);
      return reply;
    }),
  };
  return reply;
}

function makeRequest(title: string) {
  return {
    body: { title },
    user: { sub: USER_ID, org_id: ORG_ID, role: 'owner' },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
}

async function callSuggestContact(title = 'Позвонить Ивану Петрову') {
  const request = makeRequest(title);
  const reply = makeReply();
  await TasksController.suggestContact(request as never, reply as never);
  return { request, reply };
}

/** Every outbound fetch attempted during a test, whoever made it. */
let fetchTargets: string[] = [];

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const asRequest = input as { url?: unknown };
  return typeof asRequest?.url === 'string' ? asRequest.url : String(input);
}

beforeEach(() => {
  fetchTargets = [];

  dbMock.contact.findMany.mockReset();
  dbMock.contact.findMany.mockResolvedValue([CONTACT_A, CONTACT_B]);

  yandexMock.createCompletion.mockReset();
  yandexMock.isYandexGptConfigured.mockReset();
  yandexMock.isYandexGptConfigured.mockReturnValue(true);

  // The unit suite never talks to the network. Recording the attempt rather
  // than letting it through is what makes an Anthropic regression visible:
  // @anthropic-ai/sdk dials api.anthropic.com through global fetch.
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
    const url = urlOf(input);
    fetchTargets.push(url);
    throw new Error(`unit tests must not reach the network: ${url}`);
  }) as typeof fetch);
});

afterEach(() => {
  // Asserted after EVERY test in this file, not only the dedicated one, so no
  // branch can be the one that quietly dials out.
  expect(fetchTargets.filter((url) => /anthropic/i.test(url))).toEqual([]);
  vi.restoreAllMocks();
});

function okCompletion(text: string) {
  return {
    ok: true as const,
    message: { role: 'assistant' as const, text, tool_calls: [] },
    usage: { input_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    model_version: 'test',
    tools_offered: false,
  };
}

// ---------------------------------------------------------------------------
// The null contract
// ---------------------------------------------------------------------------

describe('tasks.suggestContact — silent-null contract', () => {
  it('returns null and skips the query when the provider is not configured', async () => {
    yandexMock.isYandexGptConfigured.mockReturnValue(false);

    const { reply } = await callSuggestContact();

    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.sent[0]).toEqual({ data: { contact: null } });
    expect(dbMock.contact.findMany).not.toHaveBeenCalled();
    expect(yandexMock.createCompletion).not.toHaveBeenCalled();
  });

  it('returns null and never calls the model when the org has no contacts', async () => {
    dbMock.contact.findMany.mockResolvedValue([]);

    const { reply } = await callSuggestContact();

    expect(reply.sent[0]).toEqual({ data: { contact: null } });
    expect(yandexMock.createCompletion).not.toHaveBeenCalled();
  });

  it('returns null when the reply is not a bare uuid', async () => {
    for (const reply_text of [
      'none',
      '',
      'Контакт: 11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111.',
      'zzzzzzzz-1111-4111-8111-111111111111',
      '11111111111141118111111111111111',
    ]) {
      yandexMock.createCompletion.mockResolvedValue(okCompletion(reply_text));

      const { reply } = await callSuggestContact();

      expect(reply.sent[0], `reply text: ${JSON.stringify(reply_text)}`).toEqual({
        data: { contact: null },
      });
    }
  });

  it('returns null when the uuid is well formed but not in the fetched set', async () => {
    yandexMock.createCompletion.mockResolvedValue(
      okCompletion('99999999-9999-4999-8999-999999999999'),
    );

    const { reply } = await callSuggestContact();

    expect(reply.sent[0]).toEqual({ data: { contact: null } });
  });

  it('returns null when the provider answers with a structured error', async () => {
    for (const code of ['SERVICE_NOT_CONFIGURED', 'AI_TIMEOUT', 'AI_UNAUTHORIZED', 'AI_BAD_RESPONSE']) {
      yandexMock.createCompletion.mockResolvedValue({
        ok: false,
        error: { code, message: `upstream said ${code}` },
      });

      const { reply } = await callSuggestContact();

      expect(reply.sent[0], `error code: ${code}`).toEqual({ data: { contact: null } });
    }
  });

  it('returns null when the model call throws', async () => {
    yandexMock.createCompletion.mockRejectedValue(new Error('socket hang up'));

    const { request, reply } = await callSuggestContact();

    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.sent[0]).toEqual({ data: { contact: null } });
    expect(request.log.warn).toHaveBeenCalled();
  });

  it('returns null when the contact query throws', async () => {
    dbMock.contact.findMany.mockRejectedValue(new Error('connection refused'));

    const { request, reply } = await callSuggestContact();

    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(reply.sent[0]).toEqual({ data: { contact: null } });
    expect(request.log.warn).toHaveBeenCalled();
    expect(yandexMock.createCompletion).not.toHaveBeenCalled();
  });

  it('returns the matching contact when the model answers with a uuid from the list', async () => {
    yandexMock.createCompletion.mockResolvedValue(okCompletion(`  ${CONTACT_A.id}\n`));

    const { reply } = await callSuggestContact();

    expect(reply.sent[0]).toEqual({ data: { contact: CONTACT_A } });
  });
});

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

describe('tasks.suggestContact — provider routing', () => {
  it('reaches the model through the domestic yandex-gpt seam, not Anthropic', async () => {
    yandexMock.createCompletion.mockResolvedValue(okCompletion(CONTACT_A.id));

    await callSuggestContact('Позвонить Ивану Петрову');

    expect(yandexMock.createCompletion).toHaveBeenCalledTimes(1);

    const input = yandexMock.createCompletion.mock.calls[0][0] as {
      messages: Array<{ role: string; text?: string }>;
      max_tokens?: number;
      timeout_ms?: number;
    };

    expect(input.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(input.messages[1].text).toContain(CONTACT_A.id);
    expect(input.messages[1].text).toContain('Позвонить Ивану Петрову');

    // Small output ceiling: the answer is one uuid or one word.
    expect(input.max_tokens).toBeLessThanOrEqual(50);
    // Never inherit the 30s client default on an interactive suggestion.
    expect(input.timeout_ms).toBeGreaterThan(0);
    expect(input.timeout_ms).toBeLessThanOrEqual(15_000);

    expect(fetchTargets).toEqual([]);
  });

  it('constructs no request to api.anthropic.com on any branch', async () => {
    const branches: Array<() => void> = [
      () => yandexMock.isYandexGptConfigured.mockReturnValue(false),
      () => dbMock.contact.findMany.mockResolvedValue([]),
      () => yandexMock.createCompletion.mockResolvedValue(okCompletion('none')),
      () => yandexMock.createCompletion.mockResolvedValue(okCompletion(CONTACT_B.id)),
      () => yandexMock.createCompletion.mockRejectedValue(new Error('boom')),
      () => dbMock.contact.findMany.mockRejectedValue(new Error('db down')),
    ];

    for (const arrange of branches) {
      arrange();
      await callSuggestContact();
    }

    expect(fetchTargets).toEqual([]);
  });

  it('leaves no Anthropic client behind in the controller source', () => {
    const source = readFileSync(CONTROLLER_SOURCE_PATH, 'utf8');

    // Comments in this file discuss the removed provider on purpose, so only
    // code-shaped occurrences count.
    expect(source).not.toMatch(/from\s+['"]@anthropic-ai\/sdk['"]/);
    expect(source).not.toMatch(/require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/);
    expect(source).not.toMatch(/new\s+Anthropic\s*\(/);
    expect(source).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
    expect(source).not.toMatch(/claude-[a-z0-9.-]*\d/i);
    expect(source).toMatch(/from\s+['"]\.\.\/\.\.\/services\/yandex-gpt['"]/);
  });
});
