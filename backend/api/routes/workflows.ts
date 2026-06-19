import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkflowsController } from '../controllers/workflows';

const WorkflowActionSchema = z.object({
  type: z.enum(['create_task', 'add_contact_note', 'update_deal_stage']),
  title: z.string().max(300).optional(),
  body: z.string().max(5000).optional(),
  field: z.string().max(100).optional(),
  stage_id: z.string().uuid().optional(),
  due_in_days: z.number().int().min(0).max(365).optional(),
  assigned_to: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
});

const WorkflowConditionSchema = z.object({
  field: z.string().min(1).max(100),
  operator: z.enum(['equals', 'not_equals', 'contains', 'exists']).optional(),
  value: z.unknown().optional(),
});

const WorkflowBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  trigger: z.enum(['contact_created', 'deal_stage_changed', 'task_completed', 'deal_won', 'deal_created', 'task_created', 'deal_stale']),
  conditions: z.union([
    z.array(WorkflowConditionSchema),
    z.object({ all: z.array(WorkflowConditionSchema) }),
  ]).optional(),
  actions: z.array(WorkflowActionSchema).min(1).max(20),
  status: z.enum(['active', 'paused', 'archived']).optional(),
});

const WorkflowUpdateSchema = WorkflowBodySchema.partial().extend({
  actions: z.array(WorkflowActionSchema).min(1).max(20).optional(),
});

const WorkflowFilterSchema = z.object({
  status: z.enum(['active', 'paused', 'archived']).optional(),
  trigger: z.enum(['contact_created', 'deal_stage_changed', 'task_completed', 'deal_won', 'deal_created', 'task_created', 'deal_stale']).optional(),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function workflowsRoutes(fastify: FastifyInstance): Promise<void> {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: WorkflowFilterSchema },
  }, WorkflowsController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: WorkflowBodySchema },
  }, WorkflowsController.create);

  f.get('/:id', { preHandler: [authenticate] }, WorkflowsController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: WorkflowUpdateSchema },
  }, WorkflowsController.update);

  f.delete('/:id', { preHandler: [authenticate] }, WorkflowsController.archive);
}
