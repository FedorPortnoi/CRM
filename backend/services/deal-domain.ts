/**
 * deal-domain.ts
 *
 * Shared business logic for the deals domain, called by both the HTTP
 * controller and the MCP tools.  Neither path should contain inline Prisma
 * queries for the four core CRUD operations — they live here so visibility
 * checks, org scoping, audit logging and workflow triggers are applied
 * uniformly.
 */

import { Prisma, DealStatus, WorkflowTrigger } from '@prisma/client';
import { db } from './db';
import { paginate } from './db-paginate';
import { evaluateWorkflows } from './workflows';
import { logActivity } from '../api/controllers/activities';
import { dispatchNotification, dealCtx } from './notificationEngine';
import {
  getVisibleUserIds,
  getAccessibleUserIds,
  canSeeUser,
  ownerVisibilityWhere,
  type VisibilityScope,
  type Requester,
} from './visibility';

// ─── Shared include shape ─────────────────────────────────────────────────────

export const dealInclude = {
  contact: { select: { id: true, first_name: true, last_name: true } },
  pipeline: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true, position: true } },
} as const;

// ─── Input types ──────────────────────────────────────────────────────────────

export type ListDealsFilters = {
  pipeline_id?: string;
  stage_id?: string;
  assigned_to?: string;
  scope?: VisibilityScope;
  status?: DealStatus;
  contact_id?: string;
  q?: string;
  page?: number;
  per_page?: number;
  sort?: 'created_at' | 'updated_at' | 'value' | 'expected_close' | 'title';
  order?: 'asc' | 'desc';
};

export type CreateDealInput = {
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

export type UpdateDealInput = Partial<Omit<CreateDealInput, 'value' | 'next_action' | 'next_action_due'>> & {
  value?: number | null;
  next_action?: string | null;
  next_action_due?: string | null;
};

// ─── Guard helpers ────────────────────────────────────────────────────────────

export async function contactBelongsToOrg(contactId: string, orgId: string): Promise<boolean> {
  const row = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    select: { id: true },
  });
  return row !== null;
}

export async function pipelineBelongsToOrg(pipelineId: string, orgId: string): Promise<boolean> {
  const row = await db.pipeline.findFirst({
    where: { id: pipelineId, organization_id: orgId },
    select: { id: true },
  });
  return row !== null;
}

export async function stageBelongsToPipeline(
  stageId: string,
  pipelineId: string,
  orgId: string,
): Promise<boolean> {
  const row = await db.pipelineStage.findFirst({
    where: { id: stageId, pipeline_id: pipelineId, pipeline: { organization_id: orgId } },
    select: { id: true },
  });
  return row !== null;
}

export async function userBelongsToOrg(userId: string, orgId: string): Promise<boolean> {
  const row = await db.user.findFirst({
    where: { id: userId, organization_id: orgId, is_active: true },
    select: { id: true },
  });
  return row !== null;
}

// ─── Domain errors ────────────────────────────────────────────────────────────

export type DomainError = {
  httpStatus: number;
  code: string;
  message: string;
};

export class DealDomainError extends Error {
  constructor(public readonly domainError: DomainError) {
    super(domainError.message);
    this.name = 'DealDomainError';
  }
}

// ─── listDealsForUser ─────────────────────────────────────────────────────────

export async function listDealsForUser(
  orgId: string,
  requestingUser: Requester,
  filters: ListDealsFilters,
): Promise<{ data: Awaited<ReturnType<typeof db.deal.findMany>>; total: number }> {
  const {
    pipeline_id,
    stage_id,
    assigned_to,
    scope = 'direct',
    status,
    contact_id,
    q,
    page = 1,
    per_page = 20,
    sort = 'created_at',
    order = 'desc',
  } = filters;

  const visibleIds = await getVisibleUserIds(requestingUser, scope);

  const where: Prisma.DealWhereInput = {
    organization_id: orgId,
    ...(pipeline_id && { pipeline_id }),
    ...(stage_id && { stage_id }),
    ...(assigned_to && { assigned_to }),
    ...(status && { status }),
    ...(contact_id && { contact_id }),
    ...(q && { title: { contains: q, mode: 'insensitive' } }),
    ...ownerVisibilityWhere(visibleIds),
  };

  return paginate(
    () => db.deal.count({ where }),
    () =>
      db.deal.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { [sort]: order },
        include: dealInclude,
      }),
  );
}

