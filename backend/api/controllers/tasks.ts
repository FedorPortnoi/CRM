import { FastifyRequest, FastifyReply } from 'fastify';
import { TaskPriority, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';
import { isYandexGptConfigured } from '../../services/yandex-gpt';
import { matchContactByName, type NameCandidate } from '../../services/contact-name-match';
import {
  getVisibleUserIds,
  getAccessibleUserIds,
  type VisibilityScope,
} from '../../services/visibility';
import {
  listTasksForUser,
  getTaskForUser,
  createTaskForUser,
  updateTaskForUser,
  completeTaskForUser,
  type CreateTaskBody,
  type UpdateTaskPatch,
} from '../../services/task-domain';
import {
  listTaskReminders,
  createTaskReminder,
  updateTaskReminder,
  deleteTaskReminder,
  type ReminderError,
  type ReminderInput,
  type ReminderPatch,
} from '../../services/reminders';

// ─── Local request types ──────────────────────────────────────────────────────

type ListQuery = {
  assigned_to?: string;
  scope?: VisibilityScope;
  status?: TaskStatus;
  priority?: TaskPriority;
  contact_id?: string;
  deal_id?: string;
  due_before?: string;
  due_after?: string;
  q?: string;
  page: number;
  per_page: number;
  sort: 'due_date' | 'created_at' | 'priority' | 'title';
  order: 'asc' | 'desc';
};

type IdParams = { id: string };

// ─── Handlers ────────────────────────────────────────────────────────────────

async function assignees(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Members can only assign inside their own cone; owner/admin see everyone.
  const accessibleIds = await getAccessibleUserIds(request.user);

  const members = await db.user.findMany({
    where: {
      organization_id: request.user.org_id,
      is_active: true,
      ...(accessibleIds && { id: { in: accessibleIds } }),
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  // Surface the current user first so self-assignment is the obvious default.
  const sorted = members.sort((a, b) => {
    if (a.id === request.user.sub) return -1;
    if (b.id === request.user.sub) return 1;
    return 0;
  });

  reply.send({ data: sorted, meta: { total: sorted.length } });
}

async function list(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const {
    assigned_to,
    scope,
    status,
    priority,
    contact_id,
    deal_id,
    due_before,
    due_after,
    q,
    page,
    per_page,
    sort,
    order,
  } = request.query as ListQuery;

  const { data: tasks, total } = await listTasksForUser(
    request.user.org_id,
    request.user,
    { assigned_to, scope, status, priority, contact_id, deal_id, due_before, due_after, q, page, per_page, sort, order },
  );

  reply.send({ data: tasks, meta: { total, page, per_page } });
}

async function create(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as CreateTaskBody;

  const result = await createTaskForUser(request.user.org_id, request.user, body);

  if (!result.ok) {
    reply.status(result.error.kind === 'forbidden' ? 403 : 422).send({
      error: { code: result.error.code, message: result.error.message },
    });
    return;
  }

  reply.status(201).send({ data: result.task, meta: {} });
}

async function getById(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const task = await getTaskForUser(id, request.user.org_id, request.user);

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  reply.send({ data: task, meta: {} });
}

async function update(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const body = request.body as UpdateTaskPatch;

  const result = await updateTaskForUser(id, request.user.org_id, request.user, body);

  if (!result.ok) {
    const status =
      result.error.kind === 'not_found' ? 404 :
      result.error.kind === 'forbidden' ? 403 : 422;
    reply.status(status).send({ error: { code: result.error.code, message: result.error.message } });
    return;
  }

  reply.send({ data: result.task, meta: {} });
}

async function complete(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const result = await completeTaskForUser(id, request.user.org_id, request.user);

  if (!result.ok) {
    const status = result.error.kind === 'not_found' ? 404 : 422;
    reply.status(status).send({ error: { code: result.error.code, message: result.error.message } });
    return;
  }

  reply.send({ data: result.task, meta: {} });
}

async function cancel(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const accessibleIds = await getAccessibleUserIds(request.user);
  const assignedFilter: { in: string[] } | undefined =
    accessibleIds === null ? undefined : { in: accessibleIds };

  const task = await db.task.findFirst({
    where: {
      id,
      organization_id: orgId,
      ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
    },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  const result = await db.task.updateMany({
    where: { id, organization_id: orgId },
    data: { status: TaskStatus.cancelled },
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  const updatedTask = await db.task.findFirst({
    where: { id, organization_id: orgId },
  });

  if (!updatedTask) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  reply.send({ data: updatedTask, meta: {} });
}

async function dueToday(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { scope } = request.query as { scope?: VisibilityScope };
  const visibleIds = await getVisibleUserIds(request.user, scope ?? 'direct');
  const assignedFilter: { in: string[] } | undefined =
    visibleIds === null ? undefined : { in: visibleIds };

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  const tasks = await db.task.findMany({
    where: {
      organization_id: request.user.org_id,
      ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
      status: { notIn: [TaskStatus.cancelled, TaskStatus.done] },
      due_date: { gte: startOfDay, lt: endOfDay },
    },
  });

  reply.send({ data: tasks, meta: {} });
}

// ─── Reminders ───────────────────────────────────────────────────────────────

type ReminderIdParams = { id: string; reminderId: string };

/**
 * A reminder is reachable exactly when its task is.
 *
 * Every handler below goes through getTaskForUser first rather than querying TaskReminder by
 * id and checking the org afterwards. The org is not the boundary here — the visibility cone
 * is — and TaskReminder carries an organization_id but nothing that says whose cone the task
 * sits in. Asking the task means the reminder sub-resource can never be a softer door onto a
 * task than GET /tasks/:id is.
 */
async function requireVisibleTask(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string } | null> {
  const { id } = request.params as IdParams;
  const task = await getTaskForUser(id, request.user.org_id, request.user);

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return null;
  }

  return { id: task.id };
}

function statusForReminderError(error: ReminderError): number {
  if (error.kind === 'not_found') return 404;
  if (error.kind === 'forbidden') return 403;
  return 422;
}

async function listReminders(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const task = await requireVisibleTask(request, reply);
  if (!task) return;

  const reminders = await listTaskReminders(task.id, request.user.org_id);
  reply.send({ data: reminders, meta: { total: reminders.length } });
}

async function createReminder(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const task = await requireVisibleTask(request, reply);
  if (!task) return;

  const result = await createTaskReminder(
    task.id,
    request.user.org_id,
    request.body as ReminderInput,
    request.user,
  );

  if (!result.ok) {
    reply.status(statusForReminderError(result.error)).send({
      error: { code: result.error.code, message: result.error.message },
    });
    return;
  }

  reply.status(201).send({ data: result.reminder, meta: {} });
}

async function updateReminder(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const task = await requireVisibleTask(request, reply);
  if (!task) return;

  const { reminderId } = request.params as ReminderIdParams;
  const result = await updateTaskReminder(
    reminderId,
    task.id,
    request.user.org_id,
    request.body as ReminderPatch,
    request.user,
  );

  if (!result.ok) {
    reply.status(statusForReminderError(result.error)).send({
      error: { code: result.error.code, message: result.error.message },
    });
    return;
  }

  reply.send({ data: result.reminder, meta: {} });
}

async function deleteReminder(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const task = await requireVisibleTask(request, reply);
  if (!task) return;

  const { reminderId } = request.params as ReminderIdParams;
  const result = await deleteTaskReminder(reminderId, task.id, request.user.org_id);

  if (!result.ok) {
    reply.status(statusForReminderError(result.error)).send({
      error: { code: result.error.code, message: result.error.message },
    });
    return;
  }

  reply.status(204).send();
}

// ─── Contact suggestion for a task title ─────────────────────────────────────

/**
 * How many candidate contacts are read for one suggestion.
 *
 * This used to be the size of the list handed to a model, and the number that
 * made the endpoint a ФЗ-152 problem. It is now only a memory and query bound:
 * the names never leave the process. The cap and its alphabetical ordering are
 * kept as they were, so an org past 300 contacts is truncated exactly where it
 * always was rather than silently changing which contacts can be suggested.
 */
const SUGGEST_CONTACT_LIMIT = 300;

type SuggestedContact = NameCandidate;

/**
 * Matches the title against the org's contacts in process — see
 * backend/services/contact-name-match.ts for the matching rules and for why
 * PostgreSQL's 'russian' full-text config was evaluated and rejected.
 *
 * Two providers have now been taken out of this route. It first built its own
 * Anthropic client and posted up to 300 Russian customers' full names to
 * api.anthropic.com on every call — a ст. 12 ФЗ-152 cross-border transfer with
 * no filing behind it. Routing it through the domestic yandex-gpt seam closed
 * that transfer but not the exposure: the same 300 names were still in a
 * prompt, and Wave A repoints yandex-gpt.ts at OpenAI through
 * workers/openai-proxy, which would have sent them abroad again without a line
 * changing here. Matching locally is what actually ends it. This route now has
 * no provider seam to repoint.
 *
 * Returns `null` for every failure and for every ambiguous title: the client
 * cannot distinguish "no match" from "no suggestion available", and nothing
 * about an unrequested suggestion is worth surfacing to the operator.
 */
async function resolveSuggestedContact(
  orgId: string,
  title: string,
): Promise<SuggestedContact | null> {
  // No model is called any more, so this is no longer "is there someone to
  // ask". It is kept because it is the switch operators already use to keep the
  // AI surfaces off — an unconfigured deployment, and every local dev machine,
  // has never seen this modal, and quietly turning it on everywhere is not part
  // of removing a provider. It goes when this route gets a setting of its own.
  if (!isYandexGptConfigured()) {
    return null;
  }

  const contacts = await db.contact.findMany({
    where: {
      organization_id: orgId,
      status: { not: 'archived' },
    },
    select: { id: true, first_name: true, last_name: true },
    take: SUGGEST_CONTACT_LIMIT,
    orderBy: { first_name: 'asc' },
  });

  return matchContactByName(title, contacts);
}

async function suggestContact(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { title } = request.body as { title: string };

  let contact: SuggestedContact | null = null;

  try {
    contact = await resolveSuggestedContact(request.user.org_id, title);
  } catch (err) {
    // Wider than the model call it replaced, which wrapped only the provider
    // and let a database failure escape as a 500. The contact query is now the
    // one thing here that can throw, and a convenience the operator never asked
    // for must not be able to fail their request — but the failure is logged
    // rather than lost.
    request.log.warn({ err }, 'suggest-contact failed; returning no suggestion');
  }

  reply.send({ data: { contact } });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const TasksController = {
  assignees,
  list,
  create,
  getById,
  update,
  complete,
  cancel,
  dueToday,
  suggestContact,
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
};
