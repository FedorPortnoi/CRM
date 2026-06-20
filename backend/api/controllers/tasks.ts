import { FastifyRequest, FastifyReply } from 'fastify';
import { TaskPriority, TaskStatus } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../../services/db';
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

async function suggestContact(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { title } = request.body as { title: string };
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    reply.send({ data: { contact: null } });
    return;
  }

  const contacts = await db.contact.findMany({
    where: {
      organization_id: request.user.org_id,
      status: { not: 'archived' },
    },
    select: { id: true, first_name: true, last_name: true },
    take: 300,
    orderBy: { first_name: 'asc' },
  });

  if (contacts.length === 0) {
    reply.send({ data: { contact: null } });
    return;
  }

  const contactList = contacts
    .map((c) => `${c.id}: ${c.first_name}${c.last_name ? ' ' + c.last_name : ''}`)
    .join('\n');

  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Task: "${title}"\nContacts:\n${contactList}\n\nWhich contact ID is clearly referenced in the task title? Reply with ONLY the UUID, or "none". No other text.`,
      }],
    });

    const text = (message.content[0] as { type: 'text'; text: string }).text.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuidRegex.test(text)) {
      reply.send({ data: { contact: null } });
      return;
    }

    const match = contacts.find((c) => c.id === text);
    reply.send({ data: { contact: match ?? null } });
  } catch {
    reply.send({ data: { contact: null } });
  }
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
