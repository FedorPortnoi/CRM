/**
 * public-api.ts (routes)
 *
 * Two plugins live here:
 *
 *   default export `publicApiRoutes` — the machine-facing REST API.  Mount it
 *     WITHOUT the /api/v1 prefix, e.g.
 *       await server.register(publicApiRoutes, { prefix: '/public/v1' });
 *     Nothing inside assumes a particular prefix.  Keeping it off /api/v1 also
 *     keeps it clear of `enforceAuthenticatedApiRequest`, which demands a JWT
 *     session that an API key by definition does not have.
 *
 *   named export `apiKeysRoutes` — the owner/admin console for minting and
 *     revoking those credentials.  This one IS a normal session-authenticated
 *     resource; mount it at
 *       await server.register(apiKeysRoutes, { prefix: '/api/v1/api-keys' });
 *
 * Registration is left to whoever wires backend/index.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodTypeProvider, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { DEFAULT_CURRENCY, normalizeCurrencyCode } from '../../config/market';
import { authenticate } from '../preHandlers';
import { auditLog } from '../../services/audit';
import {
  API_KEY_SCOPES,
  ApiKeyLimitError,
  ApiKeyNotFoundError,
} from '../../services/api-keys';
import { IdempotencyError } from '../../services/idempotency';
import {
  authenticatePublicApiKey,
  requirePublicApiScope,
} from '../../services/public-api-auth';
import { ContactForbiddenError, ContactNotFoundError } from '../../services/contact-domain';
import { DealDomainError } from '../../services/deal-domain';
import { ApiKeysController, PublicApiController, PublicApiError } from '../controllers/public-api';

// ─── Shared schemas ───────────────────────────────────────────────────────────

const IdParamsSchema = z.object({ id: z.string().uuid() });

const CurrencySchema = z.string().trim().length(3).transform(normalizeCurrencyCode);

const CreateContactSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  mobile: z.string().max(30).optional(),
  tags: z.array(z.string()).max(20).optional(),
  source: z.string().max(100).optional(),
  notes: z.string().max(5000).optional(),
  assigned_to: z.string().uuid().optional(),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const UpdateContactSchema = CreateContactSchema.partial().extend({
  email: z.union([z.string().email(), z.literal('')]).optional(),
});

const ContactFilterSchema = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
  assigned_to: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['created_at', 'updated_at', 'first_name', 'company']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const CreateDealSchema = z.object({
  title: z.string().min(1).max(200),
  contact_id: z.string().uuid(),
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  value: z.number().nonnegative().optional(),
  currency: CurrencySchema.default(DEFAULT_CURRENCY),
  expected_close: z.string().date().optional(),
  probability: z.number().min(0).max(100).optional(),
  next_action: z.string().max(500).optional(),
  next_action_due: z.string().optional(),
  source: z.string().max(100).optional(),
  assigned_to: z.string().uuid().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const UpdateDealSchema = CreateDealSchema.partial().extend({
  value: z.union([z.number().nonnegative(), z.null()]).optional(),
  next_action: z.union([z.string().max(500), z.null()]).optional(),
  next_action_due: z.union([z.string(), z.null()]).optional(),
});

const MoveStageSchema = z.object({ stage_id: z.string().uuid() });

const DealFilterSchema = z.object({
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  status: z.enum(['open', 'won', 'lost', 'archived']).optional(),
  contact_id: z.string().uuid().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['created_at', 'updated_at', 'value', 'expected_close', 'title']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid(),
  due_date: z.string().datetime().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  reminder_at: z.string().datetime().optional(),
});

// Recurrence is deliberately not exposed: RRULE strings need the same safety
// screening the app routes apply, and no integration has asked for them yet.
const UpdateTaskSchema = CreateTaskSchema.partial().extend({
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
});

const TaskFilterSchema = z.object({
  assigned_to: z.string().uuid().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  due_before: z.string().datetime().optional(),
  due_after: z.string().datetime().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['due_date', 'created_at', 'priority', 'title']).default('due_date'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// ─── Error mapping ────────────────────────────────────────────────────────────

/**
 * The server-wide error handler in backend/index.ts only builds the
 * `{ error: { code, message } }` envelope for URLs under /api/, so the public
 * plugin installs its own.  Fastify scopes error handlers to the plugin they
 * are registered in, which is exactly what we want.
 */
function registerPublicErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.validation
            .map((issue) => `${issue.instancePath || 'body'}: ${issue.message ?? 'invalid'}`)
            .join('; ') || 'Request failed validation',
        },
      });
      return;
    }

    if (error instanceof PublicApiError || error instanceof IdempotencyError) {
      reply.status(error.httpStatus).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    if (error instanceof ContactNotFoundError) {
      reply.status(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: error.message } });
      return;
    }

    if (error instanceof ContactForbiddenError) {
      reply.status(403).send({ error: { code: error.code, message: error.message } });
      return;
    }

    if (error instanceof DealDomainError) {
      reply.status(error.domainError.httpStatus).send({
        error: { code: error.domainError.code, message: error.domainError.message },
      });
      return;
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2023' ||
      error instanceof Prisma.PrismaClientValidationError && error.message.includes('UUID')
    ) {
      reply.status(400).send({ error: { code: 'INVALID_ID', message: 'Invalid identifier format' } });
      return;
    }

    request.log.error(error);
    reply.status(500).send({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
  });
}

