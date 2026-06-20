import { FastifyRequest, FastifyReply } from 'fastify';
import { DealStatus, WorkflowTrigger } from '@prisma/client';
import { db } from '../../services/db';
import { evaluateWorkflows } from '../../services/workflows';
import { logActivity } from './activities';
import { dispatchNotification, dealCtx } from '../../services/notificationEngine';
import { type VisibilityScope } from '../../services/visibility';
import {
  listDealsForUser,
  getDealForUser,
  createDealForUser,
  updateDealForUser,
  DealDomainError,
  dealInclude,
  stageBelongsToPipeline,
} from '../../services/deal-domain';

// ─── Local request types ──────────────────────────────────────────────────────

type ListQuery = {
  pipeline_id?: string;
  stage_id?: string;
  assigned_to?: string;
  scope?: VisibilityScope;
  status?: DealStatus;
  contact_id?: string;
  q?: string;
  page: number;
  per_page: number;
  sort: 'created_at' | 'updated_at' | 'value' | 'expected_close' | 'title';
  order: 'asc' | 'desc';
};

type StaleQuery = {
  threshold_days?: number;
};

type CreateBody = {
  title: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  value?: number;
  currency: string;
  expected_close?: string;
  probability?: number;
  next_action?: string;
  next_action_due?: string;
  source?: string;
  assigned_to?: string;
  custom_fields?: Record<string, unknown>;
};

type UpdateBody = Partial<Omit<CreateBody, 'value' | 'next_action' | 'next_action_due'>> & {
  value?: number | null;
  next_action?: string | null;
  next_action_due?: string | null;
};

type IdParams = { id: string };

type MoveStageBody = { stage_id: string };
type MarkWonBody = { actual_close?: string };
type MarkLostBody = { reason?: string; actual_close?: string };

type CreatePipelineBody = { name: string; description?: string; is_default?: boolean };
type UpdatePipelineBody = Partial<CreatePipelineBody>;

type CreateStageBody = {
  name: string;
  position: number;
  color?: string;
  is_won_stage: boolean;
  is_lost_stage: boolean;
};

type UpdateStageBody = Partial<CreateStageBody>;

// dealInclude is imported from deal-domain.ts

const MS_PER_DAY = 86_400_000;

function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY));
}

// ─── Deal CRUD ────────────────────────────────────────────────────────────────

async function list(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { pipeline_id, stage_id, assigned_to, scope, status, contact_id, q, page, per_page, sort, order } =
    request.query as ListQuery;

  const { data: deals, total } = await listDealsForUser(
    request.user.org_id,
    request.user,
    { pipeline_id, stage_id, assigned_to, scope, status, contact_id, q, page, per_page, sort, order },
  );

  reply.send({ data: deals, meta: { total, page, per_page } });
}

async function evaluateStale(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { threshold_days } = request.query as StaleQuery;
  const now = new Date();
  const org = await db.org.findUnique({
    where: { id: request.user.org_id },
    select: { stalled_threshold_days: true },
  });
  const thresholdDays = threshold_days ?? org?.stalled_threshold_days ?? 14;
  const cutoff = new Date(now.getTime() - thresholdDays * MS_PER_DAY);

  const staleDeals = await db.deal.findMany({
    where: {
      organization_id: request.user.org_id,
      status: DealStatus.open,
      stage_entered_at: { lte: cutoff },
    },
    orderBy: { stage_entered_at: 'asc' },
    include: dealInclude,
  });

  const data = staleDeals.map((deal) => ({
    ...deal,
    stale_days: daysSince(deal.stage_entered_at, now),
    stale_threshold_days: thresholdDays,
  }));

  for (const deal of data) {
    await evaluateWorkflows({
      organizationId: request.user.org_id,
      trigger: WorkflowTrigger.deal_stale,
      record: deal as unknown as Record<string, unknown>,
      userId: request.user.sub,
      triggerRecordId: deal.id,
      dedupeByTriggerRecord: true,
    });
  }

  reply.send({ data, meta: { total: data.length, threshold_days: thresholdDays } });
}

async function create(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as CreateBody;

  try {
    const deal = await createDealForUser(request.user.org_id, request.user.sub, body);
    reply.status(201).send({ data: deal, meta: {} });
  } catch (err) {
    if (err instanceof DealDomainError) {
      reply.status(err.domainError.httpStatus).send({
        error: { code: err.domainError.code, message: err.domainError.message },
      });
      return;
    }
    throw err;
  }
}

async function getById(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  try {
    const deal = await getDealForUser(id, request.user.org_id, request.user);
    reply.send({ data: deal, meta: {} });
  } catch (err) {
    if (err instanceof DealDomainError) {
      reply.status(err.domainError.httpStatus).send({
        error: { code: err.domainError.code, message: err.domainError.message },
      });
      return;
    }
    throw err;
  }
}

