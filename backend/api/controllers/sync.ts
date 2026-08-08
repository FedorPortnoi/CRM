import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../services/db';
import { can } from '../../services/capabilities';
import { getVisibleUserIds, ownerVisibilityWhere } from '../../services/visibility';

type DeltaQuery = {
  since?: string;
};

async function delta(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { since } = request.query as DeltaQuery;

  const now = Date.now();
  const maxLookbackDate = new Date(now - 365 * 24 * 60 * 60 * 1000);
  const requestedSinceDate = since
    ? new Date(since)
    : new Date(now - 30 * 24 * 60 * 60 * 1000);
  const sinceDate = Number.isNaN(requestedSinceDate.getTime()) || requestedSinceDate < maxLookbackDate
    ? maxLookbackDate
    : requestedSinceDate;

  const orgId = request.user.org_id;
  const visibleIds = await getVisibleUserIds(request.user, 'subtree');

  /**
   * DELIBERATELY A FIELD-LEVEL OMISSION, NOT A 403 ON THE ROUTE.
   *
   * This endpoint is a bundle: contacts, deals, tasks and calendar events in one
   * response. `support` legitimately reads three of those four — it holds
   * contacts.read and tasks.read — and this is the mobile background-sync
   * endpoint (src/utils/backgroundSync.ts). Gating the whole route on deals.read
   * would silently stop background sync for that role: performSync() bails on
   * `!response.ok` and nothing surfaces the failure to the user.
   *
   * So the route stays open and the one payload the caller may not read is
   * dropped. `body.data.deals` is only ever read for its `.length`
   * (backgroundSync.ts:35-40), so an empty array is already a handled shape and
   * needs no client release.
   *
   * The `take: 1000`, no-`select` deal query below is why this matters more here
   * than on a single-record read: without the check it hands a role whose whole
   * definition is "no pipeline, no money" a year of the org chart's deals, with
   * `value` and `currency`, in one request that looks exactly like normal app
   * traffic.
   */
  const mayReadDeals = can(request.user.role, 'deals.read');

  const [contacts, deals, tasks, events] = await Promise.all([
    db.contact.findMany({
      where: {
        organization_id: orgId,
        updated_at: { gt: sinceDate },
        ...ownerVisibilityWhere(visibleIds),
      },
      orderBy: { updated_at: 'asc' },
      take: 1000,
    }),
    mayReadDeals
      ? db.deal.findMany({
        where: {
          organization_id: orgId,
          updated_at: { gt: sinceDate },
          ...ownerVisibilityWhere(visibleIds),
        },
        orderBy: { updated_at: 'asc' },
        take: 1000,
      })
      : Promise.resolve([]),
    db.task.findMany({
      where: {
        organization_id: orgId,
        updated_at: { gt: sinceDate },
        ...(visibleIds !== null && { assigned_to: { in: visibleIds } }),
      },
      orderBy: { updated_at: 'asc' },
      take: 1000,
    }),
    db.calendarEvent.findMany({
      where: {
        organization_id: orgId,
        updated_at: { gt: sinceDate },
        ...(visibleIds !== null && { created_by: { in: visibleIds } }),
      },
      orderBy: { updated_at: 'asc' },
      take: 1000,
    }),
  ]);

  // The blind-index columns are derived HMACs used only for server-side lookup of encrypted
  // PII — they have no business in an API response, the same rule the contacts list and
  // contact-domain serializers already follow. Stripped here rather than via `select` so a
  // future Contact column is included by default instead of being silently dropped.
  const syncContacts = contacts.map(({ email_bidx: _e, phone_bidx: _p, mobile_bidx: _m, ...rest }) => rest);

  reply.send({
    data: { contacts: syncContacts, deals, tasks, events },
    meta: {
      since: sinceDate.toISOString(),
      server_time: new Date().toISOString(),
    },
  });
}

export const SyncController = { delta };
