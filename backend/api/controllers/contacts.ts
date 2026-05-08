import { FastifyRequest, FastifyReply } from 'fastify';
import { ContactStatus, Prisma, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';

type ContactBody = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  tags?: string[];
  source?: string;
  notes?: string;
  assigned_to?: string;
  type?: 'lead' | 'customer' | 'partner' | 'other';
  custom_fields?: Prisma.InputJsonValue;
};

type BulkArchiveBody = {
  contact_ids: string[];
};

type BulkAssignBody = BulkArchiveBody & {
  assigned_to: string;
};

type ContactImportRow = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  source?: string;
  notes?: string;
  type?: 'lead' | 'customer' | 'partner' | 'other';
};

function optionalTrimmedString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function userBelongsToOrg(userId: string, orgId: string): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, organization_id: orgId },
    select: { id: true },
  });
  return user !== null;
}

export const ContactsController = {
  list: async (request: FastifyRequest, reply: FastifyReply) => {
    const { q, status, type, assigned_to, tag, page, per_page, sort, order } = request.query as {
      q?: string;
      status?: 'active' | 'inactive' | 'archived';
      type?: 'lead' | 'customer' | 'partner' | 'other';
      assigned_to?: string;
      tag?: string;
      source?: string;
      page: number;
      per_page: number;
      sort: 'created_at' | 'updated_at' | 'first_name' | 'company';
      order: 'asc' | 'desc';
    };

    const where: Prisma.ContactWhereInput = {
      organization_id: request.user.org_id,
      status: status ?? { not: ContactStatus.archived },
      ...(type && { type }),
      ...(assigned_to && { assigned_to }),
      ...(tag && { tags: { array_contains: tag } }),
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
        orderBy: { [sort]: order },
      }),
      db.contact.count({ where }),
    ]);

    return reply.send({ data: contacts, meta: { total, page, per_page } });
  },

  create: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ContactBody;

    if (body.assigned_to !== undefined && body.assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(body.assigned_to, request.user.org_id);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    const data: Prisma.ContactUncheckedCreateInput = {
      first_name: body.first_name,
      last_name: body.last_name,
      company: body.company,
      email: body.email,
      phone: body.phone,
      mobile: body.mobile,
      tags: body.tags,
      source: body.source,
      notes: body.notes,
      assigned_to: body.assigned_to,
      type: body.type,
      custom_fields: body.custom_fields,
      organization_id: request.user.org_id,
      created_by: request.user.sub,
    };

    const contact = await db.contact.create({ data });

    return reply.code(201).send({ data: contact });
  },

  getById: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
      include: { assignee: { select: { id: true, name: true } } },
    });

    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    return reply.send({ data: contact });
  },

  update: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const existing = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });

    if (!existing || existing.status === ContactStatus.archived) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const body = request.body as Partial<ContactBody>;

    if (body.assigned_to !== undefined && body.assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(body.assigned_to, request.user.org_id);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    const updateData: Prisma.ContactUncheckedUpdateInput = {};
    if (body.first_name !== undefined) updateData.first_name = body.first_name;
    if (body.last_name !== undefined) updateData.last_name = body.last_name;
    if (body.company !== undefined) updateData.company = body.company;
    if (body.email !== undefined) updateData.email = body.email;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.mobile !== undefined) updateData.mobile = body.mobile;
    if (body.tags !== undefined) updateData.tags = body.tags;
    if (body.source !== undefined) updateData.source = body.source;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.assigned_to !== undefined) updateData.assigned_to = body.assigned_to;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.custom_fields !== undefined) updateData.custom_fields = body.custom_fields;

    const contact = await db.contact.update({ where: { id }, data: updateData });

    return reply.send({ data: contact });
  },

  archive: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const existing = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });

    if (!existing) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const contact = await db.contact.update({ where: { id }, data: { status: 'archived' } });

    return reply.send({ data: contact });
  },

  getActivity: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const [messages, tasks, events] = await Promise.all([
      db.message.findMany({
        where: { contact_id: id, organization_id: request.user.org_id },
        select: { id: true, body: true, channel: true, created_at: true },
      }),
      db.task.findMany({
        where: { contact_id: id, organization_id: request.user.org_id },
        select: { id: true, title: true, created_at: true },
      }),
      db.calendarEvent.findMany({
        where: { contact_id: id, organization_id: request.user.org_id },
        select: { id: true, title: true, created_at: true },
      }),
    ]);

    const items = [
      ...messages.map(m => ({ type: 'message' as const, id: m.id, summary: m.body, created_at: m.created_at })),
      ...tasks.map(t => ({ type: 'task' as const, id: t.id, summary: t.title, created_at: t.created_at })),
      ...events.map(e => ({ type: 'meeting' as const, id: e.id, summary: e.title, created_at: e.created_at })),
    ].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    return reply.send({ data: { contact_id: id, items } });
  },

  getDeals: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const deals = await db.deal.findMany({
      where: { contact_id: id, organization_id: request.user.org_id },
      include: {
        pipeline: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, position: true } },
      },
    });

    return reply.send({ data: deals });
  },

  getTasks: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const tasks = await db.task.findMany({
      where: {
        contact_id: id,
        organization_id: request.user.org_id,
        status: { not: TaskStatus.cancelled },
      },
      orderBy: { due_date: 'asc' },
    });

    return reply.send({ data: tasks });
  },

  getMessages: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const messages = await db.message.findMany({
      where: { contact_id: id, organization_id: request.user.org_id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ data: messages });
  },
  merge: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { source_id } = request.body as { source_id: string };
    const org_id = request.user.org_id;

    if (source_id === id) {
      return reply.code(422).send({
        error: { code: 'INVALID_MERGE', message: 'Source and target must be different contacts' },
      });
    }

    const source = await db.contact.findFirst({
      where: { id: source_id, organization_id: org_id },
    });
    if (!source) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Source contact not found' } });
    }

    const target = await db.contact.findFirst({
      where: { id, organization_id: org_id },
    });
    if (!target) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    await db.$transaction(async (tx) => {
      await tx.deal.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.task.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.message.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.calendarEvent.updateMany({
        where: { contact_id: source.id, organization_id: org_id },
        data: { contact_id: target.id },
      });
      await tx.contact.update({
        where: { id: source.id },
        data: { status: 'archived' },
      });
    });

    const updated = await db.contact.findFirst({
      where: { id: target.id, organization_id: org_id },
      include: { assignee: { select: { id: true, name: true } } },
    });

    return reply.send({ data: updated ?? target });
  },
  getCalendarEvents: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  importCsv: async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = request.body as ContactImportRow[];

    const data: Prisma.ContactCreateManyInput[] = rows.map(row => ({
      organization_id: request.user.org_id,
      created_by: request.user.sub,
      first_name: row.first_name.trim(),
      last_name: optionalTrimmedString(row.last_name),
      company: optionalTrimmedString(row.company),
      email: optionalTrimmedString(row.email),
      phone: optionalTrimmedString(row.phone),
      mobile: optionalTrimmedString(row.mobile),
      source: optionalTrimmedString(row.source),
      notes: optionalTrimmedString(row.notes),
      type: row.type,
    }));

    const result = await db.$transaction(async (tx) => tx.contact.createMany({ data }));

    return reply.code(201).send({ data: { imported_count: result.count }, meta: {} });
  },
  importFromPhone: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  bulkAssign: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids, assigned_to } = request.body as BulkAssignBody;
    const orgId = request.user.org_id;
    const uniqueContactIds = Array.from(new Set(contact_ids));

    if (assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(assigned_to, orgId);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    const contacts = await db.contact.findMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      select: { id: true },
    });

    if (contacts.length !== uniqueContactIds.length) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'One or more contacts not found' } });
    }

    const result = await db.contact.updateMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      data: { assigned_to },
    });

    return reply.send({
      data: { assigned_count: result.count, assigned_to, contact_ids: uniqueContactIds },
      meta: {},
    });
  },
  bulkTag: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  bulkArchive: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids } = request.body as BulkArchiveBody;
    const orgId = request.user.org_id;
    const uniqueContactIds = Array.from(new Set(contact_ids));

    const contacts = await db.contact.findMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      select: { id: true },
    });

    if (contacts.length !== uniqueContactIds.length) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'One or more contacts not found' } });
    }

    const result = await db.contact.updateMany({
      where: {
        id: { in: uniqueContactIds },
        organization_id: orgId,
        status: { not: ContactStatus.archived },
      },
      data: { status: ContactStatus.archived },
    });

    return reply.send({
      data: { archived_count: result.count, contact_ids: uniqueContactIds },
      meta: {},
    });
  },
};
