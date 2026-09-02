// Due dates carry a time of day since 2026-09: the forms default new deadlines to 18:00
// local. Tasks created before that were stored at local midnight, and «00:00» on them
// would read as a real deadline — so midnight renders date-only everywhere.

import { formatMarketDate, formatMarketDateTime } from '../market/profile';

export const DEFAULT_DUE_TIME = '18:00';

export function dueDateHasTime(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return date.getHours() !== 0 || date.getMinutes() !== 0;
}

export function formatDueDate(
  iso: string | null | undefined,
  dateOptions: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
): string {
  if (!iso) return '';
  return dueDateHasTime(iso)
    ? formatMarketDateTime(iso, { ...dateOptions, hour: '2-digit', minute: '2-digit' })
    : formatMarketDate(iso, dateOptions);
}

/** Local HH:MM of a stored due date, or '' for null/invalid/midnight (no explicit time). */
export function toTimeInputValue(iso: string | null): string {
  if (!dueDateHasTime(iso)) return '';
  const date = new Date(iso as string);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
