/**
 * contact-domain.ts
 *
 * Shared domain functions for the contacts resource.  Both the HTTP controller
 * and MCP tools call these instead of talking to Prisma directly, so
 * visibility scoping, field encryption/decryption, and audit logging are
 * enforced uniformly on every path.
 */

import { ContactStatus, DealStatus, Prisma, WorkflowTrigger } from '@prisma/client';
import { db } from './db';
import { paginate } from './db-paginate';
import { encryptField, decryptField } from './encryption';
import { evaluateWorkflows } from './workflows';
import { logActivity } from '../api/controllers/activities';
import { dispatchNotification, contactCtx } from './notificationEngine';
import { getVisibleUserIds, ownerVisibilityWhere } from './visibility';
import { userBelongsToOrg } from './contact-bulk';
import { getLastContactedMap } from './lastContacted';

// ---------------------------------------------------------------------------
// Re-exported types
// ---------------------------------------------------------------------------

export type ContactRequester = {
  sub: string;
  org_id: string;
  role: string;
};

export type ContactBody = {
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

export type ContactPatch = Partial<Omit<ContactBody, 'first_name'>> & {
  first_name?: string;
};

// Thrown by domain functions when a record is not found or is inaccessible.
// Callers convert this into the appropriate HTTP 404 or MCP NOT_FOUND error.
export class ContactNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message = 'Contact not found') {
    super(message);
    this.name = 'ContactNotFoundError';
  }
}

// Thrown when an assignee validation fails.
export class ContactForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ContactForbiddenError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function decryptContact<
  T extends { email?: string | null; phone?: string | null; mobile?: string | null },
>(c: T): T {
  return {
    ...c,
    email: decryptField(c.email ?? undefined) ?? null,
    phone: decryptField(c.phone ?? undefined) ?? null,
    mobile: decryptField(c.mobile ?? undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Domain operations
// ---------------------------------------------------------------------------

/**
 * List contacts visible to `requester`, applying visibility scope, optional
 * search/filter, field decryption, and last-contacted enrichment.
 *
 * This mirrors ContactsController.list but is usable from any caller that
 * can supply a requester object.
 */
export async function listContactsForUser(
  orgId: string,
  requester: ContactRequester,
  filters: {
    q?: string;
    status?: 'active' | 'inactive' | 'archived';
    type?: 'lead' | 'customer' | 'partner' | 'other';
    assigned_to?: string;
    page?: number;
    per_page?: number;
    sort?: 'created_at' | 'updated_at' | 'first_name' | 'company';
    order?: 'asc' | 'desc';
  },
): Promise<{ data: unknown[]; meta: { total: number; page: number; per_page: number } }> {
  const {
    q,
    status,
    type,
    assigned_to,
    page = 1,
    per_page = 20,
    sort = 'created_at',
    order = 'desc',
  } = filters;

  const visibleIds = await getVisibleUserIds(
    { sub: requester.sub, org_id: orgId, role: requester.role as 'owner' | 'admin' | 'member' | 'viewer' },
    'direct',
  );

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
    organization_id: orgId,
    status: status ?? { not: ContactStatus.archived },
    ...(type && { type }),
    ...(assigned_to && { assigned_to }),
    ...(andClauses.length > 0 && { AND: andClauses }),
  };

  const { data: contacts, total } = await paginate(
    () => db.contact.count({ where }),
    () =>
      db.contact.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { [sort]: order },
        include: {
          _count: { select: { deals: { where: { status: DealStatus.open } } } },
        },
      }),
  );

  const contactIds = contacts.map((c) => c.id);
  const lastContactedMap =
    contactIds.length > 0
      ? await getLastContactedMap(orgId, contactIds)
      : new Map<string, Date>();

  const contactsWithActivity = contacts.map((c) => {
    const { _count, ...rest } = c;
    return decryptContact({
      ...rest,
      last_contacted_at: lastContactedMap.get(c.id) ?? null,
      active_deals_count: _count.deals,
    });
  });

  return { data: contactsWithActivity, meta: { total, page, per_page } };
}

/**
 * Fetch a single contact by ID, scoped to the org.  Decrypts PII fields.
 * Throws ContactNotFoundError if absent or org-mismatched.
 */
export async function getContactForUser(
  contactId: string,
  orgId: string,
): Promise<unknown> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
    include: { assignee: { select: { id: true, name: true } } },
  });

  if (!contact) {
    throw new ContactNotFoundError();
  }

  return decryptContact(contact);
}

/**
 * Create a contact, encrypting PII fields, firing workflows, logging activity,
 * and dispatching assignment notifications.
 *
 * Throws ContactForbiddenError if the assignee is outside the org.
 */
