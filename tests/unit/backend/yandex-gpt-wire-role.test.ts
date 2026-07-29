import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for a defect that reached production and disabled the AI
 * assistant outright.
 *
 * `toWireMessage` built the tool-result message without a `role`, because the
 * wire type declared `role` optional. Yandex Foundation Models answers such a
 * request with HTTP 400 `invalid message role ''` — so the FIRST round of any
 * assistant turn succeeded, and the second (the one carrying the tool result
 * back) failed. Every question that actually touched CRM data died there, which
 * is nearly all of them; only a reply the model could produce without calling a
 * tool ever came back.
 *
 * The endpoint reported `configured: true` throughout, and the credentials were
 * valid, so nothing in the health surface pointed at it.
 *
 * These tests assert on the JSON handed to `fetch`, because that is the exact
 * artefact the API rejected. Asserting on `AiMessage` instead would have passed
 * against the broken build.
 */

const ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        result: {
          alternatives: [{ message: { role: 'assistant', text }, status: 'ALTERNATIVE_STATUS_FINAL' }],
          usage: { inputTextTokens: '1', completionTokens: '1', totalTokens: '2' },
          modelVersion: 'test',
        },
      }),
  } as unknown as Response;
}

/** Every message object in the outgoing payload, across every fetch call. */
function sentMessages(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.flatMap((call) => {
    const body = JSON.parse((call[1] as RequestInit).body as string) as {
      messages: Array<Record<string, unknown>>;
    };
    return body.messages;
  });
}

describe('yandex-gpt wire encoding — every message carries a role', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.YANDEX_API_KEY = 'test-key';
    process.env.YANDEX_FOLDER_ID = 'test-folder';
    fetchMock = vi.fn(async () => okResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.YANDEX_API_KEY;
    delete process.env.YANDEX_FOLDER_ID;
  });

  it('gives the tool-result message a non-empty role', async () => {
    const { createCompletion } = await import('../../../backend/services/yandex-gpt');

    await createCompletion({
      messages: [
        { role: 'system', text: 'system prompt' },
        { role: 'user', text: 'покажи мои сделки' },
        { role: 'assistant', text: '', tool_calls: [{ id: 'call-1', name: 'get_deals', arguments: {} }] },
        { role: 'tool', tool_results: [{ name: 'get_deals', content: '{"deals":[]}' }] },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, expect.anything());

    const messages = sentMessages(fetchMock);
    const toolResult = messages.find((m) => 'toolResultList' in m);

    // The specific shape the API rejected: present but empty, or absent entirely.
    expect(toolResult).toBeDefined();
    expect(toolResult?.role).toBeTruthy();
  });

  it('gives EVERY outgoing message a non-empty role, whatever the mix', async () => {
    const { createCompletion } = await import('../../../backend/services/yandex-gpt');

    await createCompletion({
      messages: [
        { role: 'system', text: 'system prompt' },
        { role: 'user', text: 'первый вопрос' },
        { role: 'assistant', text: '', tool_calls: [{ id: 'call-1', name: 'get_deals', arguments: {} }] },
        { role: 'tool', tool_results: [{ name: 'get_deals', content: '{"deals":[]}' }] },
        { role: 'assistant', text: 'вот ваши сделки' },
        { role: 'user', text: 'второй вопрос' },
      ],
    });

    const messages = sentMessages(fetchMock);
    expect(messages).toHaveLength(6);

    for (const [i, m] of messages.entries()) {
      expect(
        typeof m.role === 'string' && m.role.length > 0,
        `message ${i} (${JSON.stringify(m).slice(0, 60)}) has no usable role`,
      ).toBe(true);
    }
  });

  it('preserves assistant/user alternation across a tool round', async () => {
    const { createCompletion } = await import('../../../backend/services/yandex-gpt');

    await createCompletion({
      messages: [
        { role: 'user', text: 'вопрос' },
        { role: 'assistant', text: '', tool_calls: [{ id: 'call-1', name: 'get_deals', arguments: {} }] },
        { role: 'tool', tool_results: [{ name: 'get_deals', content: '{}' }] },
      ],
    });

    // A tool result tagged 'assistant' would put two assistant turns back to back.
    // Alternation is the reason 'user' was chosen over 'assistant'.
    expect(sentMessages(fetchMock).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
