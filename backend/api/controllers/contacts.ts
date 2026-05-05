import { FastifyRequest, FastifyReply } from 'fastify';
import { ContactStatus, Prisma, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';

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
    const body = request.body as {
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
      custom_fields?: Record<string, unknown>;
    };

    const contact = await db.contact.create({
      data: {
        ...body,
        organization_id: request.user.org_id,
        created_by: request.user.sub,
      },
    });

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

    if (!existing) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const body = request.body as Partial<{
      first_name: string;
      last_name: string;
      company: string;
      email: string;
      phone: string;
      mobile: string;
      tags: string[];
      source: string;
      notes: string;
      assigned_to: string;
      type: 'lead' | 'customer' | 'partner' | 'other';
      custom_fields: Record<string, unknown>;
    }>;

    const contact = await db.contact.update({ where: { id }, data: body });

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
  merge: async (
    request: FastifyRequest<{ Params: { id: string }; Body: { source_id: string } }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    const { source_id } = request.body;
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
  importCsv: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  importFromPhone: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  bulkAssign: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  bulkTag: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  bulkArchive: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
};
