import { FastifyRequest, FastifyReply } from 'fastify';
import { TaskPriority, TaskStatus, Prisma } from '@prisma/client';
import { db } from '../../services/db';

// ─── Local request types ──────────────────────────────────────────────────────

type ListQuery = {
  assigned_to?: string;
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

// ─── Handlers ────────────────────────────────────────────────────────────────

async function list(
  request: FastifyRequest<{ Querystring: ListQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const {
    assigned_to,
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
  } = request.query;

  const where: Prisma.TaskWhereInput = {
    organization_id: request.user.org_id,
    ...(status ? { status } : { status: { not: TaskStatus.cancelled } }),
    ...(priority && { priority }),
    ...(assigned_to && { assigned_to }),
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
  request: FastifyRequest<{ Body: CreateBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body;

  if (body.contact_id) {
    const contact = await db.contact.findFirst({
      where: { id: body.contact_id, organization_id: request.user.org_id },
    });
    if (!contact) {
      reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Contact does not belong to your organization' },
      });
      return;
    }
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

  reply.status(201).send({ data: task, meta: {} });
}

async function getById(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const task = await db.task.findFirst({
    where: { id, organization_id: request.user.org_id },
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
  request: FastifyRequest<{ Params: IdParams; Body: UpdateBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;
  const body = request.body;

  const task = await db.task.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  if (task.status === TaskStatus.cancelled) {
    reply.status(422).send({ error: { code: 'TASK_CANCELLED', message: 'Cannot update a cancelled task' } });
    return;
  }

  const updatedTask = await db.task.update({
    where: { id },
    data: {
      ...body,
      due_date: body.due_date ? new Date(body.due_date) : undefined,
      reminder_at: body.reminder_at ? new Date(body.reminder_at) : undefined,
    },
  });

  reply.send({ data: updatedTask, meta: {} });
}

async function complete(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const task = await db.task.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  if (task.status === TaskStatus.cancelled) {
    reply.status(422).send({ error: { code: 'TASK_CANCELLED', message: 'Cannot complete a cancelled task' } });
    return;
  }

  const updatedTask = await db.task.update({
    where: { id },
    data:
      task.status === TaskStatus.done
        ? { status: TaskStatus.pending, completed_at: null, completed_by: null }
        : { status: TaskStatus.done, completed_at: new Date(), completed_by: request.user.sub },
  });

  reply.send({ data: updatedTask, meta: {} });
}

async function startProgress(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const task = await db.task.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  if (task.status !== TaskStatus.pending) {
    reply.status(422).send({ error: { code: 'INVALID_STATUS_TRANSITION', message: 'Task must be pending to start' } });
    return;
  }

  const updatedTask = await db.task.update({
    where: { id },
    data: { status: TaskStatus.in_progress },
  });

  reply.send({ data: updatedTask, meta: {} });
}

async function cancel(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const task = await db.task.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!task) {
    reply.status(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    return;
  }

  const updatedTask = await db.task.update({
    where: { id },
    data: { status: TaskStatus.cancelled },
  });

  reply.send({ data: updatedTask, meta: {} });
}

async function dueToday(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  const tasks = await db.task.findMany({
    where: {
      organization_id: request.user.org_id,
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
  const tasks = await db.task.findMany({
    where: {
      organization_id: request.user.org_id,
      status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
      due_date: { lt: new Date() },
    },
  });

  reply.send({ data: tasks, meta: {} });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const TasksController = {
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