// ─── getDealForUser ───────────────────────────────────────────────────────────

export async function getDealForUser(
  dealId: string,
  orgId: string,
  requestingUser: Requester,
): Promise<Awaited<ReturnType<typeof db.deal.findFirst>> & object> {
  const deal = await db.deal.findFirst({
    where: { id: dealId, organization_id: orgId },
    include: dealInclude,
  });

  if (!deal) {
    throw new DealDomainError({ httpStatus: 404, code: 'DEAL_NOT_FOUND', message: 'Deal not found' });
  }

  const accessibleIds = await getAccessibleUserIds(requestingUser);
  if (accessibleIds !== null) {
    const canSeeIt = canSeeUser(accessibleIds, deal.assigned_to) || canSeeUser(accessibleIds, deal.created_by);
    if (!canSeeIt) {
      throw new DealDomainError({ httpStatus: 404, code: 'DEAL_NOT_FOUND', message: 'Deal not found' });
    }
  }

  return deal;
}

// ─── createDealForUser ────────────────────────────────────────────────────────

export type CreateDealResult = Awaited<ReturnType<typeof db.deal.create>>;

export async function createDealForUser(
  orgId: string,
  requestingUserId: string,
  body: CreateDealInput,
): Promise<CreateDealResult> {
  const [ownsContact, ownsPipeline, stageMatches, ownsAssignee] = await Promise.all([
    contactBelongsToOrg(body.contact_id, orgId),
    pipelineBelongsToOrg(body.pipeline_id, orgId),
    stageBelongsToPipeline(body.stage_id, body.pipeline_id, orgId),
    body.assigned_to !== undefined && body.assigned_to !== requestingUserId
      ? userBelongsToOrg(body.assigned_to, orgId)
      : Promise.resolve(true),
  ]);

  if (!ownsContact) {
    throw new DealDomainError({
      httpStatus: 403,
      code: 'FORBIDDEN',
      message: 'Contact does not belong to your organization',
    });
  }

  if (!ownsPipeline) {
    throw new DealDomainError({
      httpStatus: 404,
      code: 'PIPELINE_NOT_FOUND',
      message: 'Pipeline not found',
    });
  }

  if (!stageMatches) {
    throw new DealDomainError({
      httpStatus: 400,
      code: 'STAGE_PIPELINE_MISMATCH',
      message: 'Stage does not belong to the specified pipeline',
    });
  }

  if (!ownsAssignee) {
    throw new DealDomainError({
      httpStatus: 403,
      code: 'FORBIDDEN',
      message: 'Assigned user does not belong to your organization',
    });
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
      next_action: body.next_action,
      next_action_due: body.next_action_due ? new Date(body.next_action_due) : undefined,
      source: body.source,
      assigned_to: body.assigned_to,
      custom_fields: body.custom_fields as Prisma.InputJsonValue | undefined,
      organization_id: orgId,
      created_by: requestingUserId,
    },
    include: dealInclude,
  });

  await evaluateWorkflows({
    organizationId: orgId,
    trigger: WorkflowTrigger.deal_created,
    record: deal as unknown as Record<string, unknown>,
    userId: requestingUserId,
    triggerRecordId: deal.id,
  });

  void logActivity({
    organizationId: orgId,
    userId: requestingUserId,
    entityType: 'deal',
    entityId: deal.id,
    action: 'created',
  });

  if (deal.assigned_to) {
    void dealCtx(deal.id).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'deal.assigned', orgId, deal: ctx });
    });
  }

  return deal as CreateDealResult;
}

// ─── updateDealForUser ────────────────────────────────────────────────────────

export type UpdateDealResult = Awaited<ReturnType<typeof db.deal.update>>;

