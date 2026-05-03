import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TasksController } from '../controllers/tasks';

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid(),
  due_date: z.string().datetime().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  is_recurring: z.boolean().default(false),
  recurrence_rule: z.string().max(200).optional(),
  reminder_at: z.string().datetime().optional(),
});

const UpdateTaskSchema = CreateTaskSchema.partial();

const TaskFilterSchema = z.object({
  assigned_to: z.string().uuid().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  due_before: z.string().datetime().optional(),
  due_after: z.string().datetime().optional(),
  q: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['due_date', 'created_at', 'priority', 'title']).default('due_date'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function tasksRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: TaskFilterSchema },
  }, TasksController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateTaskSchema },
  }, TasksController.create);

  // Static convenience routes — registered before /:id so Fastify resolves them correctly
  f.get('/today', { preHandler: [authenticate] }, TasksController.dueToday);
  f.get('/overdue', { preHandler: [authenticate] }, TasksController.overdue);

  f.get('/:id', { preHandler: [authenticate] }, TasksController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateTaskSchema },
  }, TasksController.update);

  f.post('/:id/complete', { preHandler: [authenticate] }, TasksController.complete);
  f.post('/:id/start', { preHandler: [authenticate] }, TasksController.startProgress);
  f.delete('/:id', { preHandler: [authenticate] }, TasksController.cancel);
}
