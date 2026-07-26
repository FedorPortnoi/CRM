import { describe, expect, it } from 'vitest';
import {
  buildTranscript,
  type AssistantApiMessage,
} from '../../../src/utils/assistantTranscript';

// Mirrors what backend/services/assistant.ts persists for one turn:
//   user → [assistant(tool_calls) → tool(results)]* → assistant(final answer)
function row(
  id: string,
  role: AssistantApiMessage['role'],
  content: string,
  tool_calls: unknown = null,
): AssistantApiMessage {
  return { id, role, content, tool_calls, created_at: '2026-07-25T10:00:00.000Z' };
}

function toolRow(id: string, results: Array<{ name: string; content: unknown }>): AssistantApiMessage {
  return row(
    id,
    'tool',
    JSON.stringify(results.map((r) => ({ name: r.name, content: JSON.stringify(r.content) }))),
  );
}

describe('buildTranscript', () => {
  it('turns a plain question and answer into two bubbles', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Сколько у меня задач?'),
      row('m2', 'assistant', 'Три задачи на сегодня.'),
    ]);

    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toMatchObject({ key: 'm1', role: 'user', content: 'Сколько у меня задач?' });
    expect(bubbles[1]).toMatchObject({ key: 'm2', role: 'assistant', toolCalls: [] });
  });

  it('attaches the executed tool calls to the answer that closes the turn', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Создай контакт Иван Петров'),
      row('m2', 'assistant', '', [
        { id: 'c1', name: 'create_contact', arguments: { first_name: 'Иван', last_name: 'Петров' } },
      ]),
      toolRow('m3', [{ name: 'create_contact', content: { data: { id: 'x' } } }]),
      row('m4', 'assistant', 'Контакт создан.'),
    ]);

    // The intermediate assistant row and the tool row are not bubbles.
    expect(bubbles.map((b) => b.key)).toEqual(['m1', 'm4']);
    expect(bubbles[1].toolCalls).toEqual([
      {
        round: 0,
        name: 'create_contact',
        arguments: { first_name: 'Иван', last_name: 'Петров' },
        ok: true,
      },
    ]);
  });

  it('marks a call whose result carries an error as failed and keeps the reason', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Закрой задачу'),
      row('m2', 'assistant', '', [{ id: 'c1', name: 'complete_task', arguments: { id: 'abc' } }]),
      toolRow('m3', [
        { name: 'complete_task', content: { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } } },
      ]),
      row('m4', 'assistant', 'Не нашёл такую задачу.'),
    ]);

    expect(bubbles[1].toolCalls[0]).toMatchObject({
      name: 'complete_task',
      ok: false,
      error: { code: 'TASK_NOT_FOUND', message: 'Task not found' },
    });
  });

  it('pairs results with calls across several rounds, in order', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Найди контакт и заведи сделку'),
      row('m2', 'assistant', '', [{ id: 'c1', name: 'get_contacts', arguments: { q: 'Иван' } }]),
      toolRow('m3', [{ name: 'get_contacts', content: { data: [] } }]),
      row('m4', 'assistant', '', [{ id: 'c2', name: 'create_deal', arguments: { title: 'Поставка' } }]),
      toolRow('m5', [
        { name: 'create_deal', content: { error: { code: 'CONTACT_NOT_FOUND', message: 'no contact' } } },
      ]),
      row('m6', 'assistant', 'Сделку завести не удалось.'),
    ]);

    expect(bubbles[1].toolCalls.map((c) => [c.name, c.round, c.ok])).toEqual([
      ['get_contacts', 0, true],
      ['create_deal', 1, false],
    ]);
  });

  it('pairs a batch of parallel calls positionally', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Обнови обе задачи'),
      row('m2', 'assistant', '', [
        { id: 'c1', name: 'update_task', arguments: { id: 'a', title: 'Первая' } },
        { id: 'c2', name: 'update_task', arguments: { id: 'b', title: 'Вторая' } },
      ]),
      toolRow('m3', [
        { name: 'update_task', content: { data: { id: 'a' } } },
        { name: 'update_task', content: { error: { code: 'FORBIDDEN', message: 'no access' } } },
      ]),
      row('m4', 'assistant', 'Готово частично.'),
    ]);

    expect(bubbles[1].toolCalls.map((c) => c.ok)).toEqual([true, false]);
    expect(bubbles[1].toolCalls[1].arguments).toEqual({ id: 'b', title: 'Вторая' });
  });

  it('treats an unparseable (truncated) tool result as a success', () => {
    // MAX_TOOL_RESULT_CHARS truncation appends "… [обрезано]", which breaks JSON.
    const bubbles = buildTranscript([
      row('m1', 'user', 'Покажи сделки'),
      row('m2', 'assistant', '', [{ id: 'c1', name: 'get_deals', arguments: {} }]),
      row('m3', 'tool', '[{"name":"get_deals","content":"{\\"data\\":[… [обрезано]"}]'),
      row('m4', 'assistant', 'Вот сделки.'),
    ]);

    expect(bubbles[1].toolCalls[0].ok).toBe(true);
  });

  it('does not leak one turn\'s calls into the next answer', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Создай контакт'),
      row('m2', 'assistant', '', [{ id: 'c1', name: 'create_contact', arguments: { first_name: 'Иван' } }]),
      toolRow('m3', [{ name: 'create_contact', content: { data: {} } }]),
      row('m4', 'assistant', 'Создал.'),
      row('m5', 'user', 'Спасибо'),
      row('m6', 'assistant', 'Пожалуйста.'),
    ]);

    expect(bubbles[1].toolCalls).toHaveLength(1);
    expect(bubbles[3].toolCalls).toEqual([]);
  });

  it('ignores malformed tool_calls payloads instead of dropping the answer', () => {
    const bubbles = buildTranscript([
      row('m1', 'user', 'Привет'),
      row('m2', 'assistant', 'Здравствуйте.', { not: 'an array' }),
    ]);

    expect(bubbles).toHaveLength(2);
    expect(bubbles[1].content).toBe('Здравствуйте.');
  });
});
