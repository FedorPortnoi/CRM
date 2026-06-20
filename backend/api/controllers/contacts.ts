import { FastifyRequest, FastifyReply } from 'fastify';
import { ContactStatus, DealStatus, Prisma, TaskStatus } from '@prisma/client';
import { db } from '../../services/db';
import { paginate } from '../../services/db-paginate';
import { decryptField } from '../../services/encryption';
import { getContactIdsLastContactedBefore, getLastContactedMap } from '../../services/lastContacted';
import {
  getVisibleUserIds,
  ownerVisibilityWhere,
  type VisibilityScope,
} from '../../services/visibility';
import { importCsvRows, type ContactImportRow } from '../../services/contact-import';
import { userBelongsToOrg, bulkAssignContacts, bulkArchiveContacts } from '../../services/contact-bulk';
import { getContactTimeline } from '../../services/contact-timeline';
import { scanBusinessCard, ServiceNotConfiguredError, type BusinessCardBody } from '../../services/contact-recognition';
import {
  getContactForUser,
  createContactForUser,
  updateContactForUser,
  archiveContactForUser,
  ContactNotFoundError,
  ContactForbiddenError,
  type ContactBody,
} from '../../services/contact-domain';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type BulkArchiveBody = {
  contact_ids: string[];
};

type BulkAssignBody = BulkArchiveBody & {
  assigned_to: string;
};

// ---------------------------------------------------------------------------
// Shared helpers (controller-private)
// ---------------------------------------------------------------------------

function decryptContact<T extends { email?: string | null; phone?: string | null; mobile?: string | null }>(c: T): T {
  return {
    ...c,
    email: decryptField(c.email ?? undefined) ?? null,
    phone: decryptField(c.phone ?? undefined) ?? null,
    mobile: decryptField(c.mobile ?? undefined) ?? null,
  };
}

function phoneMatchKeys(value: string | null | undefined): Set<string> {
  const digits = value?.replace(/\D/g, '') ?? '';
  const keys = new Set<string>();

  if (!digits) {
    return keys;
  }

  keys.add(digits);

  if (digits.length === 10) {
    keys.add(`7${digits}`);
    keys.add(`8${digits}`);
  }

  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    const nationalNumber = digits.slice(1);
    keys.add(nationalNumber);
    keys.add(`7${nationalNumber}`);
    keys.add(`8${nationalNumber}`);
  }

  return keys;
}

function intersectIds(idSets: string[][]): string[] {
  if (idSets.length === 0) {
    return [];
  }

  const [firstSet, ...remainingSets] = idSets.map((ids) => new Set(ids));
  return Array.from(firstSet).filter((id) => remainingSets.every((set) => set.has(id)));
}

