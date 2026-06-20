import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CalendarController } from '../controllers/calendar';
import { authenticate } from '../preHandlers';

function validateEventWindow(
  body: { start_time?: string; end_time?: string },
  ctx: z.RefinementCtx,
): void {
  if (
    body.start_time !== undefined
    && body.end_time !== undefined
    && new Date(body.end_time).getTime() <= new Date(body.start_time).getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_time'],
      message: 'end_time must be after start_time',
    });
  }
}

const EventFieldsSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  attendees: z.array(z.string().uuid()).optional(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  location: z.string().max(500).optional(),
  meeting_url: z.string().url().optional(),
  reminder_minutes: z.number().int().min(0).max(10080).default(30),
  send_invite: z.boolean().default(false),
  notes: z.string().max(5000).optional(),
});

const CreateEventSchema = EventFieldsSchema.superRefine(validateEventWindow);

const UpdateEventSchema = EventFieldsSchema.partial().superRefine(validateEventWindow);

const EventFilterSchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  attendee_id: z.string().uuid().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
});

const AvailabilitySchema = z.object({
  date: z.string().date(),
  user_ids: z.preprocess(
    (v) => (typeof v === 'string' ? [v] : v),
    z.array(z.string().uuid()).min(1).max(20),
  ),
  duration_minutes: z.coerce.number().int().min(15).max(480).default(60),
});

const PostMeetingNotesSchema = z.object({
  notes: z.string().min(1).max(10000),
});

export default async function calendarRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: EventFilterSchema },
  }, CalendarController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateEventSchema },
  }, CalendarController.create);

  f.get('/availability', {
    preHandler: [authenticate],
    schema: { querystring: AvailabilitySchema },
  }, CalendarController.getAvailability);

  f.get('/:id', { preHandler: [authenticate] }, CalendarController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateEventSchema },
  }, CalendarController.update);

  f.delete('/:id', { preHandler: [authenticate] }, CalendarController.cancel);

  f.post('/:id/notes', {
    preHandler: [authenticate],
    schema: { body: PostMeetingNotesSchema },
  }, CalendarController.addPostMeetingNotes);

  f.post('/:id/complete', { preHandler: [authenticate] }, CalendarController.markCompleted);

  // Yandex Calendar sync
  f.get('/sync/yandex/auth', { preHandler: [authenticate] }, CalendarController.yandexOAuthStart);
  f.get('/sync/yandex/callback', CalendarController.yandexOAuthCallback); // OAuth redirect — no JWT
  f.delete('/sync/yandex', { preHandler: [authenticate] }, CalendarController.yandexDisconnect);
  f.get('/sync/status', { preHandler: [authenticate] }, CalendarController.syncStatus);

  // Yandex CalDAV webhook (polling fallback endpoint) — strict rate limit to prevent DoS/budget exhaustion
  f.post('/webhooks/yandex', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, CalendarController.yandexWebhook);
}
