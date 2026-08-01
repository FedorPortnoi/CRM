/**
 * public-api.ts (controller)
 *
 * Handlers for the public REST API (`/public/v1`) plus the owner/admin-only
 * endpoints that mint and revoke its credentials.
 *
 * Public handlers never touch Prisma for the core resources — they delegate to
 * contact-domain / deal-domain / task-domain so org scoping, encryption,
 * workflow evaluation, activity logging and notifications behave exactly as
 * they do on the app's own routes.  The single exception is the deal stage
 * move, which lives in the deals controller rather than the domain layer and is
 * mirrored here (see `moveDealStage`).
 *
 * Errors are THROWN, not sent: the plugin-scoped error handler in
 * routes/public-api.ts maps them to the `{ error: { code, message } }` envelope.
 * That is what makes idempotency correct — a handler that half-succeeded and
 * then replied 4xx directly would leave a cached "success" behind.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { DealStatus, WorkflowTrigger } from '@prisma/client';
import { db } from '../../services/db';
import { auditLog } from '../../services/audit';
import { logActivity } from './activities';
import { evaluateWorkflows } from '../../services/workflows';
import { dispatchNotification, dealCtx } from '../../services/notificationEngine';
import { runIdempotent } from '../../services/idempotency';
import { fireAmoOutbound } from '../../services/amocrm/sync-worker';
import type { PublicApiContext } from '../../services/public-api-auth';
import type { Requester } from '../../services/visibility';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyScope,
} from '../../services/api-keys';
import {
  createContactForUser,
  getContactForUser,
  listContactsForUser,
  updateContactForUser,
  type ContactBody,
  type ContactPatch,
} from '../../services/contact-domain';
import {
  createDealForUser,
  dealInclude,
  getDealForUser,
  listDealsForUser,
  stageBelongsToPipeline,
  updateDealForUser,
  type CreateDealInput,
  type ListDealsFilters,
  type UpdateDealInput,
} from '../../services/deal-domain';
import {
  createTaskForUser,
  getTaskForUser,
  listTasksForUser,
  updateTaskForUser,
  type CreateTaskBody,
  type DomainError as TaskDomainError,
  type ListTasksFilters,
  type UpdateTaskPatch,
} from '../../services/task-domain';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class PublicApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublicApiError';
  }
}

export function taskDomainErrorStatus(error: TaskDomainError): number {
  if (error.kind === 'not_found') return 404;
  if (error.kind === 'forbidden') return 403;
  return 422;
}

function throwTaskError(error: TaskDomainError): never {
  throw new PublicApiError(taskDomainErrorStatus(error), error.code, error.message);
}

// ─── Request context ──────────────────────────────────────────────────────────

function contextFor(request: FastifyRequest): PublicApiContext {
  const context = request.publicApi;
  if (!context) {
    // Only reachable if a route forgets the authenticate preHandler.
    throw new PublicApiError(401, 'UNAUTHORIZED', 'Invalid, revoked, or expired API key');
  }
  return context;
}

/**
 * The requester handed to the domain services.
 *
 * `role: 'admin'` is the deliberate encoding of "API keys are org-level access"
 * — it makes the visibility cone in services/visibility.ts return `null`
 * ("no per-user restriction") while org scoping still bounds every query. The
 * reasoning is spelled out at the top of services/public-api-auth.ts.
 */
function requesterFor(context: PublicApiContext): Requester {
  if (!context.actor_user_id) {
    throw new PublicApiError(
      403,
      'API_KEY_ACTOR_UNAVAILABLE',
      'This API key has no active owner or admin to act on behalf of',
    );
  }

  return { sub: context.actor_user_id, org_id: context.org_id, role: 'admin' };
}

/**
 * Requester for reads.  With `role: 'admin'` both `getVisibleUserIds` and
 * `getAccessibleUserIds` return `null` before ever looking at `sub`, and no read
 * path persists it, so an org whose actor could not be resolved can still be
 * polled.  The key id stands in purely to keep the type total — writes go
 * through `requesterFor`, which refuses rather than inventing an actor.
 */
function readRequesterFor(context: PublicApiContext): Requester {
  return {
    sub: context.actor_user_id ?? context.key_id,
    org_id: context.org_id,
    role: 'admin',
  };
}

// ─── Idempotency wrapper ──────────────────────────────────────────────────────

