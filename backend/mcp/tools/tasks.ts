import { TaskStatus } from '@prisma/client';
import { registerTool, McpUser } from '../server';
import { requireMcpWrite } from '../validation';
import {
  listTasksForUser,
  getTaskForUser,
  createTaskForUser,
  updateTaskForUser,
  completeTaskForUser,
  getOverdueTasksForUser,
} from '../../services/task-domain';
import type { Requester } from '../../services/visibility';

// McpUser.role is `string` from the JWT; the domain functions accept the
// narrower Requester type.  Cast once here so we don't sprinkle it everywhere.
function toRequester(user: McpUser): Requester {
  return {
    sub: user.sub,
    org_id: user.org_id,
    role: user.role as Requester['role'],
  };
}

type TaskStatusValue = 'pending' | 'in_progress' | 'done' | 'cancelled';
type TaskPriorityValue = 'low' | 'medium' | 'high' | 'urgent';

function isTaskStatus(v: unknown): v is TaskStatusValue {
  return v === 'pending' || v === 'in_progress' || v === 'done' || v === 'cancelled';
}

function isTaskPriority(v: unknown): v is TaskPriorityValue {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'urgent';
}

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

    const { data, total } = await listTasksForUser(
      user.org_id,
      toRequester(user),
      { assigned_to, status: status as TaskStatusValue | undefined, priority: priority as TaskPriorityValue | undefined, contact_id, deal_id, due_before, due_after, q, page, per_page },
    );

    return { data, meta: { total, page, per_page } };
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

    const task = await getTaskForUser(id, user.org_id, toRequester(user));

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
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const title = typeof args.title === 'string' ? args.title : '';
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : '';
    const description = typeof args.description === 'string' ? args.description : undefined;
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : undefined;
    const deal_id = typeof args.deal_id === 'string' ? args.deal_id : undefined;
    const due_date = typeof args.due_date === 'string' ? args.due_date : undefined;
    const priority = isTaskPriority(args.priority) ? args.priority : undefined;

    const result = await createTaskForUser(user.org_id, toRequester(user), {
      title,
      assigned_to,
      description,
      contact_id,
      deal_id,
      due_date,
      priority: priority as TaskPriorityValue | undefined,
    });

    if (!result.ok) {
      return { error: { code: result.error.code, message: result.error.message } };
    }

    return { data: result.task };
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
      status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    // Build the patch from only the fields that were explicitly provided.
    const patch: Record<string, unknown> = {};
    if (typeof args.title === 'string') patch.title = args.title;
    if (typeof args.description === 'string') patch.description = args.description;
    if (typeof args.assigned_to === 'string') patch.assigned_to = args.assigned_to;
    if (typeof args.due_date === 'string') patch.due_date = args.due_date;
    if (isTaskPriority(args.priority)) patch.priority = args.priority;
    // Note: update_task in the MCP can accept a status change directly (unlike
    // the HTTP path which uses dedicated endpoints for complete/cancel/start).
    // We honour it here but the domain service blocks updating cancelled tasks.
    if (isTaskStatus(args.status)) patch.status = args.status;

    const result = await updateTaskForUser(id, user.org_id, toRequester(user), patch as Parameters<typeof updateTaskForUser>[3]);

    if (!result.ok) {
      return { error: { code: result.error.code, message: result.error.message } };
    }

    return { data: result.task };
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
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    const result = await completeTaskForUser(id, user.org_id, toRequester(user));

    if (!result.ok) {
      return { error: { code: result.error.code, message: result.error.message } };
    }

    return { data: result.task };
  },
);

registerTool(
  'get_overdue_tasks',
  'Get all overdue tasks visible to the caller (due in the past, not yet done or cancelled)',
  {
    type: 'object',
    properties: {},
  },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const tasks = await getOverdueTasksForUser(user.org_id, toRequester(user));

    return { data: tasks, meta: {} };
  },
);

// Re-export the TaskStatus enum value for any code that imports from this module.
export { TaskStatus };
