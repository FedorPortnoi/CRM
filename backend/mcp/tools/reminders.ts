import { ReminderFrequency } from '@prisma/client';
import { registerTool, type McpUser } from '../server';
import { requireMcpToolCapability } from '../validation';
import { getTaskForUser } from '../../services/task-domain';
import {
  createTaskReminder,
  deleteTaskReminder,
  listTaskReminders,
  updateTaskReminder,
  type ReminderInput,
  type ReminderPatch,
} from '../../services/reminders';
import type { Requester } from '../../services/visibility';

function toRequester(user: McpUser): Requester {
  return { sub: user.sub, org_id: user.org_id, role: user.role as Requester['role'] };
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function invalidArgument(message: string) {
  return { error: { code: 'INVALID_ARGUMENT', message } };
}

function isFrequency(value: unknown): value is ReminderFrequency {
  return (
    value === ReminderFrequency.once ||
    value === ReminderFrequency.daily ||
    value === ReminderFrequency.weekdays ||
    value === ReminderFrequency.weekly ||
    value === ReminderFrequency.custom
  );
}

async function visibleTaskId(taskId: string, user: McpUser): Promise<string | null> {
  const task = await getTaskForUser(taskId, user.org_id, toRequester(user));
  return task?.id ?? null;
}

function taskNotFound() {
  return { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } };
}

function reminderResult<T extends { ok: boolean }>(result: T): unknown {
  if (!result.ok) {
    const failed = result as T & { error: { code: string; message: string } };
    return { error: { code: failed.error.code, message: failed.error.message } };
  }
  return result;
}

const reminderProperties = {
  frequency: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly', 'custom'] },
  time_of_day: {
    type: 'string',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    description: 'Wall-clock local time in HH:MM 24-hour form',
  },
  days_of_week: {
    type: 'array',
    maxItems: 7,
    items: { type: 'integer', minimum: 1, maximum: 7 },
    description: 'For weekly reminders: ISO weekdays, Monday=1 through Sunday=7',
  },
  recurrence_rule: { type: ['string', 'null'], maxLength: 200 },
  timezone: { type: 'string', maxLength: 64, description: 'IANA time-zone name' },
  recipient_id: { type: 'string', description: 'Recipient UUID; defaults to the task assignee' },
  starts_at: { type: 'string', description: 'ISO 8601 instant from which the rule is active' },
  expires_at: {
    type: ['string', 'null'],
    description: 'ISO 8601 instant after which reminders stop; null means no expiry',
  },
  is_active: { type: 'boolean' },
} as const;

function reminderInput(args: Record<string, unknown>): ReminderInput {
  return {
    frequency: isFrequency(args.frequency) ? args.frequency : (stringArg(args.frequency) as ReminderFrequency),
    time_of_day: stringArg(args.time_of_day),
    days_of_week: Array.isArray(args.days_of_week)
      ? args.days_of_week.filter((day): day is number => typeof day === 'number')
      : undefined,
    recurrence_rule:
      typeof args.recurrence_rule === 'string' || args.recurrence_rule === null
        ? args.recurrence_rule
        : undefined,
    timezone: typeof args.timezone === 'string' ? args.timezone : undefined,
    recipient_id: typeof args.recipient_id === 'string' ? args.recipient_id : undefined,
    starts_at: typeof args.starts_at === 'string' ? args.starts_at : undefined,
    expires_at:
      typeof args.expires_at === 'string' || args.expires_at === null ? args.expires_at : undefined,
    is_active: typeof args.is_active === 'boolean' ? args.is_active : undefined,
  };
}

function reminderPatch(args: Record<string, unknown>): ReminderPatch {
  const patch: ReminderPatch = {};
  if (isFrequency(args.frequency)) patch.frequency = args.frequency;
  if (typeof args.time_of_day === 'string') patch.time_of_day = args.time_of_day;
  if (Array.isArray(args.days_of_week)) {
    patch.days_of_week = args.days_of_week.filter((day): day is number => typeof day === 'number');
  }
  if (typeof args.recurrence_rule === 'string' || args.recurrence_rule === null) patch.recurrence_rule = args.recurrence_rule;
  if (typeof args.timezone === 'string') patch.timezone = args.timezone;
  if (typeof args.recipient_id === 'string') patch.recipient_id = args.recipient_id;
  if (typeof args.starts_at === 'string') patch.starts_at = args.starts_at;
  if (typeof args.expires_at === 'string' || args.expires_at === null) patch.expires_at = args.expires_at;
  if (typeof args.is_active === 'boolean') patch.is_active = args.is_active;
  return patch;
}

