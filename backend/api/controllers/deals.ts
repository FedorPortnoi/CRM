import { FastifyRequest, FastifyReply } from 'fastify';
import { DealStatus, WorkflowTrigger } from '@prisma/client';
import { db } from '../../services/db';
import { evaluateWorkflows } from '../../services/workflows';
import { fireWebhookEvent } from '../../services/webhooks';
import { logActivity } from './activities';
import { dispatchNotification, dealCtx } from '../../services/notificationEngine';
import {
  getVisibleUserIds,
  getAccessibleUserIds,
  canSeeUser,
  ownerVisibilityWhere,
  type VisibilityScope,
} from '../../services/visibility';
import {
  listDealsForUser,
  getDealForUser,
  createDealForUser,
  updateDealForUser,
  DealDomainError,
  dealInclude,
  stageBelongsToPipeline,
} from '../../services/deal-domain';
// Namespace import on purpose: the domain functions are called createStage,
// updateStage, deleteStage … and so are the handlers below them.
import * as pipelineDomain from '../../services/pipeline-domain';
import { PipelineDomainError } from '../../services/pipeline-domain';
import { fireAmoOutbound } from '../../services/amocrm/sync-worker';

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
  const orgThresholdDays = org?.stalled_threshold_days ?? 14;
  const thresholdDays = threshold_days ?? orgThresholdDays;
  const visibleIds = await getVisibleUserIds(request.user, 'subtree');

  const stageThresholds = threshold_days === undefined
    ? await db.pipelineStage.findMany({
        where: { pipeline: { organization_id: request.user.org_id } },
        select: { id: true, stale_after_days: true },
      })
    : [];
  const perStageThreshold = new Map(
    stageThresholds.map((stage) => [stage.id, stage.stale_after_days ?? orgThresholdDays]),
  );
  const staleByStage = stageThresholds.map((stage) => {
    const effectiveThreshold = stage.stale_after_days ?? orgThresholdDays;
    return {
      stage_id: stage.id,
      stage_entered_at: { lte: new Date(now.getTime() - effectiveThreshold * MS_PER_DAY) },
    };
  });
  const staleWhere = threshold_days !== undefined
    ? { stage_entered_at: { lte: new Date(now.getTime() - thresholdDays * MS_PER_DAY) } }
    : staleByStage.length > 0
      ? { OR: staleByStage }
      : { stage_entered_at: { lte: new Date(now.getTime() - orgThresholdDays * MS_PER_DAY) } };

  const staleDeals = await db.deal.findMany({
    where: {
      organization_id: request.user.org_id,
      status: DealStatus.open,
      ...staleWhere,
      ...ownerVisibilityWhere(visibleIds),
    },
    orderBy: { stage_entered_at: 'asc' },
    include: dealInclude,
  });

  const data = staleDeals.map((deal) => ({
    ...deal,
    stale_days: daysSince(deal.stage_entered_at, now),
    stale_threshold_days:
      threshold_days ?? (deal.stage_id ? perStageThreshold.get(deal.stage_id) : undefined) ?? orgThresholdDays,
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
    const deal = await createDealForUser(request.user.org_id, request.user, body);
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

  const accessibleIds = await getAccessibleUserIds(request.user);
  if (!canSeeUser(accessibleIds, deal.assigned_to) && !canSeeUser(accessibleIds, deal.created_by)) {
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

  fireAmoOutbound({
    organizationId: request.user.org_id,
    entityType: 'lead',
    operation: 'stage_change',
    localId: updated.id,
    record: updated as unknown as Record<string, unknown>,
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

  const accessibleIds = await getAccessibleUserIds(request.user);
  if (!canSeeUser(accessibleIds, deal.assigned_to) && !canSeeUser(accessibleIds, deal.created_by)) {
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

  fireAmoOutbound({
    organizationId: request.user.org_id,
    entityType: 'lead',
    operation: 'stage_change',
    localId: updated.id,
    record: updated as unknown as Record<string, unknown>,
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

  const accessibleIds = await getAccessibleUserIds(request.user);
  if (!canSeeUser(accessibleIds, deal.assigned_to) && !canSeeUser(accessibleIds, deal.created_by)) {
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

  // deal.lost has no WorkflowTrigger, so the outbound webhook is emitted at the write
  // site instead of via evaluateWorkflows. Fire-and-forget — it cannot fail the request.
  fireWebhookEvent({
    organizationId: request.user.org_id,
    event: 'deal.lost',
    entityId: updated.id,
    actorUserId: request.user.sub,
    record: updated as unknown as Record<string, unknown>,
  });

  fireAmoOutbound({
    organizationId: request.user.org_id,
    entityType: 'lead',
    operation: 'stage_change',
    localId: updated.id,
    record: updated as unknown as Record<string, unknown>,
  });

  reply.send({ data: updated, meta: {} });
}

// ─── Pipeline management ──────────────────────────────────────────────────────

async function listPipelines(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const includeArchived =
    (request.query as { include_archived?: boolean } | undefined)?.include_archived === true;
  const pipelines = await db.pipeline.findMany({
    where: { organization_id: request.user.org_id },
    include: {
      stages: {
        where: includeArchived ? undefined : { is_archived: false },
        // Per-stage deal count. The funnel settings screen shows "N сделок" beside
        // each stage and, more importantly, uses it to decide whether deleting the
        // stage will need a `move_to` — without it the client either hides the chip
        // or has to probe DELETE and read the 409 to find out.
        include: { _count: { select: { deals: true } } },
        orderBy: { position: 'asc' },
      },
      _count: { select: { deals: true } },
    },
    orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
  });

  reply.send({ data: pipelines, meta: {} });
}

/**
 * Every funnel-administration handler funnels its refusals through here, so a
 * guard in pipeline-domain reaches the client as the status it chose (404 for a
 * stage in another org, 409 for one that still holds deals) instead of as a 500.
 * Anything that is not a PipelineDomainError is rethrown untouched — a genuine
 * bug must not be reported to the user as a business rule.
 */
function sendPipelineError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof PipelineDomainError) {
    const { httpStatus, code, message, details } = err.domainError;
    reply.status(httpStatus).send({
      error: { code, message, ...(details ? { details } : {}) },
    });
    return true;
  }
  return false;
}

type PipelineIdParams = { id: string };
type StageQuery = { pipeline_id?: string };
type DeleteStageQuery = { move_to?: string };

async function createPipeline(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const pipeline = await pipelineDomain.createPipeline(
      request.user.org_id,
      request.user.sub,
      request.body as pipelineDomain.CreatePipelineInput,
    );
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline',
      entityId: pipeline?.id ?? '',
      action: 'created',
    });
    reply.status(201).send({ data: pipeline, meta: {} });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

async function updatePipeline(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as PipelineIdParams;
  try {
    const pipeline = await pipelineDomain.updatePipeline(
      id,
      request.user.org_id,
      request.body as pipelineDomain.UpdatePipelineInput,
    );
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline',
      entityId: id,
      action: 'updated',
      changes: request.body as Record<string, unknown>,
    });
    reply.send({ data: pipeline, meta: {} });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

async function deletePipeline(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as PipelineIdParams;
  try {
    const result = await pipelineDomain.deletePipeline(id, request.user.org_id);
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline',
      entityId: id,
      action: 'deleted',
      changes: result as unknown as Record<string, unknown>,
    });
    reply.send({ data: result, meta: {} });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

// ─── Stage management ─────────────────────────────────────────────────────────

async function stageLibrary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { pipeline_id } = request.query as StageQuery;
  try {
    const { pipeline_id: resolvedPipelineId, entries } =
      await pipelineDomain.stageLibraryForPipeline(request.user.org_id, pipeline_id);
    reply.send({ data: entries, meta: { pipeline_id: resolvedPipelineId, total: entries.length } });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

async function createStage(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const stage = await pipelineDomain.createStage(
      request.user.org_id,
      request.body as pipelineDomain.CreateStageInput,
    );
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline_stage',
      entityId: stage.id,
      action: 'created',
      changes: { pipeline_id: stage.pipeline_id, name: stage.name },
    });
    reply.status(201).send({ data: stage, meta: {} });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

async function updateStage(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;
  try {
    const stage = await pipelineDomain.updateStage(
      id,
      request.user.org_id,
      request.body as pipelineDomain.UpdateStageInput,
    );
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline_stage',
      entityId: id,
      action: 'updated',
      changes: request.body as Record<string, unknown>,
    });
    reply.send({ data: stage, meta: {} });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

async function deleteStage(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;
  const { move_to } = request.query as DeleteStageQuery;
  try {
    const result = await pipelineDomain.deleteStage(id, request.user.org_id, move_to);
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline_stage',
      entityId: id,
      action: 'deleted',
      changes: result as unknown as Record<string, unknown>,
    });
    reply.send({ data: result, meta: {} });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

async function reorderStages(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { pipeline_id, ordered_ids } = request.body as {
    pipeline_id: string;
    ordered_ids: string[];
  };
  try {
    const stages = await pipelineDomain.reorderStages(
      pipeline_id,
      request.user.org_id,
      ordered_ids,
    );
    void logActivity({
      organizationId: request.user.org_id,
      userId: request.user.sub,
      entityType: 'pipeline',
      entityId: pipeline_id,
      action: 'stages_reordered',
      changes: { ordered_ids },
    });
    reply.send({ data: stages, meta: { total: stages.length } });
  } catch (err) {
    if (sendPipelineError(reply, err)) return;
    throw err;
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const DealsController = {
  list,
  evaluateStale,
  create,
  getById,
  update,
  moveStage,
  markWon,
  markLost,
  listPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
  stageLibrary,
  createStage,
  updateStage,
  deleteStage,
  reorderStages,
};