async function update(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const body = request.body as UpdateBody;

  try {
    const updated = await updateDealForUser(id, request.user.org_id, request.user, body);
    reply.send({ data: updated, meta: {} });
  } catch (err) {
    if (err instanceof DealDomainError) {
      reply.status(err.domainError.httpStatus).send({
        error: { code: err.domainError.code, message: err.domainError.message },
      });
      return;
    }
    throw err;
  }
}

async function archive(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (deal.status === DealStatus.archived) {
    reply.status(422).send({ error: { code: 'DEAL_ALREADY_ARCHIVED', message: 'Deal is already archived' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id, organization_id: request.user.org_id },
    data: { status: DealStatus.archived },
    include: dealInclude,
  });

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'deal', entityId: updated.id, action: 'archived' });
  reply.send({ data: updated, meta: {} });
}

async function moveStage(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { stage_id } = request.body as MoveStageBody;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (deal.status !== DealStatus.open) {
    reply.status(422).send({ error: { code: 'DEAL_NOT_OPEN', message: 'Only open deals can be moved between stages' } });
    return;
  }

  if (deal.stage_id === stage_id) {
    reply.status(422).send({ error: { code: 'DEAL_ALREADY_IN_STAGE', message: 'Deal is already in this stage' } });
    return;
  }

  const stageExists = deal.pipeline_id !== null
    ? await stageBelongsToPipeline(stage_id, deal.pipeline_id, request.user.org_id)
    : false;

  if (!stageExists) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found in this deal\'s pipeline' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id, organization_id: request.user.org_id },
    data: { stage_id, stage_entered_at: new Date() },
    include: dealInclude,
  });

  await evaluateWorkflows({
    organizationId: request.user.org_id,
    trigger: WorkflowTrigger.deal_stage_changed,
    record: updated as unknown as Record<string, unknown>,
    userId: request.user.sub,
    triggerRecordId: updated.id,
  });

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'deal', entityId: updated.id, action: 'stage_changed', changes: { stage_id } });

  void dealCtx(updated.id, updated.stage?.name, request.user.sub).then((ctx) => {
    if (ctx) void dispatchNotification({ eventType: 'deal.stage_changed', orgId: request.user.org_id, deal: ctx });
  });

  reply.send({ data: updated, meta: {} });
}

async function markWon(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { actual_close } = request.body as MarkWonBody;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (deal.status !== DealStatus.open) {
    reply.status(422).send({ error: { code: 'DEAL_NOT_OPEN', message: 'Only open deals can be marked as won' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id, organization_id: request.user.org_id },
    data: {
      status: DealStatus.won,
      actual_close: actual_close ? new Date(actual_close) : new Date(),
    },
    include: dealInclude,
  });

  await evaluateWorkflows({
    organizationId: request.user.org_id,
    trigger: WorkflowTrigger.deal_won,
    record: updated as unknown as Record<string, unknown>,
    userId: request.user.sub,
    triggerRecordId: updated.id,
  });

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'deal', entityId: updated.id, action: 'won' });

  void dealCtx(updated.id, undefined, request.user.sub).then((ctx) => {
    if (ctx) void dispatchNotification({ eventType: 'deal.won', orgId: request.user.org_id, deal: ctx });
  });

  reply.send({ data: updated, meta: {} });
}

