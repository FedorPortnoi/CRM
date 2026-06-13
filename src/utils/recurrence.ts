// Friendly, intuitive repeat options shown as a dropdown in the task forms.
// Each maps to a canonical RFC-5545 RRULE string the backend validates and the
// scheduler parses. No free-text RRULE entry — users only pick from this list.

export interface RecurrenceOption {
  labelKey: string;
  rule: string | null;
}

export const RECURRENCE_OPTIONS: RecurrenceOption[] = [
  { labelKey: 'tasks.recurrenceNone', rule: null },
  { labelKey: 'tasks.recurrenceDaily', rule: 'FREQ=DAILY' },
  { labelKey: 'tasks.recurrenceWeekly', rule: 'FREQ=WEEKLY' },
  { labelKey: 'tasks.recurrenceBiweekly', rule: 'FREQ=WEEKLY;INTERVAL=2' },
  { labelKey: 'tasks.recurrenceWeekdays', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { labelKey: 'tasks.recurrenceMonthly', rule: 'FREQ=MONTHLY' },
  { labelKey: 'tasks.recurrenceYearly', rule: 'FREQ=YEARLY' },
];

// Bare preset strings stored before the RRULE migration — map them forward so
// existing tasks still resolve to the right option.
const LEGACY_RULE_MAP: Record<string, string> = {
  daily: 'FREQ=DAILY',
  weekly: 'FREQ=WEEKLY',
  monthly: 'FREQ=MONTHLY',
};

export function normalizeRule(rule: string | null): string | null {
  if (!rule) return null;
  return LEGACY_RULE_MAP[rule] ?? rule;
}

export function labelKeyForRule(rule: string | null): string | null {
  const normalized = normalizeRule(rule);
  const match = RECURRENCE_OPTIONS.find((o) => o.rule === normalized);
  return match ? match.labelKey : null;
}
