import { FastifyRequest, FastifyReply } from 'fastify';
import { DealStatus, Prisma } from '@prisma/client';
import { db } from '../../services/db';

// ─── Local request types ──────────────────────────────────────────────────────

type ListQuery = {
  pipeline_id?: string;
  stage_id?: string;
  assigned_to?: string;
  status?: DealStatus;
  contact_id?: string;
  q?: string;
  page: number;
  per_page: number;
  sort: 'created_at' | 'updated_at' | 'value' | 'expected_close' | 'title';
  order: 'asc' | 'desc';
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
  source?: string;
  assigned_to?: string;
  custom_fields?: Record<string, unknown>;
};

type UpdateBody = Partial<CreateBody>;

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

// ─── Deal include helper ─────────────────────────────────────────────────────

const dealInclude = {
  contact: { select: { id: true, first_name: true, last_name: true } },
  pipeline: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true, position: true } },
} as const;

// ─── Deal CRUD ────────────────────────────────────────────────────────────────

async function list(
  request: FastifyRequest<{ Querystring: ListQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const { pipeline_id, stage_id, assigned_to, status, contact_id, q, page, per_page, sort, order } =
    request.query;

  const where: Prisma.DealWhereInput = {
    organization_id: request.user.org_id,
    ...(pipeline_id && { pipeline_id }),
    ...(stage_id && { stage_id }),
    ...(assigned_to && { assigned_to }),
    ...(status && { status }),
    ...(contact_id && { contact_id }),
    ...(q && { title: { contains: q, mode: 'insensitive' } }),
  };

  const [deals, total] = await Promise.all([
    db.deal.findMany({
      where,
      skip: (page - 1) * per_page,
      take: per_page,
      orderBy: { [sort]: order },
      include: dealInclude,
    }),
    db.deal.count({ where }),
  ]);

  reply.send({ data: deals, meta: { total, page, per_page } });
}

async function create(
  request: FastifyRequest<{ Body: CreateBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body;

  const stage = await db.pipelineStage.findFirst({
    where: { id: body.stage_id, pipeline_id: body.pipeline_id },
  });

  if (!stage) {
    reply.status(400).send({
      error: { code: 'STAGE_PIPELINE_MISMATCH', message: 'Stage does not belong to the specified pipeline' },
    });
    return;
  }

  const deal = await db.deal.create({
    data: {
      title: body.title,
      contact_id: body.contact_id,
      pipeline_id: body.pipeline_id,
      stage_id: body.stage_id,
      value: body.value,
      currency: body.currency,
      expected_close: body.expected_close ? new Date(body.expected_close) : undefined,
      probability: body.probability,
      source: body.source,
      assigned_to: body.assigned_to,
      custom_fields: body.custom_fields,
      organization_id: request.user.org_id,
      created_by: request.user.sub,
    },
    include: dealInclude,
  });

  reply.status(201).send({ data: deal, meta: {} });
}

async function getById(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
    include: dealInclude,
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  reply.send({ data: deal, meta: {} });
}

async function update(
  request: FastifyRequest<{ Params: IdParams; Body: UpdateBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;
  const body = request.body;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (body.contact_id !== undefined) {
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

  if (body.pipeline_id !== undefined) {
    const pipeline = await db.pipeline.findFirst({
      where: { id: body.pipeline_id, organization_id: request.user.org_id },
    });
    if (!pipeline) {
      reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
      return;
    }
  }

  if (body.stage_id !== undefined || body.pipeline_id !== undefined) {
    const nextPipelineId = body.pipeline_id ?? deal.pipeline_id;
    const nextStageId = body.stage_id ?? deal.stage_id;
    if (!nextPipelineId || !nextStageId) {
      reply.status(400).send({
        error: { code: 'STAGE_PIPELINE_MISMATCH', message: 'Stage does not belong to this deal\'s pipeline' },
      });
      return;
    }
    const stage = await db.pipelineStage.findFirst({
      where: {
        id: nextStageId,
        pipeline_id: nextPipelineId,
      },
    });
    if (!stage) {
      reply.status(400).send({
        error: { code: 'STAGE_PIPELINE_MISMATCH', message: 'Stage does not belong to this deal\'s pipeline' },
      });
      return;
    }
  }

  const updateData: Prisma.DealUncheckedUpdateInput = {};
  if (body.title !== undefined) updateData.title = body.title;
  if (body.contact_id !== undefined) updateData.contact_id = body.contact_id;
  if (body.pipeline_id !== undefined) updateData.pipeline_id = body.pipeline_id;
  if (body.stage_id !== undefined) updateData.stage_id = body.stage_id;
  if (body.value !== undefined) updateData.value = body.value;
  if (body.currency !== undefined) updateData.currency = body.currency;
  if (body.expected_close !== undefined) {
    updateData.expected_close = body.expected_close ? new Date(body.expected_close) : null;
  }
  if (body.probability !== undefined) updateData.probability = body.probability;
  if (body.source !== undefined) updateData.source = body.source;
  if (body.assigned_to !== undefined) updateData.assigned_to = body.assigned_to;
  if (body.custom_fields !== undefined) {
    updateData.custom_fields = body.custom_fields as Prisma.InputJsonValue;
  }

  const updated = await db.deal.update({
    where: { id },
    data: updateData,
    include: dealInclude,
  });

  reply.send({ data: updated, meta: {} });
}

async function archive(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

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
    where: { id },
    data: { status: DealStatus.archived },
    include: dealInclude,
  });

  reply.send({ data: updated, meta: {} });
}

async function moveStage(
  request: FastifyRequest<{ Params: IdParams; Body: MoveStageBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;
  const { stage_id } = request.body;

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

  // Verify target stage exists and belongs to the deal's pipeline
  const stage = await db.pipelineStage.findFirst({
    where: { id: stage_id, pipeline_id: deal.pipeline_id ?? undefined },
  });

  if (!stage) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found in this deal\'s pipeline' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id },
    data: { stage_id },
    include: dealInclude,
  });

  reply.send({ data: updated, meta: {} });
}

