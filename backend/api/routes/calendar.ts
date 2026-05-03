import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CalendarController } from '../controllers/calendar';

const CreateEventSchema = z.object({
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

const UpdateEventSchema = CreateEventSchema.partial();

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
  user_ids: z.array(z.string().uuid()).min(1).max(20),
  duration_minutes: z.number().int().min(15).max(480).default(60),
});

const PostMeetingNotesSchema = z.object({
  notes: z.string().min(1).max(10000),
});

const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

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

  // Google Calendar sync
  f.get('/sync/google/auth', { preHandler: [authenticate] }, CalendarController.googleOAuthStart);
  f.get('/sync/google/callback', CalendarController.googleOAuthCallback); // OAuth redirect — no JWT
  f.delete('/sync/google', { preHandler: [authenticate] }, CalendarController.googleDisconnect);
  f.get('/sync/status', { preHandler: [authenticate] }, CalendarController.syncStatus);

  // Google Calendar push notification webhook — no JWT auth
  f.post('/webhooks/google', CalendarController.googleWebhook);
}
