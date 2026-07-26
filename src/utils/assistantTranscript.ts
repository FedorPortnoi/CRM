// Stored assistant messages → chat bubbles.
//
// A live turn comes back with `tool_calls: [{ name, arguments, ok, error? }]`,
// but the transcript on the server keeps the two halves apart: the model's
// intended calls sit on the intermediate `assistant` rows, their outcomes in
// the `tool` row that follows. Reopening a conversation therefore has to pair
// them back up — otherwise history shows the prose that claimed a contact was
// created without the evidence that it was.
//
// Pure and RN-free on purpose: this is the one piece of the assistant screen
// with logic worth unit-testing.
import type { AssistantToolCall } from './assistantTools';

/** A row of AssistantMessage as GET /conversations/:id returns it. */
export type AssistantApiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: unknown;
  created_at: string;
};

/** One turn as the chat renders it. `tool` rows never become bubbles. */
export type AssistantBubble = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: AssistantToolCall[];
  created_at: string | null;
  /** Local-only: an optimistic user turn that is in flight or was refused. */
  state?: 'sending' | 'failed';
};

type StoredToolCall = { name?: unknown; arguments?: unknown };

export function parseStoredToolCalls(
  value: unknown,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(value)) return [];

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const entry of value as StoredToolCall[]) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (name === null) continue;
    const args =
      entry.arguments && typeof entry.arguments === 'object' && !Array.isArray(entry.arguments)
        ? (entry.arguments as Record<string, unknown>)
        : {};
    calls.push({ name, arguments: args });
  }
  return calls;
}

type StoredToolOutcome = { ok: boolean; error?: { code: string; message: string } };

/**
 * A `tool` row holds `[{ name, content }]`, where a refused or failed call was
 * serialised as `{"error":{"code","message"}}`. Anything that does not parse
 * (a truncated result, plain text) counts as a success: a false "not completed"
 * badge on a call that did change data would be worse than no badge at all.
 */
export function parseStoredToolResults(content: string): StoredToolOutcome[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.map((entry): StoredToolOutcome => {
    const raw = entry as { content?: unknown };
    if (typeof raw?.content !== 'string') return { ok: true };

    try {
      const inner = JSON.parse(raw.content) as { error?: { code?: unknown; message?: unknown } };
      if (inner && typeof inner === 'object' && inner.error && typeof inner.error === 'object') {
        return {
          ok: false,
          error: {
            code: typeof inner.error.code === 'string' ? inner.error.code : 'TOOL_EXECUTION_FAILED',
            message: typeof inner.error.message === 'string' ? inner.error.message : '',
          },
        };
      }
    } catch {
      return { ok: true };
    }
    return { ok: true };
  });
}

/**
 * Stored rows → chat bubbles.
 *
 * backend/services/assistant.ts writes one turn as
 *   user → [assistant(tool_calls) → tool(results)]* → assistant(final answer)
 * so every call collected since the last user row belongs to the answer that
 * closes the turn.
 */
export function buildTranscript(messages: AssistantApiMessage[]): AssistantBubble[] {
  const bubbles: AssistantBubble[] = [];
  let pending: AssistantToolCall[] = [];
  let batchStart = 0;
  let round = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      bubbles.push({
        key: message.id,
        role: 'user',
        content: message.content,
        toolCalls: [],
        created_at: message.created_at,
      });
      pending = [];
      batchStart = 0;
      round = 0;
      continue;
    }

    if (message.role === 'tool') {
      const results = parseStoredToolResults(message.content);
      for (let i = 0; i < results.length; i += 1) {
        const call = pending[batchStart + i];
        if (!call) break;
        call.ok = results[i].ok;
        const failure = results[i].error;
        if (failure) call.error = failure;
      }
      batchStart = pending.length;
      continue;
    }

    const calls = parseStoredToolCalls(message.tool_calls);
    if (calls.length > 0) {
      batchStart = pending.length;
      for (const call of calls) {
        pending.push({ round, name: call.name, arguments: call.arguments, ok: true });
      }
      round += 1;
      continue;
    }

    bubbles.push({
      key: message.id,
      role: 'assistant',
      content: message.content,
      toolCalls: pending,
      created_at: message.created_at,
    });
    pending = [];
    batchStart = 0;
    round = 0;
  }

  return bubbles;
}
