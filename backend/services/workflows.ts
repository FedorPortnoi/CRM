import {
  MessageChannel,
  MessageDirection,
  MessageStatus,
  Prisma,
  TaskPriority,
  TaskStatus,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowTrigger,
} from '@prisma/client';
import { db } from './db';
import { userBelongsToOrg } from './db-guards';

type WorkflowContext = {
  organizationId: string;
  trigger: WorkflowTrigger;
  record: Record<string, unknown>;
  userId?: string | null;
  triggerRecordId?: string | null;
  dedupeByTriggerRecord?: boolean;
};

type WorkflowCondition = {
  field: string;
  operator?: 'equals' | 'not_equals' | 'contains' | 'exists';
  value?: unknown;
};

type WorkflowAction = {
  type: 'create_task' | 'add_contact_note' | 'update_deal_stage';
  title?: string;
  body?: string;
  field?: string;
  stage_id?: string;
  due_in_days?: number;
  assigned_to?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
};

type ActiveWorkflow = Awaited<ReturnType<typeof db.workflow.findMany>>[number];
type WorkflowActionValidationError = {
  code: 'INVALID_WORKFLOW_ACTION';
  message: string;
};

const WORKFLOW_CACHE_TTL_MS = 30000;
const activeWorkflowCache = new Map<string, { expiresAt: number; workflows: ActiveWorkflow[] }>();

function workflowCacheKey(organizationId: string, trigger: WorkflowTrigger): string {
  return `${organizationId}:${trigger}`;
}

export function invalidateWorkflowCache(organizationId: string): void {
  const prefix = `${organizationId}:`;
  for (const key of activeWorkflowCache.keys()) {
    if (key.startsWith(prefix)) {
      activeWorkflowCache.delete(key);
    }
  }
}

async function getActiveWorkflows(organizationId: string, trigger: WorkflowTrigger): Promise<ActiveWorkflow[]> {
  const key = workflowCacheKey(organizationId, trigger);
  const cached = activeWorkflowCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.workflows;
  }

  const workflows = await db.workflow.findMany({
    where: {
      organization_id: organizationId,
      trigger,
      status: WorkflowStatus.active,
    },
  });

  activeWorkflowCache.set(key, { expiresAt: now + WORKFLOW_CACHE_TTL_MS, workflows });
  return workflows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

// Fields an admin may reference in workflow action templates.
// Dot-notation paths are intentionally rejected — they would allow
// traversal into sensitive nested properties (e.g. assigned_to.password_hash).
const INTERPOLATION_ALLOWLIST = new Set([
  'first_name', 'last_name', 'company', 'source', 'notes', 'status', 'type',
  'title', 'value', 'currency', 'description', 'priority', 'name', 'tags', 'due_date',
]);

function readField(record: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    const currentRecord = asRecord(current);
    return currentRecord ? currentRecord[key] : undefined;
  }, record);
}

function matchesCondition(record: Record<string, unknown>, condition: WorkflowCondition): boolean {
  const operator = condition.operator ?? 'equals';
  const actual = readField(record, condition.field);

  if (operator === 'exists') {
    return actual !== undefined && actual !== null && actual !== '';
  }

  if (operator === 'contains') {
    return String(actual ?? '').toLowerCase().includes(String(condition.value ?? '').toLowerCase());
  }

  if (operator === 'not_equals') {
    return String(actual ?? '') !== String(condition.value ?? '');
  }

  return String(actual ?? '') === String(condition.value ?? '');
}

function workflowMatches(record: Record<string, unknown>, rawConditions: Prisma.JsonValue | null): boolean {
  if (!rawConditions) return true;

  const conditionRecord = asRecord(rawConditions);
  const conditions = asArray<WorkflowCondition>(
    Array.isArray(rawConditions) ? rawConditions : conditionRecord?.all,
  );

  return conditions.every((condition) =>
    typeof condition.field === 'string' && matchesCondition(record, condition),
  );
}

function interpolate(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    if (path.includes('.') || !INTERPOLATION_ALLOWLIST.has(path)) return '';
    const value = record[path];
    return value === undefined || value === null ? '' : String(value);
  }).trim();
}

