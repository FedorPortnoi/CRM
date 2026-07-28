import { FastifyRequest, FastifyReply } from 'fastify';
import { TaskPriority, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';
import { createCompletion, isYandexGptConfigured } from '../../services/yandex-gpt';
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

// ─── Contact suggestion for a task title ─────────────────────────────────────

/** How many candidate contacts are put in front of the model. */
const SUGGEST_CONTACT_LIMIT = 300;

/** The only useful reply is one UUID or the word "none" — nothing longer. */
const SUGGEST_CONTACT_MAX_TOKENS = 50;

/** An extraction, not a piece of writing: no reason to sample. */
const SUGGEST_CONTACT_TEMPERATURE = 0;

/**
 * Deliberately far below the client's 30s default. The operator is typing a
 * task title while this runs and every failure is a silent `null`, so waiting
 * longer buys a suggestion nobody is still looking at.
 */
const SUGGEST_CONTACT_TIMEOUT_MS = 10_000;

const SUGGEST_CONTACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUGGEST_CONTACT_SYSTEM_PROMPT = [
  'Ты сопоставляешь заголовок задачи в CRM со списком контактов.',
  'Если в заголовке явно назван один из контактов — ответь РОВНО его UUID из списка.',
  'Если явного совпадения нет — ответь одним словом none.',
  'Никакого другого текста, пояснений и знаков препинания.',
].join('\n');

type SuggestedContact = { id: string; first_name: string; last_name: string | null };

/**
 * Adapter onto backend/services/yandex-gpt — the same `createCompletion` seam
 * the assistant and contact-ai.ts use, and the single provider client in the
 * backend.
 *
 * This endpoint previously built its own Anthropic client and posted up to 300
 * Russian customers' full names to api.anthropic.com on every call: a ст. 12
 * ФЗ-152 cross-border transfer with no filing behind it.
 *
 * Routing it here closes THAT transfer, because Yandex is domestic. It does not
 * make the exposure disappear. The same 300 names are still in the prompt, and
 * Wave A repoints yandex-gpt.ts at OpenAI through workers/openai-proxy — at
 * which point they cross the border again with no change to this file. Whether
 * contact names may reach a model at all is an open decision the owner has not
 * made (contact-ai.ts already sends them deliberately); this endpoint is now in
 * that same bucket rather than outside it.
 *
 * Returns `null` for every failure: the client cannot distinguish "no match"
 * from "no model", and nothing about an unrequested suggestion is worth
 * surfacing to the operator.
 */
async function resolveSuggestedContact(
  orgId: string,
  title: string,
): Promise<SuggestedContact | null> {
  // Checked before the query: with no provider configured there is nobody to
  // ask, and reading 300 contacts only to drop them is pure waste.
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

  if (contacts.length === 0) {
    return null;
  }

  const contactList = contacts
    .map((c) => `${c.id}: ${c.first_name}${c.last_name ? ' ' + c.last_name : ''}`)
    .join('\n');

  const result = await createCompletion({
    messages: [
      { role: 'system', text: SUGGEST_CONTACT_SYSTEM_PROMPT },
      { role: 'user', text: `Задача: "${title}"\nКонтакты:\n${contactList}` },
    ],
    temperature: SUGGEST_CONTACT_TEMPERATURE,
    max_tokens: SUGGEST_CONTACT_MAX_TOKENS,
    timeout_ms: SUGGEST_CONTACT_TIMEOUT_MS,
  });

  if (!result.ok) {
    return null;
  }

  // Strict on purpose: a bare UUID or nothing. A model that wraps the id in
  // prose is a model that is guessing, and a wrong contact silently attached to
  // a task is worse than no suggestion.
  const text = (result.message.text ?? '').trim();
  if (!SUGGEST_CONTACT_UUID_RE.test(text)) {
    return null;
  }

  return contacts.find((c) => c.id === text) ?? null;
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
    // Widened from the Anthropic version, which caught only around the model
    // call and let a database failure escape as a 500. A convenience the
    // operator never asked for must not be able to fail their request — but the
    // failure is logged rather than lost.
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
};
