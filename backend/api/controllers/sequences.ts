import { FastifyReply, FastifyRequest } from 'fastify';
import { SequenceEnrollmentStatus, SequenceStatus } from '@prisma/client';
import { auditLog } from '../../services/audit';
import { getAccessibleUserIds } from '../../services/visibility';
import {
  ConsentContactNotFoundError,
  InvalidUnsubscribeTokenError,
  getConsentState,
  recordMarketingConsent,
  unsubscribeByToken,
  withdrawMarketingConsent,
} from '../../services/consent';
import {
  MAX_BULK_ENROLL,
  addStep,
  archiveSequence,
  createSequence,
  deleteStep,
  enrollContact,
  enrollContacts,
  getSequence,
  listEnrollments,
  listSequences,
  listSteps,
  reorderSteps,
  unenrollContact,
  updateSequence,
  updateStep,
} from '../../services/sequences';

type IdParams = { id: string };
type StepParams = { id: string; stepId: string };
type EnrollmentParams = { id: string; enrollmentId: string };
type ContactParams = { contactId: string };
type TokenParams = { token: string };

type SequenceBody = {
  name: string;
  description?: string | null;
  status?: SequenceStatus;
  steps?: Array<{
    delay_days?: number;
    template_id?: string | null;
    subject?: string | null;
    body?: string | null;
  }>;
};

type SequencePatchBody = {
  name?: string;
  description?: string | null;
  status?: SequenceStatus;
};

type StepBody = {
  delay_days?: number;
  template_id?: string | null;
  subject?: string | null;
  body?: string | null;
};

type ReorderBody = { step_ids: string[] };
type EnrollBody = { contact_id: string };
type BulkEnrollBody = { contact_ids: string[] };
type ConsentBody = { source: string; consented_at?: string };

type SequenceListQuery = { status?: SequenceStatus; page?: number; per_page?: number };
type EnrollmentListQuery = { status?: SequenceEnrollmentStatus; page?: number; per_page?: number };

// HTTP status for each domain error code. Anything not listed is a bug, not a client
// error, and is rethrown so the Fastify error handler turns it into a 500.
const ERROR_STATUS: Record<string, number> = {
  SEQUENCE_NOT_FOUND: 404,
  SEQUENCE_STEP_NOT_FOUND: 404,
  ENROLLMENT_NOT_FOUND: 404,
  EMAIL_TEMPLATE_NOT_FOUND: 404,
  CONTACT_NOT_FOUND: 404,
  INVALID_UNSUBSCRIBE_TOKEN: 404,
  ALREADY_ENROLLED: 409,
  MARKETING_CONSENT_REQUIRED: 422,
  CONTACT_UNSUBSCRIBED: 422,
  CONTACT_NO_EMAIL: 422,
  SEQUENCE_NOT_ENROLLABLE: 422,
  SEQUENCE_HAS_NO_STEPS: 422,
  INVALID_SEQUENCE_STEP: 422,
  SEQUENCE_STEP_LIMIT_REACHED: 422,
  INVALID_STEP_ORDER: 422,
};

function handleSequenceError(error: unknown, reply: FastifyReply): FastifyReply {
  const code = (error as { code?: unknown }).code;
  const status = typeof code === 'string' ? ERROR_STATUS[code] : undefined;

  if (!status || typeof code !== 'string') {
    throw error;
  }

  const message = error instanceof Error ? error.message : 'Request failed';
  return reply.status(status).send({ error: { code, message } });
}

/**
 * Sequences are an org-wide marketing surface with legal exposure attached, so mutating
 * them is owner/admin only — the same bar `adminRoutePolicy` in api/authenticate.ts sets
 * for the other org-wide admin surfaces. Enforced here as well as there so the check holds
 * even if the route table and the policy table drift apart.
 *
 * Returns the reply when it denies, never undefined, so callers can `return` it and stop.
 */
export function denySequenceAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  const { role } = request.user;
  if (role === 'owner' || role === 'admin') {
    return null;
  }

  return reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'Only owner or admin can manage email sequences' },
  });
}

// ─── Sequence CRUD ────────────────────────────────────────────────────────────

