import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RRule } from 'rrule';
import { TasksController } from '../controllers/tasks';
import { authenticate } from '../preHandlers';

function isSafeRRule(val: string): boolean {
  try {
    const rule = RRule.fromString(val.startsWith('RRULE:') ? val : `RRULE:${val}`);
    if (rule.options.count !== null && rule.options.count !== undefined && rule.options.count > 1000) return false;
    if (rule.options.interval !== undefined && rule.options.interval < 1) return false;
    return true;
  } catch { return false; }
}

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid(),
  due_date: z.string().datetime().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  is_recurring: z.boolean().default(false),
  recurrence_rule: z.string().max(200).optional().refine(
    (v) => v === undefined || isSafeRRule(v),
    { message: 'Invalid or unsafe recurrence rule' },
  ),
  reminder_at: z.string().datetime().optional(),
});

const UpdateTaskSchema = CreateTaskSchema.partial();

const TaskFilterSchema = z.object({
  assigned_to: z.string().uuid().optional(),
  scope: z.enum(['direct', 'subtree']).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  due_before: z.string().datetime().optional(),
  due_after: z.string().datetime().optional(),
  q: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['due_date', 'created_at', 'priority', 'title']).default('due_date'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

const ScopeQuerySchema = z.object({
  scope: z.enum(['direct', 'subtree']).optional(),
});

// ─── Reminders ────────────────────────────────────────────────────────────────

/**
 * 24-hour wall clock, and nothing else.
 *
 * The stored value is text on purpose (see the schema comment on TaskReminder.time_of_day),
 * which means this pattern is the only thing standing between the occurrence engine and a
 * string it cannot parse. A reminder that fails to parse at fire time is a reminder that
 * never fires and says nothing about why, so it is rejected at the door instead.
 */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Anything Intl will not accept as a zone would throw inside the formatter on every tick,
 * for every reminder, forever. Checked here rather than trusted from the client, because the
 * client sends whatever the device reports and a device can report nonsense.
 */
function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const ReminderFieldsSchema = z.object({
  frequency: z.enum(['once', 'daily', 'weekdays', 'weekly', 'custom']),
  time_of_day: z.string().regex(TIME_OF_DAY_PATTERN, 'time_of_day must be HH:MM in 24-hour form'),
  days_of_week: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  recurrence_rule: z.string().max(200).nullable().optional(),
  timezone: z.string().max(64).refine(isValidTimeZone, 'timezone must be a valid IANA zone name').optional(),
  recipient_id: z.string().uuid().optional(),
  starts_at: z.string().datetime().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  is_active: z.boolean().optional(),
});

/**
 * The cross-field rules, applied to whatever the request actually carries.
 *
 * On a PATCH these can only check the fields present — `frequency: 'weekly'` with no
 * `days_of_week` in the same body is valid if the stored row already has days. The merged
 * rule is re-validated in services/reminders.ts, which is the only place that can see both
 * halves, and this pass exists to reject the obviously-wrong before it gets that far.
 */
function refineReminder(
  value: z.infer<typeof ReminderFieldsSchema> | Partial<z.infer<typeof ReminderFieldsSchema>>,
  ctx: z.RefinementCtx,
  strict: boolean,
): void {
  if ((strict || value.frequency !== undefined) && value.frequency === 'weekly') {
    if (strict && (!value.days_of_week || value.days_of_week.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['days_of_week'], message: 'weekly reminders need at least one weekday' });
    }
  }

  if (strict && value.frequency === 'once' && !value.starts_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['starts_at'], message: 'once reminders need starts_at' });
  }

  if (value.days_of_week && value.days_of_week.length === 0 && value.frequency === 'weekly') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['days_of_week'], message: 'weekly reminders need at least one weekday' });
  }

  if (strict && value.frequency === 'custom' && !value.recurrence_rule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrence_rule'], message: 'custom reminders need a recurrence_rule' });
  }

  if (value.recurrence_rule && !isSafeRRule(value.recurrence_rule)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrence_rule'], message: 'Invalid or unsafe recurrence rule' });
  }

  if (value.starts_at && value.expires_at && new Date(value.expires_at) <= new Date(value.starts_at)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expires_at'], message: 'expires_at must be after starts_at' });
  }
}

const CreateReminderSchema = ReminderFieldsSchema.superRefine((value, ctx) => refineReminder(value, ctx, true));
const UpdateReminderSchema = ReminderFieldsSchema.partial().superRefine((value, ctx) => refineReminder(value, ctx, false));

const TaskIdParamsSchema = z.object({ id: z.string().uuid() });
const ReminderParamsSchema = z.object({ id: z.string().uuid(), reminderId: z.string().uuid() });

export default async function tasksRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: TaskFilterSchema },
  }, TasksController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateTaskSchema },
  }, TasksController.create);

  // Static convenience routes — registered before /:id so Fastify resolves them correctly
  f.get('/assignees', { preHandler: [authenticate] }, TasksController.assignees);
  f.get('/today', { preHandler: [authenticate], schema: { querystring: ScopeQuerySchema } }, TasksController.dueToday);
  f.post('/suggest-contact', {
    preHandler: [authenticate],
    schema: { body: z.object({ title: z.string().min(1).max(500) }) },
  }, TasksController.suggestContact);

  f.get('/:id', { preHandler: [authenticate] }, TasksController.getById);

  // Registered before the /:id mutations only for readability — Fastify's router prefers the
  // longer, more specific path regardless of order.
  f.get('/:id/reminders', {
    preHandler: [authenticate],
    schema: { params: TaskIdParamsSchema },
  }, TasksController.listReminders);

  f.post('/:id/reminders', {
    preHandler: [authenticate],
    schema: { params: TaskIdParamsSchema, body: CreateReminderSchema },
  }, TasksController.createReminder);

  f.patch('/:id/reminders/:reminderId', {
    preHandler: [authenticate],
    schema: { params: ReminderParamsSchema, body: UpdateReminderSchema },
  }, TasksController.updateReminder);

  f.delete('/:id/reminders/:reminderId', {
    preHandler: [authenticate],
    schema: { params: ReminderParamsSchema },
  }, TasksController.deleteReminder);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateTaskSchema },
  }, TasksController.update);

  f.post('/:id/complete', { preHandler: [authenticate] }, TasksController.complete);
  f.delete('/:id', { preHandler: [authenticate] }, TasksController.cancel);
}
