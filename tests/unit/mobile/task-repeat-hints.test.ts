import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const forms = [
  ['create', 'src/app/task/new.tsx'],
  ['edit', 'src/app/task/edit/[id].tsx'],
] as const;

describe('repeat vs reminders on the task form', () => {
  // The owner asked what the difference between the two controls was. Whatever
  // confuses the owner confuses every operator, and neither field said anything.
  it.each(forms)('explains what repeat does on the %s form', (_name, file) => {
    const source = read(file);
    const repeatLabel = source.indexOf("t('tasks.repeat')");
    const hint = source.indexOf("t('tasks.repeatHint')");
    expect(repeatLabel).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(repeatLabel);
  });

  it.each(forms)('warns on the %s form that a repeat without a due date is inert', (_name, file) => {
    // runRecurrence() in backend/services/scheduler.ts skips every task with no
    // due_date, so the recurrence a user picked here would never happen and
    // nothing would ever say why.
    expect(read(file)).toContain("recurrenceRule !== null && dueDate === ''");
  });

  it('keeps that skip the reason the warning exists', () => {
    const scheduler = read('backend/services/scheduler.ts');
    expect(scheduler).toContain('if (!task.due_date || !task.recurrence_rule) continue;');
  });

  it('sends each control to the other one, so neither reads as the same thing', () => {
    const ru = read('src/i18n/locales/ru.ts');
    expect(ru).toContain('Это не напоминание');
    expect(ru).toContain('Саму задачу оно не повторяет');
  });
});
