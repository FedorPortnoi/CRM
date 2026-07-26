/**
 * Email template routes. Mount under /api/v1/email-templates.
 *
 * Every route here is AUTHENTICATED — none of them belongs on the public
 * allowlist. (The one public route in this feature is the tracking pixel; see
 * backend/api/routes/tracking.ts.)
 *
 * Route ordering note: '/placeholders' and '/preview' are declared before the
 * '/:id' family so they are matched as static segments rather than swallowed as
 * an id.
 */

import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { EmailTemplatesController } from '../controllers/email-templates';
import { authenticate } from '../preHandlers';
import {
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
} from '../../services/email-templates';

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().min(1).max(200).optional(),
});

const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TEMPLATE_NAME_LENGTH),
  subject: z.string().min(1).max(MAX_TEMPLATE_SUBJECT_LENGTH),
  body: z.string().min(1).max(MAX_TEMPLATE_BODY_LENGTH),
});

const UpdateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TEMPLATE_NAME_LENGTH).optional(),
  subject: z.string().min(1).max(MAX_TEMPLATE_SUBJECT_LENGTH).optional(),
  body: z.string().min(1).max(MAX_TEMPLATE_BODY_LENGTH).optional(),
});

const PreviewQuerySchema = z.object({
  contact_id: z.string().uuid().optional(),
});

const DraftPreviewSchema = z.object({
  subject: z.string().max(MAX_TEMPLATE_SUBJECT_LENGTH).default(''),
  body: z.string().max(MAX_TEMPLATE_BODY_LENGTH).default(''),
  contact_id: z.string().uuid().optional(),
});

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export default async function emailTemplatesRoutes(fastify: FastifyInstance): Promise<void> {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/placeholders', { preHandler: [authenticate] }, EmailTemplatesController.placeholders);

  f.post('/preview', {
    preHandler: [authenticate],
    schema: { body: DraftPreviewSchema },
  }, EmailTemplatesController.previewDraft);

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: ListQuerySchema },
  }, EmailTemplatesController.list);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateTemplateSchema },
  }, EmailTemplatesController.create);

  f.get('/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema },
  }, EmailTemplatesController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema, body: UpdateTemplateSchema },
  }, EmailTemplatesController.update);

  f.delete('/:id', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema },
  }, EmailTemplatesController.remove);

  f.get('/:id/preview', {
    preHandler: [authenticate],
    schema: { params: IdParamSchema, querystring: PreviewQuerySchema },
  }, EmailTemplatesController.preview);
}
