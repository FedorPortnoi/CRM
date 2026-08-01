// Data layer for per-task reminders.
//
// Backend contract (backend/api/routes/tasks.ts, built in parallel):
//   GET    /tasks/:id/reminders                 -> { data: Reminder[] }
//   POST   /tasks/:id/reminders                 -> { data: Reminder }
//   PATCH  /tasks/:id/reminders/:reminderId     -> { data: Reminder }
//   DELETE /tasks/:id/reminders/:reminderId     -> { data: { id } }
//
// A reminder is a WALL-CLOCK schedule, not an instant: `time_of_day` ("HH:MM") is
// interpreted in `timezone` (an IANA name) by the server, which is what decides when the
// phone actually buzzes. Only `starts_at` / `expires_at` are instants, and the UI resolves
// its picked calendar day in the reminder's own IANA zone at the API boundary.
//
// The query key ends with the bearer token, which utils/queryClient.ts refuses to
// dehydrate — reminders name a recipient and a task, so they stay out of the plaintext
// AsyncStorage cache.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { API_URL } from '../utils/api';
import { useUserStore } from '../store/userStore';

export const REMINDER_FREQUENCIES = ['once', 'daily', 'weekdays', 'weekly', 'custom'] as const;
export type ReminderFrequency = (typeof REMINDER_FREQUENCIES)[number];

/**
 * The frequencies the editor can author. `custom` carries a raw RRULE the UI cannot
 * safely rebuild, so it is shown read-only and only when a reminder already has it.
 */
export const EDITABLE_REMINDER_FREQUENCIES: readonly ReminderFrequency[] = [
  'once',
  'daily',
  'weekdays',
  'weekly',
] as const;

/** Matches the server default for `User.timezone`. */
export const DEFAULT_REMINDER_TIMEZONE = 'Europe/Moscow';

/** Guard-rail, not a server rule: more than a handful per task is always a mistake. */
export const MAX_REMINDERS_PER_TASK = 5;

export const DEFAULT_REMINDER_TIME = '09:00';

/** ISO weekday numbers, 1 = Monday .. 7 = Sunday. */
export const WEEKDAYS_ISO = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAYS_MON_TO_FRI = [1, 2, 3, 4, 5];

/** A reminder as the server returns it. */
export interface TaskReminder {
  id: string;
  task_id?: string;
  frequency: ReminderFrequency;
  time_of_day: string;
  days_of_week?: number[] | null;
  timezone: string;
  starts_at: string;
  expires_at?: string | null;
  recipient_id?: string | null;
  /** Only meaningful when `frequency === 'custom'`. Never authored by this client. */
  recurrence_rule?: string | null;
}

/**
 * A reminder as the editor holds it. Dates are plain `YYYY-MM-DD` wall-clock days because
 * that is all the user picks; the instants are rebuilt at the API boundary.
 *
 * `key` is a client-side identity so a not-yet-saved row can still be edited and deleted.
 * `id` is null until the server has one.
 */
export interface ReminderDraft {
  key: string;
  id: string | null;
  frequency: ReminderFrequency;
  time_of_day: string;
  days_of_week: number[];
  timezone: string;
  starts_on: string;
  expires_on: string | null;
  recipient_id: string | null;
  rrule: string | null;
}

/** The POST/PATCH body. */
export interface ReminderPayload {
  frequency: ReminderFrequency;
  time_of_day: string;
  days_of_week?: number[];
  timezone: string;
  starts_at: string;
  expires_at?: string | null;
  recipient_id?: string | null;
  recurrence_rule?: string | null;
}

// ─── Dates ────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` for the device's today. */
export function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  try {
    let formatter = zoneFormatterCache.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      zoneFormatterCache.set(zone, formatter);
    }
    return formatter;
  } catch {
    return null;
  }
}

function wallParts(zone: string, instant: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const formatter = zoneFormatter(zone);
  if (!formatter) return null;
  const parts = formatter.formatToParts(instant);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

function offsetAt(zone: string, instant: Date): number | null {
  const wall = wallParts(zone, instant);
  if (!wall) return null;
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) -
    Math.floor(instant.getTime() / 1000) * 1000
  );
}

/** Resolve a calendar day and wall-clock time in an arbitrary IANA zone to one UTC instant. */
export function zonedDateTimeToUtc(date: string, time: string, zone: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dateMatch || !timeMatch || !zoneFormatter(zone)) return null;

  const localTs = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  const calendarProbe = new Date(localTs);
  if (
    calendarProbe.getUTCFullYear() !== Number(dateMatch[1]) ||
    calendarProbe.getUTCMonth() + 1 !== Number(dateMatch[2]) ||
    calendarProbe.getUTCDate() !== Number(dateMatch[3])
  ) {
    return null;
  }
  const firstOffset = offsetAt(zone, new Date(localTs));
  if (firstOffset === null) return null;
  const firstGuess = localTs - firstOffset;
  const secondOffset = offsetAt(zone, new Date(firstGuess));
  if (secondOffset === null) return null;
  if (firstOffset === secondOffset) return new Date(firstGuess);

  const secondGuess = localTs - secondOffset;
  const thirdOffset = offsetAt(zone, new Date(secondGuess));
  if (thirdOffset === null) return null;
  if (secondOffset === thirdOffset) return new Date(secondGuess);

  return new Date(localTs - Math.min(secondOffset, thirdOffset));
}

