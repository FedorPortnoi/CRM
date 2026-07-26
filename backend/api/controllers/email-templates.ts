import { FastifyRequest, FastifyReply } from 'fastify';
import {
  EmailTemplateInUseError,
  EmailTemplateLimitError,
  EmailTemplateNotFoundError,
  TEMPLATE_PLACEHOLDERS,
  TemplateContactNotFoundError,
  createEmailTemplate,
  deleteEmailTemplate,
  getEmailTemplate,
  listEmailTemplates,
  previewEmailTemplate,
  renderEmailTemplate,
  sampleTemplateValues,
  unknownTemplatePlaceholders,
  updateEmailTemplate,
  loadContactTemplateValues,
  type TemplateRequester,
} from '../../services/email-templates';

type IdParams = { id: string };

type ListQuery = {
  page?: number;
  per_page?: number;
  q?: string;
};

type CreateBody = {
  name: string;
  subject: string;
  body: string;
};

type UpdateBody = Partial<CreateBody>;

type PreviewQuery = { contact_id?: string };

type DraftPreviewBody = {
  subject: string;
  body: string;
  contact_id?: string;
};

function requesterOf(request: FastifyRequest): TemplateRequester {
  return {
    sub: request.user.sub,
    org_id: request.user.org_id,
    role: request.user.role,
  };
}

/**
 * Templates are an org-wide asset, not a user-owned record: there is no
 * visibility cone dimension to them, so mutation is owner/admin and reading is
 * open to any member of the org. (Previewing against a specific contact DOES go
 * through the cone — that check lives in the service, next to the query.)
 */
function requireTemplateAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const { role } = request.user;
  if (role !== 'owner' && role !== 'admin') {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Only owner or admin can manage email templates' },
    });
    return false;
  }
  return true;
}

function handleTemplateError(error: unknown, reply: FastifyReply): void {
  if (error instanceof EmailTemplateNotFoundError || error instanceof TemplateContactNotFoundError) {
    reply.status(404).send({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof EmailTemplateLimitError) {
    reply.status(422).send({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof EmailTemplateInUseError) {
    reply.status(409).send({ error: { code: error.code, message: error.message } });
    return;
  }

  throw error;
}

async function placeholders(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send({
    data: TEMPLATE_PLACEHOLDERS.map((placeholder) => ({ ...placeholder })),
    meta: { total: TEMPLATE_PLACEHOLDERS.length },
  });
}

async function list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = request.query as ListQuery;
  const page = query.page ?? 1;
  const perPage = query.per_page ?? 25;

  const { data, total } = await listEmailTemplates(request.user.org_id, {
    page,
    per_page: perPage,
    q: query.q,
  });

  reply.send({ data, meta: { total, page, per_page: perPage } });
}

async function getById(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;

  try {
    const template = await getEmailTemplate(id, request.user.org_id);
    reply.send({
      data: template,
      meta: { unknown_placeholders: unknownTemplatePlaceholders(template) },
    });
  } catch (error) {
    handleTemplateError(error, reply);
  }
}

async function create(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireTemplateAdmin(request, reply)) return;

  const body = request.body as CreateBody;

  try {
    const template = await createEmailTemplate({
      organizationId: request.user.org_id,
      createdBy: request.user.sub,
      name: body.name,
      subject: body.subject,
      body: body.body,
    });

    // A typo like {{frist_name}} is reported, not rejected: extra keys can be
    // legitimately supplied at send time, but the author has to see it here
    // rather than in the customer's inbox.
    reply.status(201).send({
      data: template,
      meta: { unknown_placeholders: unknownTemplatePlaceholders(template) },
    });
  } catch (error) {
    handleTemplateError(error, reply);
  }
}

async function update(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireTemplateAdmin(request, reply)) return;

  const { id } = request.params as IdParams;
  const body = request.body as UpdateBody;

  try {
    const template = await updateEmailTemplate(id, request.user.org_id, {
      name: body.name,
      subject: body.subject,
      body: body.body,
    });

    reply.send({
      data: template,
      meta: { unknown_placeholders: unknownTemplatePlaceholders(template) },
    });
  } catch (error) {
    handleTemplateError(error, reply);
  }
}

async function remove(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireTemplateAdmin(request, reply)) return;

  const { id } = request.params as IdParams;

  try {
    const deleted = await deleteEmailTemplate(id, request.user.org_id);
    reply.send({ data: deleted, meta: {} });
  } catch (error) {
    handleTemplateError(error, reply);
  }
}

/** GET /:id/preview?contact_id=… — read-only, so viewers can use it too. */
async function preview(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as IdParams;
  const query = request.query as PreviewQuery;

  try {
    const rendered = await previewEmailTemplate(id, requesterOf(request), {
      contact_id: query.contact_id,
    });

    reply.send({
      data: rendered,
      meta: {
        contact_id: query.contact_id ?? null,
        sample: query.contact_id === undefined,
      },
    });
  } catch (error) {
    handleTemplateError(error, reply);
  }
}

/** POST /preview — render an unsaved draft. Same authoring right as create. */
async function previewDraft(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireTemplateAdmin(request, reply)) return;

  const body = request.body as DraftPreviewBody;

  try {
    const values = body.contact_id
      ? await loadContactTemplateValues(body.contact_id, requesterOf(request))
      : sampleTemplateValues();

    reply.send({
      data: renderEmailTemplate({ subject: body.subject, body: body.body }, values),
      meta: {
        contact_id: body.contact_id ?? null,
        sample: body.contact_id === undefined,
        unknown_placeholders: unknownTemplatePlaceholders({
          subject: body.subject,
          body: body.body,
        }),
      },
    });
  } catch (error) {
    handleTemplateError(error, reply);
  }
}

export const EmailTemplatesController = {
  placeholders,
  list,
  getById,
  create,
  update,
  remove,
  preview,
  previewDraft,
};
