import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DealsController } from '../controllers/deals';

const CreateDealSchema = z.object({
  title: z.string().min(1).max(200),
  contact_id: z.string().uuid(),
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).default('USD'),
  expected_close: z.string().date().optional(),
  probability: z.number().min(0).max(100).optional(),
  source: z.string().max(100).optional(),
  assigned_to: z.string().uuid().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const UpdateDealSchema = CreateDealSchema.partial()
  .extend({ value: z.number().positive().optional() });

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
  status: z.enum(['open', 'won', 'lost', 'archived']).optional(),
  contact_id: z.string().uuid().optional(),
  q: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['created_at', 'updated_at', 'value', 'expected_close', 'title']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const CreatePipelineSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  is_default: z.boolean().optional(),
});

const CreateStageSchema = z.object({
  name: z.string().min(1).max(100),
  position: z.number().int().nonnegative(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  is_won_stage: z.boolean().default(false),
  is_lost_stage: z.boolean().default(false),
});

const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
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

  f.delete('/:id', { preHandler: [authenticate] }, DealsController.archive);

  // Pipeline management — static paths registered before /:id; Fastify radix tree resolves correctly
  f.get('/pipelines', { preHandler: [authenticate] }, DealsController.listPipelines);

  f.post('/pipelines', {
    preHandler: [authenticate],
    schema: { body: CreatePipelineSchema },
  }, DealsController.createPipeline);

  f.get('/pipelines/:id', { preHandler: [authenticate] }, DealsController.getPipeline);
  f.patch('/pipelines/:id', { preHandler: [authenticate] }, DealsController.updatePipeline);
  f.delete('/pipelines/:id', { preHandler: [authenticate] }, DealsController.deletePipeline);

  // Stage management
  f.get('/pipelines/:id/stages', { preHandler: [authenticate] }, DealsController.listStages);

  f.post('/pipelines/:id/stages', {
    preHandler: [authenticate],
    schema: { body: CreateStageSchema },
  }, DealsController.createStage);

  f.patch('/stages/:id', { preHandler: [authenticate] }, DealsController.updateStage);
  f.delete('/stages/:id', { preHandler: [authenticate] }, DealsController.deleteStage);
}
