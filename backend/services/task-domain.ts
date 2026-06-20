/**
 * task-domain.ts
 *
 * Shared domain logic for the tasks resource. Both the HTTP controller and the
 * MCP tools delegate to these functions so that visibility checks, org scoping,
 * and audit logging are applied consistently regardless of the calling path.
 */

import { Prisma, TaskStatus, TaskPriority, WorkflowTrigger } from '@prisma/client';
import { db } from './db';
import { paginate } from './db-paginate';
import { evaluateWorkflows } from './workflows';
import { logActivity } from '../api/controllers/activities';
import { dispatchNotification, taskCtx } from './notificationEngine';
import {
  getVisibleUserIds,
  getAccessibleUserIds,
  canSeeUser,
  type VisibilityScope,
  type Requester,
} from './visibility';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ListTasksFilters = {
  assigned_to?: string;
  scope?: VisibilityScope;
  status?: TaskStatus;
  priority?: TaskPriority;
  contact_id?: string;
  deal_id?: string;
  due_before?: string;
  due_after?: string;
  q?: string;
  page?: number;
  per_page?: number;
  sort?: 'due_date' | 'created_at' | 'priority' | 'title';
  order?: 'asc' | 'desc';
};

export type CreateTaskBody = {
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

export type UpdateTaskPatch = Partial<CreateTaskBody> & {
  // Status may be set directly via MCP's update_task.  The domain function
  // handles completed_at / completed_by bookkeeping when status changes to/from done.
  status?: TaskStatus;
};

export type DomainError =
  | { kind: 'not_found'; code: string; message: string }
  | { kind: 'forbidden'; code: string; message: string }
  | { kind: 'unprocessable'; code: string; message: string };

// ─── Internal helpers ─────────────────────────────────────────────────────────

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

/**
 * Translate the resolved visibility set + an optional explicit client filter
 * into a Prisma `assigned_to` where-condition.
 *
 * `null` visibleIds means owner/admin — no per-user restriction.
 * Requesting a user outside your cone yields `{ in: [] }` (zero rows).
 */
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

// ─── Domain functions ─────────────────────────────────────────────────────────

/**
 * List tasks that `requestingUser` is allowed to see, with optional filters and
 * pagination.  Applies the same role/hierarchy visibility as the HTTP controller.
 */
export async function listTasksForUser(
  orgId: string,
  requestingUser: Requester,
  filters: ListTasksFilters,
): Promise<{ data: Awaited<ReturnType<typeof db.task.findMany>>; total: number; page: number; per_page: number }> {
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
    page = 1,
    per_page = 20,
    sort = 'due_date',
    order = 'asc',
  } = filters;

  const visibleIds = await getVisibleUserIds(requestingUser, scope ?? 'direct');
  const assignedFilter = resolveAssignedFilter(visibleIds, assigned_to);

  const where: Prisma.TaskWhereInput = {
    organization_id: orgId,
    ...(status ? { status } : { status: { not: TaskStatus.cancelled } }),
    ...(priority && { priority }),
    ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
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

  const { data: tasks, total } = await paginate(
    () => db.task.count({ where }),
    () => db.task.findMany({
      where,
      skip,
      take,
      orderBy: [{ [sort]: order }],
    }),
  );

  return { data: tasks, total, page, per_page };
}

/**
 * Fetch a single task, enforcing visibility (returns null if the task is not
 * within the requester's cone or does not belong to the org).
 *
 * Callers decide what HTTP/MCP error to return on null.
 */
export async function getTaskForUser(
  taskId: string,
  orgId: string,
  requestingUser: Requester,
): Promise<Awaited<ReturnType<typeof db.task.findFirst>> | null> {
  const accessibleIds = await getAccessibleUserIds(requestingUser);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  return db.task.findFirst({
    where: {
      id: taskId,
      organization_id: orgId,
      ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
    },
    include: {
      assignee: { select: { id: true, name: true } },
      contact: { select: { id: true, first_name: true, last_name: true } },
    },
  });
}

/**
 * Create a task, enforcing:
 *   - assigned_to must be within the requester's cone
 *   - contact_id / deal_id must belong to the org
 *
 * Returns a DomainError if any check fails, otherwise the created task.
 */
export async function createTaskForUser(
  orgId: string,
  requestingUser: Requester,
  body: CreateTaskBody,
): Promise<{ ok: true; task: Awaited<ReturnType<typeof db.task.create>> } | { ok: false; error: DomainError }> {
  const accessibleIds = await getAccessibleUserIds(requestingUser);

  const [ownsAssignee, ownsContact, ownsDeal] = await Promise.all([
    body.assigned_to === requestingUser.sub
      ? Promise.resolve(true)
      : canSeeUser(accessibleIds, body.assigned_to)
        ? userBelongsToOrg(body.assigned_to, orgId)
        : Promise.resolve(false),
    body.contact_id
      ? contactBelongsToOrg(body.contact_id, orgId)
      : Promise.resolve(true),
    body.deal_id
      ? dealBelongsToOrg(body.deal_id, orgId)
      : Promise.resolve(true),
  ]);

  if (!ownsAssignee) {
    return {
      ok: false,
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Assigned user is outside your team' },
    };
  }

  if (!ownsContact) {
    return {
      ok: false,
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
    };
  }

  if (!ownsDeal) {
    return {
      ok: false,
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    };
  }

  const task = await db.task.create({
    data: {
      ...body,
      due_date: body.due_date ? new Date(body.due_date) : undefined,
      reminder_at: body.reminder_at ? new Date(body.reminder_at) : undefined,
      organization_id: orgId,
      created_by: requestingUser.sub,
    },
  });

  await evaluateWorkflows({
    organizationId: orgId,
    trigger: WorkflowTrigger.task_created,
    record: task as unknown as Record<string, unknown>,
    userId: requestingUser.sub,
    triggerRecordId: task.id,
  });

  void logActivity({
    organizationId: orgId,
    userId: requestingUser.sub,
    entityType: 'task',
    entityId: task.id,
    action: 'created',
  });

  void taskCtx(task.id).then((ctx) => {
    if (ctx) void dispatchNotification({ eventType: 'task.assigned', orgId, task: ctx });
  });

  return { ok: true, task };
}

/**
 * Update a task, enforcing:
 *   - task must be within requester's cone
 *   - task must not be cancelled
 *   - new assigned_to (if changed) must be within cone
 *   - contact_id / deal_id must belong to the org
 *
 * Returns a DomainError or the updated task.
 */
export async function updateTaskForUser(
  taskId: string,
  orgId: string,
  requestingUser: Requester,
  patch: UpdateTaskPatch,
): Promise<
  | { ok: true; task: Awaited<ReturnType<typeof db.task.findFirst>> & object }
  | { ok: false; error: DomainError }
> {
  const accessibleIds = await getAccessibleUserIds(requestingUser);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const existing = await db.task.findFirst({
    where: {
      id: taskId,
      organization_id: orgId,
      ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
    },
  });

  if (!existing) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  if (existing.status === TaskStatus.cancelled) {
    return {
      ok: false,
      error: { kind: 'unprocessable', code: 'TASK_CANCELLED', message: 'Cannot update a cancelled task' },
    };
  }

  const [ownsAssignee, ownsContact, ownsDeal] = await Promise.all([
    patch.assigned_to !== undefined && patch.assigned_to !== requestingUser.sub
      ? canSeeUser(accessibleIds, patch.assigned_to)
        ? userBelongsToOrg(patch.assigned_to, orgId)
        : Promise.resolve(false)
      : Promise.resolve(true),
    patch.contact_id !== undefined
      ? contactBelongsToOrg(patch.contact_id, orgId)
      : Promise.resolve(true),
    patch.deal_id !== undefined
      ? dealBelongsToOrg(patch.deal_id, orgId)
      : Promise.resolve(true),
  ]);

  if (!ownsAssignee) {
    return {
      ok: false,
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Assigned user is outside your team' },
    };
  }

  if (!ownsContact) {
    return {
      ok: false,
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
    };
  }

  if (!ownsDeal) {
    return {
      ok: false,
      error: { kind: 'forbidden', code: 'FORBIDDEN', message: 'Deal does not belong to your organization' },
    };
  }

  // Derive completion bookkeeping fields when status changes.
  const completionFields: Prisma.TaskUncheckedUpdateInput = {};
  if (patch.status === TaskStatus.done && existing.status !== TaskStatus.done) {
    completionFields.completed_at = new Date();
    completionFields.completed_by = requestingUser.sub;
  } else if (patch.status !== undefined && patch.status !== TaskStatus.done && existing.status === TaskStatus.done) {
    completionFields.completed_at = null;
    completionFields.completed_by = null;
  }

  const result = await db.task.updateMany({
    where: { id: taskId, organization_id: orgId, status: { not: TaskStatus.cancelled } },
    data: {
      ...patch,
      due_date: patch.due_date ? new Date(patch.due_date) : undefined,
      reminder_at: patch.reminder_at ? new Date(patch.reminder_at) : undefined,
      ...completionFields,
    },
  });

  if (result.count !== 1) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  const updated = await db.task.findFirst({ where: { id: taskId, organization_id: orgId } });
  if (!updated) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  // Fire task_completed workflow if status transitioned to done.
  if (updated.status === TaskStatus.done && existing.status !== TaskStatus.done) {
    void evaluateWorkflows({
      organizationId: orgId,
      trigger: WorkflowTrigger.task_completed,
      record: updated as unknown as Record<string, unknown>,
      userId: requestingUser.sub,
      triggerRecordId: updated.id,
    });
  }

  void logActivity({
    organizationId: orgId,
    userId: requestingUser.sub,
    entityType: 'task',
    entityId: updated.id,
    action: updated.status === TaskStatus.done && existing.status !== TaskStatus.done ? 'completed' : 'updated',
  });

  if (patch.assigned_to && patch.assigned_to !== existing.assigned_to) {
    void taskCtx(updated.id, requestingUser.sub).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'task.reassigned', orgId, task: ctx });
    });
  }

  return { ok: true, task: updated };
}