async function markWon(
  request: FastifyRequest<{ Params: IdParams; Body: MarkWonBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;
  const { actual_close } = request.body;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (deal.status === DealStatus.won) {
    reply.status(422).send({ error: { code: 'DEAL_ALREADY_WON', message: 'Deal is already marked as won' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id },
    data: {
      status: DealStatus.won,
      actual_close: actual_close ? new Date(actual_close) : new Date(),
    },
    include: dealInclude,
  });

  reply.send({ data: updated, meta: {} });
}

async function markLost(
  request: FastifyRequest<{ Params: IdParams; Body: MarkLostBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;
  const { reason, actual_close } = request.body;

  const deal = await db.deal.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!deal) {
    reply.status(404).send({ error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } });
    return;
  }

  if (deal.status === DealStatus.lost) {
    reply.status(422).send({ error: { code: 'DEAL_ALREADY_LOST', message: 'Deal is already marked as lost' } });
    return;
  }

  const updated = await db.deal.update({
    where: { id },
    data: {
      status: DealStatus.lost,
      lost_reason: reason,
      actual_close: actual_close ? new Date(actual_close) : new Date(),
    },
    include: dealInclude,
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
  request: FastifyRequest<{ Body: CreatePipelineBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { name, description, is_default } = request.body;

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
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

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
  request: FastifyRequest<{ Params: IdParams; Body: UpdatePipelineBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;
  const { name, description, is_default } = request.body;

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
    where: { id },
    data: { name, description, is_default },
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  reply.send({ data: updated, meta: {} });
}

async function deletePipeline(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const pipeline = await db.pipeline.findFirst({
    where: { id, organization_id: request.user.org_id },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  const openDealCount = await db.deal.count({
    where: { pipeline_id: id, status: DealStatus.open },
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

  await db.pipeline.delete({ where: { id } });

  reply.send({ data: { deleted: true }, meta: {} });
}

// ─── Stage management ─────────────────────────────────────────────────────────

async function listStages(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id: pipeline_id } = request.params;

  const pipeline = await db.pipeline.findFirst({
    where: { id: pipeline_id, organization_id: request.user.org_id },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  const stages = await db.pipelineStage.findMany({
    where: { pipeline_id },
    orderBy: { position: 'asc' },
    include: { _count: { select: { deals: true } } },
  });

  reply.send({ data: stages, meta: {} });
}

async function createStage(
  request: FastifyRequest<{ Params: IdParams; Body: CreateStageBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id: pipeline_id } = request.params;
  const body = request.body;

  const pipeline = await db.pipeline.findFirst({
    where: { id: pipeline_id, organization_id: request.user.org_id },
  });

  if (!pipeline) {
    reply.status(404).send({ error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } });
    return;
  }

  const stage = await db.pipelineStage.create({
    data: { ...body, pipeline_id },
  });

  reply.status(201).send({ data: stage, meta: {} });
}

async function updateStage(
  request: FastifyRequest<{ Params: IdParams; Body: UpdateStageBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const stage = await db.pipelineStage.findFirst({
    where: { id },
    include: { pipeline: { select: { organization_id: true } } },
  });

  if (!stage || stage.pipeline.organization_id !== request.user.org_id) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  const updated = await db.pipelineStage.update({
    where: { id },
    data: request.body,
  });

  reply.send({ data: updated, meta: {} });
}

async function deleteStage(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params;

  const stage = await db.pipelineStage.findFirst({
    where: { id },
    include: { pipeline: { select: { organization_id: true } } },
  });

  if (!stage || stage.pipeline.organization_id !== request.user.org_id) {
    reply.status(404).send({ error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' } });
    return;
  }

  const openDealCount = await db.deal.count({
    where: { stage_id: id, status: DealStatus.open },
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

  await db.pipelineStage.delete({ where: { id } });

  reply.send({ data: { deleted: true }, meta: {} });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const DealsController = {
  list,
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
