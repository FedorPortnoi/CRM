import { Prisma, ContactStatus } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';

type ContactTypeValue = 'lead' | 'customer' | 'partner' | 'other';
type ContactStatusValue = 'active' | 'inactive' | 'archived';

function isContactStatus(v: unknown): v is ContactStatusValue {
  return v === 'active' || v === 'inactive' || v === 'archived';
}

function isContactType(v: unknown): v is ContactTypeValue {
  return v === 'lead' || v === 'customer' || v === 'partner' || v === 'other';
}

registerTool(
  'get_contacts',
  'List contacts for the authenticated org with optional search and filters',
  {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query across name, email, phone, company' },
      status: { type: 'string', enum: ['active', 'inactive', 'archived'] },
      type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
      page: { type: 'integer', default: 1 },
      per_page: { type: 'integer', default: 20, maximum: 100 },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const q = typeof args.q === 'string' ? args.q : undefined;
    const status = isContactStatus(args.status) ? args.status : undefined;
    const type = isContactType(args.type) ? args.type : undefined;
    const page = typeof args.page === 'number' ? Math.max(1, Math.floor(args.page)) : 1;
    const per_page = typeof args.per_page === 'number' ? Math.min(100, Math.max(1, Math.floor(args.per_page))) : 20;

    const where: Prisma.ContactWhereInput = {
      organization_id: user.org_id,
      status: status ?? { not: ContactStatus.archived },
      ...(type && { type }),
      ...(q && {
        OR: [
          { first_name: { contains: q, mode: 'insensitive' } },
          { last_name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { company: { contains: q, mode: 'insensitive' } },
        ],
      }),
    };

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { created_at: 'desc' },
      }),
      db.contact.count({ where }),
    ]);

    return { data: contacts, meta: { total, page, per_page } };
  },
);

registerTool(
  'get_contact',
  'Get a single contact by ID',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const contact = await db.contact.findFirst({
      where: { id, organization_id: user.org_id },
      include: { assignee: { select: { id: true, name: true } } },
    });

    if (!contact) {
      return { error: { code: 'NOT_FOUND', message: 'Contact not found' } };
    }

    return { data: contact };
  },
);

registerTool(
  'create_contact',
  'Create a new contact in the org',
  {
    type: 'object',
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      company: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      mobile: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      source: { type: 'string' },
      notes: { type: 'string' },
      assigned_to: { type: 'string', description: 'User UUID' },
      type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
    },
    required: ['first_name'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const first_name = typeof args.first_name === 'string' ? args.first_name.trim() : '';
    if (!first_name) {
      return { error: { code: 'VALIDATION_ERROR', message: 'first_name is required' } };
    }
    const last_name = typeof args.last_name === 'string' ? args.last_name : undefined;
    const company = typeof args.company === 'string' ? args.company : undefined;
    const email = typeof args.email === 'string' ? args.email : undefined;
    const phone = typeof args.phone === 'string' ? args.phone : undefined;
    const mobile = typeof args.mobile === 'string' ? args.mobile : undefined;
    const tags = Array.isArray(args.tags) ? (args.tags as Prisma.InputJsonValue) : undefined;
    const source = typeof args.source === 'string' ? args.source : undefined;
    const notes = typeof args.notes === 'string' ? args.notes : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;
    const type = isContactType(args.type) ? args.type : undefined;

    const contact = await db.contact.create({
      data: {
        first_name,
        last_name,
        company,
        email,
        phone,
        mobile,
        tags,
        source,
        notes,
        assigned_to,
        type,
        organization_id: user.org_id,
        created_by: user.sub,
      },
    });

    return { data: contact };
  },
);

registerTool(
  'update_contact',
  'Update fields on an existing contact',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact UUID' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      company: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      mobile: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      source: { type: 'string' },
      notes: { type: 'string' },
      assigned_to: { type: 'string' },
      type: { type: 'string', enum: ['lead', 'customer', 'partner', 'other'] },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const existing = await db.contact.findFirst({
      where: { id, organization_id: user.org_id },
    });

    if (!existing || existing.status === ContactStatus.archived) {
      return { error: { code: 'NOT_FOUND', message: 'Contact not found' } };
    }

    const updateData: Prisma.ContactUncheckedUpdateInput = {};
    if (typeof args.first_name === 'string') updateData.first_name = args.first_name;
    if (typeof args.last_name === 'string') updateData.last_name = args.last_name;
    if (typeof args.company === 'string') updateData.company = args.company;
    if (typeof args.email === 'string') updateData.email = args.email;
    if (typeof args.phone === 'string') updateData.phone = args.phone;
    if (typeof args.mobile === 'string') updateData.mobile = args.mobile;
    if (Array.isArray(args.tags)) updateData.tags = args.tags as Prisma.InputJsonValue;
    if (typeof args.source === 'string') updateData.source = args.source;
    if (typeof args.notes === 'string') updateData.notes = args.notes;
    if (typeof args.assigned_to === 'string') updateData.assigned_to = args.assigned_to;
    if (isContactType(args.type)) updateData.type = args.type;

    const contact = await db.contact.update({ where: { id }, data: updateData });

    return { data: contact };
  },
);

registerTool(
  'archive_contact',
  'Archive a contact by ID',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const existing = await db.contact.findFirst({
      where: { id, organization_id: user.org_id },
    });

    if (!existing) {
      return { error: { code: 'NOT_FOUND', message: 'Contact not found' } };
    }

    const contact = await db.contact.update({
      where: { id },
      data: { status: ContactStatus.archived },
    });

    return { data: contact };
  },
);

registerTool(
  'merge_contacts',
  'Merge source contact into target contact (source archived; all linked deals/tasks/messages/events moved to target)',
  {
    type: 'object',
    properties: {
      target_id: { type: 'string', description: 'UUID of the contact to keep' },
      source_id: { type: 'string', description: 'UUID of the contact to merge and archive' },
    },
    required: ['target_id', 'source_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const target_id = typeof args.target_id === 'string' ? args.target_id : '';
    const source_id = typeof args.source_id === 'string' ? args.source_id : '';

    if (source_id === target_id) {
      return { error: { code: 'INVALID_MERGE', message: 'Source and target must be different contacts' } };
    }

    const [source, target] = await Promise.all([
      db.contact.findFirst({ where: { id: source_id, organization_id: user.org_id } }),
      db.contact.findFirst({ where: { id: target_id, organization_id: user.org_id } }),
    ]);

    if (!source) {
      return { error: { code: 'NOT_FOUND', message: 'Source contact not found' } };
    }

    if (!target) {
      return { error: { code: 'NOT_FOUND', message: 'Target contact not found' } };
    }

    await db.$transaction(async (tx) => {
      await tx.deal.updateMany({
        where: { contact_id: source_id, organization_id: user.org_id },
        data: { contact_id: target_id },
      });
      await tx.task.updateMany({
        where: { contact_id: source_id, organization_id: user.org_id },
        data: { contact_id: target_id },
      });
      await tx.message.updateMany({
        where: { contact_id: source_id, organization_id: user.org_id },
        data: { contact_id: target_id },
      });
      await tx.calendarEvent.updateMany({
        where: { contact_id: source_id, organization_id: user.org_id },
        data: { contact_id: target_id },
      });
      await tx.contact.update({
        where: { id: source_id },
        data: { status: ContactStatus.archived },
      });
    });

    const updated = await db.contact.findFirst({
      where: { id: target_id, organization_id: user.org_id },
      include: { assignee: { select: { id: true, name: true } } },
    });

    return { data: updated ?? target };
  },
);
