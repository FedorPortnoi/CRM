import { can } from '../../services/capabilities';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SequenceEnrollmentStatus, SequenceStatus } from '@prisma/client';
import { auditLog } from '../../services/audit';
import { getAccessibleUserIds } from '../../services/visibility';
import {
  ConsentContactNotFoundError,
  ConsentGrantForbiddenError,
  GRANT_CONSENT_CAPABILITY,
  InvalidUnsubscribeTokenError,
  canGrantMarketingConsent,
  getConsentState,
  recordMarketingConsent,
  unsubscribeByToken,
  validateUnsubscribeToken,
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
 * The 403 body for this surface. Exported because `adminRoutePolicy` in api/authenticate.ts
 * now denies first and must answer with the SAME bytes — a client that has always seen this
 * sentence must not start seeing a different one just because the gate moved earlier in the
 * pipeline. The literal is repeated there rather than imported: authenticate.ts is a leaf
 * that pulls in only db/sessions/capabilities, and importing this controller would drag the
 * whole sequences → email → encryption chain into the request-gate module. Both copies are
 * pinned by tests (sequences.test.ts and authenticate.test.ts), so drift fails loudly.
 */
export const SEQUENCE_ADMIN_DENIAL_MESSAGE = 'Only owner or admin can manage email sequences';

/**
 * Sequences are an org-wide marketing surface with legal exposure attached, so mutating
 * them is owner/admin only — the same bar `adminRoutePolicy` in api/authenticate.ts sets
 * for the other org-wide admin surfaces. That policy entry exists now
 * (`sequences.manage_admin` → `sequences.manage`) and is what AUDITS the denial; this check
 * is kept as the second door so the gate holds even if the route table and the policy table
 * drift apart. Deliberately writes no audit row of its own: the preHandler returns before
 * the handler runs, so auditing here too would only ever double-log.
 *
 * Returns the reply when it denies, never undefined, so callers can `return` it and stop.
 */
export function denySequenceAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  const { role } = request.user;
  // sequences.manage, NOT visibility.all. These are not the same set:
  // visibility.all is held by accountant and marketer, sequences.manage only by
  // marketer (plus owner/admin). Checking the wrong one let `accountant` — a
  // role whose whole point is "deliberately no writes at all" — read every
  // campaign, step and enrollment list, and would have handed it full mutation
  // of marketing email the day accountant was granted any write capability.
  if (can(role, 'sequences.manage')) {
    return null;
  }

  return reply.status(403).send({
    error: { code: 'FORBIDDEN', message: SEQUENCE_ADMIN_DENIAL_MESSAGE },
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

  // The service raises this too, so a caller that reaches recordMarketingConsent without
  // passing the gate below still answers 403 rather than 500.
  if (error instanceof ConsentGrantForbiddenError) {
    return reply.status(403).send({ error: { code: error.code, message: error.message } });
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

  // GRANTING is gated, withdrawing is not — see GRANT_CONSENT_CAPABILITY in
  // services/consent.ts. This call writes the evidence that a mailing is lawful and, on a
  // contact who had opted out, clears `unsubscribed_at` and puts them back in scope; on the
  // strength of `contacts.write` alone, a менеджер or a support operator could reverse a
  // recipient's legal refusal with a free-text `source` and nothing would look wrong.
  if (!canGrantMarketingConsent(request.user.role)) {
    // Denied on the consent ledger is itself evidence — record who tried.
    await auditLog({
      action: 'consent.record_refused',
      outcome: 'denied',
      request,
      targetType: 'contact',
      targetId: contactId,
      metadata: {
        reason: 'missing_capability',
        required: GRANT_CONSENT_CAPABILITY,
        role: request.user.role,
      },
    });

    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'Recording marketing consent requires a role that manages email sequences',
      },
    });
  }

  try {
    const state = await recordMarketingConsent({
      contactId,
      organizationId: request.user.org_id,
      source: body.source,
      consentedAt: body.consented_at ? new Date(body.consented_at) : undefined,
      accessibleUserIds: await coneFor(request),
      actorRole: request.user.role,
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

// ─── Public unsubscribe (GET renders, POST acts) ──────────────────────────────

/**
 * The opt-out page is served to a mail client's browser, so it carries its own styling and
 * references nothing external — no CDN, no font, no image. Inline `<style>` survives the
 * app's CSP (helmet's default `style-src` allows it); if a stricter policy ever strips it
 * the page is still a heading, a sentence and a button.
 */
const UNSUBSCRIBE_PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 2rem 1rem; min-height: 100vh; box-sizing: border-box;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    background: #f5f5f7; color: #1c1c1e;
  }
  main {
    max-width: 34rem; margin: 0 auto; padding: 1.75rem; border-radius: 14px;
    background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,.12);
  }
  h1 { margin: 0 0 1rem; font-size: 1.35rem; line-height: 1.3; }
  p { margin: 0 0 1rem; }
  ul { margin: 0 0 1rem; padding-left: 1.25rem; }
  li { margin-bottom: .35rem; }
  button {
    appearance: none; border: 0; border-radius: 10px; cursor: pointer;
    padding: .85rem 1.4rem; font-size: 1rem; font-weight: 600;
    background: #1c1c1e; color: #ffffff;
  }
  .note { font-size: .875rem; color: #6b6b70; margin-bottom: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f0f11; color: #f2f2f4; }
    main { background: #1c1c1f; box-shadow: none; }
    button { background: #f2f2f4; color: #1c1c1e; }
    .note { color: #9a9aa0; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Self-contained page shell. Russian, because the recipients are. */
function renderUnsubscribeHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${UNSUBSCRIBE_PAGE_STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/**
 * The confirmation page. `action` is this request's own path, so the form posts back to the
 * same URL whatever prefix the deployment is mounted behind.
 */
function renderUnsubscribeConfirmation(action: string): string {
  return renderUnsubscribeHtml(
    'Отказ от рекламной рассылки',
    `<h1>Отписаться от рекламной рассылки?</h1>
<p>Чтобы отказаться, нажмите кнопку ниже. Пока вы её не нажали, ничего не изменилось.</p>
<p>После подтверждения:</p>
<ul>
<li>рекламные письма на ваш адрес больше не отправляются;</li>
<li>все уже запущенные для вас цепочки писем останавливаются немедленно;</li>
<li>отказ действует по всей организации-отправителю, а не только для одной рассылки;</li>
<li>отменить его можно только по вашему новому согласию.</li>
</ul>
<p>Отказ не удаляет ваши данные и не касается служебной переписки — ответов на ваши обращения и писем по действующему договору.</p>
<form method="post" action="${escapeHtml(action)}">
<button type="submit">Отказаться от рассылки</button>
</form>
<p class="note">Отказ от рекламы в любой момент — ст. 18 Федерального закона «О рекламе» (ФЗ-38).</p>`,
  );
}

function renderUnsubscribeDone(alreadyUnsubscribed: boolean): string {
  return renderUnsubscribeHtml(
    'Вы отписаны',
    `<h1>${alreadyUnsubscribed ? 'Вы уже отписаны' : 'Вы отписаны'}</h1>
<p>Рекламные письма на ваш адрес больше не отправляются, все запущенные цепочки писем остановлены.</p>
<p class="note">Служебная переписка — ответы на ваши обращения и письма по действующему договору — этим отказом не затрагивается.</p>`,
  );
}

function renderUnsubscribeInvalid(): string {
  return renderUnsubscribeHtml(
    'Ссылка недействительна',
    `<h1>Ссылка недействительна</h1>
<p>Возможно, она скопирована не полностью или уже не действует.</p>
<p>Если вы продолжаете получать рекламные письма, ответьте на любое из них с просьбой отписать вас — этого достаточно.</p>`,
  );
}

/** The page's own URL, without the query string. */
function selfPath(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

/**
 * RFC 8058 one-click. The mail provider POSTs `List-Unsubscribe=One-Click` as a form body
 * and expects the action to happen with no further interaction — no page, no button. The
 * header name is matched case-insensitively because the field is copied by hand into a lot
 * of sending stacks.
 */
function isOneClickUnsubscribe(request: FastifyRequest): boolean {
  const body = request.body;
  if (!body || typeof body !== 'object') {
    return false;
  }

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key.toLowerCase() === 'list-unsubscribe') {
      return typeof value === 'string' && value.trim().toLowerCase() === 'one-click';
    }
  }

  return false;
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * PUBLIC — no authentication. ФЗ-38 art. 18 requires refusal to be immediate and
 * effortless; possession of the unguessable token is the authorization. Must be listed in
 * `isPublicApiRoute()` in api/authenticate.ts or the global preHandler will 401 it.
 *
 * GET RENDERS, IT DOES NOT UNSUBSCRIBE. Enterprise mail scanners (Defender Safe Links,
 * Proofpoint URL Defense) fetch every link in a message at delivery time; when the opt-out
 * was performed on GET they unsubscribed recipients who never clicked, silently, before the
 * message was even opened. The only trace was a `consent.unsubscribed` audit row that
 * looked exactly like a real click. So the state change moved to POST and this handler
 * only reads: token validation is unchanged, nothing is written.
 */
async function unsubscribePage(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { token } = request.params as TokenParams;

  const contact = await validateUnsubscribeToken(token);
  if (!contact) {
    return reply.status(404).type('text/html; charset=utf-8').send(renderUnsubscribeInvalid());
  }

  // Already opted out: show the outcome rather than a button that would do nothing.
  if (contact.unsubscribed_at) {
    return reply.type('text/html; charset=utf-8').send(renderUnsubscribeDone(true));
  }

  return reply
    .type('text/html; charset=utf-8')
    .send(renderUnsubscribeConfirmation(selfPath(request)));
}

/**
 * PUBLIC — no authentication. This is the handler that actually withdraws consent: reached
 * either from the button on the page above, or straight from a mail provider's RFC 8058
 * one-click POST, which gets the action with no page in between.
 *
 * The JSON body shape is unchanged for programmatic callers; a browser submitting the form
 * (Accept: text/html) gets the confirmation page instead.
 */
async function unsubscribe(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { token } = request.params as TokenParams;
  const oneClick = isOneClickUnsubscribe(request);

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
        source: oneClick ? 'list_unsubscribe_one_click' : 'email_link',
        already_unsubscribed: result.already_unsubscribed,
        stopped_enrollments: result.stopped_enrollments,
      },
    });

    if (!oneClick && acceptsHtml(request)) {
      return reply
        .type('text/html; charset=utf-8')
        .send(renderUnsubscribeDone(result.already_unsubscribed));
    }

    return reply.send({
      data: {
        unsubscribed: true,
        already_unsubscribed: result.already_unsubscribed,
        unsubscribed_at: result.unsubscribed_at,
      },
      meta: {},
    });
  } catch (error) {
    // A dead token from a browser form deserves the page, not a JSON blob.
    if (!oneClick && acceptsHtml(request) && error instanceof InvalidUnsubscribeTokenError) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderUnsubscribeInvalid());
    }

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
  unsubscribePage,
  unsubscribe,
};
