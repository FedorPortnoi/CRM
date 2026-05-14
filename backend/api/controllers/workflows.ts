import { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma, WorkflowStatus } from '@prisma/client';
import { db } from '../../services/db';

type ListQuery = {
  status?: WorkflowStatus;
  trigger?: 'contact_created' | 'deal_stage_changed' | 'task_completed';
};

type WorkflowBody = {
  name: string;
  description?: string;
  trigger: 'contact_created' | 'deal_stage_changed' | 'task_completed';
  conditions?: Prisma.InputJsonValue;
  actions: Prisma.InputJsonValue;
  status?: WorkflowStatus;
};

type WorkflowUpdateBody = Partial<WorkflowBody>;

type IdParams = { id: string };

async function list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { status, trigger } = request.query as ListQuery;

  const workflows = await db.workflow.findMany({
    where: {
      organization_id: request.user.org_id,
      status: status ?? { not: WorkflowStatus.archived },
      ...(trigger ? { trigger } : {}),
    },
    orderBy: { created_at: 'desc' },
    include: {
      _count: { select: { runs: true } },
    },
  });

  reply.send({ data: workflows, meta: { total: workflows.length } });
}

async function create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as WorkflowBody;

  const workflow = await db.workflow.create({
    data: {
      organization_id: request.user.org_id,
      name: body.name,
      description: body.description,
      trigger: body.trigger,
      conditions: body.conditions,
      actions: body.actions,
      status: body.status ?? WorkflowStatus.active,
      created_by: request.user.sub,
    },
  });

  reply.status(201).send({ data: workflow, meta: {} });
}

async function getById(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  const workflow = await db.workflow.findFirst({
    where: { id, organization_id: request.user.org_id },
    include: {
      runs: { orderBy: { created_at: 'desc' }, take: 20 },
    },
  });

  if (!workflow) {
    reply.status(404).send({ error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } });
    return;
  }

  reply.send({ data: workflow, meta: {} });
}

async function update(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;
  const body = request.body as WorkflowUpdateBody;

  const existing = await db.workflow.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!existing) {
    reply.status(404).send({ error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } });
    return;
  }

  const workflow = await db.workflow.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.trigger !== undefined && { trigger: body.trigger }),
      ...(body.conditions !== undefined && { conditions: body.conditions }),
      ...(body.actions !== undefined && { actions: body.actions }),
      ...(body.status !== undefined && { status: body.status }),
    },
  });

  reply.send({ data: workflow, meta: {} });
}

async function archive(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  const existing = await db.workflow.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!existing) {
    reply.status(404).send({ error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } });
    return;
  }

  const workflow = await db.workflow.update({
    where: { id },
    data: { status: WorkflowStatus.archived },
  });

  reply.send({ data: workflow, meta: {} });
}

async function runs(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  const workflow = await db.workflow.findFirst({
    where: { id, organization_id: request.user.org_id },
    select: { id: true },
  });

  if (!workflow) {
    reply.status(404).send({ error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } });
    return;
  }

  const runList = await db.workflowRun.findMany({
    where: { workflow_id: id, organization_id: request.user.org_id },
    orderBy: { created_at: 'desc' },
    take: 100,
  });

  reply.send({ data: runList, meta: { total: runList.length } });
}

export const WorkflowsController = {
  list,
  create,
  getById,
  update,
  archive,
  runs,
};