export async function createContactForUser(
  orgId: string,
  requestingUserId: string,
  body: ContactBody,
): Promise<unknown> {
  if (body.assigned_to !== undefined && body.assigned_to !== requestingUserId) {
    const ownsAssignee = await userBelongsToOrg(body.assigned_to, orgId);
    if (!ownsAssignee) {
      throw new ContactForbiddenError('Assigned user does not belong to your organization');
    }
  }

  const data: Prisma.ContactUncheckedCreateInput = {
    first_name: body.first_name,
    last_name: body.last_name,
    company: body.company,
    email: body.email ? encryptField(body.email) : undefined,
    phone: body.phone ? encryptField(body.phone) : undefined,
    mobile: body.mobile ? encryptField(body.mobile) : undefined,
    tags: body.tags,
    source: body.source,
    notes: body.notes,
    assigned_to: body.assigned_to,
    type: body.type,
    custom_fields: body.custom_fields,
    organization_id: orgId,
    created_by: requestingUserId,
  };

  const contact = await db.contact.create({ data });

  await evaluateWorkflows({
    organizationId: orgId,
    trigger: WorkflowTrigger.contact_created,
    record: contact as unknown as Record<string, unknown>,
    userId: requestingUserId,
    triggerRecordId: contact.id,
  });

  void logActivity({
    organizationId: orgId,
    userId: requestingUserId,
    entityType: 'contact',
    entityId: contact.id,
    action: 'created',
  });

  if (contact.assigned_to && contact.assigned_to !== requestingUserId) {
    void contactCtx(contact.id, requestingUserId).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'contact.assigned', orgId, contact: ctx });
    });
  }

  return decryptContact(contact);
}

/**
 * Update a contact's fields, encrypting PII, writing an audit trail, and
 * enforcing org-scoped assignee validation.
 *
 * Throws ContactNotFoundError or ContactForbiddenError as appropriate.
 */
export async function updateContactForUser(
  contactId: string,
  orgId: string,
  requestingUserId: string,
  patch: ContactPatch,
): Promise<unknown> {
  const existing = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId, status: { not: ContactStatus.archived } },
  });

  if (!existing) {
    throw new ContactNotFoundError();
  }

  if (patch.assigned_to !== undefined && patch.assigned_to !== requestingUserId) {
    const ownsAssignee = await userBelongsToOrg(patch.assigned_to, orgId);
    if (!ownsAssignee) {
      throw new ContactForbiddenError('Assigned user does not belong to your organization');
    }
  }

  const updateData: Prisma.ContactUncheckedUpdateInput = {};
  if (patch.first_name !== undefined) updateData.first_name = patch.first_name;
  if (patch.last_name !== undefined) updateData.last_name = patch.last_name;
  if (patch.company !== undefined) updateData.company = patch.company;
  if (patch.email !== undefined) updateData.email = patch.email ? encryptField(patch.email) : patch.email;
  if (patch.phone !== undefined) updateData.phone = patch.phone ? encryptField(patch.phone) : patch.phone;
  if (patch.mobile !== undefined) updateData.mobile = patch.mobile ? encryptField(patch.mobile) : patch.mobile;
  if (patch.tags !== undefined) updateData.tags = patch.tags;
  if (patch.source !== undefined) updateData.source = patch.source;
  if (patch.notes !== undefined) updateData.notes = patch.notes;
  if (patch.assigned_to !== undefined) updateData.assigned_to = patch.assigned_to;
  if (patch.type !== undefined) updateData.type = patch.type;
  if (patch.custom_fields !== undefined) updateData.custom_fields = patch.custom_fields;

  const result = await db.contact.updateMany({
    where: { id: contactId, organization_id: orgId, status: { not: ContactStatus.archived } },
    data: updateData,
  });

  if (result.count !== 1) {
    throw new ContactNotFoundError();
  }

  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
  });

  if (!contact) {
    throw new ContactNotFoundError();
  }

  const PII_FIELDS = new Set(['email', 'phone', 'mobile']);
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(updateData) as (keyof typeof updateData)[]) {
    if (PII_FIELDS.has(key as string)) {
      changes[key as string] = '[changed]';
    } else {
      changes[key as string] = {
        from: existing[key as keyof typeof existing],
        to: updateData[key],
      };
    }
  }
  void logActivity({
    organizationId: orgId,
    userId: requestingUserId,
    entityType: 'contact',
    entityId: contactId,
    action: 'updated',
    changes,
  });

  return decryptContact(contact);
}

/**
 * Archive a contact by ID (org-scoped).  Logs the action.
 * Throws ContactNotFoundError if the contact is absent or org-mismatched.
 */
export async function archiveContactForUser(
  contactId: string,
  orgId: string,
  requestingUserId: string,
): Promise<unknown> {
  const existing = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
  });

  if (!existing) {
    throw new ContactNotFoundError();
  }

  const result = await db.contact.updateMany({
    where: { id: contactId, organization_id: orgId },
    data: { status: ContactStatus.archived },
  });

  if (result.count !== 1) {
    throw new ContactNotFoundError();
  }

  const contact = await db.contact.findFirst({
    where: { id: contactId, organization_id: orgId },
  });

  if (!contact) {
    throw new ContactNotFoundError();
  }

  void logActivity({
    organizationId: orgId,
    userId: requestingUserId,
    entityType: 'contact',
    entityId: contactId,
    action: 'archived',
  });

  return contact;
}