// ─── Public REST API ──────────────────────────────────────────────────────────

export default async function publicApiRoutes(fastify: FastifyInstance): Promise<void> {
  if (!fastify.hasRequestDecorator('publicApi')) {
    fastify.decorateRequest('publicApi', null);
  }

  registerPublicErrorHandler(fastify);

  // index.ts only marks /api/ responses uncacheable; do the same for CRM data
  // served here.
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    return payload;
  });

  fastify.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  /** Authenticate the key, then require the scope this route needs. */
  const guard = (scope: Parameters<typeof requirePublicApiScope>[0]) =>
    [authenticatePublicApiKey, requirePublicApiScope(scope)];

  // Contacts
  f.get('/contacts', {
    preHandler: guard('contacts:read'),
    schema: { querystring: ContactFilterSchema },
  }, PublicApiController.listContacts);

  f.post('/contacts', {
    preHandler: guard('contacts:write'),
    schema: { body: CreateContactSchema },
  }, PublicApiController.createContact);

  f.get('/contacts/:id', {
    preHandler: guard('contacts:read'),
    schema: { params: IdParamsSchema },
  }, PublicApiController.getContact);

  f.patch('/contacts/:id', {
    preHandler: guard('contacts:write'),
    schema: { params: IdParamsSchema, body: UpdateContactSchema },
  }, PublicApiController.updateContact);

  // Deals
  f.get('/deals', {
    preHandler: guard('deals:read'),
    schema: { querystring: DealFilterSchema },
  }, PublicApiController.listDeals);

  f.post('/deals', {
    preHandler: guard('deals:write'),
    schema: { body: CreateDealSchema },
  }, PublicApiController.createDeal);

  f.get('/deals/:id', {
    preHandler: guard('deals:read'),
    schema: { params: IdParamsSchema },
  }, PublicApiController.getDeal);

  f.patch('/deals/:id', {
    preHandler: guard('deals:write'),
    schema: { params: IdParamsSchema, body: UpdateDealSchema },
  }, PublicApiController.updateDeal);

  f.patch('/deals/:id/stage', {
    preHandler: guard('deals:write'),
    schema: { params: IdParamsSchema, body: MoveStageSchema },
  }, PublicApiController.moveDealStage);

  // Tasks
  f.get('/tasks', {
    preHandler: guard('tasks:read'),
    schema: { querystring: TaskFilterSchema },
  }, PublicApiController.listTasks);

  f.post('/tasks', {
    preHandler: guard('tasks:write'),
    schema: { body: CreateTaskSchema },
  }, PublicApiController.createTask);

  f.get('/tasks/:id', {
    preHandler: guard('tasks:read'),
    schema: { params: IdParamsSchema },
  }, PublicApiController.getTask);

  f.patch('/tasks/:id', {
    preHandler: guard('tasks:write'),
    schema: { params: IdParamsSchema, body: UpdateTaskSchema },
  }, PublicApiController.updateTask);
}

// ─── API key management (session-authenticated) ───────────────────────────────

const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);

const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1).max(API_KEY_SCOPES.length).refine(
    (scopes) => new Set(scopes).size === scopes.length,
    { message: 'Scopes must be unique' },
  ),
  expires_at: z.string().datetime().optional(),
});

/**
 * Same bar as `adminRoutePolicy` in api/authenticate.ts: owner or admin, with a
 * denial written to the audit trail.  That table is path-driven and this route
 * is not in it, so the check is enforced here instead of extending a file this
 * change does not own.
 */
async function requireApiKeyAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user.role === 'owner' || request.user.role === 'admin') {
    return;
  }

  await auditLog({
    action: 'api_key.admin',
    outcome: 'denied',
    request,
    organizationId: request.user.org_id,
    userId: request.user.sub,
    metadata: {
      method: request.method.toUpperCase(),
      path: request.url.split('?')[0] ?? request.url,
      role: request.user.role,
      reason: 'API key administration requires owner or admin',
    },
  });

  reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'API key administration requires owner or admin' },
  });
}

export async function apiKeysRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiKeyNotFoundError || error instanceof ApiKeyLimitError) {
      reply.status(error.httpStatus).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request failed validation' },
      });
      return;
    }

    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      reply.status(status).send({
        error: { code: 'BAD_REQUEST', message: (error as Error).message },
      });
      return;
    }

    request.log.error(error);
    reply.status(500).send({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
  });

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate, requireApiKeyAdmin],
  }, ApiKeysController.listKeys);

  f.post('/', {
    preHandler: [authenticate, requireApiKeyAdmin],
    schema: { body: CreateApiKeySchema },
  }, ApiKeysController.createKey);

  f.delete('/:id', {
    preHandler: [authenticate, requireApiKeyAdmin],
    schema: { params: IdParamsSchema },
  }, ApiKeysController.revokeKey);
}
