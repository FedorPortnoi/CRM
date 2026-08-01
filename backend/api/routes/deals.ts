import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DealsController } from '../controllers/deals';
import { DEFAULT_CURRENCY, normalizeCurrencyCode } from '../../config/market';
import { authenticate } from '../preHandlers';

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

// ─── Funnel administration ────────────────────────────────────────────────────
//
// Everything below is gated on `org.manage` by the table in api/authenticate.ts
// (`deals.pipeline_admin` / `deals.stage_admin`), which matches on the path
// prefix and the method — the gate predates these routes. Nothing here re-checks
// the role; what these schemas guarantee is only that the SHAPE reaching the
// controller is well formed.

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const StageColorSchema = z.string().regex(HEX_COLOR, 'color must be a #RRGGBB hex value');

const CreateStageSchema = z
  .object({
    pipeline_id: z.string().uuid(),
    // Either a name typed by the user or a key from OPTIONAL_STAGE_LIBRARY,
    // whose fields (name, colour, probability, won/lost) become the defaults.
    template_key: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(120).optional(),
    position: z.number().int().min(0).max(500).optional(),
    color: StageColorSchema.optional(),
    probability: z.number().int().min(0).max(100).optional(),
    stale_after_days: z.number().int().min(1).max(365).optional(),
    is_won_stage: z.boolean().optional(),
    is_lost_stage: z.boolean().optional(),
  })
  .refine((body) => body.name !== undefined || body.template_key !== undefined, {
    message: 'either name or template_key is required',
    path: ['name'],
  });

// Nulls are meaningful here and are NOT the same as omitting the field: `color:
// null` clears the colour, `color` absent leaves it alone. Sending `undefined`
// over JSON is impossible, so a "clear this" action needs an explicit null.
const UpdateStageSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    color: z.union([StageColorSchema, z.null()]).optional(),
    probability: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
    stale_after_days: z.union([z.number().int().min(1).max(365), z.null()]).optional(),
    is_archived: z.boolean().optional(),
    is_won_stage: z.boolean().optional(),
    is_lost_stage: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });

const DeleteStageQuerySchema = z.object({
  move_to: z.string().uuid().optional(),
});

const ReorderStagesSchema = z.object({
  pipeline_id: z.string().uuid(),
  // Must be the pipeline's whole stage set, in the wanted order — the domain
  // layer rejects a subset, a superset and repeats.
  ordered_ids: z.array(z.string().uuid()).min(1).max(100),
});

const StageLibraryQuerySchema = z.object({
  pipeline_id: z.string().uuid().optional(),
});

const PipelineListQuerySchema = z.object({
  include_archived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  is_default: z.boolean().optional(),
  stage_names: z.array(z.string().min(1).max(120)).min(1).max(30).optional(),
});

const UpdatePipelineSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.union([z.string().max(2000), z.null()]).optional(),
    is_default: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });

const IdParamSchema = z.object({ id: z.string().uuid() });

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
  f.get('/pipelines', {
    preHandler: [authenticate],
    schema: { querystring: PipelineListQuerySchema },
  }, DealsController.listPipelines);

  f.post('/pipelines', {
    preHandler: [authenticate],
    schema: { body: CreatePipelineSchema },
  }, DealsController.createPipeline);

  f.patch('/pipelines/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema, body: UpdatePipelineSchema },
  }, DealsController.updatePipeline);

  f.delete('/pipelines/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema },
  }, DealsController.deletePipeline);

  // Stage management. '/stages/library' and '/stages/reorder' are static and so
  // win over '/stages/:id' in the radix tree regardless of registration order,
  // but they are declared first anyway so the file reads in the order Fastify
  // matches.
  f.get('/stages/library', {
    preHandler: [authenticate],
    schema: { querystring: StageLibraryQuerySchema },
  }, DealsController.stageLibrary);

  f.post('/stages/reorder', {
    preHandler: [authenticate],
    schema: { body: ReorderStagesSchema },
  }, DealsController.reorderStages);

  f.post('/stages', {
    preHandler: [authenticate],
    schema: { body: CreateStageSchema },
  }, DealsController.createStage);

  f.patch('/stages/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema, body: UpdateStageSchema },
  }, DealsController.updateStage);

  f.delete('/stages/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema, querystring: DeleteStageQuerySchema },
  }, DealsController.deleteStage);
}