function endpointFor(request: FastifyRequest): string {
  const path = request.url.split('?')[0] ?? request.url;
  return `${request.method.toUpperCase()} ${path}`;
}

/**
 * Run a write behind the request's `Idempotency-Key`, if it carries one.
 * The stored body is the serialised response, so a replay is byte-identical to
 * what the first caller received.
 */
async function withIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
  context: PublicApiContext,
  successStatus: number,
  operation: () => Promise<unknown>,
): Promise<void> {
  const result = await runIdempotent({
    rawKey: request.headers['idempotency-key'],
    organizationId: context.org_id,
    endpoint: endpointFor(request),
    requestBody: request.body ?? null,
    statusCode: successStatus,
    operation,
  });

  reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false');
  reply.status(result.statusCode).send(result.body);
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

type ContactListQuery = {
  q?: string;
  status?: 'active' | 'inactive' | 'archived';
  type?: 'lead' | 'customer' | 'partner' | 'other';
  assigned_to?: string;
  page: number;
  per_page: number;
  sort: 'created_at' | 'updated_at' | 'first_name' | 'company';
  order: 'asc' | 'desc';
};

type IdParams = { id: string };

async function listContacts(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const query = request.query as ContactListQuery;

  const result = await listContactsForUser(context.org_id, readRequesterFor(context), query);

  reply.send(result);
}

async function createContact(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);

  await withIdempotency(request, reply, context, 201, async () => {
    const contact = await createContactForUser(
      context.org_id,
      requester.sub,
      request.body as ContactBody,
    );
    return { data: contact, meta: {} };
  });
}

async function getContact(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const { id } = request.params as IdParams;

  const contact = await getContactForUser(id, context.org_id, readRequesterFor(context));
  reply.send({ data: contact, meta: {} });
}

async function updateContact(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);
  const { id } = request.params as IdParams;

  await withIdempotency(request, reply, context, 200, async () => {
    const contact = await updateContactForUser(
      id,
      context.org_id,
      requester,
      request.body as ContactPatch,
    );
    return { data: contact, meta: {} };
  });
}

// ─── Deals ────────────────────────────────────────────────────────────────────

type DealListQuery = ListDealsFilters & { page: number; per_page: number };

async function listDeals(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const query = request.query as DealListQuery;

  const { data, total } = await listDealsForUser(context.org_id, readRequesterFor(context), query);

  reply.send({ data, meta: { total, page: query.page, per_page: query.per_page } });
}

async function createDeal(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);

  await withIdempotency(request, reply, context, 201, async () => {
    const deal = await createDealForUser(context.org_id, requester, request.body as CreateDealInput);
    return { data: deal, meta: {} };
  });
}

async function getDeal(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const { id } = request.params as IdParams;

  const deal = await getDealForUser(id, context.org_id, readRequesterFor(context));
  reply.send({ data: deal, meta: {} });
}

async function updateDeal(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);
  const { id } = request.params as IdParams;

  await withIdempotency(request, reply, context, 200, async () => {
    const deal = await updateDealForUser(
      id,
      context.org_id,
      requester,
      request.body as UpdateDealInput,
    );
    return { data: deal, meta: {} };
  });
}

/**
 * Stage moves are not in deal-domain — the app's own handler is
 * DealsController.moveStage — so the sequence is mirrored here rather than
 * routed through `updateDealForUser`, which would skip `stage_entered_at` (used
 * by stale-deal detection) and the deal_stage_changed workflow trigger.
 * Every query below is org-scoped.
 */
