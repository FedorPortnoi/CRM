import { ContactStatus } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';
import { requireMcpWrite } from '../validation';
import {
  listContactsForUser,
  getContactForUser,
  createContactForUser,
  updateContactForUser,
  archiveContactForUser,
  ContactNotFoundError,
  ContactForbiddenError,
  type ContactBody,
} from '../../services/contact-domain';

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

    return listContactsForUser(user.org_id, user, { q, status, type, page, per_page });
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
    try {
      const contact = await getContactForUser(id, user.org_id);
      return { data: contact };
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return { error: { code: err.code, message: err.message } };
      }
      throw err;
    }
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
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const first_name = typeof args.first_name === 'string' ? args.first_name.trim() : '';
    if (!first_name) {
      return { error: { code: 'VALIDATION_ERROR', message: 'first_name is required' } };
    }

    const body: ContactBody = {
      first_name,
      last_name: typeof args.last_name === 'string' ? args.last_name : undefined,
      company: typeof args.company === 'string' ? args.company : undefined,
      email: typeof args.email === 'string' ? args.email : undefined,
      phone: typeof args.phone === 'string' ? args.phone : undefined,
      mobile: typeof args.mobile === 'string' ? args.mobile : undefined,
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
      source: typeof args.source === 'string' ? args.source : undefined,
      notes: typeof args.notes === 'string' ? args.notes : undefined,
      assigned_to: typeof args.assigned_to === 'string' ? args.assigned_to : undefined,
      type: isContactType(args.type) ? args.type : undefined,
    };

    try {
      const contact = await createContactForUser(user.org_id, user.sub, body);
      return { data: contact };
    } catch (err) {
      if (err instanceof ContactForbiddenError) {
        return { error: { code: err.code, message: err.message } };
      }
      throw err;
    }
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
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    const patch: Partial<ContactBody> = {};
    if (typeof args.first_name === 'string') patch.first_name = args.first_name;
    if (typeof args.last_name === 'string') patch.last_name = args.last_name;
    if (typeof args.company === 'string') patch.company = args.company;
    if (typeof args.email === 'string') patch.email = args.email;
    if (typeof args.phone === 'string') patch.phone = args.phone;
    if (typeof args.mobile === 'string') patch.mobile = args.mobile;
    if (Array.isArray(args.tags)) patch.tags = args.tags as string[];
    if (typeof args.source === 'string') patch.source = args.source;
    if (typeof args.notes === 'string') patch.notes = args.notes;
    if (typeof args.assigned_to === 'string') patch.assigned_to = args.assigned_to;
    if (isContactType(args.type)) patch.type = args.type;

    try {
      const contact = await updateContactForUser(id, user.org_id, user.sub, patch);
      return { data: contact };
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return { error: { code: err.code, message: err.message } };
      }
      if (err instanceof ContactForbiddenError) {
        return { error: { code: err.code, message: err.message } };
      }
      throw err;
    }
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
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    try {
      const contact = await archiveContactForUser(id, user.org_id, user.sub);
      return { data: contact };
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return { error: { code: err.code, message: err.message } };
      }
      throw err;
    }
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
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

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
