import { db } from './db';

export type VisibilityScope = 'direct' | 'subtree';

export type Requester = {
  sub: string;
  org_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
};

/**
 * Resolve the set of user IDs whose records `requester` is allowed to see.
 *
 *  - owner / admin → `null`, meaning "no per-user restriction" (org scope only).
 *  - everyone else → themselves plus the people under them, always bounded to
 *    their own branch of the org chart:
 *      • scope 'direct'  → self + direct reports (one level down)   [default / "B"]
 *      • scope 'subtree' → self + every descendant, recursively     ["A"]
 *
 * The toggle only changes how *deep* a manager looks inside their own cone; it
 * never lets them see sideways or upward. The returned IDs always live inside
 * the requester's organization.
 *
 * Callers add `assigned_to: { in: ids }` to their existing org-scoped `where`
 * whenever the result is non-null.
 */
export async function getVisibleUserIds(
  requester: Requester,
  scope: VisibilityScope = 'direct',
): Promise<string[] | null> {
  if (requester.role === 'owner' || requester.role === 'admin') {
    return null;
  }

  if (scope === 'subtree') {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE descendants AS (
        SELECT "id"
        FROM "User"
        WHERE "id" = ${requester.sub}::uuid
          AND "organization_id" = ${requester.org_id}::uuid
        UNION ALL
        SELECT u."id"
        FROM "User" u
        INNER JOIN descendants d ON u."manager_id" = d."id"
        WHERE u."organization_id" = ${requester.org_id}::uuid
      )
      SELECT "id" FROM descendants
    `;
    return rows.map((r) => r.id);
  }

  // 'direct': self + immediate reports only
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "User"
    WHERE "organization_id" = ${requester.org_id}::uuid
      AND ("id" = ${requester.sub}::uuid OR "manager_id" = ${requester.sub}::uuid)
  `;
  return rows.map((r) => r.id);
}

/**
 * The manager's full access cone (self + entire subtree), regardless of the
 * direct/subtree view toggle. Used for single-record access checks and for
 * validating assignment targets, so a manager can always act on anything that
 * lives somewhere beneath them even when their default list view is 'direct'.
 */
export async function getAccessibleUserIds(requester: Requester): Promise<string[] | null> {
  return getVisibleUserIds(requester, 'subtree');
}

/**
 * Whether `userId` falls within `visibleIds`. A `null` set means unrestricted
 * (owner/admin), so everything is visible.
 */
export function canSeeUser(visibleIds: string[] | null, userId: string | null | undefined): boolean {
  if (visibleIds === null) return true;
  if (!userId) return false;
  return visibleIds.includes(userId);
}

/**
 * Build a Prisma `OR` clause that scopes a list query to records owned by or
 * assigned to any of the visible users.  Returns `undefined` when visibleIds is
 * null (owner/admin — no per-user restriction needed).
 *
 * Deals and contacts have a NULLABLE `assigned_to`, so we also OR in
 * `created_by` so a member still sees records they created but that have not
 * been explicitly assigned to anyone in their cone.
 */
export function ownerVisibilityWhere(
  visibleIds: string[] | null,
): { OR: Array<{ assigned_to?: { in: string[] }; created_by?: { in: string[] } }> } | undefined {
  if (visibleIds === null) return undefined;
  return {
    OR: [
      { assigned_to: { in: visibleIds } },
      { created_by: { in: visibleIds } },
    ],
  };
}
