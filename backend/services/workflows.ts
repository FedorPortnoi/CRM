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

type WorkflowContext = {
  organizationId: string;
  trigger: WorkflowTrigger;
  record: Record<string, unknown>;
  userId?: string | null;
  triggerRecordId?: string | null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

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
    const value = readField(record, path);
    return value === undefined || value === null ? '' : String(value);
  }).trim();
}

function dateFromOffset(days: number | undefined): Date | undefined {
  if (days === undefined) return undefined;
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + days);
  return due;
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
        assigned_to: action.assigned_to ?? context.userId ?? '',
        created_by: context.userId ?? undefined,
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

    await db.deal.updateMany({
      where: { id: dealId, organization_id: context.organizationId },
      data: { stage_id: action.stage_id },
    });
  }
}

export async function evaluateWorkflows(context: WorkflowContext): Promise<void> {
  const workflows = await db.workflow.findMany({
    where: {
      organization_id: context.organizationId,
      trigger: context.trigger,
      status: WorkflowStatus.active,
    },
  });

  for (const workflow of workflows) {
    try {
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
