import { db } from './db';

export type LastContactedMap = Map<string, Date>;

/**
 * Returns a map of contact_id -> last interaction date for all non-archived contacts
 * in the given org. Derived from MAX of: messages.created_at, calendar_events.start_time.
 * Uses raw SQL for efficiency (single query instead of N+1).
 */
export async function getLastContactedMap(orgId: string): Promise<LastContactedMap> {
  const rows = await db.$queryRaw<Array<{ contact_id: string; last_contacted_at: Date }>>`
    SELECT
      c.id AS contact_id,
      GREATEST(
        MAX(m.created_at),
        MAX(ce.start_time)
      ) AS last_contacted_at
    FROM "Contact" c
    LEFT JOIN "Message" m
      ON m.contact_id = c.id AND m.organization_id = ${orgId}::uuid
    LEFT JOIN "CalendarEvent" ce
      ON ce.contact_id = c.id AND ce.organization_id = ${orgId}::uuid
      AND ce.status != 'cancelled'
    WHERE c.organization_id = ${orgId}::uuid
      AND c.status != 'archived'
    GROUP BY c.id
  `;

  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row.last_contacted_at) {
      map.set(row.contact_id, row.last_contacted_at);
    }
  }
  return map;
}