async function markLost(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { reason, actual_close } = request.body as MarkLostBody;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (deal.status !== DealStatus.open) {
    reply.status(422).send({ error: { code: 'DEAL_NOT_OPEN', message: 'Only open deals can be marked as lost' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id, organization_id: request.user.org_id },
    data: {
      status: DealStatus.lost,
      lost_reason: reason,
      actual_close: actual_close ? new Date(actual_close) : new Date(),
    },
    include: dealInclude,
  });

  void logActivity({ organizationId: request.user.org_id, userId: request.user.sub, entityType: 'deal', entityId: updated.id, action: 'lost' });

  void dealCtx(updated.id, undefined, request.user.sub).then((ctx) => {
    if (ctx) void dispatchNotification({ eventType: 'deal.lost', orgId: request.user.org_id, deal: ctx });
  });

  reply.send({ data: updated, meta: {} });
}

// ─── Pipeline management ──────────────────────────────────────────────────────

async function listPipelines(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const pipelines = await db.pipeline.findMany({
    where: { organization_id: request.user.org_id },
    include: {
      stages: { orderBy: { position: 'asc' } },
      _count: { select: { deals: true } },
    },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });

  reply.send({ data: pipelines, meta: {} });
}

async function createPipeline(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { name, description, is_default } = request.body as CreatePipelineBody;

  // If new pipeline is default, unset existing default
  if (is_default) {
    await db.pipeline.updateMany({
      where: { organization_id: request.user.org_id, is_default: true },
      data: { is_default: false },
    });
  }

  const pipeline = await db.pipeline.create({
    data: {
      name,
      description,
      is_default: is_default ?? false,
      organization_id: request.user.org_id,
      created_by: request.user.sub,
    },
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  reply.status(201).send({ data: pipeline, meta: {} });
}

async function getPipeline(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const pipeline = await db.pipeline.findFirst({
    where: { id, organization_id: request.user.org_id },
    include: {
      stages: { orderBy: { position: 'asc' } },
      _count: { select: { deals: true } },
    },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  reply.send({ data: pipeline, meta: {} });
}

async function updatePipeline(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const { name, description, is_default } = request.body as UpdatePipelineBody;

  const pipeline = await db.pipeline.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  if (is_default) {
    await db.pipeline.updateMany({
      where: { organization_id: request.user.org_id, is_default: true, id: { not: id } },
      data: { is_default: false },
    });
  }

  const updated = await db.pipeline.update({
    where: { id, organization_id: request.user.org_id },
    data: { name, description, is_default },
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  reply.send({ data: updated, meta: {} });
}

async function deletePipeline(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const pipeline = await db.pipeline.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  const openDealCount = await db.deal.count({
    where: { pipeline_id: id, organization_id: request.user.org_id, status: DealStatus.open },
  });

  if (openDealCount > 0) {
    reply.status(409).send({
      error: {
        code: 'PIPELINE_HAS_OPEN_DEALS',
        message: `Cannot delete pipeline with ${openDealCount} open deal(s). Archive or move deals first.`,
      },
    });
    return;
  }

  // Null out pipeline/stage refs on non-open deals so FK constraints don't block deletion
  await db.deal.updateMany({
    where: { pipeline_id: id, organization_id: request.user.org_id },
    data: { pipeline_id: null, stage_id: null },
  });

  await db.pipelineStage.deleteMany({
    where: { pipeline_id: id, pipeline: { organization_id: request.user.org_id } },
  });

  const deleted = await db.pipeline.deleteMany({ where: { id, organization_id: request.user.org_id } });
  if (deleted.count !== 1) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  reply.send({ data: { deleted: true }, meta: {} });
}

// ─── Stage management ─────────────────────────────────────────────────────────

async function listStages(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id: pipeline_id } = request.params as IdParams;

  const pipeline = await db.pipeline.findFirst({
    where: { id: pipeline_id, organization_id: request.user.org_id },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  const stages = await db.pipelineStage.findMany({
    where: { pipeline_id, pipeline: { organization_id: request.user.org_id } },
    orderBy: { position: 'asc' },
    include: { _count: { select: { deals: true } } },
  });

  reply.send({ data: stages, meta: {} });
}

async function createStage(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id: pipeline_id } = request.params as IdParams;
  const body = request.body as CreateStageBody;

  const stage = await db.$transaction(async (tx) => {
    const pipeline = await tx.pipeline.findFirst({
      where: { id: pipeline_id, organization_id: request.user.org_id },
      select: { id: true },
    });

    if (!pipeline) {
      return null;
    }

    return tx.pipelineStage.create({
      data: { ...body, pipeline_id },
    });
  });

  if (!stage) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  reply.status(201).send({ data: stage, meta: {} });
}

async function updateStage(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;
  const body = request.body as UpdateStageBody;

  const stage = await db.pipelineStage.findFirst({
    where: { id, pipeline: { organization_id: request.user.org_id } },
    include: { pipeline: { select: { organization_id: true } } },
  });

  if (!stage) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  const result = await db.pipelineStage.updateMany({
    where: { id, pipeline: { organization_id: request.user.org_id } },
    data: body,
  });

  if (result.count !== 1) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  const updated = await db.pipelineStage.findFirst({
    where: { id, pipeline: { organization_id: request.user.org_id } },
  });

  if (!updated) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  reply.send({ data: updated, meta: {} });
}

async function deleteStage(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as IdParams;

  const stage = await db.pipelineStage.findFirst({
    where: { id, pipeline: { organization_id: request.user.org_id } },
    include: { pipeline: { select: { organization_id: true } } },
  });

  if (!stage) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  const openDealCount = await db.deal.count({
    where: { stage_id: id, organization_id: request.user.org_id, status: DealStatus.open },
  });

  if (openDealCount > 0) {
    reply.status(409).send({
      error: {
        code: 'STAGE_HAS_OPEN_DEALS',
        message: `Cannot delete stage with ${openDealCount} open deal(s). Move deals to another stage first.`,
      },
    });
    return;
  }

  await db.deal.updateMany({
    where: { stage_id: id, organization_id: request.user.org_id, status: { not: DealStatus.open } },
    data: { stage_id: null },
  });

  const deleted = await db.pipelineStage.deleteMany({
    where: { id, pipeline: { organization_id: request.user.org_id } },
  });
  if (deleted.count !== 1) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  reply.send({ data: { deleted: true }, meta: {} });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const DealsController = {
  list,
  evaluateStale,
  create,
  getById,
  update,
  archive,
  moveStage,
  markWon,
  markLost,
  listPipelines,
  createPipeline,
  getPipeline,
  updatePipeline,
  deletePipeline,
  listStages,
  createStage,
  updateStage,
  deleteStage,
};
