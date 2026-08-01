/**
 * Nightly reconciliation between 4КУБ and amoCRM.
 *
 * WHY THIS EXISTS AT ALL, given that webhooks already deliver every change: amoCRM does not
 * guarantee delivery. Its own documented behaviour is to retry a failed delivery three times
 * (5 min / 15 min / 1 h) and then give up AND DISABLE THE SUBSCRIPTION. So a deploy, a restart
 * or ninety minutes of downtime does not merely delay changes — it loses them permanently and
 * silently, and can switch the whole feed off without anyone being told. A sync built only on
 * webhooks is a sync that drifts, and the drift is invisible until a customer notices their
 * two systems disagree.
 *
 * WHAT IT DOES NOT DO. It never deletes and it never archives on the strength of absence. An
 * entity that exists locally but not in the remote page could be missing for a dozen reasons
 * that are not deletion — a filter, a permission, a page boundary, a partial API failure — and
 * "it wasn't in the response" is the weakest possible evidence on which to destroy a
 * customer's record. Divergences of that shape are counted and logged for a human.
 *
 * SCHEDULER REGISTRATION (backend/services/scheduler.ts, inside hourlyJobs()):
 *
 *     void runExclusively('amocrm-reconcile', async () => { await runAmoReconciliationTick(); });
 *
 * plus the import:
 *
 *     import { runAmoReconciliationTick } from './amocrm/reconcile';
 *
 * It goes on the HOURLY loop rather than a fourth timer, and gates itself to one UTC hour a
 * night — see shouldRunAmoReconciliation. Production is pinned to UTC, so that hour is a real
 * hour and not whatever the host's locale thinks. A tick outside the window returns
 * immediately and costs one comparison.
 */

import { AmoIntegrationStatus, AmoSyncDirection, AmoSyncJobStatus, Prisma } from '@prisma/client';
import { db } from '../db';
import {
  asPlainObject,
  enqueueAmoSyncJob,
  toBigIntOrNull,
  toRemoteDate,
  type AmoClientModule,
} from './sync-worker';
import { type AmoEntityType } from './echo';

// ─── Scheduling gate ──────────────────────────────────────────────────────────

/** 03:00 UTC — after the working day in every Russian time zone, before the morning load. */
export const AMO_RECONCILE_HOUR_UTC = 3;

/** How far back to look when an org has never recorded a successful sync. */
export const AMO_RECONCILE_DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const AMO_RECONCILE_PAGE_LIMIT = 250;