async function findContactIdsByPhone(orgId: string, searchKeys: Set<string>): Promise<string[]> {
  if (searchKeys.size === 0) {
    return [];
  }

  const keys = Array.from(searchKeys);
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "Contact"
    WHERE organization_id = ${orgId}::uuid
      AND (
        regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') IN (${Prisma.join(keys)})
        OR regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g') IN (${Prisma.join(keys)})
      )
  `);

  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export const ContactsController = {
  list: async (request: FastifyRequest, reply: FastifyReply) => {
    const {
      q,
      status,
      type,
      assigned_to,
      scope,
      tag,
      phone,
      source,
      last_contacted_before,
      page,
      per_page,
      sort,
      order,
    } = request.query as {
      q?: string;
      status?: 'active' | 'inactive' | 'archived';
      type?: 'lead' | 'customer' | 'partner' | 'other';
      assigned_to?: string;
      scope?: VisibilityScope;
      tag?: string;
      phone?: string;
      source?: string;
      last_contacted_before?: string;
      page: number;
      per_page: number;
      sort: 'created_at' | 'updated_at' | 'first_name' | 'company';
      order: 'asc' | 'desc';
    };

    const visibleIds = await getVisibleUserIds(request.user, scope ?? 'direct');

    const andClauses: Prisma.ContactWhereInput[] = [];
    if (q) {
      andClauses.push({
        OR: [
          { first_name: { contains: q, mode: 'insensitive' } },
          { last_name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { company: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    const visibilityClause = ownerVisibilityWhere(visibleIds);
    if (visibilityClause) {
      andClauses.push(visibilityClause);
    }

    const where: Prisma.ContactWhereInput = {
      organization_id: request.user.org_id,
      status: status ?? { not: ContactStatus.archived },
      ...(type && { type }),
      ...(assigned_to && { assigned_to }),
      ...(tag && { tags: { array_contains: tag } }),
      ...(source && { source }),
      ...(andClauses.length > 0 && { AND: andClauses }),
    };

    const lastContactedBefore = last_contacted_before ? new Date(last_contacted_before) : null;
    const idFilters: string[][] = [];

    if (phone !== undefined) {
      const searchKeys = phoneMatchKeys(phone);
      if (searchKeys.size === 0) {
        return reply.send({ data: [], meta: { total: 0, page, per_page } });
      }
      idFilters.push(await findContactIdsByPhone(request.user.org_id, searchKeys));
    }

    if (lastContactedBefore !== null) {
      idFilters.push(await getContactIdsLastContactedBefore(request.user.org_id, lastContactedBefore));
    }

    if (idFilters.length > 0) {
      const matchedIds = intersectIds(idFilters);
      if (matchedIds.length === 0) {
        return reply.send({ data: [], meta: { total: 0, page, per_page } });
      }
      where.id = { in: matchedIds };
    }

    const { data: contacts, total } = await paginate(
      () => db.contact.count({ where }),
      () => db.contact.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { [sort]: order },
        include: {
          _count: { select: { deals: { where: { status: DealStatus.open } } } },
        },
      }),
    );

    const contactIds = contacts.map(c => c.id);
    const lastContactedMap = contactIds.length > 0
      ? await getLastContactedMap(request.user.org_id, contactIds)
      : new Map<string, Date>();
    const contactsWithActivity = contacts.map(c => {
      const { _count, ...rest } = c;
      return decryptContact({
        ...rest,
        last_contacted_at: lastContactedMap.get(c.id) ?? null,
        active_deals_count: _count.deals,
      });
    });

    return reply.send({ data: contactsWithActivity, meta: { total, page, per_page } });
  },

  create: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ContactBody;
    try {
      const contact = await createContactForUser(request.user.org_id, request.user.sub, body);
      return reply.code(201).send({ data: contact, meta: {} });
    } catch (err) {
      if (err instanceof ContactForbiddenError) {
        return reply.code(403).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  },

  getById: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      const contact = await getContactForUser(id, request.user.org_id, request.user);
      return reply.send({ data: contact });
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  },

  update: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<ContactBody>;
    try {
      const contact = await updateContactForUser(id, request.user.org_id, request.user, body);
      return reply.send({ data: contact });
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof ContactForbiddenError) {
        return reply.code(403).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  },

  archive: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      const contact = await archiveContactForUser(id, request.user.org_id, request.user);
      return reply.send({ data: contact });
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  },

  getActivity: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const contact = await db.contact.findFirst({
      where: { id, organization_id: request.user.org_id },
    });
    if (!contact) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contact not found' } });
    }

    const timeline = await getContactTimeline(request.user.org_id, id);
    return reply.send({ data: timeline });
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

  importCsv: async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = request.body as ContactImportRow[];
    const result = await importCsvRows(request.user.org_id, request.user.sub, rows);
    return reply.code(201).send({ data: result, meta: {} });
  },

  bulkAssign: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids, assigned_to } = request.body as BulkAssignBody;
    const orgId = request.user.org_id;

    if (assigned_to !== request.user.sub) {
      const ownsAssignee = await userBelongsToOrg(assigned_to, orgId);
      if (!ownsAssignee) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Assigned user does not belong to your organization' },
        });
      }
    }

    try {
      const result = await bulkAssignContacts({ orgId, requestingUserId: request.user.sub, contact_ids, assigned_to });
      return reply.send({ data: result, meta: {} });
    } catch (error) {
      const e = error as Error & { code?: string; status?: number };
      if (e.status && e.code) {
        return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
      }
      throw error;
    }
  },

  bulkArchive: async (request: FastifyRequest, reply: FastifyReply) => {
    const { contact_ids } = request.body as BulkArchiveBody;
    const orgId = request.user.org_id;

    try {
      const result = await bulkArchiveContacts({ orgId, contact_ids });
      return reply.send({ data: result, meta: {} });
    } catch (error) {
      const e = error as Error & { code?: string; status?: number };
      if (e.status && e.code) {
        return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
      }
      throw error;
    }
  },

  scanBusinessCard: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as BusinessCardBody;

    try {
      const result = await scanBusinessCard(request.user.org_id, request.user.sub, body);
      return reply.send({ data: result, meta: {} });
    } catch (error) {
      if (error instanceof ServiceNotConfiguredError) {
        return reply.code(503).send({
          error: { code: 'SERVICE_NOT_CONFIGURED', message: error.message },
        });
      }

      const e = error as Error & { code?: string; status?: number };
      if (e.status === 400 && e.code) {
        return reply.code(400).send({ error: { code: e.code, message: e.message } });
      }

      return reply.code(502).send({
        error: {
          code: 'VISION_API_ERROR',
          message: error instanceof Error ? error.message : 'Business card OCR failed',
        },
      });
    }
  },
};