function validateReminderArgs(args: Record<string, unknown>, create: boolean): ReturnType<typeof invalidArgument> | null {
  if (create && !isFrequency(args.frequency)) return invalidArgument('frequency is required and must be once, daily, weekdays, weekly or custom');
  if (args.frequency !== undefined && !isFrequency(args.frequency)) return invalidArgument('frequency is invalid');
  if (create && typeof args.time_of_day !== 'string') return invalidArgument('time_of_day is required');
  if (args.time_of_day !== undefined && (typeof args.time_of_day !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(args.time_of_day))) {
    return invalidArgument('time_of_day must be HH:MM in 24-hour form');
  }
  if (args.days_of_week !== undefined) {
    if (!Array.isArray(args.days_of_week) || args.days_of_week.length > 7) return invalidArgument('days_of_week must be an array with at most seven days');
    if (args.days_of_week.some((day) => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7)) {
      return invalidArgument('days_of_week entries must be ISO weekdays 1 through 7');
    }
  }
  for (const field of ['starts_at', 'expires_at'] as const) {
    const value = args[field];
    if (value !== undefined && value !== null && (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()))) {
      return invalidArgument(`${field} must be an ISO 8601 date-time${field === 'expires_at' ? ' or null' : ''}`);
    }
  }
  return null;
}

registerTool(
  'get_task_reminders',
  'List reminder schedules attached to a task visible to the authenticated user',
  {
    type: 'object',
    properties: { task_id: { type: 'string', description: 'Task UUID' } },
    required: ['task_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const readErr = requireMcpToolCapability(user, 'get_task_reminders');
    if (readErr) return readErr;

    const taskId = await visibleTaskId(stringArg(args.task_id), user);
    if (!taskId) return taskNotFound();

    const reminders = await listTaskReminders(taskId, user.org_id);
    return { data: reminders, meta: { total: reminders.length } };
  },
);

registerTool(
  'create_task_reminder',
  'Create a once, daily, weekday, weekly or custom reminder for a visible task',
  {
    type: 'object',
    properties: { task_id: { type: 'string', description: 'Task UUID' }, ...reminderProperties },
    required: ['task_id', 'frequency', 'time_of_day'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'create_task_reminder');
    if (writeErr) return writeErr;

    const inputErr = validateReminderArgs(args, true);
    if (inputErr) return inputErr;

    const taskId = await visibleTaskId(stringArg(args.task_id), user);
    if (!taskId) return taskNotFound();

    const result = await createTaskReminder(
      taskId,
      user.org_id,
      reminderInput(args),
      toRequester(user),
    );
    if (!result.ok) return reminderResult(result);
    return { data: result.reminder, meta: {} };
  },
);

registerTool(
  'update_task_reminder',
  'Update, pause, resume or reschedule one reminder attached to a visible task',
  {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task UUID' },
      reminder_id: { type: 'string', description: 'Reminder UUID' },
      ...reminderProperties,
    },
    required: ['task_id', 'reminder_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'update_task_reminder');
    if (writeErr) return writeErr;

    const inputErr = validateReminderArgs(args, false);
    if (inputErr) return inputErr;

    const patchFields = ['frequency', 'time_of_day', 'days_of_week', 'recurrence_rule', 'timezone', 'recipient_id', 'starts_at', 'expires_at', 'is_active'];
    if (!patchFields.some((field) => args[field] !== undefined)) return invalidArgument('no fields to update');

    const taskId = await visibleTaskId(stringArg(args.task_id), user);
    if (!taskId) return taskNotFound();

    const result = await updateTaskReminder(
      stringArg(args.reminder_id),
      taskId,
      user.org_id,
      reminderPatch(args),
      toRequester(user),
    );
    if (!result.ok) return reminderResult(result);
    return { data: result.reminder, meta: {} };
  },
);

registerTool(
  'delete_task_reminder',
  'Delete one reminder schedule from a visible task without deleting or closing the task',
  {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task UUID' },
      reminder_id: { type: 'string', description: 'Reminder UUID' },
    },
    required: ['task_id', 'reminder_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'delete_task_reminder');
    if (writeErr) return writeErr;

    const taskId = await visibleTaskId(stringArg(args.task_id), user);
    if (!taskId) return taskNotFound();

    const result = await deleteTaskReminder(stringArg(args.reminder_id), taskId, user.org_id);
    if (!result.ok) return reminderResult(result);
    return { data: { deleted: true, reminder_id: stringArg(args.reminder_id) }, meta: {} };
  },
);