/** Calendar date seen in `zone` at a stored instant. */
export function instantToDateInZone(value: string | null | undefined, zone: string): string {
  if (!value) return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const wall = wallParts(zone, instant);
  if (!wall) return '';
  return `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
}

/** "9:5" / "9:05" / "09:05" all normalise to "09:05"; anything else falls back. */
export function normalizeTimeOfDay(value: string | null | undefined): string {
  if (!value) return DEFAULT_REMINDER_TIME;
  const match = /^(\d{1,2}):(\d{1,2})/.exec(value.trim());
  if (!match) return DEFAULT_REMINDER_TIME;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function splitTimeOfDay(value: string): { hour: number; minute: number } {
  const [hour, minute] = normalizeTimeOfDay(value).split(':');
  return { hour: Number(hour), minute: Number(minute) };
}

export function joinTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ─── Drafts ───────────────────────────────────────────────────────────────────

let draftCounter = 0;

function nextDraftKey(): string {
  draftCounter += 1;
  return `draft-${Date.now().toString(36)}-${draftCounter}`;
}

export function newReminderDraft(options: {
  timezone: string;
  startsOn?: string;
  timeOfDay?: string;
}): ReminderDraft {
  return {
    key: nextDraftKey(),
    id: null,
    frequency: 'once',
    time_of_day: normalizeTimeOfDay(options.timeOfDay ?? DEFAULT_REMINDER_TIME),
    days_of_week: [],
    timezone: options.timezone,
    starts_on: options.startsOn && options.startsOn !== '' ? options.startsOn : todayDateString(),
    expires_on: null,
    recipient_id: null,
    rrule: null,
  };
}

export function draftFromReminder(reminder: TaskReminder): ReminderDraft {
  return {
    key: `saved-${reminder.id}`,
    id: reminder.id,
    frequency: reminder.frequency,
    time_of_day: normalizeTimeOfDay(reminder.time_of_day),
    days_of_week: [...(reminder.days_of_week ?? [])].sort((a, b) => a - b),
    timezone: reminder.timezone || DEFAULT_REMINDER_TIMEZONE,
    starts_on: instantToDateInZone(reminder.starts_at, reminder.timezone) || todayDateString(),
    expires_on: reminder.expires_at
      ? instantToDateInZone(reminder.expires_at, reminder.timezone)
      : null,
    recipient_id: reminder.recipient_id ?? null,
    rrule: reminder.recurrence_rule ?? null,
  };
}

export function toReminderPayload(draft: ReminderDraft): ReminderPayload {
  const startTime = draft.frequency === 'once' ? draft.time_of_day : '00:00';
  const startsAt = zonedDateTimeToUtc(draft.starts_on, startTime, draft.timezone);
  const expiresAt = draft.expires_on
    ? zonedDateTimeToUtc(draft.expires_on, '23:59', draft.timezone)
    : null;
  if (!startsAt || (draft.expires_on && !expiresAt)) {
    throw new Error('Reminder contains an invalid date or timezone');
  }

  return {
    frequency: draft.frequency,
    time_of_day: normalizeTimeOfDay(draft.time_of_day),
    ...(draft.frequency === 'weekly' && draft.days_of_week.length > 0
      ? { days_of_week: [...draft.days_of_week].sort((a, b) => a - b) }
      : {}),
    timezone: draft.timezone,
    starts_at: startsAt.toISOString(),
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
    ...(draft.recipient_id ? { recipient_id: draft.recipient_id } : {}),
    ...(draft.frequency === 'custom' && draft.rrule
      ? { recurrence_rule: draft.rrule }
      : {}),
  };
}

/** Field-by-field identity, used to send a PATCH only for rows that actually moved. */
export function draftSignature(draft: ReminderDraft): string {
  return [
    draft.frequency,
    normalizeTimeOfDay(draft.time_of_day),
    [...draft.days_of_week].sort((a, b) => a - b).join(','),
    draft.timezone,
    draft.starts_on,
    draft.expires_on ?? '',
    draft.recipient_id ?? '',
  ].join('|');
}

/**
 * The instant a `once` reminder fires, as this device reckons it.
 *
 * Only ever used for the LOCAL notification mirror. It resolves the wall clock in the
 * reminder's zone, so travel or an intentionally-selected office zone does not move it.
 */
export function localFireInstant(draft: ReminderDraft): string | null {
  if (draft.frequency !== 'once') return null;
  return zonedDateTimeToUtc(draft.starts_on, draft.time_of_day, draft.timezone)?.toISOString() ?? null;
}

/**
 * The one reminder the device may schedule locally: the earliest `once` reminder.
 *
 * Repeating reminders are the SERVER's job. Mirroring them locally as well would buzz the
 * phone twice for the same reminder, so they are deliberately skipped here.
 */
export function firstLocalFireInstant(drafts: ReminderDraft[]): string | null {
  const instants = drafts
    .map(localFireInstant)
    .filter((value): value is string => value !== null)
    .sort();
  return instants[0] ?? null;
}

// ─── Timezone ─────────────────────────────────────────────────────────────────

/** The device's IANA zone, or null when the runtime cannot report one. */
export function getDeviceTimezone(): string | null {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The zone new reminders start in: the signed-in user's server-side `User.timezone` when
 * the session carries one, else the device's, else the product default.
 *
 * `AuthUser` in store/userStore.ts does not declare `timezone` yet (that store belongs to
 * another agent this cycle), so it is read defensively rather than typed.
 */
export function useDefaultReminderTimezone(): string {
  const user = useUserStore((s) => s.user);
  const fromUser = (user as { timezone?: unknown } | null)?.timezone;
  if (typeof fromUser === 'string' && fromUser.length > 0) return fromUser;
  return getDeviceTimezone() ?? DEFAULT_REMINDER_TIMEZONE;
}

// ─── Transport ────────────────────────────────────────────────────────────────

type Envelope<T> = { data: T };

export class ReminderApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ReminderApiError';
    this.code = code;
    this.status = status;
  }
}

async function reminderRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });

  const body = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const envelope = body as { error?: { code?: string; message?: string } } | null;
    throw new ReminderApiError(
      envelope?.error?.code ?? 'REQUEST_FAILED',
      envelope?.error?.message ?? `Request failed with status ${res.status}`,
      res.status,
    );
  }

  return body as T;
}

export function taskRemindersKey(taskId: string, token: string | null): unknown[] {
  return ['task-reminders', taskId, token];
}

export function useTaskReminders(taskId: string | null): UseQueryResult<TaskReminder[], Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<TaskReminder[], Error>({
    queryKey: taskRemindersKey(taskId ?? '', token),
    queryFn: () =>
      reminderRequest<Envelope<TaskReminder[]>>(`/tasks/${taskId ?? ''}/reminders`, token ?? '').then(
        (body) => body.data ?? [],
      ),
    enabled: Boolean(token) && Boolean(taskId),
    // 4xx are answers, not outages.
    retry: (failureCount: number, error: Error) => {
      if (error instanceof ReminderApiError && error.status < 500) return false;
      return failureCount < 2;
    },
  });
}

export async function createTaskReminder(
  taskId: string,
  token: string,
  draft: ReminderDraft,
): Promise<TaskReminder> {
  const body = await reminderRequest<Envelope<TaskReminder>>(`/tasks/${taskId}/reminders`, token, {
    method: 'POST',
    body: JSON.stringify(toReminderPayload(draft)),
  });
  return body.data;
}

export async function updateTaskReminder(
  taskId: string,
  token: string,
  reminderId: string,
  draft: ReminderDraft,
): Promise<TaskReminder> {
  const body = await reminderRequest<Envelope<TaskReminder>>(
    `/tasks/${taskId}/reminders/${reminderId}`,
    token,
    { method: 'PATCH', body: JSON.stringify(toReminderPayload(draft)) },
  );
  return body.data;
}

export async function deleteTaskReminder(
  taskId: string,
  token: string,
  reminderId: string,
): Promise<void> {
  await reminderRequest<Envelope<{ id: string }>>(`/tasks/${taskId}/reminders/${reminderId}`, token, {
    method: 'DELETE',
  });
}

/**
 * Reconcile the editor's list against what the server already has.
 *
 * Deletions run first so that a "replace these two with one" edit cannot trip a
 * per-task cap on the server. Every call is awaited: a half-applied schedule is worse
 * than a reported failure, so the first rejection propagates.
 */
export async function syncTaskReminders(args: {
  taskId: string;
  token: string;
  original: ReminderDraft[];
  next: ReminderDraft[];
}): Promise<void> {
  const { taskId, token, original, next } = args;
  if (!taskId || !token) return;

  const keptIds = new Set(next.map((d) => d.id).filter((id): id is string => id !== null));
  const removed = original.filter((d) => d.id !== null && !keptIds.has(d.id));

  for (const draft of removed) {
    if (draft.id) await deleteTaskReminder(taskId, token, draft.id);
  }

  const originalById = new Map(
    original.filter((d) => d.id !== null).map((d) => [d.id as string, d]),
  );

  for (const draft of next) {
    if (draft.id === null) {
      await createTaskReminder(taskId, token, draft);
      continue;
    }
    const before = originalById.get(draft.id);
    if (!before || draftSignature(before) !== draftSignature(draft)) {
      await updateTaskReminder(taskId, token, draft.id, draft);
    }
  }
}

/** Same reconciliation, wired to react-query so the detail screen refreshes itself. */
export function useSyncTaskReminders(
  taskId: string | null,
): UseMutationResult<void, Error, { original: ReminderDraft[]; next: ReminderDraft[] }> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<void, Error, { original: ReminderDraft[]; next: ReminderDraft[] }>({
    mutationFn: (vars) =>
      syncTaskReminders({ taskId: taskId ?? '', token: token ?? '', ...vars }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-reminders', taskId ?? ''] });
    },
  });
}
