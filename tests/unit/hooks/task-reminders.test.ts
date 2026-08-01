import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/store/userStore', () => ({
  useUserStore: Object.assign(vi.fn(), {
    getState: () => ({ token: null, user: null }),
  }),
}));
vi.mock('../../../src/utils/api', () => ({ API_URL: 'https://api.example.test/api/v1' }));

import {
  draftFromReminder,
  localFireInstant,
  toReminderPayload,
  zonedDateTimeToUtc,
  type ReminderDraft,
} from '../../../src/hooks/useTaskReminders';

function draft(overrides: Partial<ReminderDraft> = {}): ReminderDraft {
  return {
    key: 'draft-1',
    id: null,
    frequency: 'once',
    time_of_day: '09:00',
    days_of_week: [],
    timezone: 'Europe/Moscow',
    starts_on: '2026-08-30',
    expires_on: null,
    recipient_id: null,
    rrule: null,
    ...overrides,
  };
}

describe('task reminder API boundary', () => {
  it('resolves a once reminder at its selected wall-clock time, not UTC midnight', () => {
    const payload = toReminderPayload(draft());
    expect(payload.starts_at).toBe('2026-08-30T06:00:00.000Z');
    expect(localFireInstant(draft())).toBe(payload.starts_at);
  });

  it('resolves dates in the chosen zone even when it differs from the device zone', () => {
    expect(
      zonedDateTimeToUtc('2026-01-15', '09:00', 'America/New_York')?.toISOString(),
    ).toBe('2026-01-15T14:00:00.000Z');
  });

  it('uses local start/end-of-day boundaries for repeating schedules', () => {
    const payload = toReminderPayload(
      draft({ frequency: 'daily', expires_on: '2026-09-02' }),
    );
    expect(payload.starts_at).toBe('2026-08-29T21:00:00.000Z');
    expect(payload.expires_at).toBe('2026-09-02T20:59:00.000Z');
  });

  it('round-trips stored instants back to calendar dates in the reminder zone', () => {
    const restored = draftFromReminder({
      id: 'reminder-1',
      frequency: 'once',
      time_of_day: '09:00',
      days_of_week: [],
      timezone: 'America/Los_Angeles',
      starts_at: '2026-08-31T06:30:00.000Z',
      expires_at: null,
      recurrence_rule: null,
    });
    expect(restored.starts_on).toBe('2026-08-30');
  });

  it('preserves the backend recurrence_rule field for read-only custom schedules', () => {
    const restored = draftFromReminder({
      id: 'reminder-1',
      frequency: 'custom',
      time_of_day: '09:00',
      days_of_week: [],
      timezone: 'Europe/Moscow',
      starts_at: '2026-08-29T21:00:00.000Z',
      expires_at: null,
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE',
    });
    expect(restored.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(toReminderPayload(restored).recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
  });
});
