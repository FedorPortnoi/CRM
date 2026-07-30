import { FastifyRequest, FastifyReply } from 'fastify';
import { ContactStatus, DealStatus, Prisma } from '@prisma/client';
import { db } from '../../services/db';
import { paginate } from '../../services/db-paginate';
import { decryptField } from '../../services/encryption';
import { getContactIdsLastContactedBefore, getLastContactedMap } from '../../services/lastContacted';
import {
  getVisibleUserIds,
  getAccessibleUserIds,
  ownerVisibilityWhere,
  type VisibilityScope,
  type Requester,
} from '../../services/visibility';
import { contactBlindIndexClauses, buildContactPhoneSearchWhere } from '../../services/contact-search';
import { findNearbyContacts } from '../../services/nearby';
import { importCsvRows, type ContactImportRow } from '../../services/contact-import';
import { userBelongsToOrg, bulkAssignContacts, bulkArchiveContacts } from '../../services/contact-bulk';
import { getContactTimeline, type TimelineItem } from '../../services/contact-timeline';
import { listDealsForUser } from '../../services/deal-domain';
import { listTasksForUser } from '../../services/task-domain';
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

// Blind-index columns are internal search keys — keyed hashes of the contact's
// PII — and have no business in an API response, so they are dropped on the way
// out alongside the decryption of the fields they index.
const BLIND_INDEX_COLUMNS = ['email_bidx', 'phone_bidx', 'mobile_bidx'] as const;