async function moveDealStage(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);
  const { id } = request.params as IdParams;
  const { stage_id } = request.body as { stage_id: string };

  await withIdempotency(request, reply, context, 200, async () => {
    const deal = await db.deal.findFirst({
      where: { id, organization_id: context.org_id },
    });

    if (!deal) {
      throw new PublicApiError(404, 'DEAL_NOT_FOUND', 'Deal not found');
    }

    if (deal.status !== DealStatus.open) {
      throw new PublicApiError(422, 'DEAL_NOT_OPEN', 'Only open deals can be moved between stages');
    }

    if (deal.stage_id === stage_id) {
      throw new PublicApiError(422, 'DEAL_ALREADY_IN_STAGE', 'Deal is already in this stage');
    }

    const stageExists = deal.pipeline_id !== null
      ? await stageBelongsToPipeline(stage_id, deal.pipeline_id, context.org_id)
      : false;

    if (!stageExists) {
      throw new PublicApiError(404, 'STAGE_NOT_FOUND', "Stage not found in this deal's pipeline");
    }

    const updated = await db.deal.update({
      where: { id, organization_id: context.org_id },
      data: { stage_id, stage_entered_at: new Date() },
      include: dealInclude,
    });

    await evaluateWorkflows({
      organizationId: context.org_id,
      trigger: WorkflowTrigger.deal_stage_changed,
      record: updated as unknown as Record<string, unknown>,
      userId: requester.sub,
      triggerRecordId: updated.id,
    });

    void logActivity({
      organizationId: context.org_id,
      userId: requester.sub,
      entityType: 'deal',
      entityId: updated.id,
      action: 'stage_changed',
      changes: { stage_id },
    });

    void dealCtx(updated.id, updated.stage?.name, requester.sub).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'deal.stage_changed', orgId: context.org_id, deal: ctx });
    });

    fireAmoOutbound({
      organizationId: context.org_id,
      entityType: 'lead',
      operation: 'stage_change',
      localId: updated.id,
      record: updated as unknown as Record<string, unknown>,
    });

    return { data: updated, meta: {} };
  });
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

type TaskListQuery = ListTasksFilters & { page: number; per_page: number };

async function listTasks(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const query = request.query as TaskListQuery;

  const result = await listTasksForUser(context.org_id, readRequesterFor(context), query);

  reply.send({
    data: result.data,
    meta: { total: result.total, page: result.page, per_page: result.per_page },
  });
}

async function createTask(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);

  await withIdempotency(request, reply, context, 201, async () => {
    const result = await createTaskForUser(
      context.org_id,
      requester,
      request.body as CreateTaskBody,
    );

    if (!result.ok) {
      throwTaskError(result.error);
    }

    return { data: result.task, meta: {} };
  });
}

async function getTask(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const { id } = request.params as IdParams;

  const task = await getTaskForUser(id, context.org_id, readRequesterFor(context));

  if (!task) {
    throw new PublicApiError(404, 'TASK_NOT_FOUND', 'Task not found');
  }

  reply.send({ data: task, meta: {} });
}

async function updateTask(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const context = contextFor(request);
  const requester = requesterFor(context);
  const { id } = request.params as IdParams;

  await withIdempotency(request, reply, context, 200, async () => {
    const result = await updateTaskForUser(
      id,
      context.org_id,
      requester,
      request.body as UpdateTaskPatch,
    );

    if (!result.ok) {
      throwTaskError(result.error);
    }

    return { data: result.task, meta: {} };
  });
}

// ─── API key management (session-authenticated, owner/admin only) ─────────────

async function listKeys(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const keys = await listApiKeys(request.user.org_id);
  reply.send({ data: keys, meta: { total: keys.length } });
}

async function createKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as { name: string; scopes: ApiKeyScope[]; expires_at?: string };

  const created = await createApiKey({
    organizationId: request.user.org_id,
    createdBy: request.user.sub,
    name: body.name,
    scopes: body.scopes,
    expiresAt: body.expires_at ? new Date(body.expires_at) : null,
  });

  await auditLog({
    action: 'api_key.created',
    request,
    organizationId: request.user.org_id,
    userId: request.user.sub,
    targetType: 'api_key',
    targetId: created.id,
    metadata: { key_prefix: created.key_prefix, scopes: created.scopes },
  });

  // `key` appears here and nowhere else, ever.
  reply.status(201).send({ data: created, meta: {} });
}

async function revokeKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  const revoked = await revokeApiKey(id, request.user.org_id);

  await auditLog({
    action: 'api_key.revoked',
    request,
    organizationId: request.user.org_id,
    userId: request.user.sub,
    targetType: 'api_key',
    targetId: revoked.id,
    metadata: { key_prefix: revoked.key_prefix },
  });

  reply.send({ data: revoked, meta: {} });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const PublicApiController = {
  listContacts,
  createContact,
  getContact,
  updateContact,
  listDeals,
  createDeal,
  getDeal,
  updateDeal,
  moveDealStage,
  listTasks,
  createTask,
  getTask,
  updateTask,
};

export const ApiKeysController = {
  listKeys,
  createKey,
  revokeKey,
};