function dateFromOffset(days: number | undefined): Date | undefined {
  if (days === undefined) return undefined;
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

async function resolveOrganizationUser(
  userId: string | null | undefined,
  organizationId: string,
): Promise<string | null> {
  if (!userId) return null;
  return await userBelongsToOrg(userId, organizationId) ? userId : null;
}

async function resolveTaskAssignee(action: WorkflowAction, context: WorkflowContext): Promise<string> {
  if (action.assigned_to && await userBelongsToOrg(action.assigned_to, context.organizationId)) {
    return action.assigned_to;
  }

  const contextUserId = await resolveOrganizationUser(context.userId, context.organizationId);
  if (contextUserId) {
    return contextUserId;
  }

  throw new Error('Workflow task assignee does not belong to this organization');
}

async function targetStageBelongsToDealPipeline(
  stageId: string,
  pipelineId: string | null,
  organizationId: string,
): Promise<boolean> {
  const stage = await db.pipelineStage.findFirst({
    where: {
      id: stageId,
      pipeline: {
        organization_id: organizationId,
        ...(pipelineId ? { id: pipelineId } : {}),
      },
    },
    select: { id: true },
  });

  return stage !== null;
}

export async function validateWorkflowActionsForOrganization(
  organizationId: string,
  rawActions: unknown,
): Promise<WorkflowActionValidationError | null> {
  const actions = asArray<WorkflowAction>(rawActions);
  const stageIds = new Set<string>();
  const assigneeIds = new Set<string>();

  for (const [index, action] of actions.entries()) {
    if (action.type === 'update_deal_stage' && !action.stage_id) {
      return {
        code: 'INVALID_WORKFLOW_ACTION',
        message: `actions[${index}].stage_id is required for update_deal_stage`,
      };
    }

    if (action.stage_id) {
      stageIds.add(action.stage_id);
    }

    if (action.type === 'create_task' && action.assigned_to) {
      assigneeIds.add(action.assigned_to);
    }
  }

  if (stageIds.size > 0) {
    const stages = await db.pipelineStage.findMany({
      where: {
        id: { in: [...stageIds] },
        pipeline: { organization_id: organizationId },
      },
      select: { id: true },
    });
    const validStageIds = new Set(stages.map((stage) => stage.id));
    const invalidStageId = [...stageIds].find((stageId) => !validStageIds.has(stageId));

    if (invalidStageId) {
      return {
        code: 'INVALID_WORKFLOW_ACTION',
        message: `Workflow stage ${invalidStageId} does not belong to this organization`,
      };
    }
  }

  if (assigneeIds.size > 0) {
    const users = await db.user.findMany({
      where: {
        id: { in: [...assigneeIds] },
        organization_id: organizationId,
      },
      select: { id: true },
    });
    const validAssigneeIds = new Set(users.map((user) => user.id));
    const invalidAssigneeId = [...assigneeIds].find((assigneeId) => !validAssigneeIds.has(assigneeId));

    if (invalidAssigneeId) {
      return {
        code: 'INVALID_WORKFLOW_ACTION',
        message: `Workflow assignee ${invalidAssigneeId} does not belong to this organization`,
      };
    }
  }

  return null;
}

async function executeAction(
  action: WorkflowAction,
  context: WorkflowContext,
  record: Record<string, unknown>,
): Promise<void> {
  if (action.type === 'create_task') {
    const contactId = typeof record.contact_id === 'string'
      ? record.contact_id
      : typeof record.id === 'string' && context.trigger === WorkflowTrigger.contact_created
        ? record.id
        : undefined;

    await db.task.create({
      data: {
        organization_id: context.organizationId,
        title: interpolate(action.title ?? 'Follow up', record),
        description: action.body ? interpolate(action.body, record) : undefined,
        contact_id: contactId,
        assigned_to: await resolveTaskAssignee(action, context),
        created_by: await resolveOrganizationUser(context.userId, context.organizationId) ?? undefined,
        due_date: dateFromOffset(action.due_in_days),
        priority: (action.priority ?? 'medium') as TaskPriority,
        status: TaskStatus.pending,
      },
    });
    return;
  }

  if (action.type === 'add_contact_note') {
    const contactId = typeof record.contact_id === 'string'
      ? record.contact_id
      : typeof record.id === 'string' && context.trigger === WorkflowTrigger.contact_created
        ? record.id
        : undefined;

    if (!contactId) return;

    await db.message.create({
      data: {
        organization_id: context.organizationId,
        contact_id: contactId,
        user_id: context.userId ?? undefined,
        direction: MessageDirection.outbound,
        channel: MessageChannel.in_app,
        body: interpolate(action.body ?? 'Workflow note', record),
        status: MessageStatus.delivered,
      },
    });
    return;
  }

  if (action.type === 'update_deal_stage') {
    const dealId = typeof record.id === 'string' ? record.id : undefined;
    if (!dealId || !action.stage_id) return;

    const deal = await db.deal.findFirst({
      where: { id: dealId, organization_id: context.organizationId },
      select: { id: true, pipeline_id: true },
    });

    if (!deal) return;

    const stageMatchesDeal = await targetStageBelongsToDealPipeline(
      action.stage_id,
      deal.pipeline_id,
      context.organizationId,
    );

    if (!stageMatchesDeal) {
      throw new Error('Workflow target stage does not belong to this deal pipeline');
    }

    await db.deal.updateMany({
      where: { id: dealId, organization_id: context.organizationId },
      data: { stage_id: action.stage_id, stage_entered_at: new Date() },
    });
  }
}

export async function evaluateWorkflows(context: WorkflowContext): Promise<void> {
  const workflows = await getActiveWorkflows(context.organizationId, context.trigger);

  for (const workflow of workflows) {
    try {
      if (context.dedupeByTriggerRecord && context.triggerRecordId) {
        const existingRun = await db.workflowRun.findFirst({
          where: {
            workflow_id: workflow.id,
            organization_id: context.organizationId,
            trigger_record_id: context.triggerRecordId,
          },
          select: { id: true },
        });

        if (existingRun) {
          continue;
        }
      }

      if (!workflowMatches(context.record, workflow.conditions)) {
        continue;
      }

      const actions = asArray<WorkflowAction>(workflow.actions);
      for (const action of actions) {
        await executeAction(action, context, context.record);
      }

      await db.workflowRun.create({
        data: {
          workflow_id: workflow.id,
          organization_id: context.organizationId,
          trigger_record_id: context.triggerRecordId,
          status: WorkflowRunStatus.success,
        },
      });
    } catch (error) {
      await db.workflowRun.create({
        data: {
          workflow_id: workflow.id,
          organization_id: context.organizationId,
          trigger_record_id: context.triggerRecordId,
          status: WorkflowRunStatus.failed,
          error_message: error instanceof Error ? error.message : 'Unknown workflow error',
        },
      });
    }
  }
}