export async function updateDealForUser(
  dealId: string,
  orgId: string,
  requestingUser: Requester,
  patch: UpdateDealInput,
): Promise<UpdateDealResult> {
  const requestingUserId = requestingUser.sub;

  const deal = await db.deal.findFirst({
    where: { id: dealId, organization_id: orgId },
  });

  if (!deal) {
    throw new DealDomainError({ httpStatus: 404, code: 'DEAL_NOT_FOUND', message: 'Deal not found' });
  }

  const accessibleIds = await getAccessibleUserIds(requestingUser);
  if (accessibleIds !== null) {
    const canSeeIt = canSeeUser(accessibleIds, deal.assigned_to) || canSeeUser(accessibleIds, deal.created_by);
    if (!canSeeIt) {
      throw new DealDomainError({ httpStatus: 404, code: 'DEAL_NOT_FOUND', message: 'Deal not found' });
    }
  }

  // Validate stage/pipeline change
  let stageMatchesPromise: Promise<boolean> = Promise.resolve(true);
  if (patch.stage_id !== undefined || patch.pipeline_id !== undefined) {
    const nextPipelineId = patch.pipeline_id ?? deal.pipeline_id;
    const nextStageId = patch.stage_id ?? deal.stage_id;
    if (!nextPipelineId || !nextStageId) {
      throw new DealDomainError({
        httpStatus: 400,
        code: 'STAGE_PIPELINE_MISMATCH',
        message: "Stage does not belong to this deal's pipeline",
      });
    }
    stageMatchesPromise = stageBelongsToPipeline(nextStageId, nextPipelineId, orgId);
  }

  const [ownsContact, ownsPipeline, ownsAssignee, stageMatches] = await Promise.all([
    patch.contact_id !== undefined
      ? contactBelongsToOrg(patch.contact_id, orgId)
      : Promise.resolve(true),
    patch.pipeline_id !== undefined
      ? pipelineBelongsToOrg(patch.pipeline_id, orgId)
      : Promise.resolve(true),
    patch.assigned_to !== undefined && patch.assigned_to !== requestingUserId
      ? userBelongsToOrg(patch.assigned_to, orgId)
      : Promise.resolve(true),
    stageMatchesPromise,
  ]);

  if (!ownsContact) {
    throw new DealDomainError({
      httpStatus: 403,
      code: 'FORBIDDEN',
      message: 'Contact does not belong to your organization',
    });
  }

  if (!ownsPipeline) {
    throw new DealDomainError({
      httpStatus: 404,
      code: 'PIPELINE_NOT_FOUND',
      message: 'Pipeline not found',
    });
  }

  if (!ownsAssignee) {
    throw new DealDomainError({
      httpStatus: 403,
      code: 'FORBIDDEN',
      message: 'Assigned user does not belong to your organization',
    });
  }

  if (!stageMatches) {
    throw new DealDomainError({
      httpStatus: 400,
      code: 'STAGE_PIPELINE_MISMATCH',
      message: "Stage does not belong to this deal's pipeline",
    });
  }

  const updateData: Prisma.DealUncheckedUpdateInput = {};
  if (patch.title !== undefined) updateData.title = patch.title;
  if (patch.contact_id !== undefined) updateData.contact_id = patch.contact_id;
  if (patch.pipeline_id !== undefined) updateData.pipeline_id = patch.pipeline_id;
  if (patch.stage_id !== undefined) updateData.stage_id = patch.stage_id;
  if (patch.value !== undefined) updateData.value = patch.value;
  if (patch.currency !== undefined) updateData.currency = patch.currency;
  if (patch.expected_close !== undefined) {
    updateData.expected_close = patch.expected_close ? new Date(patch.expected_close) : null;
  }
  if (patch.probability !== undefined) updateData.probability = patch.probability;
  if (patch.next_action !== undefined) updateData.next_action = patch.next_action;
  if (patch.next_action_due !== undefined) {
    updateData.next_action_due = patch.next_action_due ? new Date(patch.next_action_due) : null;
  }
  if (patch.source !== undefined) updateData.source = patch.source;
  if (patch.assigned_to !== undefined) updateData.assigned_to = patch.assigned_to;
  if (patch.custom_fields !== undefined) {
    updateData.custom_fields = patch.custom_fields as Prisma.InputJsonValue;
  }

  const updated = await db.deal.update({
    where: { id: dealId, organization_id: orgId },
    data: updateData,
    include: dealInclude,
  });

  void logActivity({
    organizationId: orgId,
    userId: requestingUserId,
    entityType: 'deal',
    entityId: updated.id,
    action: 'updated',
  });

  if (patch.assigned_to !== undefined && patch.assigned_to !== deal.assigned_to) {
    void dealCtx(updated.id, undefined, requestingUserId).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'deal.reassigned', orgId, deal: ctx });
    });
  }

  return updated as UpdateDealResult;
}
