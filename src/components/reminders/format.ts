// Turns a reminder into one line a person can read: «Ежедневно в 09:00 до 30 августа».
//
// Every fragment goes through i18n so the sentence can be re-ordered per language; the
// only thing assembled here is which fragments apply.

import { formatMarketDate } from '../../market/profile';
import {
  normalizeTimeOfDay,
  type ReminderDraft,
  type ReminderFrequency,
} from '../../hooks/useTaskReminders';

/** Narrow view of i18next's `t`, enough for the keys used here. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** ISO weekday (1 = Mon .. 7 = Sun) -> i18n key. */
export function weekdayKey(iso: number): string {
  return `reminders.weekdayShort${iso}`;
}

export function weekdayLabel(iso: number, t: Translate): string {
  return t(weekdayKey(iso));
}

const FREQUENCY_LABEL_KEYS: Record<ReminderFrequency, string> = {
  once: 'reminders.frequencyOnce',
  daily: 'reminders.frequencyDaily',
  weekdays: 'reminders.frequencyWeekdays',
  weekly: 'reminders.frequencyWeekly',
  custom: 'reminders.frequencyCustom',
};

export function frequencyLabel(frequency: ReminderFrequency, t: Translate): string {
  return t(FREQUENCY_LABEL_KEYS[frequency]);
}

/** «30 августа», with the year appended only when it is not the current one. */
export function formatDayMonth(date: string): string {
  if (!date) return '';
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return formatMarketDate(parsed, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** «пн, ср, пт» — the chip labels, lower-cased for use inside a sentence. */
export function formatWeekdayList(days: number[], t: Translate): string {
  return [...days]
    .sort((a, b) => a - b)
    .map((iso) => weekdayLabel(iso, t).toLocaleLowerCase('ru-RU'))
    .join(', ');
}

/**
 * The schedule sentence, without the timezone. `expires_on` is folded in as «до <дата>»
 * rather than appended as a separate clause so the whole thing stays one line.
 */
export function describeReminder(draft: ReminderDraft, t: Translate): string {
  const time = normalizeTimeOfDay(draft.time_of_day);

  let schedule: string;
  switch (draft.frequency) {
    case 'once':
      schedule = t('reminders.summaryOnce', { date: formatDayMonth(draft.starts_on), time });
      break;
    case 'daily':
      schedule = t('reminders.summaryDaily', { time });
      break;
    case 'weekdays':
      schedule = t('reminders.summaryWeekdays', { time });
      break;
    case 'weekly':
      schedule =
        draft.days_of_week.length > 0
          ? t('reminders.summaryWeekly', { days: formatWeekdayList(draft.days_of_week, t), time })
          : t('reminders.summaryWeeklyNoDays', { time });
      break;
    default:
      schedule = t('reminders.summaryCustom', { time });
      break;
  }

  if (draft.expires_on) {
    schedule = t('reminders.summaryUntil', {
      schedule,
      date: formatDayMonth(draft.expires_on),
    });
  }

  return schedule;
}