function decryptContact<T extends { email?: string | null; phone?: string | null; mobile?: string | null }>(c: T): T {
  const out: Record<string, unknown> = {
    ...c,
    email: decryptField(c.email ?? undefined) ?? null,
    phone: decryptField(c.phone ?? undefined) ?? null,
    mobile: decryptField(c.mobile ?? undefined) ?? null,
  };

  for (const column of BLIND_INDEX_COLUMNS) {
    delete out[column];
  }

  return out as T;
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

// Legacy fallback: a digit-normalized scan over the raw phone/mobile columns.
// It only ever matches rows stored before field encryption was introduced —
// against ciphertext the regexp_replace produces meaningless digits. Kept so
// those rows remain findable; the blind-index lookup below is the real path.
async function findContactIdsByPlaintextPhone(orgId: string, searchKeys: Set<string>): Promise<string[]> {
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

// The child routes below (/:id/deals, /:id/tasks) have no pagination in their
// contract — src/app/contact/[id].tsx reads `data` as a plain array — so the
// shared list helpers are asked for a single page large enough to be one. Stated
// explicitly rather than inheriting their 20-row default, which would silently
// truncate a busy contact.
const CONTACT_CHILDREN_PAGE_SIZE = 500;

/**
 * Drop timeline entries whose owner sits outside the caller's cone.
 *
 * getContactTimeline() is org-scoped and takes no requester, so a contact the
 * caller may legitimately see used to hand back every message, task and meeting
 * attached to it, including another branch's. The filtering happens on the way
 * out rather than by widening that service's signature.
 *
 * Rows with a NULL owner are KEPT. An inbound message has no user_id at all —
 * the capture-match path in captures.ts writes exactly such a Message — and an
 * imported meeting has no created_by; both belong to the contact rather than to
 * an operator, and the contact is already inside the cone by the time we get
 * here. That is the one place this differs from the org-wide feeds, where a NULL
 * owner is attributable to nobody and the row is excluded.
 */
async function filterTimelineToCone(
  requester: Requester,
  items: TimelineItem[],
): Promise<TimelineItem[]> {
  const accessibleIds = await getAccessibleUserIds(requester);

  // owner/admin and every role holding visibility.all — no per-user restriction.
  if (accessibleIds === null) {
    return items;
  }

  const idsOfType = (type: TimelineItem['type']): string[] =>
    items.filter((item) => item.type === type).map((item) => item.id);

  const messageIds = idsOfType('message');
  const taskIds = idsOfType('task');
  const eventIds = idsOfType('meeting');

  const [messages, tasks, events] = await Promise.all([
    messageIds.length > 0
      ? db.message.findMany({
          where: {
            id: { in: messageIds },
            organization_id: requester.org_id,
            OR: [{ user_id: null }, { user_id: { in: accessibleIds } }],
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    taskIds.length > 0
      ? db.task.findMany({
          where: {
            id: { in: taskIds },
            organization_id: requester.org_id,
            assigned_to: { in: accessibleIds },
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    eventIds.length > 0
      ? db.calendarEvent.findMany({
          where: {
            id: { in: eventIds },
            organization_id: requester.org_id,
            OR: [{ created_by: null }, { created_by: { in: accessibleIds } }],
          },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const visibleIds = new Set([...messages, ...tasks, ...events].map((row) => row.id));
  return items.filter((item) => visibleIds.has(item.id));
}

// Blind-index lookup for encrypted phone/mobile. Org-scoped here as well as in
// the caller's where-clause: blind indexes are deterministic deployment-wide, so
// organization_id is the only thing keeping one tenant out of another's rows.
async function findContactIdsByBlindIndex(
  orgId: string,
  indexWhere: Prisma.ContactWhereInput,
): Promise<string[]> {
  const rows = await db.contact.findMany({
    where: { organization_id: orgId, ...indexWhere },
    select: { id: true },
  });

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
          // email/phone are ciphertext, so `contains` only ever matches rows that
          // predate field encryption. Kept so those legacy rows stay findable.
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { company: { contains: q, mode: 'insensitive' } },
          // A term shaped like an email or a phone number is also matched exactly
          // through the blind indexes; name/company keep the text search above.
          // Empty for every other term.
          ...contactBlindIndexClauses(q),
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
      const phoneIndexWhere = buildContactPhoneSearchWhere(phone);
      if (searchKeys.size === 0 && !phoneIndexWhere) {
        return reply.send({ data: [], meta: { total: 0, page, per_page } });
      }

      // Union of the two lookups: encrypted rows come back from the blind index,
      // pre-encryption rows from the legacy digit scan.
      const [indexedIds, legacyIds] = await Promise.all([
        phoneIndexWhere
          ? findContactIdsByBlindIndex(request.user.org_id, phoneIndexWhere)
          : Promise.resolve<string[]>([]),
        findContactIdsByPlaintextPhone(request.user.org_id, searchKeys),
      ]);
      idFilters.push(Array.from(new Set([...indexedIds, ...legacyIds])));
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

  // Field-visit lookup: contacts around the rep's current position, nearest first.
  // Coordinates come from the contact's own `address` JSON — nothing is geocoded.
  nearby: async (request: FastifyRequest, reply: FastifyReply) => {
    const { latitude, longitude, radius_m, limit, type, status, scope } = request.query as {
      latitude: number;
      longitude: number;
      radius_m: number;
      limit: number;
      type?: 'lead' | 'customer' | 'partner' | 'other';
      status?: 'active' | 'inactive' | 'archived';
      scope?: VisibilityScope;
    };

    const origin = { latitude, longitude };
    const visibleIds = await getVisibleUserIds(request.user, scope ?? 'direct');

    const hits = await findNearbyContacts({
      orgId: request.user.org_id,
      origin,
      radiusMeters: radius_m,
      limit,
      visibleIds,
      status,
      type,
    });

    const meta = { total: 0, radius_m, limit, origin };

    if (hits.length === 0) {
      return reply.send({ data: [], meta });
    }

    const contacts = await db.contact.findMany({
      where: {
        organization_id: request.user.org_id,
        id: { in: hits.map((hit) => hit.contact_id) },
      },
      include: {
        _count: { select: { deals: { where: { status: DealStatus.open } } } },
      },
    });

    const contactsById = new Map(contacts.map((c) => [c.id, c]));
    const lastContactedMap = await getLastContactedMap(
      request.user.org_id,
      contacts.map((c) => c.id),
    );

    // Driven by `hits`, so the nearest-first ordering from the distance pass survives.
    const data = hits.flatMap((hit) => {
      const contact = contactsById.get(hit.contact_id);
      if (!contact) {
        return [];
      }

      const { _count, ...rest } = contact;
      return [decryptContact({
        ...rest,
        last_contacted_at: lastContactedMap.get(contact.id) ?? null,
        active_deals_count: _count.deals,
        latitude: hit.latitude,
        longitude: hit.longitude,
        distance_meters: Math.round(hit.distance_meters),
        bearing_degrees: Math.round(hit.bearing_degrees * 10) / 10,
      })];
    });

    return reply.send({ data, meta: { ...meta, total: data.length } });
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

    try {
      await getContactForUser(id, request.user.org_id, request.user);
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    // Seeing the contact is not the same as seeing everything hung off it: the
    // timeline is assembled org-wide, so it is coned before it goes out.
    const timeline = await getContactTimeline(request.user.org_id, id);
    const items = await filterTimelineToCone(request.user, timeline.items);

    return reply.send({ data: { ...timeline, items } });
  },

  getDeals: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      await getContactForUser(id, request.user.org_id, request.user);
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    // The contact being visible never made every deal on it visible — this used to
    // return another branch's deal, value and all, to anyone who knew the contact
    // id. listDealsForUser applies the same cone GET /deals does; 'subtree' so the
    // reach matches the one getContactForUser just used on the contact itself.
    const { data: deals } = await listDealsForUser(request.user.org_id, request.user, {
      contact_id: id,
      scope: 'subtree',
      per_page: CONTACT_CHILDREN_PAGE_SIZE,
    });

    return reply.send({ data: deals });
  },

  getTasks: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      await getContactForUser(id, request.user.org_id, request.user);
    } catch (err) {
      if (err instanceof ContactNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    // Same leak as getDeals above, on the tasks side. listTasksForUser reproduces
    // this query exactly — omitting `status` gives it the same `{ not: cancelled }`
    // filter and the same due_date-ascending order — and adds the cone.
    const { data: tasks } = await listTasksForUser(request.user.org_id, request.user, {
      contact_id: id,
      scope: 'subtree',
      per_page: CONTACT_CHILDREN_PAGE_SIZE,
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
