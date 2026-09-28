import { describe, it, expect } from 'vitest';
import { displayDateToIso, isoToDisplayDate, maskDateInput } from '../../../src/utils/dateInput';

describe('typed dates read ДД.ММ.ГГГГ, not ГГГГ-ММ-ДД', () => {
  it('masks digits into day.month.year as they are typed', () => {
    expect(maskDateInput('2')).toBe('2');
    expect(maskDateInput('28')).toBe('28');
    expect(maskDateInput('280')).toBe('28.0');
    expect(maskDateInput('2809')).toBe('28.09');
    expect(maskDateInput('28092026')).toBe('28.09.2026');
    expect(maskDateInput('28.09.2026')).toBe('28.09.2026');
    expect(maskDateInput('280920261')).toBe('28.09.2026');
  });

  it('lets backspace delete through a dot', () => {
    // «28.0» minus one character is «28.», which must not stick as «28.».
    expect(maskDateInput('28.')).toBe('28');
  });

  it('converts to ISO only for real calendar dates', () => {
    expect(displayDateToIso('28.09.2026')).toBe('2026-09-28');
    expect(displayDateToIso('29.02.2028')).toBe('2028-02-29');
    expect(displayDateToIso('29.02.2026')).toBeNull();
    expect(displayDateToIso('31.04.2026')).toBeNull();
    expect(displayDateToIso('00.10.2026')).toBeNull();
    expect(displayDateToIso('15.13.2026')).toBeNull();
    expect(displayDateToIso('28.09')).toBeNull();
    expect(displayDateToIso('2026-09-28')).toBeNull();
  });

  it('shows stored ISO dates the Russian way', () => {
    expect(isoToDisplayDate('2026-09-28')).toBe('28.09.2026');
    expect(isoToDisplayDate('2026-09-28T15:00:00.000Z')).toBe('28.09.2026');
    expect(isoToDisplayDate(null)).toBe('');
    expect(isoToDisplayDate('garbage')).toBe('');
  });
});
