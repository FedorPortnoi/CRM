// The zone list the reminder editor offers.
//
// City names are DATA, not translated strings: they are proper nouns and the RU/EN pair
// is carried on the row itself rather than through i18n keys. Offsets are hard-coded
// because Russia has observed no DST since 2014, so every one of these is fixed; that
// also avoids depending on `timeZoneName: 'shortOffset'`, which needs an ICU newer than
// some Hermes builds ship with.

import { DEFAULT_REMINDER_TIMEZONE, getDeviceTimezone } from '../../hooks/useTaskReminders';

export interface TimezoneOption {
  /** IANA identifier — the only value ever sent to the server. */
  id: string;
  city: string;
  cityEn: string;
  /** Fixed UTC offset in hours. */
  offset: number;
}

export const REMINDER_TIMEZONES: TimezoneOption[] = [
  { id: 'Europe/Kaliningrad', city: 'Калининград', cityEn: 'Kaliningrad', offset: 2 },
  { id: 'Europe/Moscow', city: 'Москва', cityEn: 'Moscow', offset: 3 },
  { id: 'Europe/Samara', city: 'Самара', cityEn: 'Samara', offset: 4 },
  { id: 'Asia/Yekaterinburg', city: 'Екатеринбург', cityEn: 'Yekaterinburg', offset: 5 },
  { id: 'Asia/Omsk', city: 'Омск', cityEn: 'Omsk', offset: 6 },
  { id: 'Asia/Krasnoyarsk', city: 'Красноярск', cityEn: 'Krasnoyarsk', offset: 7 },
  { id: 'Asia/Irkutsk', city: 'Иркутск', cityEn: 'Irkutsk', offset: 8 },
  { id: 'Asia/Yakutsk', city: 'Якутск', cityEn: 'Yakutsk', offset: 9 },
  { id: 'Asia/Vladivostok', city: 'Владивосток', cityEn: 'Vladivostok', offset: 10 },
  { id: 'Asia/Magadan', city: 'Магадан', cityEn: 'Magadan', offset: 11 },
  { id: 'Asia/Kamchatka', city: 'Камчатка', cityEn: 'Kamchatka', offset: 12 },
];

export function findTimezoneOption(id: string): TimezoneOption | null {
  return REMINDER_TIMEZONES.find((zone) => zone.id === id) ?? null;
}

function offsetLabel(offset: number): string {
  return `UTC${offset >= 0 ? '+' : '-'}${Math.abs(offset)}`;
}

/**
 * A zone as the user should read it — «Москва (UTC+3)» for a known one, the bare IANA
 * identifier for anything else, which is at least unambiguous.
 */
export function timezoneLabel(id: string, language: string): string {
  const option = findTimezoneOption(id);
  if (!option) return id;
  const city = language.startsWith('ru') ? option.city : option.cityEn;
  return `${city} (${offsetLabel(option.offset)})`;
}

/**
 * The rows the picker shows: the standard list, plus the device's own zone and the
 * currently selected zone when either falls outside it (a user abroad, or a reminder
 * created on another device).
 */
export function timezoneOptionsFor(selected: string): string[] {
  const ids = REMINDER_TIMEZONES.map((zone) => zone.id);
  const device = getDeviceTimezone();
  const extras = [device, selected, DEFAULT_REMINDER_TIMEZONE].filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && !ids.includes(id),
  );
  return [...new Set([...ids, ...extras])];
}
