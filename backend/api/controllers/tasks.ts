import { FastifyRequest, FastifyReply } from 'fastify';
import { TaskPriority, TaskStatus, Prisma, WorkflowTrigger } from '@prisma/client';
import { db } from '../../services/db';
import { evaluateWorkflows } from '../../services/workflows';
import { logActivity } from './activities';
import { dispatchNotification, taskCtx } from '../../services/notificationEngine';
import {
  getVisibleUserIds,
  getAccessibleUserIds,
  canSeeUser,
  type VisibilityScope,
} from '../../services/visibility';

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

type CreateBody = {
  title: string;
  description?: string;
  contact_id?: string;
  deal_id?: string;
  assigned_to: string;
  due_date?: string;
  priority?: TaskPriority;
  is_recurring?: boolean;
  recurrence_rule?: string;
  reminder_at?: string;
};

type UpdateBody = Partial<CreateBody>;

type IdParams = { id: string };

async function userBelongsToOrg(userId: string, orgId: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, organization_id: orgId, is_active: true },
    select: { id: true },
  });
  return user !== null;
}

async function contactBelongsToOrg(contactId: string, orgId: string): Promise<boolean> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    select: { id: true },
  });

  return contact !== null;
}

async function dealBelongsToOrg(dealId: string, orgId: string): Promise<boolean> {
  const deal = await db.deal.findFirst({
    where: { id: dealId, organization_id: orgId },
    select: { id: true },
  });

  return deal !== null;
}

// Translate a resolved visibility set (+ optional explicit client filter) into a
// Prisma `assigned_to` where-condition. A `null` set means owner/admin — no
// per-user restriction. Asking for someone outside your cone yields no rows.
function resolveAssignedFilter(
  visibleIds: string[] | null,
  requested?: string,
): Prisma.TaskWhereInput['assigned_to'] {
  if (visibleIds === null) {
    return requested ?? undefined;
  }
  if (requested) {
    return visibleIds.includes(requested) ? requested : { in: [] };
  }
  return { in: visibleIds };
}

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

  // Role/hierarchy visibility: owner/admin → whole org; everyone else → self +
  // reports at the requested depth ('direct' = one level down, the default).
  const visibleIds = await getVisibleUserIds(request.user, scope ?? 'direct');
  const assignedFilter = resolveAssignedFilter(visibleIds, assigned_to);

  const where: Prisma.TaskWhereInput = {
    organization_id: request.user.org_id,
    ...(status ? { status } : { status: { not: TaskStatus.cancelled } }),
    ...(priority && { priority }),
    ...(assignedFilter && { assigned_to: assignedFilter }),
    ...(contact_id && { contact_id }),
    ...(deal_id && { deal_id }),
    ...(q && { title: { contains: q, mode: 'insensitive' } }),
    ...((due_before || due_after) && {
      due_date: {
        ...(due_before && { lt: new Date(due_before) }),
        ...(due_after && { gte: new Date(due_after) }),
      },
    }),
  };

  const skip = (page - 1) * per_page;
  const take = per_page;

  const [tasks, total] = await Promise.all([
    db.task.findMany({
      where,
      skip,
      take,
      orderBy: [{ [sort]: order }],
    }),
    db.task.count({ where }),
  ]);

  reply.send({ data: tasks, meta: { total, page, per_page } });
}

async function create(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as CreateBody;

  // You may only assign to yourself or someone inside your cone (subtree).
  const accessibleIds = await getAccessibleUserIds(request.user);

  const [ownsAssignee, ownsContact, ownsDeal] = await Promise.all([
    body.assigned_to === request.user.sub
      ? Promise.resolve(true)
      : canSeeUser(accessibleIds, body.assigned_to)
        ? userBelongsToOrg(body.assigned_to, request.user.org_id)
        : Promise.resolve(false),
    body.contact_id
      ? contactBelongsToOrg(body.contact_id, request.user.org_id)
      : Promise.resolve(true),
    body.deal_id
      ? dealBelongsToOrg(body.deal_id, request.user.org_id)
      : Promise.resolve(true),
  ]);

  if (!ownsAssignee) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Assigned user is outside your team' },
    });
    return;
  }

  if (!ownsContact) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
    });
    return;
  }

  if (!ownsDeal) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    });
    return;
  }

  const task = await db.task.create({
    data: {
      ...body,
      due_date: body.due_date ? new Date(body.due_date) : undefined,
      reminder_at: body.reminder_at ? new Date(body.reminder_at) : undefined,
      organization_id: request.user.org_id,
      created_by: request.user.sub,
    },
  });

  await evaluateWorkflows({
    organizationId: request.user.org_id,
    trigger: WorkflowTrigger.task_created,
    record: task as unknown as Record<string, unknown>,
    userId: request.user.sub,
    triggerRecordId: task.id,
  });

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'task', entityId: task.id, action: 'created' });

  void taskCtx(task.id).then((ctx) => {
    if (ctx) void dispatchNotification({ eventType: 'task.assigned', orgId: request.user.org_id, task: ctx });
  });

  reply.status(201).send({ data: task, meta: {} });
}