export function shouldRunAmoReconciliation(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = Number.parseInt(env.AMO_RECONCILE_HOUR_UTC ?? '', 10);
  const hour = Number.isInteger(configured) && configured >= 0 && configured <= 23
    ? configured
    : AMO_RECONCILE_HOUR_UTC;
  return now.getUTCHours() === hour;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReconcileSummary = {
  organizationsScanned: number;
  entitiesInspected: number;
  healed: number;
  /** Mapped locally, absent from the remote listing. Never acted on — see the file header. */
  localOnly: number;
  errors: number;
};

const EMPTY_SUMMARY: ReconcileSummary = {
  organizationsScanned: 0,
  entitiesInspected: 0,
  healed: 0,
  localOnly: 0,
  errors: 0,
};

type ReconcileEntitySpec = {
  entityType: AmoEntityType;
  path: string;
  collection: string;
};

const RECONCILED_ENTITIES: readonly ReconcileEntitySpec[] = [
  { entityType: 'lead', path: '/api/v4/leads', collection: 'leads' },
  { entityType: 'contact', path: '/api/v4/contacts', collection: 'contacts' },
];

let clientOverride: AmoClientModule | null = null;
const CLIENT_MODULE_SPECIFIER = './client';

/** Test seam; the production path is the dynamic import. Same pattern as sync-worker.ts. */
export function setAmoReconcileClient(client: AmoClientModule | null): void {
  clientOverride = client;
}

async function loadClient(): Promise<AmoClientModule> {
  if (clientOverride) return clientOverride;
  return (await import(/* @vite-ignore */ CLIENT_MODULE_SPECIFIER)) as unknown as AmoClientModule;
}

// ─── The tick ─────────────────────────────────────────────────────────────────

export async function runAmoReconciliationTick(
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<ReconcileSummary> {
  if (!options.force && !shouldRunAmoReconciliation(now)) {
    return { ...EMPTY_SUMMARY };
  }

  // Only active integrations. A needs_reauth or paused account cannot be read, and walking it
  // would burn the same retries the sync worker deliberately refuses to burn.
  const integrations = await db.amoIntegration.findMany({
    where: { status: AmoIntegrationStatus.active },
    select: { organization_id: true, last_sync_at: true },
  });

  const summary: ReconcileSummary = { ...EMPTY_SUMMARY, organizationsScanned: integrations.length };

  for (const integration of integrations) {
    try {
      const orgSummary = await reconcileOrganization(
        integration.organization_id,
        integration.last_sync_at,
        now,
      );
      summary.entitiesInspected += orgSummary.entitiesInspected;
      summary.healed += orgSummary.healed;
      summary.localOnly += orgSummary.localOnly;
    } catch (error) {
      summary.errors += 1;
      // One unreachable account must not stop the others.
      console.error(
        `[amocrm] reconciliation failed for org ${integration.organization_id}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return summary;
}

/**
 * Diff one organization and enqueue an inbound job for anything the webhooks missed.
 *
 * Healing goes through the SAME AmoSyncJob queue the webhooks feed, not through a private
 * apply path. That is the whole point: one applier means one place where conflict resolution,
 * echo suppression and hash bookkeeping happen, so a row healed at 03:00 is treated exactly
 * like a row that arrived by webhook at noon. A second applier would be a second set of rules
 * that drift apart.
 */
export async function reconcileOrganization(
  organizationId: string,
  _lastSyncAt: Date | null,
  now: Date,
): Promise<Pick<ReconcileSummary, 'entitiesInspected' | 'healed' | 'localOnly'>> {
  const client = await loadClient();

  let entitiesInspected = 0;
  let healed = 0;
  const seenByType = new Map<AmoEntityType, Set<string>>();

  for (const spec of RECONCILED_ENTITIES) {
    const seenAmoIds = new Set<string>();
    seenByType.set(spec.entityType, seenAmoIds);

    // Full inventory, deliberately. An updated_at delta cannot distinguish "unchanged" from
    // "missing remotely", so it cannot produce a trustworthy localOnly diagnostic.
    const pages = client.paginate(organizationId, spec.path, {
      limit: AMO_RECONCILE_PAGE_LIMIT,
    });

    for await (const page of pages) {
      if (!Array.isArray(page)) continue;

      const entities = page
        .map((item) => asPlainObject(item))
        .filter((item): item is Record<string, unknown> => item !== null);

      if (entities.length === 0) continue;

      entitiesInspected += entities.length;
      healed += await healPage(organizationId, spec, entities, seenAmoIds);

    }
  }

  const localOnly = await countLocalOnly(organizationId, seenByType);

  // last_sync_at is advanced only after a clean pass. Advancing it on a partial or failed run
  // would move the lookback window past the very rows that were not checked, and they would
  // then never be checked again.
  await db.amoIntegration.updateMany({
    where: { organization_id: organizationId, status: AmoIntegrationStatus.active },
    data: { last_sync_at: now },
  });

  return { entitiesInspected, healed, localOnly };
}

async function healPage(
  organizationId: string,
  spec: ReconcileEntitySpec,
  entities: readonly Record<string, unknown>[],
  seenAmoIds: Set<string>,
): Promise<number> {
  const amoIds: bigint[] = [];
  const byAmoId = new Map<string, Record<string, unknown>>();

  for (const entity of entities) {
    const amoId = toBigIntOrNull(entity.id);
    if (amoId === null) continue;
    const key = amoId.toString();
    if (seenAmoIds.has(key)) continue;
    seenAmoIds.add(key);
    amoIds.push(amoId);
    byAmoId.set(key, entity);
  }

  if (amoIds.length === 0) return 0;

  const [maps, queued] = await Promise.all([
    db.amoEntityMap.findMany({
      where: {
        organization_id: organizationId,
        entity_type: spec.entityType,
        amo_id: { in: amoIds },
      },
      select: { amo_id: true, last_synced_at: true },
    }),
    // Anything already waiting in the queue is left alone. Enqueuing a second job for the same
    // entity would apply the same remote state twice and, worse, could reorder it behind a
    // newer change that is already queued.
    db.amoSyncJob.findMany({
      where: {
        organization_id: organizationId,
        entity_type: spec.entityType,
        amo_id: { in: amoIds },
        status: { in: [AmoSyncJobStatus.pending, AmoSyncJobStatus.processing] },
      },
      select: { amo_id: true },
    }),
  ]);

  const mapByAmoId = new Map(maps.map((row) => [row.amo_id.toString(), row]));
  const queuedAmoIds = new Set(
    queued.map((row) => (row.amo_id === null ? '' : row.amo_id.toString())),
  );

  let healedCount = 0;

  for (const [key, entity] of byAmoId) {
    if (queuedAmoIds.has(key)) continue;

    const map = mapByAmoId.get(key);
    const remoteUpdatedAt = toRemoteDate(entity.updated_at ?? entity.last_modified);

    // Never mapped -> the create webhook never arrived (or predates the integration).
    // Mapped but modified after the last successful sync -> the update webhook was lost.
    const needsHealing =
      !map ||
      (remoteUpdatedAt !== null &&
        (map.last_synced_at === null || remoteUpdatedAt.getTime() > map.last_synced_at.getTime()));

    if (!needsHealing) continue;

    await enqueueAmoSyncJob({
      organizationId,
      direction: AmoSyncDirection.inbound,
      entityType: spec.entityType,
      operation: map ? 'update' : 'create',
      amoId: BigInt(key),
      payload: {
        action: `reconcile.${spec.collection}`,
        source: 'reconcile',
        received_at: new Date().toISOString(),
        entity,
      } as Prisma.InputJsonValue,
    });

    healedCount += 1;
  }

  return healedCount;
}

/**
 * Count rows that exist here, are mapped to an amoCRM id, and were not seen in the remote
 * listing. COUNTED, NOT ACTED ON — see the file header. The number is the signal a human needs
 * to go looking; a non-zero count that stays non-zero night after night means the two systems
 * have genuinely diverged.
 */
async function countLocalOnly(
  organizationId: string,
  seenByType: ReadonlyMap<AmoEntityType, ReadonlySet<string>>,
): Promise<number> {
  const mappings = await db.amoEntityMap.findMany({
    where: {
      organization_id: organizationId,
      entity_type: { in: ['lead', 'contact'] },
    },
    select: { entity_type: true, amo_id: true },
  });
  return mappings.reduce((count, mapping) => {
    const seen = seenByType.get(mapping.entity_type as AmoEntityType);
    return seen?.has(mapping.amo_id.toString()) ? count : count + 1;
  }, 0);
}
