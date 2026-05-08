import { Prisma, TaskStatus, TaskPriority } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';

type TaskStatusValue = 'pending' | 'in_progress' | 'done' | 'cancelled';
type TaskPriorityValue = 'low' | 'medium' | 'high' | 'urgent';

function isTaskStatus(v: unknown): v is TaskStatusValue {
  return v === 'pending' || v === 'in_progress' || v === 'done' || v === 'cancelled';
}

function isTaskPriority(v: unknown): v is TaskPriorityValue {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'urgent';
}

const taskInclude = {
  assignee: { select: { id: true, name: true } },
  contact: { select: { id: true, first_name: true, last_name: true } },
} as const;

registerTool(
  'get_tasks',
  'List tasks for the authenticated org with optional filters',
  {
    type: 'object',
    properties: {
      assigned_to: { type: 'string', description: 'Filter by assigned user UUID' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      contact_id: { type: 'string', description: 'Filter by contact UUID' },
      deal_id: { type: 'string', description: 'Filter by deal UUID' },
      due_before: { type: 'string', description: 'ISO 8601 upper bound for due_date' },
      due_after: { type: 'string', description: 'ISO 8601 lower bound for due_date' },
      q: { type: 'string', description: 'Search by task title' },
      page: { type: 'integer', default: 1 },
      per_page: { type: 'integer', default: 20, maximum: 100 },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;
    const status = isTaskStatus(args.status) ? args.status : undefined;
    const priority = isTaskPriority(args.priority) ? args.priority : undefined;
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : undefined;
    const deal_id = typeof args.deal_id === 'string' ? args.deal_id : undefined;
    const due_before = typeof args.due_before === 'string' ? args.due_before : undefined;
    const due_after = typeof args.due_after === 'string' ? args.due_after : undefined;
    const q = typeof args.q === 'string' ? args.q : undefined;
    const page = typeof args.page === 'number' ? Math.max(1, Math.floor(args.page)) : 1;
    const per_page = typeof args.per_page === 'number' ? Math.min(100, Math.max(1, Math.floor(args.per_page))) : 20;

    const where: Prisma.TaskWhereInput = {
      organization_id: user.org_id,
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

    const [tasks, total] = await Promise.all([
      db.task.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { due_date: 'asc' },
        include: taskInclude,
      }),
      db.task.count({ where }),
    ]);

    return { data: tasks, meta: { total, page, per_page } };
  },
);

registerTool(
  'get_task',
  'Get a single task by ID',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const task = await db.task.findFirst({
      where: { id, organization_id: user.org_id },
      include: taskInclude,
    });

    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } };
    }

    return { data: task };
  },
);

registerTool(
  'create_task',
  'Create a new task in the org',
  {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title' },
      assigned_to: { type: 'string', description: 'User UUID to assign the task to' },
      description: { type: 'string' },
      contact_id: { type: 'string', description: 'Contact UUID to link' },
      deal_id: { type: 'string', description: 'Deal UUID to link' },
      due_date: { type: 'string', description: 'Due date (ISO 8601)' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    },
    required: ['title', 'assigned_to'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const title = typeof args.title === 'string' ? args.title : '';
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : '';
    const description = typeof args.description === 'string' ? args.description : undefined;
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : undefined;
    const deal_id = typeof args.deal_id === 'string' ? args.deal_id : undefined;
    const due_date = typeof args.due_date === 'string' ? args.due_date : undefined;
    const priority = isTaskPriority(args.priority) ? args.priority : undefined;

    const task = await db.task.create({
      data: {
        title,
        assigned_to,
        description,
        contact_id,
        deal_id,
        due_date: due_date ? new Date(due_date) : undefined,
        priority,
        organization_id: user.org_id,
        created_by: user.sub,
      },
      include: taskInclude,
    });

    return { data: task };
  },
);

registerTool(
  'update_task',
  'Update fields on an existing task',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task UUID' },
      title: { type: 'string' },
      description: { type: 'string' },
      assigned_to: { type: 'string' },
      due_date: { type: 'string', description: 'ISO 8601 date' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const task = await db.task.findFirst({
      where: { id, organization_id: user.org_id },
    });

    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } };
    }

    if (task.status === TaskStatus.cancelled) {
      return { error: { code: 'TASK_CANCELLED', message: 'Cannot update a cancelled task' } };
    }

    const updateData: Prisma.TaskUncheckedUpdateInput = {};
    if (typeof args.title === 'string') updateData.title = args.title;
    if (typeof args.description === 'string') updateData.description = args.description;
    if (typeof args.assigned_to === 'string') updateData.assigned_to = args.assigned_to;
    if (typeof args.due_date === 'string') {
      updateData.due_date = args.due_date ? new Date(args.due_date) : null;
    }
    if (isTaskPriority(args.priority)) updateData.priority = args.priority;

    const updated = await db.task.update({
      where: { id },
      data: updateData,
      include: taskInclude,
    });

    return { data: updated };
  },
);

registerTool(
  'complete_task',
  'Toggle a task between done and pending (calling twice undoes completion)',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const task = await db.task.findFirst({
      where: { id, organization_id: user.org_id },
    });

    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } };
    }

    if (task.status === TaskStatus.cancelled) {
      return { error: { code: 'TASK_CANCELLED', message: 'Cannot complete a cancelled task' } };
    }

    const updated = await db.task.update({
      where: { id },
      data:
        task.status === TaskStatus.done
          ? { status: TaskStatus.pending, completed_at: null, completed_by: null }
          : { status: TaskStatus.done, completed_at: new Date(), completed_by: user.sub },
      include: taskInclude,
    });

    return { data: updated };
  },
);

registerTool(
  'get_overdue_tasks',
  'Get all overdue tasks for the org (due in the past, not yet done or cancelled)',
  {
    type: 'object',
    properties: {},
  },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const tasks = await db.task.findMany({
      where: {
        organization_id: user.org_id,
        status: { notIn: [TaskStatus.done, TaskStatus.cancelled] },
        due_date: { lt: new Date() },
      },
      include: taskInclude,
      orderBy: { due_date: 'asc' },
    });

    return { data: tasks, meta: {} };
  },
);