async function getById(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  // Gate access to the requester's cone; out-of-cone tasks read as "not found".
  const accessibleIds = await getAccessibleUserIds(request.user);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const task = await db.task.findFirst({
    where: {
      id,
      organization_id: request.user.org_id,
      ...(assignedFilter && { assigned_to: assignedFilter }),
    },
    include: {
      assignee: { select: { id: true, name: true } },
      contact: { select: { id: true, first_name: true, last_name: true } },
    },
  });

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
  const body = request.body as UpdateBody;
  const orgId = request.user.org_id;

  const accessibleIds = await getAccessibleUserIds(request.user);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const task = await db.task.findFirst({
    where: {
      id,
      organization_id: orgId,
      ...(assignedFilter && { assigned_to: assignedFilter }),
    },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  if (task.status === TaskStatus.cancelled) {
    reply.status(422).send({ error: { code: 'TASK_CANCELLED', message: 'Cannot update a cancelled task' } });
    return;
  }

  const [ownsAssignee, ownsContact, ownsDeal] = await Promise.all([
    body.assigned_to !== undefined && body.assigned_to !== request.user.sub
      ? canSeeUser(accessibleIds, body.assigned_to)
        ? userBelongsToOrg(body.assigned_to, request.user.org_id)
        : Promise.resolve(false)
      : Promise.resolve(true),
    body.contact_id !== undefined
      ? contactBelongsToOrg(body.contact_id, orgId)
      : Promise.resolve(true),
    body.deal_id !== undefined
      ? dealBelongsToOrg(body.deal_id, orgId)
      : Promise.resolve(true),
  ]);

  if (!ownsAssignee) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Assigned user is outside your team' },
    });
    return;
  }

  if (!ownsContact) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
    });
    return;
  }

  if (!ownsDeal) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    });
    return;
  }

  const result = await db.task.updateMany({
    where: { id, organization_id: orgId, status: { not: TaskStatus.cancelled } },
    data: {
      ...body,
      due_date: body.due_date ? new Date(body.due_date) : undefined,
      reminder_at: body.reminder_at ? new Date(body.reminder_at) : undefined,
    },
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

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'task', entityId: updatedTask.id, action: 'updated' });

  if (body.assigned_to && body.assigned_to !== task.assigned_to) {
    void taskCtx(updatedTask.id).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'task.reassigned', orgId: request.user.org_id, task: ctx });
    });
  }

  reply.send({ data: updatedTask, meta: {} });
}

async function complete(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const accessibleIds = await getAccessibleUserIds(request.user);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const task = await db.task.findFirst({
    where: {
      id,
      organization_id: orgId,
      ...(assignedFilter && { assigned_to: assignedFilter }),
    },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  if (task.status === TaskStatus.cancelled) {
    reply.status(422).send({ error: { code: 'TASK_CANCELLED', message: 'Cannot complete a cancelled task' } });
    return;
  }

  const result = await db.task.updateMany({
    where: { id, organization_id: orgId, status: { not: TaskStatus.cancelled } },
    data:
      task.status === TaskStatus.done
        ? { status: TaskStatus.pending, completed_at: null, completed_by: null }
        : { status: TaskStatus.done, completed_at: new Date(), completed_by: request.user.sub },
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

  if (updatedTask.status === TaskStatus.done && task.status !== TaskStatus.done) {
    await evaluateWorkflows({
      organizationId: request.user.org_id,
      trigger: WorkflowTrigger.task_completed,
      record: updatedTask as unknown as Record<string, unknown>,
      userId: request.user.sub,
      triggerRecordId: updatedTask.id,
    });
  }

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'task', entityId: updatedTask.id, action: updatedTask.status === TaskStatus.done ? 'completed' : 'updated' });

  if (updatedTask.status === TaskStatus.done && task.status !== TaskStatus.done) {
    void taskCtx(updatedTask.id).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'task.completed', orgId: request.user.org_id, task: ctx });
    });
  }

  reply.send({ data: updatedTask, meta: {} });
}

async function startProgress(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const accessibleIds = await getAccessibleUserIds(request.user);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const task = await db.task.findFirst({
    where: {
      id,
      organization_id: orgId,
      ...(assignedFilter && { assigned_to: assignedFilter }),
    },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  if (task.status !== TaskStatus.pending) {
    reply.status(422).send({ error: { code: 'INVALID_STATUS_TRANSITION', message: 'Task must be pending to start' } });
    return;
  }

  const result = await db.task.updateMany({
    where: { id, organization_id: orgId, status: TaskStatus.pending },
    data: { status: TaskStatus.in_progress },
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

async function cancel(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const orgId = request.user.org_id;

  const accessibleIds = await getAccessibleUserIds(request.user);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const task = await db.task.findFirst({
    where: {
      id,
      organization_id: orgId,
      ...(assignedFilter && { assigned_to: assignedFilter }),
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
  const assignedFilter = resolveAssignedFilter(visibleIds, undefined);

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  const tasks = await db.task.findMany({
    where: {
      organization_id: request.user.org_id,
      ...(assignedFilter && { assigned_to: assignedFilter }),
      status: { notIn: [TaskStatus.cancelled, TaskStatus.done] },
      due_date: { gte: startOfDay, lt: endOfDay },
    },
  });

  reply.send({ data: tasks, meta: {} });
}

async function overdue(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { scope } = request.query as { scope?: VisibilityScope };
  const visibleIds = await getVisibleUserIds(request.user, scope ?? 'direct');
  const assignedFilter = resolveAssignedFilter(visibleIds, undefined);

  const tasks = await db.task.findMany({
    where: {
      organization_id: request.user.org_id,
      ...(assignedFilter && { assigned_to: assignedFilter }),
      status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
      due_date: { lt: new Date() },
    },
  });

  reply.send({ data: tasks, meta: {} });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const TasksController = {
  assignees,
  list,
  create,
  getById,
  update,
  complete,
  startProgress,
  cancel,
  dueToday,
  overdue,
};