/**
 * Toggle a task between done and pending, enforcing visibility and cancelled-state guard.
 * Fires workflow evaluation and notifications on completion.
 */
export async function completeTaskForUser(
  taskId: string,
  orgId: string,
  requestingUser: Requester,
): Promise<
  | { ok: true; task: Awaited<ReturnType<typeof db.task.findFirst>> & object }
  | { ok: false; error: DomainError }
> {
  const accessibleIds = await getAccessibleUserIds(requestingUser);
  const assignedFilter = resolveAssignedFilter(accessibleIds, undefined);

  const existing = await db.task.findFirst({
    where: {
      id: taskId,
      organization_id: orgId,
      ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
    },
  });

  if (!existing) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  if (existing.status === TaskStatus.cancelled) {
    return {
      ok: false,
      error: { kind: 'unprocessable', code: 'TASK_CANCELLED', message: 'Cannot complete a cancelled task' },
    };
  }

  const result = await db.task.updateMany({
    where: { id: taskId, organization_id: orgId, status: { not: TaskStatus.cancelled } },
    data:
      existing.status === TaskStatus.done
        ? { status: TaskStatus.pending, completed_at: null, completed_by: null }
        : { status: TaskStatus.done, completed_at: new Date(), completed_by: requestingUser.sub },
  });

  if (result.count !== 1) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  const updated = await db.task.findFirst({ where: { id: taskId, organization_id: orgId } });
  if (!updated) {
    return { ok: false, error: { kind: 'not_found', code: 'TASK_NOT_FOUND', message: 'Task not found' } };
  }

  if (updated.status === TaskStatus.done && existing.status !== TaskStatus.done) {
    await evaluateWorkflows({
      organizationId: orgId,
      trigger: WorkflowTrigger.task_completed,
      record: updated as unknown as Record<string, unknown>,
      userId: requestingUser.sub,
      triggerRecordId: updated.id,
    });
  }

  void logActivity({
    organizationId: orgId,
    userId: requestingUser.sub,
    entityType: 'task',
    entityId: updated.id,
    action: updated.status === TaskStatus.done ? 'completed' : 'updated',
  });

  if (updated.status === TaskStatus.done && existing.status !== TaskStatus.done) {
    void taskCtx(updated.id).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'task.completed', orgId, task: ctx });
    });
  }

  return { ok: true, task: updated };
}

/**
 * Return overdue tasks (past due, not done/cancelled) visible to `requestingUser`.
 */
export async function getOverdueTasksForUser(
  orgId: string,
  requestingUser: Requester,
  scope?: VisibilityScope,
): Promise<Awaited<ReturnType<typeof db.task.findMany>>> {
  const visibleIds = await getVisibleUserIds(requestingUser, scope ?? 'direct');
  const assignedFilter = resolveAssignedFilter(visibleIds, undefined);

  return db.task.findMany({
    where: {
      organization_id: orgId,
      ...(assignedFilter !== undefined && { assigned_to: assignedFilter }),
      status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
      due_date: { lt: new Date() },
    },
    include: {
      assignee: { select: { id: true, name: true } },
      contact: { select: { id: true, first_name: true, last_name: true } },
    },
    orderBy: { due_date: 'asc' },
  });
}