async function list(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const query = request.query as SequenceListQuery;
  const page = query.page ?? 1;
  const perPage = query.per_page ?? 25;

  const { data, total } = await listSequences(request.user.org_id, {
    status: query.status,
    page,
    perPage,
  });

  return reply.send({ data, meta: { total, page, per_page: perPage } });
}

async function create(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const body = request.body as SequenceBody;

  try {
    const sequence = await createSequence({
      organizationId: request.user.org_id,
      createdBy: request.user.sub,
      name: body.name,
      description: body.description,
      status: body.status,
      steps: body.steps,
    });
    return reply.status(201).send({ data: sequence, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function getById(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;

  try {
    const sequence = await getSequence(id, request.user.org_id);
    return reply.send({ data: sequence, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function update(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;
  const body = request.body as SequencePatchBody;

  try {
    const sequence = await updateSequence(id, request.user.org_id, body);
    return reply.send({ data: sequence, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function archive(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;

  try {
    const result = await archiveSequence(id, request.user.org_id);
    return reply.send({ data: result, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

// ─── Steps ────────────────────────────────────────────────────────────────────

async function steps(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;

  try {
    const data = await listSteps(id, request.user.org_id);
    return reply.send({ data, meta: { total: data.length } });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function createStep(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;
  const body = request.body as StepBody;

  try {
    const step = await addStep(id, request.user.org_id, body);
    return reply.status(201).send({ data: step, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function patchStep(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { stepId } = request.params as StepParams;
  const body = request.body as StepBody;

  try {
    const step = await updateStep(stepId, request.user.org_id, body);
    return reply.send({ data: step, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function removeStep(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { stepId } = request.params as StepParams;

  try {
    const deleted = await deleteStep(stepId, request.user.org_id);
    return reply.send({ data: deleted, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function reorder(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;
  const body = request.body as ReorderBody;

  try {
    const data = await reorderSteps(id, request.user.org_id, body.step_ids);
    return reply.send({ data, meta: { total: data.length } });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

// ─── Enrollments ──────────────────────────────────────────────────────────────

async function enrollments(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;
  const query = request.query as EnrollmentListQuery;
  const page = query.page ?? 1;
  const perPage = query.per_page ?? 50;

  try {
    const { data, total } = await listEnrollments(id, request.user.org_id, {
      status: query.status,
      page,
      perPage,
    });
    return reply.send({ data, meta: { total, page, per_page: perPage } });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function enroll(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;
  const body = request.body as EnrollBody;

  try {
    const enrollment = await enrollContact({
      sequenceId: id,
      contactId: body.contact_id,
      organizationId: request.user.org_id,
      enrolledBy: request.user.sub,
    });

    await auditLog({
      action: 'sequence.enrolled',
      request,
      targetType: 'sequence_enrollment',
      targetId: id,
      metadata: { sequence_id: id, contact_id: body.contact_id },
    });

    return reply.status(201).send({ data: enrollment, meta: {} });
  } catch (error) {
    // A consent refusal is a legitimate, expected outcome — record the attempt so the
    // audit trail shows the mailing was withheld rather than silently lost.
    const code = (error as { code?: unknown }).code;
    if (code === 'MARKETING_CONSENT_REQUIRED' || code === 'CONTACT_UNSUBSCRIBED') {
      await auditLog({
        action: 'sequence.enrollment_refused',
        outcome: 'denied',
        request,
        targetType: 'contact',
        targetId: body.contact_id,
        metadata: { sequence_id: id, reason: code },
      });
    }

    return handleSequenceError(error, reply);
  }
}

async function enrollBulk(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { id } = request.params as IdParams;
  const body = request.body as BulkEnrollBody;
  const contactIds = body.contact_ids.slice(0, MAX_BULK_ENROLL);

  try {
    const result = await enrollContacts({
      sequenceId: id,
      contactIds,
      organizationId: request.user.org_id,
      enrolledBy: request.user.sub,
    });

    await auditLog({
      action: 'sequence.enrolled_bulk',
      request,
      targetType: 'sequence',
      targetId: id,
      metadata: {
        sequence_id: id,
        requested: contactIds.length,
        enrolled: result.enrolled.length,
        refused: result.refused.length,
      },
    });

    return reply.send({
      data: result,
      meta: {
        requested: contactIds.length,
        enrolled: result.enrolled.length,
        refused: result.refused.length,
      },
    });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

async function unenroll(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const denied = denySequenceAdmin(request, reply);
  if (denied) return denied;

  const { enrollmentId } = request.params as EnrollmentParams;

  try {
    const enrollment = await unenrollContact(enrollmentId, request.user.org_id);
    return reply.send({ data: enrollment, meta: {} });
  } catch (error) {
    return handleSequenceError(error, reply);
  }
}

// ─── Consent ──────────────────────────────────────────────────────────────────

/**
 * Consent is an operational act on a contact, not a sequence-admin act, so any non-viewer
 * may record or withdraw it — but only inside their visibility cone. Owner/admin get
 * `null` back from getAccessibleUserIds and are unrestricted.
 */
async function coneFor(request: FastifyRequest): Promise<string[] | null> {
  return getAccessibleUserIds({
    sub: request.user.sub,
    org_id: request.user.org_id,
    role: request.user.role,
  });
}

function handleConsentError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof ConsentContactNotFoundError || error instanceof InvalidUnsubscribeTokenError) {
    return reply.status(404).send({ error: { code: error.code, message: error.message } });
  }

  throw error;
}

async function consentState(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { contactId } = request.params as ContactParams;

  try {
    const state = await getConsentState(contactId, request.user.org_id, {
      accessibleUserIds: await coneFor(request),
    });
    return reply.send({ data: state, meta: {} });
  } catch (error) {
    return handleConsentError(error, reply);
  }
}

async function grantConsent(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { contactId } = request.params as ContactParams;
  const body = request.body as ConsentBody;

  try {
    const state = await recordMarketingConsent({
      contactId,
      organizationId: request.user.org_id,
      source: body.source,
      consentedAt: body.consented_at ? new Date(body.consented_at) : undefined,
      accessibleUserIds: await coneFor(request),
    });

    // The audit row is part of the ФЗ-38 evidence: who recorded the consent and when.
    await auditLog({
      action: 'consent.recorded',
      request,
      targetType: 'contact',
      targetId: contactId,
      metadata: { source: body.source, consented_at: state.marketing_consent_at?.toISOString() },
    });

    return reply.send({ data: state, meta: {} });
  } catch (error) {
    return handleConsentError(error, reply);
  }
}

async function revokeConsent(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { contactId } = request.params as ContactParams;

  try {
    const state = await withdrawMarketingConsent({
      contactId,
      organizationId: request.user.org_id,
      accessibleUserIds: await coneFor(request),
    });

    await auditLog({
      action: 'consent.withdrawn',
      request,
      targetType: 'contact',
      targetId: contactId,
      metadata: { stopped_enrollments: state.stopped_enrollments, source: 'crm_user' },
    });

    return reply.send({ data: state, meta: {} });
  } catch (error) {
    return handleConsentError(error, reply);
  }
}

/**
 * PUBLIC — no authentication. ФЗ-38 art. 18 requires refusal to be immediate and
 * effortless; possession of the unguessable token is the authorization. Must be listed in
 * `isPublicApiRoute()` in api/authenticate.ts or the global preHandler will 401 it.
 */
async function unsubscribe(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { token } = request.params as TokenParams;

  try {
    const result = await unsubscribeByToken(token);

    await auditLog({
      action: 'consent.unsubscribed',
      request,
      organizationId: result.organization_id,
      userId: null,
      targetType: 'contact',
      targetId: result.contact_id,
      metadata: {
        source: 'email_link',
        already_unsubscribed: result.already_unsubscribed,
        stopped_enrollments: result.stopped_enrollments,
      },
    });

    return reply.send({
      data: {
        unsubscribed: true,
        already_unsubscribed: result.already_unsubscribed,
        unsubscribed_at: result.unsubscribed_at,
      },
      meta: {},
    });
  } catch (error) {
    return handleConsentError(error, reply);
  }
}

export const SequencesController = {
  list,
  create,
  getById,
  update,
  archive,
  steps,
  createStep,
  patchStep,
  removeStep,
  reorder,
  enrollments,
  enroll,
  enrollBulk,
  unenroll,
};

export const ConsentController = {
  consentState,
  grantConsent,
  revokeConsent,
  unsubscribe,
};
