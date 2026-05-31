import { Prisma } from '@prisma/client';
import { db } from './db';

export type LastContactedMap = Map<string, Date>;

function contactIdFilter(contactIds: string[] | undefined): Prisma.Sql {
  if (contactIds === undefined) {
    return Prisma.empty;
  }

  if (contactIds.length === 0) {
    return Prisma.sql`AND false`;
  }

  return Prisma.sql`AND c.id IN (${Prisma.join(contactIds.map((id) => Prisma.sql`${id}::uuid`))})`;
}

/**
 * Returns a map of contact_id -> last interaction date for all non-archived contacts
 * in the given org, optionally narrowed to specific contact IDs. Derived from MAX of:
 * messages.created_at and non-cancelled calendar_events.start_time.
 * Uses raw SQL for efficiency (single query instead of N+1).
 */
export async function getLastContactedMap(
  orgId: string,
  contactIds?: string[],
): Promise<LastContactedMap> {
  if (contactIds !== undefined && contactIds.length === 0) {
    return new Map<string, Date>();
  }

  const rows = await db.$queryRaw<Array<{ contact_id: string; last_contacted_at: Date }>>(Prisma.sql`
    SELECT
      c.id AS contact_id,
      MAX(activity.contacted_at) AS last_contacted_at
    FROM "Contact" c
    LEFT JOIN (
      SELECT contact_id, organization_id, created_at AS contacted_at
      FROM "Message"
      UNION ALL
      SELECT contact_id, organization_id, start_time AS contacted_at
      FROM "CalendarEvent"
      WHERE contact_id IS NOT NULL AND status != 'cancelled'
    ) activity
      ON activity.contact_id = c.id AND activity.organization_id = ${orgId}::uuid
    WHERE c.organization_id = ${orgId}::uuid
      AND c.status != 'archived'
      ${contactIdFilter(contactIds)}
    GROUP BY c.id
  `);

  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row.last_contacted_at) {
      map.set(row.contact_id, row.last_contacted_at);
    }
  }
  return map;
}

export async function getContactIdsLastContactedBefore(
  orgId: string,
  cutoff: Date,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ contact_id: string }>>`
    SELECT c.id AS contact_id
    FROM "Contact" c
    LEFT JOIN (
      SELECT contact_id, organization_id, created_at AS contacted_at
      FROM "Message"
      UNION ALL
      SELECT contact_id, organization_id, start_time AS contacted_at
      FROM "CalendarEvent"
      WHERE contact_id IS NOT NULL AND status != 'cancelled'
    ) activity
      ON activity.contact_id = c.id AND activity.organization_id = ${orgId}::uuid
    WHERE c.organization_id = ${orgId}::uuid
    GROUP BY c.id
    HAVING MAX(activity.contacted_at) IS NULL OR MAX(activity.contacted_at) < ${cutoff}
  `;

  return rows.map((row) => row.contact_id);
}
