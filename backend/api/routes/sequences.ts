import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SequencesController, ConsentController } from '../controllers/sequences';
import { authenticate } from '../preHandlers';
import { MAX_BULK_ENROLL, MAX_STEPS_PER_SEQUENCE } from '../../services/sequences';
import { CONSENT_SOURCES } from '../../services/consent';

const StepInputSchema = z
  .object({
    delay_days: z.coerce.number().int().min(0).max(365).default(0),
    template_id: z.string().uuid().nullable().optional(),
    subject: z.string().min(1).max(500).nullable().optional(),
    body: z.string().min(1).max(50_000).nullable().optional(),
  })
  .refine((step) => Boolean(step.template_id) || Boolean(step.subject && step.body), {
    message: 'A step needs either a template_id or both subject and body',
  });

const CreateSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  steps: z.array(StepInputSchema).max(MAX_STEPS_PER_SEQUENCE).optional(),
});

const UpdateSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

const UpdateStepSchema = z.object({
  delay_days: z.coerce.number().int().min(0).max(365).optional(),
  template_id: z.string().uuid().nullable().optional(),
  subject: z.string().min(1).max(500).nullable().optional(),
  body: z.string().min(1).max(50_000).nullable().optional(),
});

const ReorderStepsSchema = z.object({
  step_ids: z.array(z.string().uuid()).min(1).max(MAX_STEPS_PER_SEQUENCE),
});

const SequenceFilterSchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

const EnrollmentFilterSchema = z.object({
  status: z.enum(['active', 'completed', 'unsubscribed', 'failed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});

const EnrollSchema = z.object({
  contact_id: z.string().uuid(),
});

const BulkEnrollSchema = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_ENROLL),
});

const RecordConsentSchema = z.object({
  // Free text is allowed beyond the known list because the evidence has to describe what
  // actually happened, but the known values keep the common cases uniform for reporting.
  source: z.string().trim().min(1).max(200),
  consented_at: z.string().datetime().optional(),
});

// Keeps the documented source vocabulary reachable from the route module.
export const KNOWN_CONSENT_SOURCES = CONSENT_SOURCES;

/**
 * Mount at `/api/v1/sequences`.
 *
 * Every route here is authenticated AND gated on `sequences.manage` — owner, admin and
 * marketer, not owner/admin alone, since marketer was granted that capability.
 *
 * TWO doors ask that question and both must stay. `adminRoutePolicy` in api/authenticate.ts
 * carries the entry for `/api/v1/sequences` (action `sequences.manage_admin` → capability
 * `sequences.manage`); it answers FIRST and is what writes the `outcome: 'denied'` audit
 * row, the same way as the other admin surfaces. `denySequenceAdmin` in
 * controllers/sequences.ts then re-checks the identical capability per handler, so a route
 * added here is still gated even if the policy table is never updated to match.
 */
export default async function sequencesRoutes(fastify: FastifyInstance): Promise<void> {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: SequenceFilterSchema },
  }, SequencesController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateSequenceSchema },
  }, SequencesController.create);

  f.get('/:id', { preHandler: [authenticate] }, SequencesController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateSequenceSchema },
  }, SequencesController.update);

  // Soft archive — the EmailSend ledger under this sequence is consent evidence and is
  // never destroyed. Mirrors DELETE /contacts/:id, which also archives.
  f.delete('/:id', { preHandler: [authenticate] }, SequencesController.archive);

  f.get('/:id/steps', { preHandler: [authenticate] }, SequencesController.steps);

  f.post('/:id/steps', {
    preHandler: [authenticate],
    schema: { body: StepInputSchema },
  }, SequencesController.createStep);

  // Registered ahead of '/:id/steps/:stepId' for readability — Fastify prefers static
  // segments over parametric ones regardless of order.
  f.post('/:id/steps/reorder', {
    preHandler: [authenticate],
    schema: { body: ReorderStepsSchema },
  }, SequencesController.reorder);

  f.patch('/:id/steps/:stepId', {
    preHandler: [authenticate],
    schema: { body: UpdateStepSchema },
  }, SequencesController.patchStep);

  f.delete('/:id/steps/:stepId', { preHandler: [authenticate] }, SequencesController.removeStep);

  f.get('/:id/enrollments', {
    preHandler: [authenticate],
    schema: { querystring: EnrollmentFilterSchema },
  }, SequencesController.enrollments);

  f.post('/:id/enrollments', {
    preHandler: [authenticate],
    schema: { body: EnrollSchema },
  }, SequencesController.enroll);

  f.post('/:id/enrollments/bulk', {
    preHandler: [authenticate],
    schema: { body: BulkEnrollSchema },
  }, SequencesController.enrollBulk);

  f.delete(
    '/:id/enrollments/:enrollmentId',
    { preHandler: [authenticate] },
    SequencesController.unenroll,
  );
}

/**
 * Mount at `/api/v1/consent`.
 *
 * The two `/unsubscribe/:token` routes are PUBLIC and carry no `authenticate` preHandler.
 * They must be added to `isPublicApiRoute()` in api/authenticate.ts, otherwise the global
 * preHandler 401s every unsubscribe click — which is exactly the ФЗ-38 art. 18 failure
 * (refusal must be possible at any moment) that the fines are written for.
 *
 * GET RENDERS A CONFIRMATION PAGE; POST PERFORMS THE WITHDRAWAL. GET used to do the
 * withdrawal itself, on the reasoning that a plain link is all a mail client can offer and
 * an unwanted unsubscribe is the safe direction. It is not: enterprise scanners (Microsoft
 * Defender Safe Links, Proofpoint URL Defense) fetch every link in a message at delivery,
 * so recipients were being opted out before they had read the email — invisibly, since the
 * resulting audit row is indistinguishable from a real click. The page keeps the plain link
 * working (one tap, no login, no account) while requiring one deliberate action.
 *
 * POST also serves RFC 8058 one-click: a body of `List-Unsubscribe=One-Click` acts
 * immediately with no page, which is what the mail providers' `List-Unsubscribe-Post`
 * header promises. Both routes are method-matched in `isPublicApiRoute()` already.
 */
export async function consentRoutes(fastify: FastifyInstance): Promise<void> {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/contacts/:contactId', { preHandler: [authenticate] }, ConsentController.consentState);

  // Granting is capability-gated in the controller (GRANT_CONSENT_CAPABILITY); withdrawing
  // below is not, and must not become so.
  f.post('/contacts/:contactId', {
    preHandler: [authenticate],
    schema: { body: RecordConsentSchema },
  }, ConsentController.grantConsent);

  f.delete('/contacts/:contactId', { preHandler: [authenticate] }, ConsentController.revokeConsent);

  // PUBLIC — no preHandler by design.
  // Deliberately no body schema on the POST: the RFC 8058 one-click body
  // (`List-Unsubscribe=One-Click`), the form's own submission and an empty body must all be
  // accepted, and a schema here would reject the very clients this exists for.
  f.get('/unsubscribe/:token', ConsentController.unsubscribePage);
  f.post('/unsubscribe/:token', ConsentController.unsubscribe);
}
