import { FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
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
      ...(status && { status }),
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

  getActivity: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  getDeals: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  getTasks: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  getMessages: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
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
