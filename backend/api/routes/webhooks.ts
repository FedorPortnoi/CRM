import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WebhooksController } from '../controllers/webhooks';
import { authenticate } from '../preHandlers';
import { WEBHOOK_EVENTS, type WebhookEventName } from '../../services/webhooks';

const WebhookEventSchema = z.enum([
  'contact.created',
  'contact.updated',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'task.created',
  'task.completed',
]);

// Keeps the Zod enum and the service's event catalogue from drifting apart.
type SchemaEvent = z.infer<typeof WebhookEventSchema>;
const _eventsMatchService: SchemaEvent extends WebhookEventName
  ? WebhookEventName extends SchemaEvent ? true : never
  : never = true;
void _eventsMatchService;

const CreateWebhookSchema = z.object({
  url: z.string().url().max(2000),
  events: z.array(WebhookEventSchema).min(1).max(WEBHOOK_EVENTS.length),
  status: z.enum(['active', 'paused']).optional(),
});

const UpdateWebhookSchema = z.object({
  url: z.string().url().max(2000).optional(),
  events: z.array(WebhookEventSchema).min(1).max(WEBHOOK_EVENTS.length).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

const DeliveryFilterSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'success', 'failed']).optional(),
});

export default async function webhooksRoutes(fastify: FastifyInstance): Promise<void> {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/events', { preHandler: [authenticate] }, WebhooksController.listEvents);

  f.get('/', { preHandler: [authenticate] }, WebhooksController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateWebhookSchema },
  }, WebhooksController.create);

  f.get('/:id', { preHandler: [authenticate] }, WebhooksController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateWebhookSchema },
  }, WebhooksController.update);

  f.post('/:id/pause', { preHandler: [authenticate] }, WebhooksController.pause);

  f.post('/:id/resume', { preHandler: [authenticate] }, WebhooksController.resume);

  f.post('/:id/rotate-secret', { preHandler: [authenticate] }, WebhooksController.rotateSecret);

  f.delete('/:id', { preHandler: [authenticate] }, WebhooksController.remove);

  f.get('/:id/deliveries', {
    preHandler: [authenticate],
    schema: { querystring: DeliveryFilterSchema },
  }, WebhooksController.deliveries);
}
