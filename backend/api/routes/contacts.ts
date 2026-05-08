import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ContactsController } from '../controllers/contacts';

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

const MergeContactSchema = z.object({
  source_id: z.string().uuid(),
});

const BulkArchiveSchema = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(100),
});

const BulkAssignSchema = BulkArchiveSchema.extend({
  assigned_to: z.string().uuid(),
});

const ContactFilterSchema = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  type: z.enum(['lead', 'customer', 'partner', 'other']).optional(),
  assigned_to: z.string().uuid().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['created_at', 'updated_at', 'first_name', 'company']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function contactsRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/', {
    preHandler: [authenticate],
    schema: { querystring: ContactFilterSchema },
  }, ContactsController.list);

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
  f.get('/:id/messages', { preHandler: [authenticate] }, ContactsController.getMessages);
  f.get('/:id/events', { preHandler: [authenticate] }, ContactsController.getCalendarEvents);

  f.post('/import-csv', {
    preHandler: [authenticate],
    schema: { body: ImportContactsCsvSchema },
  }, ContactsController.importCsv);
  f.post('/import', {
    preHandler: [authenticate],
    schema: { body: ImportContactsCsvSchema },
  }, ContactsController.importCsv);
  f.post('/import/phone', { preHandler: [authenticate] }, ContactsController.importFromPhone);
  f.post('/bulk-assign', {
    preHandler: [authenticate],
    schema: { body: BulkAssignSchema },
  }, ContactsController.bulkAssign);
  f.post('/bulk-tag', { preHandler: [authenticate] }, ContactsController.bulkTag);
  f.post('/bulk-archive', {
    preHandler: [authenticate],
    schema: { body: BulkArchiveSchema },
  }, ContactsController.bulkArchive);

  f.post('/:id/merge', {
    preHandler: [authenticate],
    schema: { body: MergeContactSchema },
  }, ContactsController.merge);
}
