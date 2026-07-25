import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ContactsController } from '../controllers/contacts';
import { DEFAULT_RADIUS_METERS, MAX_RADIUS_METERS } from '../../services/nearby';
import { authenticate } from '../preHandlers';

const CreateContactSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  mobile: z.string().max(30).optional(),
  tags: z.array(z.string()).max(20).optional(),
  source: z.string().max(100).optional(),
  notes: z.string().max(5000).optional(),
  assigned_to: z.string().uuid().optional(),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

const UpdateContactSchema = CreateContactSchema.partial().extend({
  email: z.union([z.string().email(), z.literal('')]).optional(),
});

const ImportContactRowSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).optional(),
  company: z.string().trim().max(200).optional(),
  email: z.union([z.string().trim().email(), z.string().trim().length(0)]).optional(),
  phone: z.string().trim().max(30).optional(),
  mobile: z.string().trim().max(30).optional(),
  source: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(5000).optional(),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
});

const ImportContactsCsvSchema = z.array(ImportContactRowSchema).min(1).max(500);

const BusinessCardSchema = z.object({
  text: z.string().max(10000).optional(),
  image_base64: z.string().max(10_000_000).optional(),
  create_contact: z.boolean().default(false),
}).refine((body) => Boolean(body.text || body.image_base64), {
  message: 'text or image_base64 is required',
});

const BulkArchiveSchema = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(100),
});

const BulkAssignSchema = BulkArchiveSchema.extend({
  assigned_to: z.string().uuid(),
});

const ContactFilterSchema = z.object({
  q: z.string().optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
  assigned_to: z.string().uuid().optional(),
  scope: z.enum(['direct', 'subtree']).optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  last_contacted_before: z.string().datetime().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['created_at', 'updated_at', 'first_name', 'company']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// `z.coerce.number()` turns an empty query value into 0, which for a coordinate is
// a real point on the globe (the equator) rather than a missing one. Parse by hand
// so a blank or unparsable value fails instead of silently relocating the rep.
function numericQueryParam<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') {
      return value;
    }
    const trimmed = value.trim();
    return trimmed === '' ? Number.NaN : Number(trimmed);
  }, schema);
}

const NearbyContactsSchema = z.object({
  latitude: numericQueryParam(z.number().min(-90).max(90)),
  longitude: numericQueryParam(z.number().min(-180).max(180)),
  radius_m: numericQueryParam(z.number().min(1).max(MAX_RADIUS_METERS)).default(DEFAULT_RADIUS_METERS),
  limit: numericQueryParam(z.number().int().min(1).max(100)).default(50),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  scope: z.enum(['direct', 'subtree']).optional(),
});

export default async function contactsRoutes(fastify: FastifyInstance) {
  for (const contentType of ['application/octet-stream', 'audio/l16', 'audio/wav', 'audio/x-wav']) {
    if (!fastify.hasContentTypeParser(contentType)) {
      fastify.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => {
        done(null, body);
      });
    }
  }

  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: ContactFilterSchema },
  }, ContactsController.list);

  // Registered ahead of '/:id' for readability — Fastify prefers static segments
  // over parametric ones regardless of order.
  f.get('/nearby', {
    preHandler: [authenticate],
    schema: { querystring: NearbyContactsSchema },
  }, ContactsController.nearby);

  f.post('/', {
    preHandler: [authenticate],
    schema: { body: CreateContactSchema },
  }, ContactsController.create);

  f.get('/:id', { preHandler: [authenticate] }, ContactsController.getById);

  f.patch('/:id', {
    preHandler: [authenticate],
    schema: { body: UpdateContactSchema },
  }, ContactsController.update);

  f.delete('/:id', { preHandler: [authenticate] }, ContactsController.archive);

  f.get('/:id/activity', { preHandler: [authenticate] }, ContactsController.getActivity);
  f.get('/:id/deals', { preHandler: [authenticate] }, ContactsController.getDeals);
  f.get('/:id/tasks', { preHandler: [authenticate] }, ContactsController.getTasks);

  f.post('/import-csv', {
    preHandler: [authenticate],
    schema: { body: ImportContactsCsvSchema },
  }, ContactsController.importCsv);

  f.post('/business-card/scan', {
    preHandler: [authenticate],
    schema: { body: BusinessCardSchema },
  }, ContactsController.scanBusinessCard);

  f.post('/bulk-assign', {
    preHandler: [authenticate],
    schema: { body: BulkAssignSchema },
  }, ContactsController.bulkAssign);

  f.post('/bulk-archive', {
    preHandler: [authenticate],
    schema: { body: BulkArchiveSchema },
  }, ContactsController.bulkArchive);
}
