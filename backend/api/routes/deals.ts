import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DealsController } from '../controllers/deals';
import { DEFAULT_CURRENCY, normalizeCurrencyCode } from '../../config/market';

const CurrencySchema = z.string().trim().length(3).transform(normalizeCurrencyCode);

const CreateDealSchema = z.object({
  title: z.string().min(1).max(200),
  contact_id: z.string().uuid().optional(),
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

const UpdateDealSchema = CreateDealSchema.partial()
  .extend({
    value: z.union([z.number().nonnegative(), z.null()]).optional(),
    next_action: z.union([z.string().max(500), z.null()]).optional(),
    next_action_due: z.union([z.string(), z.null()]).optional(),
  });

const MoveStageSchema = z.object({
  stage_id: z.string().uuid(),
});

const LostReasonSchema = z.object({
  reason: z.string().max(500).optional(),
  actual_close: z.string().date().optional(),
});

const WonSchema = z.object({
  actual_close: z.string().date().optional(),
});

const DealFilterSchema = z.object({
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  scope: z.enum(['direct', 'subtree']).optional(),
  status: z.enum(['open', 'won', 'lost', 'archived']).optional(),
  contact_id: z.string().uuid().optional(),
  q: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['created_at', 'updated_at', 'value', 'expected_close', 'title']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const StaleDealScanSchema = z.object({
  threshold_days: z.coerce.number().int().min(0).max(365).optional(),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function dealsRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  // Deal CRUD
  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: DealFilterSchema },
  }, DealsController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateDealSchema },
  }, DealsController.create);

  f.post('/stale/evaluate', {
    preHandler: [authenticate],
    schema: { querystring: StaleDealScanSchema },
  }, DealsController.evaluateStale);

  f.get('/:id', { preHandler: [authenticate] }, DealsController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateDealSchema },
  }, DealsController.update);

  f.patch('/:id/stage', {
    preHandler: [authenticate],
    schema: { body: MoveStageSchema },
  }, DealsController.moveStage);

  f.post('/:id/won', {
    preHandler: [authenticate],
    schema: { body: WonSchema },
  }, DealsController.markWon);

  f.post('/:id/lost', {
    preHandler: [authenticate],
    schema: { body: LostReasonSchema },
  }, DealsController.markLost);

  // Pipeline management — static paths registered before /:id; Fastify radix tree resolves correctly
  f.get('/pipelines', { preHandler: [authenticate] }, DealsController.listPipelines);
}
