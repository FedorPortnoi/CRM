import { can } from '../../services/capabilities';
import { FastifyRequest, FastifyReply } from 'fastify';
import { WebhookDeliveryStatus, WebhookStatus } from '@prisma/client';
import { UnsafeWebhookUrlError } from '../../services/webhook-ssrf';
import {
  WEBHOOK_EVENTS,
  WebhookEndpointLimitError,
  WebhookEndpointNotFoundError,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  rotateWebhookEndpointSecret,
  setWebhookEndpointStatus,
  updateWebhookEndpoint,
  type WebhookEventName,
} from '../../services/webhooks';

type IdParams = { id: string };

type CreateBody = {
  url: string;
  events: WebhookEventName[];
  status?: WebhookStatus;
};

type UpdateBody = Partial<CreateBody>;

type DeliveryQuery = {
  page?: number;
  per_page?: number;
  status?: WebhookDeliveryStatus;
};

// Webhook endpoints are an org-wide integration surface: owner/admin only.
// There is no visibility-cone dimension here — the rows are not user-owned.
function requireWebhookAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const { role } = request.user;
  if (!can(role, 'integrations.manage')) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Only owner or admin can manage webhooks' },
    });
    return false;
  }
  return true;
}

function handleWebhookError(error: unknown, reply: FastifyReply): void {
  if (error instanceof WebhookEndpointNotFoundError) {
    reply.status(404).send({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof WebhookEndpointLimitError) {
    reply.status(422).send({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof UnsafeWebhookUrlError) {
    reply.status(400).send({ error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

async function listEvents(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  reply.send({ data: [...WEBHOOK_EVENTS], meta: { total: WEBHOOK_EVENTS.length } });
}

async function list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const endpoints = await listWebhookEndpoints(request.user.org_id);
  reply.send({ data: endpoints, meta: { total: endpoints.length } });
}

async function create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const body = request.body as CreateBody;

  try {
    const endpoint = await createWebhookEndpoint({
      organizationId: request.user.org_id,
      createdBy: request.user.sub,
      url: body.url,
      events: body.events,
      status: body.status,
    });

    // `secret` is returned exactly once — it is never included in any later response.
    reply.status(201).send({ data: endpoint, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function getById(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;

  try {
    const endpoint = await getWebhookEndpoint(id, request.user.org_id);
    reply.send({ data: endpoint, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function update(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;
  const body = request.body as UpdateBody;

  try {
    const endpoint = await updateWebhookEndpoint(id, request.user.org_id, {
      url: body.url,
      events: body.events,
      status: body.status,
    });
    reply.send({ data: endpoint, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function pause(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;

  try {
    const endpoint = await setWebhookEndpointStatus(id, request.user.org_id, WebhookStatus.paused);
    reply.send({ data: endpoint, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function resume(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;

  try {
    const endpoint = await setWebhookEndpointStatus(id, request.user.org_id, WebhookStatus.active);
    reply.send({ data: endpoint, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function rotateSecret(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;

  try {
    const endpoint = await rotateWebhookEndpointSecret(id, request.user.org_id);
    reply.send({ data: endpoint, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function remove(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;

  try {
    const deleted = await deleteWebhookEndpoint(id, request.user.org_id);
    reply.send({ data: deleted, meta: {} });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

async function deliveries(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireWebhookAdmin(request, reply)) return;

  const { id } = request.params as IdParams;
  const query = request.query as DeliveryQuery;
  const page = query.page ?? 1;
  const perPage = query.per_page ?? 25;

  try {
    const { data, total } = await listWebhookDeliveries(id, request.user.org_id, {
      page,
      perPage,
      status: query.status,
    });
    reply.send({ data, meta: { total, page, per_page: perPage } });
  } catch (error) {
    handleWebhookError(error, reply);
  }
}

export const WebhooksController = {
  listEvents,
  list,
  create,
  getById,
  update,
  pause,
  resume,
  rotateSecret,
  remove,
  deliveries,
};
