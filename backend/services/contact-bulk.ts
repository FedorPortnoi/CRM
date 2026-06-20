import { ContactStatus } from '@prisma/client';
import { db } from './db';
import { userBelongsToOrg } from './db-guards';
export { userBelongsToOrg };

export type BulkAssignParams = {
  orgId: string;
  requestingUserId: string;
  contact_ids: string[];
  assigned_to: string;
};

export type BulkArchiveParams = {
  orgId: string;
  contact_ids: string[];
};

export type BulkAssignResult = {
  assigned_count: number;
  assigned_to: string;
  contact_ids: string[];
};

export type BulkArchiveResult = {
  archived_count: number;
  contact_ids: string[];
};

/**
 * Assign a list of contacts to a new owner.
 *
 * Throws with `{ code, status }` on validation failure so the controller can
 * turn it into the correct HTTP response without knowing DB details.
 */
export async function bulkAssignContacts(params: BulkAssignParams): Promise<BulkAssignResult> {
  const { orgId, contact_ids, assigned_to } = params;
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
    const err = new Error('One or more contacts not found') as Error & { code: string; status: number };
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const result = await db.contact.updateMany({
    where: {
      id: { in: uniqueContactIds },
      organization_id: orgId,
      status: { not: ContactStatus.archived },
    },
    data: { assigned_to },
  });

  if (result.count !== uniqueContactIds.length) {
    const err = new Error('One or more contacts not found') as Error & { code: string; status: number };
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }

  return { assigned_count: result.count, assigned_to, contact_ids: uniqueContactIds };
}

/**
 * Archive a list of contacts.
 *
 * Throws with `{ code, status }` on validation failure so the controller can
 * turn it into the correct HTTP response without knowing DB details.
 */
export async function bulkArchiveContacts(params: BulkArchiveParams): Promise<BulkArchiveResult> {
  const { orgId, contact_ids } = params;
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
    const err = new Error('One or more contacts not found') as Error & { code: string; status: number };
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const result = await db.contact.updateMany({
    where: {
      id: { in: uniqueContactIds },
      organization_id: orgId,
      status: { not: ContactStatus.archived },
    },
    data: { status: ContactStatus.archived },
  });

  if (result.count !== uniqueContactIds.length) {
    const err = new Error('One or more contacts not found') as Error & { code: string; status: number };
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }

  return { archived_count: result.count, contact_ids: uniqueContactIds };
}
