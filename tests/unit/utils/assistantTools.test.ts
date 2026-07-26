import { describe, expect, it } from 'vitest';
import {
  assistantToolDoneKey,
  assistantToolKind,
  assistantToolLabelKey,
  describeToolArguments,
  isKnownAssistantTool,
  splitToolCalls,
  type AssistantToolCall,
} from '../../../src/utils/assistantTools';

function call(name: string, args: Record<string, unknown> = {}): AssistantToolCall {
  return { round: 0, name, arguments: args, ok: true };
}

describe('assistant tool catalogue', () => {
  it('classifies every mutating CRM tool as a write', () => {
    const writes = [
      'create_contact',
      'update_contact',
      'archive_contact',
      'merge_contacts',
      'create_deal',
      'update_deal',
      'move_deal_to_stage',
      'create_task',
      'update_task',
      'complete_task',
      'create_event',
      'update_event',
      'cancel_event',
      'complete_event',
    ];

    for (const name of writes) {
      expect(assistantToolKind(name), name).toBe('write');
      expect(isKnownAssistantTool(name), name).toBe(true);
    }
  });

  it('classifies lookups as reads', () => {
    for (const name of ['get_contacts', 'get_deals', 'get_tasks', 'get_events', 'get_revenue']) {
      expect(assistantToolKind(name), name).toBe('read');
    }
  });

  it('treats an unknown tool as a write so a new action is never hidden', () => {
    expect(isKnownAssistantTool('send_invoice')).toBe(false);
    expect(assistantToolKind('send_invoice')).toBe('write');
  });

  it('builds the i18n keys the screen looks up', () => {
    expect(assistantToolLabelKey('create_contact')).toBe('assistant.tool_create_contact');
    expect(assistantToolDoneKey('create_contact')).toBe('assistant.toolDone_create_contact');
  });

  it('puts writes and reads in separate buckets, keeping order', () => {
    const { writes, reads } = splitToolCalls([
      call('get_contacts'),
      call('create_contact'),
      call('get_deals'),
      call('update_deal'),
    ]);

    expect(writes.map((c) => c.name)).toEqual(['create_contact', 'update_deal']);
    expect(reads.map((c) => c.name)).toEqual(['get_contacts', 'get_deals']);
  });
});

describe('describeToolArguments', () => {
  it('describes a contact by name', () => {
    expect(describeToolArguments({ first_name: 'Иван', last_name: 'Петров' })).toBe('Иван Петров');
  });

  it('describes a deal by title and formats money through the market profile', () => {
    const described = describeToolArguments({ title: 'Поставка станков', value: 1200000 });
    expect(described).toContain('Поставка станков');
    expect(described).toMatch(/₽/);
  });

  it('quotes a search phrase', () => {
    expect(describeToolArguments({ q: 'Иван' })).toBe('«Иван»');
  });

  it('never puts a raw identifier on screen', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(describeToolArguments({ id, contact_id: id, stage_id: id })).toBe('');
    expect(describeToolArguments({ title: id })).toBe('');
  });

  it('falls back to the company when there is no person name', () => {
    expect(describeToolArguments({ company: 'ООО «Ромашка»' })).toBe('ООО «Ромашка»');
  });

  it('returns an empty string for arguments with nothing human in them', () => {
    expect(describeToolArguments({})).toBe('');
    expect(describeToolArguments({ page: 2, per_page: 20 })).toBe('');
  });

  it('truncates a long descriptor', () => {
    const described = describeToolArguments({ title: 'я'.repeat(200) });
    expect(described.length).toBeLessThanOrEqual(90);
    expect(described.endsWith('…')).toBe(true);
  });
});
