/**
 * The amoCRM sync worker — one tick that drains AmoSyncJob in BOTH directions.
 *
 * Shaped deliberately after runWebhookDeliveryTick in backend/services/webhooks.ts rather than
 * invented fresh: same per-row atomic claim, same lease, same exponential backoff, same
 * "oldest due first so no organization starves the others" scan. Where this differs from that
 * file, the difference is called out at the site.
 *
 * Registered from backend/services/scheduler.ts's existing 60 s loop — see the note at
 * runAmoSyncTick for the exact line.
 *
 * ─── THE THREE THINGS THAT WILL BITE ─────────────────────────────────────────
 *
 * 1. THE LEASE IS MEASURED FROM THE CLAIM, NOT FROM `now`. This is the bug that was live in
 *    webhooks.ts and in sequences.ts before it, twice, and it is subtle enough to reintroduce:
 *    `now` is captured once when the tick starts and the tick then works through a backlog. By
 *    the time a job is claimed, `now + LEASE` can already be in the past, so the row still
 *    reads as due, the next tick re-claims it while this one is mid-flight, and amoCRM gets
 *    the same PATCH twice while `attempts` burns down against a job that never failed.
 *
 * 2. needs_reauth AND paused HALT THE ORG ENTIRELY. amoCRM's refresh token rotates on every
 *    refresh; once a refresh comes back invalid_grant the account is unreachable until a human
 *    re-authorizes, and retrying against it earns a ban. A halted org's jobs are left exactly
 *    as they are — not failed, not incremented — so they resume untouched after re-auth. See
 *    haltedOrganizationIds().
 *
 * 3. DELETES ARE NOT PROPAGATED OUTBOUND. See enqueueAmoOutbound and applyInboundDelete.
 */

import { Prisma, AmoIntegrationStatus, AmoSyncDirection, AmoSyncJobStatus, ContactStatus, DealStatus } from '@prisma/client';
import { db } from '../db';
import { blindIndex, decryptField, encryptField } from '../encryption';
import {
  canonicalizeAmoEntity,
  currentSyncOrigin,
  decideOutbound,
  findEntityMapByAmoId,
  hashAmoEntity,
  isRemoteOrigin,
  recordLocalHash,
  recordRemoteHash,
  runWithSyncOrigin,
  type AmoEntityType,
  type SyncOrigin,
} from './echo';
import { AMO_STATUS_LOST, AMO_STATUS_WON } from './mapping';

// ─── Sibling module contracts ─────────────────────────────────────────────────

/**
 * What this worker needs from backend/services/amocrm/client.ts (a sibling agent's file).
 *
 * The modules are loaded through a VARIABLE specifier and a runtime `import()` rather than a
 * static `import` on purpose: they did not exist when this file was written, and a static
 * import of a missing module fails at transform time, which would take every test in this
 * suite down with it — including the ones that never touch the network. Tests inject fakes
 * through setAmoSyncDependencies() and never reach the dynamic import at all.
 *
 * IF THE SIBLING'S EXPORTS DO NOT MATCH THIS SHAPE, this is the single place to adapt.
 */
export type AmoClientModule = {
  amoRequest(orgId: string, method: string, path: string, body?: unknown): Promise<unknown>;
  paginate(orgId: string, path: string, params?: Record<string, string | number>): AsyncGenerator<unknown[]>;
};

/**
 * What this worker needs from backend/services/amocrm/mapping.ts (a sibling agent's file):
 * the amo status id <-> local stage id bridge, in both directions.
 *
 * // VERIFY: the sibling's exported names. The brief specified only "amo status id <-> local
 * // stage id", not a signature. If mapping.ts exports different names, adapt loadMapping()
 * // below — nothing else in this file touches it.
 */
export type AmoMappingModule = {
  localStageForAmoStatus(
    orgId: string,
    amoStatusId: number,
    amoPipelineId?: number | null,
  ): Promise<{ pipeline_id: string; stage_id: string } | null>;
  amoStatusForLocalStage(
    orgId: string,
    localStageId: string,
  ): Promise<{ status_id: number; pipeline_id: number } | null>;
  ensureAmoStatusForLocalStage(
    orgId: string,
    localStageId: string,
    client: AmoClientModule,
  ): Promise<{ status_id: number; pipeline_id: number }>;
};

const CLIENT_MODULE_SPECIFIER = './client';
const MAPPING_MODULE_SPECIFIER = './mapping';

let clientOverride: AmoClientModule | null = null;
let mappingOverride: AmoMappingModule | null = null;

/** Test seam. Production never calls this; the dynamic import below is the real path. */
export function setAmoSyncDependencies(deps: {
  client?: AmoClientModule | null;
  mapping?: AmoMappingModule | null;
}): void {
  if (deps.client !== undefined) clientOverride = deps.client;
  if (deps.mapping !== undefined) mappingOverride = deps.mapping;
}

export function resetAmoSyncDependencies(): void {
  clientOverride = null;
  mappingOverride = null;
}

async function loadClient(): Promise<AmoClientModule> {
  if (clientOverride) return clientOverride;
  const mod = (await import(/* @vite-ignore */ CLIENT_MODULE_SPECIFIER)) as unknown as AmoClientModule;
  return mod;
}

async function loadMapping(): Promise<AmoMappingModule> {
  if (mappingOverride) return mappingOverride;
  const mod = (await import(/* @vite-ignore */ MAPPING_MODULE_SPECIFIER)) as unknown as AmoMappingModule;
  return mod;
}

// ─── Retry policy ─────────────────────────────────────────────────────────────

/**
 * Delay before attempt N+1, indexed by the number of attempts that have already failed.
 *
 * Longer than the webhook ladder because the failure modes are different: a webhook receiver
 * that is down is somebody else's problem, whereas an amoCRM 429 means WE are the problem and
 * backing off hard is the difference between recovering and being blocked. The final rung is
 * two hours, which is long enough that a rate-limit window has certainly closed.
 */
export const AMO_SYNC_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
export const MAX_AMO_SYNC_ATTEMPTS = AMO_SYNC_RETRY_DELAYS_MS.length + 1;

/** See point 1 in the file header. Exported so a test can assert the lease is real. */
export const AMO_SYNC_LEASE_MS = 5 * 60_000;

const AMO_SYNC_TICK_SCAN_SIZE = 1000;
const AMO_SYNC_TICK_BATCH_SIZE = 100;
const AMO_SYNC_ERROR_MAX_LENGTH = 500;

/** failedAttempts is 1 after the first attempt failed; null once the cap is reached. */
export function getAmoSyncRetryDelayMs(failedAttempts: number): number | null {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    return null;
  }
  return AMO_SYNC_RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

export function nextAmoSyncAttemptAt(failedAttempts: number, failedAt: Date): Date | null {
  const delay = getAmoSyncRetryDelayMs(failedAttempts);
  return delay === null ? null : new Date(failedAt.getTime() + delay);
}

function safeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'amoCRM sync failed');
  return message.slice(0, AMO_SYNC_ERROR_MAX_LENGTH);
}

// ─── Job enqueue ──────────────────────────────────────────────────────────────

export type AmoSyncOperation = 'create' | 'update' | 'delete' | 'stage_change';

export type EnqueueAmoSyncJobInput = {
  organizationId: string;
  direction: AmoSyncDirection;
  entityType: AmoEntityType;
  operation: AmoSyncOperation;
  localId?: string | null;
  amoId?: bigint | number | null;
  payload: Prisma.InputJsonValue;
  /** Defaults to now, i.e. due on the next tick. */
  dueAt?: Date;
};

export async function enqueueAmoSyncJob(input: EnqueueAmoSyncJobInput): Promise<{ id: string }> {
  return db.amoSyncJob.create({
    data: {
      organization_id: input.organizationId,
      direction: input.direction,
      entity_type: input.entityType,
      operation: input.operation,
      local_id: input.localId ?? null,
      amo_id: input.amoId === null || input.amoId === undefined ? null : BigInt(input.amoId),
      payload: input.payload,
      status: AmoSyncJobStatus.pending,
      next_attempt_at: input.dueAt ?? new Date(),
    },
    select: { id: true },
  });
}

// ─── Outbound enqueue point (called from the domain layer) ────────────────────

export type AmoOutboundInput = {
  organizationId: string;
  entityType: AmoEntityType;
  operation: AmoSyncOperation;
  localId: string;
  /** The local row AFTER the write, exactly as Prisma returned it. */
  record: Record<string, unknown>;
  /** Overrides the ambient AsyncLocalStorage tag. Callers normally omit it. */
  origin?: SyncOrigin;
};

export type AmoOutboundResult =
  | { enqueued: true; jobId: string }
  | { enqueued: false; reason: 'no_integration' | 'integration_inactive' | 'delete_not_propagated' | 'remote_origin' | 'matches_last_remote_hash' };

/**
 * The one function deal-domain.ts and contact-domain.ts call. Standalone on purpose — those
 * two files belong to other agents right now, so this side owns every decision and the wiring
 * is a single line at each write site.
 *
 * DELETES ARE NOT PROPAGATED IN v1, and this is the enforcement point rather than a note in a
 * README. Reason: a bug on this side would delete a customer's records out of their amoCRM
 * account, which is the one failure in this whole feature that no retry, no queue and no
 * conflict table can undo. amoCRM's own recycle bin is the only safety net and it is not ours
 * to rely on. Archiving locally is reversible; deleting remotely is not, so v1 only ever does
 * the reversible one. The inbound direction still HONOURS deletes — see applyInboundDelete —
 * it just turns them into an archive too.
 */
export async function enqueueAmoOutbound(input: AmoOutboundInput): Promise<AmoOutboundResult> {
  if (input.operation === 'delete') {
    return { enqueued: false, reason: 'delete_not_propagated' };
  }

  const origin = input.origin ?? currentSyncOrigin();

  // Cheapest check first, and the only one that needs no database round trip. An inbound apply
  // does thousands of writes; none of them should cost a query to discover they are echoes.
  if (isRemoteOrigin(origin)) {
    return { enqueued: false, reason: 'remote_origin' };
  }

  const integration = await db.amoIntegration.findFirst({
    where: { organization_id: input.organizationId },
    select: { status: true },
  });

  if (!integration) {
    return { enqueued: false, reason: 'no_integration' };
  }

  // A paused or unauthorized account gets nothing queued. Queuing anyway would build a backlog
  // that all fires at once on re-auth, replaying weeks of intermediate states in order.
  if (integration.status !== AmoIntegrationStatus.active) {
    return { enqueued: false, reason: 'integration_inactive' };
  }

  const decision = await decideOutbound({
    organizationId: input.organizationId,
    entityType: input.entityType,
    localId: input.localId,
    record: input.record,
    origin,
  });

  if (decision.suppress) {
    return { enqueued: false, reason: decision.reason };
  }

  const job = await enqueueAmoSyncJob({
    organizationId: input.organizationId,
    direction: AmoSyncDirection.outbound,
    entityType: input.entityType,
    operation: input.operation,
    localId: input.localId,
    payload: {
      record: toJsonRecord(input.record),
      local_hash: decision.hash,
      local_updated_at: toIsoOrNull(input.record.updated_at),
    } as Prisma.InputJsonValue,
  });

  return { enqueued: true, jobId: job.id };
}

/**
 * Fire-and-forget wrapper, mirroring fireWebhookEvent in services/webhooks.ts.
 *
 * THIS IS THE FORM THE DOMAIN LAYER SHOULD CALL. A sync failure must never fail — or even
 * slow down — the CRM request that produced it: the queue exists precisely so the user's save
 * does not depend on a third party being up.
 */
export function fireAmoOutbound(input: AmoOutboundInput): void {
  // The origin is read HERE, synchronously, while the caller's AsyncLocalStorage context is
  // still current. Reading it inside the promise would be a coin flip: `void` detaches the
  // continuation and the store may already have unwound.
  const origin = input.origin ?? currentSyncOrigin();

  void enqueueAmoOutbound({ ...input, origin }).catch((error) => {
    // Never log the record: it holds customer PII.
    console.error(
      `[amocrm] failed to enqueue outbound ${input.entityType}.${input.operation}`,
      safeSyncError(error),
    );
  });
}

function toJsonRecord(record: Record<string, unknown>): Record<string, unknown> {
  // Date and Decimal are not JSON scalars; round-tripping normalizes them so the payload
  // re-serializes identically on every retry.
  return JSON.parse(JSON.stringify(record, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )) as Record<string, unknown>;
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

// ─── Conflict resolution ──────────────────────────────────────────────────────

export type ConflictField = {
  field: string;
  localValue: unknown;
  remoteValue: unknown;
};

export type ConflictResolutionInput = {
  organizationId: string;
  entityType: AmoEntityType;
  localId: string | null;
  amoId: bigint | number | null;
  fields: readonly ConflictField[];
  localUpdatedAt: Date | null;
  remoteUpdatedAt: Date | null;
  lastSyncedAt: Date | null;
};

export type ConflictResolution = {
  /** Fields the remote side won, ready to be written locally. */
  apply: Record<string, unknown>;
  /** One row per value that was thrown away. */
  conflicts: Array<{ field: string; winner: 'local' | 'remote' }>;
};

/**
 * Last write wins by timestamp, and EVERY DISCARDED VALUE IS WRITTEN DOWN.
 *
 * The policy is the easy half. The half that matters is the second sentence: a silent clobber
 * is indistinguishable from data loss to the person whose edit vanished, and "the CRM ate my
 * change" is unanswerable without a record. AmoSyncConflict is that record — local_value and
 * remote_value together hold both sides, so the losing value is recoverable by hand from the
 * table long after the fact.
 *
 * WHAT COUNTS AS A CONFLICT. Not "the values differ" — that is just a change. A conflict is
 * BOTH sides having moved since last_synced_at. If only the remote moved, the remote wins with
 * nothing thrown away and no row is written; noise in this table is how it stops being read.
 *
 * NO REMOTE TIMESTAMP means the ordering is unknowable, and the tie is broken in favour of
 * LOCAL — the copy whose provenance we can actually vouch for — with a conflict row recorded
 * so the remote value is still recoverable.
 */
export async function resolveAmoFieldConflicts(
  input: ConflictResolutionInput,
): Promise<ConflictResolution> {
  const apply: Record<string, unknown> = {};
  const conflicts: Array<{ field: string; winner: 'local' | 'remote' }> = [];
  const rows: Prisma.AmoSyncConflictCreateManyInput[] = [];

  const localTouchedSinceSync =
    input.localUpdatedAt !== null &&
    (input.lastSyncedAt === null || input.localUpdatedAt.getTime() > input.lastSyncedAt.getTime());

  const remoteIsNewer =
    input.remoteUpdatedAt !== null &&
    (input.localUpdatedAt === null || input.remoteUpdatedAt.getTime() > input.localUpdatedAt.getTime());

  for (const field of input.fields) {
    if (valuesEqual(field.localValue, field.remoteValue)) {
      continue;
    }

    // The remote is the only side that moved: an ordinary inbound update, not a conflict.
    // lastSyncedAt === null is the first-ever sync; there is no local edit to lose.
    if (!localTouchedSinceSync) {
      apply[field.field] = field.remoteValue;
      continue;
    }

    const winner: 'local' | 'remote' = remoteIsNewer ? 'remote' : 'local';
    if (winner === 'remote') {
      apply[field.field] = field.remoteValue;
    }

    conflicts.push({ field: field.field, winner });
    rows.push({
      organization_id: input.organizationId,
      entity_type: input.entityType,
      local_id: input.localId,
      amo_id: input.amoId === null || input.amoId === undefined ? null : BigInt(input.amoId),
      field: field.field,
      // PII is encrypted at rest everywhere else in this codebase; a conflict row holding a
      // customer's plaintext phone number would be a hole straight through that.
      local_value: conflictValue(field.field, field.localValue),
      remote_value: conflictValue(field.field, field.remoteValue),
      winner,
      local_updated_at: input.localUpdatedAt,
      remote_updated_at: input.remoteUpdatedAt,
    });
  }

  if (rows.length > 0) {
    await db.amoSyncConflict.createMany({ data: rows });
  }

  return { apply, conflicts };
}

const CONFLICT_ENCRYPTED_FIELDS = new Set(['email', 'phone', 'mobile']);

function conflictValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asString = value instanceof Date ? value.toISOString() : String(value);
  if (asString === '') return null;
  return CONFLICT_ENCRYPTED_FIELDS.has(field) ? encryptField(asString) : asString.slice(0, 2000);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const left = a === null || a === undefined || a === '' ? null : a instanceof Date ? a.toISOString() : String(a);
  const right = b === null || b === undefined || b === '' ? null : b instanceof Date ? b.toISOString() : String(b);
  return left === right;
}

// ─── Halting ──────────────────────────────────────────────────────────────────

/**
 * The org ids whose queue must not move, and the reason each is halted.
 *
 * needs_reauth is terminal until a human re-authorizes; paused is a deliberate operator
 * action. In both cases the jobs are left exactly where they are — status untouched, attempts
 * untouched, next_attempt_at untouched — so nothing is lost and nothing is burned. An org with
 * no AmoIntegration row at all is also halted: there is no account to talk to.
 */
export async function haltedOrganizationIds(
  organizationIds: readonly string[],
): Promise<Map<string, string>> {
  const halted = new Map<string, string>();
  if (organizationIds.length === 0) return halted;

  const integrations = await db.amoIntegration.findMany({
    where: { organization_id: { in: [...organizationIds] } },
    select: { organization_id: true, status: true },
  });

  const byOrg = new Map(integrations.map((row) => [row.organization_id, row.status]));

  for (const organizationId of organizationIds) {
    const status = byOrg.get(organizationId);
    if (status === undefined) {
      halted.set(organizationId, 'no amoCRM integration is connected');
    } else if (status !== AmoIntegrationStatus.active) {
      halted.set(organizationId, `amoCRM integration is ${status}`);
    }
  }

  return halted;
}

// ─── The tick ─────────────────────────────────────────────────────────────────

type JobCandidate = { id: string; organization_id: string };

export type AmoSyncTickSummary = {
  scanned: number;
  processed: number;
  haltedOrganizations: number;
};

/**
 * One pass over due jobs, both directions.
 *
 * SCHEDULER REGISTRATION (backend/services/scheduler.ts, inside minuteJobs()):
 *
 *     void runExclusively('amocrm-sync', async () => { await runAmoSyncTick(); });
 *
 * plus the import:
 *
 *     import { runAmoSyncTick } from './amocrm/sync-worker';
 *
 * runExclusively is the same guard the webhook tick uses and is needed for the same reason:
 * the claim below makes a second PROCESS safe, but it does not stop this tick being started
 * again while it is still working through a backlog it has already scanned.
 */
export async function runAmoSyncTick(now: Date = new Date()): Promise<AmoSyncTickSummary> {
  // A claimed row is `processing` with next_attempt_at pushed out by the lease, so scanning
  // both states is what recovers work from a process that died mid-flight.
  const dueRows = await db.amoSyncJob.findMany({
    where: {
      status: { in: [AmoSyncJobStatus.pending, AmoSyncJobStatus.processing] },
      next_attempt_at: { lte: now },
    },
    select: { organization_id: true },
    orderBy: { next_attempt_at: 'asc' },
    take: AMO_SYNC_TICK_SCAN_SIZE,
  });

  const organizationIds = [...new Set(dueRows.map((row) => row.organization_id))];
  const halted = await haltedOrganizationIds(organizationIds);

  let processed = 0;

  for (const organizationId of organizationIds) {
    const haltReason = halted.get(organizationId);
    if (haltReason) {
      // Deliberately not an error and deliberately not a status change on the jobs. Said out
      // loud, because a queue that silently stops is the failure nobody notices.
      console.warn(`[amocrm] sync halted for org ${organizationId}: ${haltReason}`);
      continue;
    }

    const candidates = await db.amoSyncJob.findMany({
      where: {
        organization_id: organizationId,
        status: { in: [AmoSyncJobStatus.pending, AmoSyncJobStatus.processing] },
        next_attempt_at: { lte: now },
      },
      select: { id: true, organization_id: true },
      // Oldest first: within one entity the operations are order-dependent (a create must land
      // before the update that follows it), so these are drained strictly sequentially rather
      // than in concurrent waves the way independent webhook deliveries are.
      orderBy: { next_attempt_at: 'asc' },
      take: AMO_SYNC_TICK_BATCH_SIZE,
    });

    for (const candidate of candidates) {
      try {
        if (await processAmoSyncJob(candidate, now)) {
          processed += 1;
        }
      } catch (error) {
        console.error('[amocrm] sync job failed outside its own handler', safeSyncError(error));
      }
    }
  }

  return { scanned: dueRows.length, processed, haltedOrganizations: halted.size };
}

/** Returns true if this worker won the claim and ran the job. */
export async function processAmoSyncJob(candidate: JobCandidate, now: Date): Promise<boolean> {
  // See point 1 in the file header: the lease is measured from HERE, not from `now`. The
  // `where` still tests `now`, so a row another worker has already leased cannot be stolen.
  const claimedAt = new Date();
  const claimed = await db.amoSyncJob.updateMany({
    where: {
      id: candidate.id,
      organization_id: candidate.organization_id,
      status: { in: [AmoSyncJobStatus.pending, AmoSyncJobStatus.processing] },
      next_attempt_at: { lte: now },
    },
    data: {
      status: AmoSyncJobStatus.processing,
      attempts: { increment: 1 },
      next_attempt_at: new Date(claimedAt.getTime() + AMO_SYNC_LEASE_MS),
    },
  });

  if (claimed.count !== 1) {
    return false;
  }

  const job = await db.amoSyncJob.findFirst({
    where: { id: candidate.id, organization_id: candidate.organization_id },
    select: {
      id: true,
      organization_id: true,
      direction: true,
      entity_type: true,
      operation: true,
      local_id: true,
      amo_id: true,
      payload: true,
      attempts: true,
    },
  });

  if (!job) {
    return false;
  }

  try {
    const outcome = job.direction === AmoSyncDirection.inbound
      // Everything written beneath this call is tagged 'amo', so no write inside it can
      // produce an outbound job. Defence 1 from echo.ts, applied at its only real seam.
      ? await runWithSyncOrigin('amo', () => applyInboundJob(job))
      : await pushOutboundJob(job);

    await db.amoSyncJob.updateMany({
      where: { id: job.id, organization_id: job.organization_id },
      data: {
        status: outcome.dropped ? AmoSyncJobStatus.dropped : AmoSyncJobStatus.delivered,
        error_message: outcome.reason ?? null,
        processed_at: new Date(),
        next_attempt_at: null,
      },
    });

    return true;
  } catch (error) {
    await failAmoSyncJob(job.id, job.organization_id, job.attempts, error);
    return true;
  }
}

async function failAmoSyncJob(
  jobId: string,
  organizationId: string,
  attempts: number,
  error: unknown,
): Promise<void> {
  const failedAt = new Date();
  const retryAt = nextAmoSyncAttemptAt(attempts, failedAt);
  const message = safeSyncError(error);

  await db.amoSyncJob.updateMany({
    where: { id: jobId, organization_id: organizationId },
    data: retryAt
      ? {
          status: AmoSyncJobStatus.pending,
          error_message: message,
          next_attempt_at: retryAt,
        }
      : {
          // Out of attempts. The reason is recorded rather than the row being deleted: a
          // failed job is the only evidence that a change never reached amoCRM.
          status: AmoSyncJobStatus.failed,
          error_message: message,
          next_attempt_at: null,
          processed_at: failedAt,
        },
  });
}

// ─── Job shape ────────────────────────────────────────────────────────────────

type SyncJobRow = {
  id: string;
  organization_id: string;
  direction: AmoSyncDirection;
  entity_type: string;
  operation: string;
  local_id: string | null;
  amo_id: bigint | null;
  payload: Prisma.JsonValue;
  attempts: number;
};

type JobOutcome = { dropped: boolean; reason?: string };

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function entityTypeOf(job: SyncJobRow): AmoEntityType | null {
  return job.entity_type === 'lead' || job.entity_type === 'contact' || job.entity_type === 'company'
    ? job.entity_type
    : null;
}

// ─── Inbound ──────────────────────────────────────────────────────────────────

/**
 * Apply one change amoCRM sent us.
 *
 * Runs inside runWithSyncOrigin('amo'), so every write beneath it is tagged and cannot bounce
 * back out. The hash written at the end is defence 2 for the same change, and the two are
 * independent on purpose — see echo.ts.
 */
export async function applyInboundJob(job: SyncJobRow): Promise<JobOutcome> {
  const entityType = entityTypeOf(job);
  if (!entityType) {
    return { dropped: true, reason: `unsupported entity type: ${job.entity_type}` };
  }
  const payload = asRecord(job.payload);
  const entity = asRecord(payload.entity as Prisma.JsonValue);

  if (job.operation === 'delete') {
    return applyInboundDelete(job, entityType);
  }

  if (entityType === 'lead') {
    return applyInboundLead(job, entity, payload);
  }

  if (entityType === 'contact') {
    return applyInboundContact(job, entity, payload);
  }

  // Companies map onto Contact rows in 4КУБ and have no dedicated local entity in v1.
  return { dropped: true, reason: `inbound ${entityType} is not applied in v1` };
}

/**
 * INBOUND DELETE ARCHIVES, IT DOES NOT DELETE.
 *
 * amoCRM's delete_lead means "the operator moved this to the recycle bin", which is reversible
 * on their side for 30 days. Mirroring that with a real DELETE here would be irreversible on
 * ours, and would take the deal's tasks, calendar events and activity history with it — none
 * of which amoCRM knows about or asked to remove. A restore from their bin would then have
 * nothing to restore to.
 *
 * Archiving keeps the row, its history and its foreign keys, and DealStatus.archived /
 * ContactStatus.archived already exist for exactly this. If a customer genuinely wants the
 * record gone, the local delete path is a deliberate, audited action they take here.
 */
async function applyInboundDelete(job: SyncJobRow, entityType: AmoEntityType): Promise<JobOutcome> {
  if (job.amo_id === null) {
    return { dropped: true, reason: 'delete without an amo_id' };
  }

  const map = await findEntityMapByAmoId(job.organization_id, entityType, job.amo_id);
  if (!map) {
    return { dropped: true, reason: 'delete for an entity that was never synced' };
  }

  if (entityType === 'lead') {
    await db.deal.updateMany({
      where: { id: map.local_id, organization_id: job.organization_id },
      data: { status: DealStatus.archived },
    });
    return { dropped: false, reason: 'archived locally; deletes are never propagated' };
  }

  await db.contact.updateMany({
    where: { id: map.local_id, organization_id: job.organization_id },
    data: { status: ContactStatus.archived },
  });
  return { dropped: false, reason: 'archived locally; deletes are never propagated' };
}

async function applyInboundLead(
  job: SyncJobRow,
  entity: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const amoId = job.amo_id ?? toBigIntOrNull(entity.id);
  if (amoId === null) {
    return { dropped: true, reason: 'lead webhook carried no id' };
  }

  const remoteUpdatedAt = toRemoteDate(entity.last_modified ?? entity.updated_at ?? payload.received_at);
  const map = await findEntityMapByAmoId(job.organization_id, 'lead', amoId);

  const statusId = toNumberOrNull(entity.status_id);
  const pipelineId = toNumberOrNull(entity.pipeline_id);
  let localStage: { pipeline_id: string; stage_id: string } | null = null;

  if (statusId !== null) {
    const mapping = await loadMapping();
    localStage = await mapping.localStageForAmoStatus(job.organization_id, statusId, pipelineId);
    if (!localStage) {
      // Thrown, not dropped: an unmapped stage is a configuration gap a human can close, and
      // the job should still be waiting when they do.
      throw new Error(`no local stage is mapped to amoCRM status ${statusId}`);
    }
  }

  if (!map) {
    if (job.operation === 'stage_change') {
      return { dropped: true, reason: 'stage change for a lead that has never been imported' };
    }
    const remoteContactId = await resolveInboundLeadContactId(job.organization_id, amoId, entity);
    return createLocalDealFromAmo(
      job,
      entity,
      amoId,
      localStage,
      remoteUpdatedAt,
      remoteContactId,
    );
  }

  const deal = await db.deal.findFirst({
    where: { id: map.local_id, organization_id: job.organization_id },
  });

  if (!deal) {
    return { dropped: true, reason: 'mapped local deal no longer exists' };
  }

  const remoteContactId = await resolveInboundLeadContactId(job.organization_id, amoId, entity);

  const remoteFields: ConflictField[] = [];
  if (typeof entity.name === 'string' && entity.name !== '') {
    remoteFields.push({ field: 'title', localValue: deal.title, remoteValue: entity.name });
  }
  const price = toNumberOrNull(entity.price);
  if (price !== null) {
    remoteFields.push({ field: 'value', localValue: deal.value, remoteValue: price });
  }
  if (localStage) {
    remoteFields.push({ field: 'stage_id', localValue: deal.stage_id, remoteValue: localStage.stage_id });
    remoteFields.push({ field: 'pipeline_id', localValue: deal.pipeline_id, remoteValue: localStage.pipeline_id });
  }
  remoteFields.push({
    field: 'contact_id',
    localValue: deal.contact_id,
    remoteValue: remoteContactId,
  });
  const remoteStatus = statusId === AMO_STATUS_WON
    ? DealStatus.won
    : statusId === AMO_STATUS_LOST
      ? DealStatus.lost
      : statusId === null
        ? null
        : DealStatus.open;
  if (remoteStatus !== null) {
    remoteFields.push({ field: 'status', localValue: deal.status, remoteValue: remoteStatus });
    remoteFields.push({
      field: 'actual_close',
      localValue: deal.actual_close,
      remoteValue: remoteStatus === DealStatus.open
        ? null
        : toRemoteDate(entity.closed_at) ?? remoteUpdatedAt ?? new Date(),
    });
  }

  const resolution = await resolveAmoFieldConflicts({
    organizationId: job.organization_id,
    entityType: 'lead',
    localId: deal.id,
    amoId,
    fields: remoteFields,
    localUpdatedAt: deal.updated_at,
    remoteUpdatedAt,
    lastSyncedAt: map.last_synced_at,
  });

  const data: Prisma.DealUncheckedUpdateInput = {};
  if (resolution.apply.title !== undefined) data.title = String(resolution.apply.title);
  if (resolution.apply.value !== undefined) data.value = Number(resolution.apply.value);
  if (resolution.apply.stage_id !== undefined) {
    data.stage_id = String(resolution.apply.stage_id);
    // The stage clock restarts when the stage does; every funnel report reads this column.
    data.stage_entered_at = new Date();
  }
  if (resolution.apply.pipeline_id !== undefined) data.pipeline_id = String(resolution.apply.pipeline_id);
  if (resolution.apply.contact_id !== undefined) {
    data.contact_id = resolution.apply.contact_id === null
      ? null
      : String(resolution.apply.contact_id);
  }
  if (resolution.apply.status !== undefined) data.status = String(resolution.apply.status) as DealStatus;
  if (resolution.apply.actual_close !== undefined) {
    data.actual_close = resolution.apply.actual_close === null
      ? null
      : toRemoteDate(resolution.apply.actual_close);
  }

  if (Object.keys(data).length > 0) {
    await db.deal.updateMany({
      where: { id: deal.id, organization_id: job.organization_id },
      data,
    });
  }

  const written = await db.deal.findFirst({
    where: { id: deal.id, organization_id: job.organization_id },
  });

  // Hash what we WROTE, not what we received — see the header of echo.ts. This is the value
  // the outbound enqueue that this write may have triggered will compare itself against.
  await recordRemoteHash({
    organizationId: job.organization_id,
    entityType: 'lead',
    localId: deal.id,
    amoId,
    hash: hashAmoEntity('lead', (written ?? deal) as unknown as Record<string, unknown>),
  });

  return {
    dropped: false,
    reason: resolution.conflicts.length > 0
      ? `${resolution.conflicts.length} field conflict(s) recorded`
      : undefined,
  };
}

async function createLocalDealFromAmo(
  job: SyncJobRow,
  entity: Record<string, unknown>,
  amoId: bigint,
  localStage: { pipeline_id: string; stage_id: string } | null,
  _remoteUpdatedAt: Date | null,
  contactId: string | null,
): Promise<JobOutcome> {
  if (!localStage) {
    throw new Error('cannot create a local deal without a mapped pipeline stage');
  }

  const title = typeof entity.name === 'string' && entity.name !== ''
    ? entity.name
    : `amoCRM #${amoId.toString()}`;

  const statusId = toNumberOrNull(entity.status_id);
  const status = statusId === AMO_STATUS_WON
    ? DealStatus.won
    : statusId === AMO_STATUS_LOST
      ? DealStatus.lost
      : DealStatus.open;
  const deal = await db.deal.create({
    data: {
      organization_id: job.organization_id,
      title,
      value: toNumberOrNull(entity.price) ?? undefined,
      pipeline_id: localStage.pipeline_id,
      stage_id: localStage.stage_id,
      contact_id: contactId,
      source: 'amocrm',
      status,
      actual_close: status === DealStatus.open
        ? undefined
        : toRemoteDate(entity.closed_at) ?? new Date(),
    },
  });

  await recordRemoteHash({
    organizationId: job.organization_id,
    entityType: 'lead',
    localId: deal.id,
    amoId,
    hash: hashAmoEntity('lead', deal as unknown as Record<string, unknown>),
  });

  return { dropped: false };
}

type AmoLeadContactRef = { amoId: bigint | null; authoritative: boolean };

/**
 * Resolve amoCRM's single main-contact relationship onto Deal.contact_id.
 *
 * Lead webhooks are sparse: some carry `_embedded.contacts`, others contain only the lead id
 * and changed scalar fields. An absent `_embedded.contacts` is therefore not a clear. In that
 * case we read the relationship endpoint before touching the local foreign key. A present,
 * empty contacts array is an explicit "no contact" and needs no round trip.
 */
async function resolveInboundLeadContactId(
  organizationId: string,
  amoLeadId: bigint,
  entity: Record<string, unknown>,
): Promise<string | null> {
  const embedded = readEmbeddedLeadContact(entity);
  const ref = embedded.authoritative
    ? embedded
    : readLeadContactLinks(await (await loadClient()).amoRequest(
        organizationId,
        'GET',
        `/api/v4/leads/${amoLeadId.toString()}/links`,
      ));

  if (ref.amoId === null) return null;

  const map = await findEntityMapByAmoId(organizationId, 'contact', ref.amoId);
  if (!map) {
    // Contact events can arrive after lead events in the same webhook delivery. Retrying is
    // intentional: once that contact job creates its tenant-scoped map, this lead can link
    // without silently losing the relationship in the meantime.
    throw new Error(
      `amoCRM lead ${amoLeadId.toString()} main contact ${ref.amoId.toString()} has no local mapping`,
    );
  }

  const contact = await db.contact.findFirst({
    where: { id: map.local_id, organization_id: organizationId },
    select: { id: true },
  });
  if (!contact) {
    throw new Error(
      `amoCRM lead ${amoLeadId.toString()} main contact maps to a missing local contact`,
    );
  }

  return contact.id;
}

function readEmbeddedLeadContact(entity: Record<string, unknown>): AmoLeadContactRef {
  const embedded = asPlainObject(entity._embedded);
  if (!embedded || !Object.prototype.hasOwnProperty.call(embedded, 'contacts')) {
    return { amoId: null, authoritative: false };
  }

  const contacts = Array.isArray(embedded.contacts) ? embedded.contacts : [];
  const refs = contacts.map(asPlainObject).filter((value): value is Record<string, unknown> => value !== null);
  const main = refs.find((contact) => contact.is_main === true) ?? refs[0] ?? null;
  const amoId = main ? toBigIntOrNull(main.id) : null;
  if (main && amoId === null) {
    throw new Error('amoCRM lead embedded contact has an invalid id');
  }
  return { amoId, authoritative: true };
}

function readLeadContactLinks(response: unknown): AmoLeadContactRef {
  const contacts = readAmoContactLinks(response);
  const main = contacts.find((link) => link.isMain) ?? contacts[0] ?? null;

  return {
    amoId: main?.amoId ?? null,
    authoritative: true,
  };
}

async function applyInboundContact(
  job: SyncJobRow,
  entity: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const amoId = job.amo_id ?? toBigIntOrNull(entity.id);
  if (amoId === null) {
    return { dropped: true, reason: 'contact webhook carried no id' };
  }

  const remoteUpdatedAt = toRemoteDate(entity.last_modified ?? entity.updated_at ?? payload.received_at);
  const map = await findEntityMapByAmoId(job.organization_id, 'contact', amoId);
  const name = typeof entity.name === 'string' ? entity.name.trim() : '';
  const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
  const lastName = rest.join(' ');

  // amoCRM carries phone/email in custom_fields, and the webhook body only sometimes includes
  // them. What is absent here is healed by the nightly reconcile, which reads the full entity.
  const customFields = readAmoCustomFields(entity);

  if (!map) {
    const contact = await db.contact.create({
      data: {
        organization_id: job.organization_id,
        first_name: firstName || `amoCRM #${amoId.toString()}`,
        last_name: lastName || undefined,
        email: customFields.email ? encryptField(customFields.email) : undefined,
        email_bidx: customFields.email ? blindIndex(customFields.email, 'email') : undefined,
        phone: customFields.phone ? encryptField(customFields.phone) : undefined,
        phone_bidx: customFields.phone ? blindIndex(customFields.phone, 'phone') : undefined,
        source: 'amocrm',
      },
    });

    await recordRemoteHash({
      organizationId: job.organization_id,
      entityType: 'contact',
      localId: contact.id,
      amoId,
      hash: hashAmoEntity('contact', contact as unknown as Record<string, unknown>),
    });

    return { dropped: false };
  }

  const contact = await db.contact.findFirst({
    where: { id: map.local_id, organization_id: job.organization_id },
  });

  if (!contact) {
    return { dropped: true, reason: 'mapped local contact no longer exists' };
  }

  const remoteFields: ConflictField[] = [];
  if (firstName) {
    remoteFields.push({ field: 'first_name', localValue: contact.first_name, remoteValue: firstName });
    remoteFields.push({ field: 'last_name', localValue: contact.last_name, remoteValue: lastName || null });
  }
  if (customFields.email !== null) {
    remoteFields.push({
      field: 'email',
      localValue: decryptField(contact.email ?? undefined) ?? null,
      remoteValue: customFields.email,
    });
  }
  if (customFields.phone !== null) {
    remoteFields.push({
      field: 'phone',
      localValue: decryptField(contact.phone ?? undefined) ?? null,
      remoteValue: customFields.phone,
    });
  }

  const resolution = await resolveAmoFieldConflicts({
    organizationId: job.organization_id,
    entityType: 'contact',
    localId: contact.id,
    amoId,
    fields: remoteFields,
    localUpdatedAt: contact.updated_at,
    remoteUpdatedAt,
    lastSyncedAt: map.last_synced_at,
  });

  const data: Prisma.ContactUncheckedUpdateInput = {};
  if (resolution.apply.first_name !== undefined) data.first_name = String(resolution.apply.first_name);
  if (resolution.apply.last_name !== undefined) {
    data.last_name = resolution.apply.last_name === null ? null : String(resolution.apply.last_name);
  }
  if (resolution.apply.email !== undefined) {
    const email = resolution.apply.email === null ? null : String(resolution.apply.email);
    data.email = email ? encryptField(email) : null;
    data.email_bidx = email ? blindIndex(email, 'email') : null;
  }
  if (resolution.apply.phone !== undefined) {
    const phone = resolution.apply.phone === null ? null : String(resolution.apply.phone);
    data.phone = phone ? encryptField(phone) : null;
    data.phone_bidx = phone ? blindIndex(phone, 'phone') : null;
  }
  if (Object.keys(data).length > 0) {
    await db.contact.updateMany({
      where: { id: contact.id, organization_id: job.organization_id },
      data,
    });
  }

  const written = await db.contact.findFirst({
    where: { id: contact.id, organization_id: job.organization_id },
  });

  await recordRemoteHash({
    organizationId: job.organization_id,
    entityType: 'contact',
    localId: contact.id,
    amoId,
    hash: hashAmoEntity('contact', (written ?? contact) as unknown as Record<string, unknown>),
  });

  return {
    dropped: false,
    reason: resolution.conflicts.length > 0
      ? `${resolution.conflicts.length} field conflict(s) recorded`
      : undefined,
  };
}

/**
 * Pull phone/email out of amoCRM's custom_fields shape.
 *
 * // VERIFY: amoCRM's webhook body uses the v2 custom_fields layout
 * //   contacts[update][0][custom_fields][0][{id,name,code,values[0][value]}]
 * // while the v4 REST API returns `custom_fields_values` with `field_code`. Both spellings
 * // are read here because the webhook and the API disagree and the docs describe only the
 * // API one (https://www.amocrm.ru/developers/content/crm_platform/webhooks-format).
 */
function readAmoCustomFields(entity: Record<string, unknown>): { email: string | null; phone: string | null } {
  const groups = [entity.custom_fields, entity.custom_fields_values].filter(Array.isArray) as unknown[][];
  let email: string | null = null;
  let phone: string | null = null;

  for (const group of groups) {
    for (const rawField of group) {
      const field = asPlainObject(rawField);
      if (!field) continue;

      const code = String(field.code ?? field.field_code ?? field.name ?? '').toUpperCase();
      const values = Array.isArray(field.values) ? field.values : [];
      const first = asPlainObject(values[0]);
      const value = first ? first.value : undefined;
      if (typeof value !== 'string' || value === '') continue;

      if (code.includes('EMAIL') && email === null) email = value;
      if (code.includes('PHONE') && phone === null) phone = value;
    }
  }

  return { email, phone };
}

// ─── Outbound ─────────────────────────────────────────────────────────────────

/** Push one local change to amoCRM. Throws to trigger backoff; returns to settle the job. */
export async function pushOutboundJob(job: SyncJobRow): Promise<JobOutcome> {
  if (job.operation === 'delete') {
    // Belt and braces: enqueueAmoOutbound already refuses to create these, so a delete job in
    // the outbound queue means something bypassed that helper. It still does not go out.
    return { dropped: true, reason: 'deletes are never propagated to amoCRM in v1' };
  }

  const entityType = entityTypeOf(job);
  if (!entityType) {
    return { dropped: true, reason: `unsupported entity type: ${job.entity_type}` };
  }
  if (entityType === 'company') {
    return { dropped: true, reason: 'outbound company sync is not implemented in v1' };
  }

  if (!job.local_id) {
    return { dropped: true, reason: 'outbound job carried no local_id' };
  }

  const payload = asRecord(job.payload);
  const record = asRecord(payload.record as Prisma.JsonValue);
  const client = await loadClient();

  const map = await db.amoEntityMap.findFirst({
    where: {
      organization_id: job.organization_id,
      entity_type: entityType,
      local_id: job.local_id,
    },
    select: { amo_id: true },
  });

  const leadContact = entityType === 'lead'
    ? await resolveOutboundLeadContact(job.organization_id, record)
    : { specified: false, amoId: null };

  const body = entityType === 'lead'
    ? await buildLeadBody(job.organization_id, record)
    : buildContactBody(record, map !== null);

  let amoId = map?.amo_id ?? null;
  let createdNow = false;

  if (amoId === null) {
    const created = await client.amoRequest(
      job.organization_id,
      'POST',
      entityType === 'lead' ? '/api/v4/leads' : '/api/v4/contacts',
      [body],
    );
    amoId = readCreatedAmoId(created, entityType);
    if (amoId === null) {
      throw new Error('amoCRM did not return an id for the created entity');
    }
    createdNow = true;

    if (entityType === 'lead' && leadContact.specified) {
      // A lead creation and a relation write are two amoCRM requests. Persist the assigned id
      // between them so a relation timeout retries this lead instead of creating a duplicate.
      await recordLocalHash({
        organizationId: job.organization_id,
        entityType,
        localId: job.local_id,
        amoId,
        hash: typeof payload.local_hash === 'string'
          ? payload.local_hash
          : hashAmoPayloadFromRecord(entityType, record),
      });
    }
  } else {
    await client.amoRequest(
      job.organization_id,
      'PATCH',
      `${entityType === 'lead' ? '/api/v4/leads' : '/api/v4/contacts'}/${amoId.toString()}`,
      body,
    );
  }

  if (entityType === 'lead' && leadContact.specified) {
    await reconcileOutboundLeadContact(
      client,
      job.organization_id,
      amoId,
      leadContact.amoId,
      createdNow,
    );
  }

  // Record what we pushed, so amoCRM telling us about our own push is recognisable as such.
  await recordLocalHash({
    organizationId: job.organization_id,
    entityType,
    localId: job.local_id,
    amoId,
    hash: typeof payload.local_hash === 'string'
      ? payload.local_hash
      : hashAmoPayloadFromRecord(entityType, record),
  });

  return { dropped: false };
}

type OutboundLeadContact = { specified: boolean; amoId: bigint | null };

async function resolveOutboundLeadContact(
  organizationId: string,
  record: Record<string, unknown>,
): Promise<OutboundLeadContact> {
  if (!Object.prototype.hasOwnProperty.call(record, 'contact_id')) {
    // Old or deliberately partial queue rows did not authorize a relationship clear.
    return { specified: false, amoId: null };
  }
  if (record.contact_id === null || record.contact_id === undefined || record.contact_id === '') {
    return { specified: true, amoId: null };
  }
  if (typeof record.contact_id !== 'string') {
    throw new Error('local deal contact_id is not a valid id');
  }

  const contact = await db.contact.findFirst({
    where: { id: record.contact_id, organization_id: organizationId },
    select: { id: true },
  });
  if (!contact) {
    throw new Error(`local deal contact ${record.contact_id} does not exist in this organization`);
  }

  const map = await db.amoEntityMap.findFirst({
    where: { organization_id: organizationId, entity_type: 'contact', local_id: contact.id },
    select: { amo_id: true },
  });
  if (!map) {
    // The dependency stays visible in AmoSyncJob.error_message and succeeds once the contact
    // create job has recorded its identity map. Silently sending an unlinked lead is data loss.
    throw new Error(`local deal contact ${contact.id} has no amoCRM mapping`);
  }

  return { specified: true, amoId: map.amo_id };
}

async function reconcileOutboundLeadContact(
  client: AmoClientModule,
  organizationId: string,
  amoLeadId: bigint,
  desiredContactId: bigint | null,
  createdNow: boolean,
): Promise<void> {
  const existing = createdNow
    ? []
    : readAmoContactLinks(await client.amoRequest(
        organizationId,
        'GET',
        `/api/v4/leads/${amoLeadId.toString()}/links`,
      ));
  const currentMain = existing.filter((link) => link.isMain);
  const desiredIsMain = desiredContactId !== null && currentMain.some((link) => link.amoId === desiredContactId);

  if (desiredContactId !== null && !desiredIsMain) {
    await client.amoRequest(
      organizationId,
      'POST',
      `/api/v4/leads/${amoLeadId.toString()}/link`,
      [{
        to_entity_id: amoJsonInteger(desiredContactId),
        to_entity_type: 'contacts',
        metadata: { is_main: true },
      }],
    );
  }

  // Only replace the relationship 4KUB models: the previous main contact. Non-main contacts
  // can belong to another amoCRM workflow and are never detached here.
  const obsoleteMain = currentMain.filter((link) => desiredContactId === null || link.amoId !== desiredContactId);
  if (obsoleteMain.length > 0) {
    await client.amoRequest(
      organizationId,
      'POST',
      `/api/v4/leads/${amoLeadId.toString()}/unlink`,
      obsoleteMain.map((link) => ({
        to_entity_id: amoJsonInteger(link.amoId),
        to_entity_type: 'contacts',
      })),
    );
  }
}

function readAmoContactLinks(response: unknown): Array<{ amoId: bigint; isMain: boolean }> {
  const root = asPlainObject(response);
  const embedded = root ? asPlainObject(root._embedded) : null;
  const links = embedded && Array.isArray(embedded.links)
    ? embedded.links.map(asPlainObject).filter((value): value is Record<string, unknown> => value !== null)
    : [];

  return links.flatMap((link) => {
    if (link.to_entity_type !== 'contacts') return [];
    const amoId = toBigIntOrNull(link.to_entity_id);
    if (amoId === null) {
      throw new Error('amoCRM lead contact link has an invalid id');
    }
    const metadata = asPlainObject(link.metadata);
    return [{
      amoId,
      isMain: metadata?.main_contact === true || metadata?.is_main === true,
    }];
  });
}

function amoJsonInteger(value: bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`amoCRM id ${value.toString()} exceeds JSON's safe integer range`);
  }
  return asNumber;
}

function hashAmoPayloadFromRecord(entityType: AmoEntityType, record: Record<string, unknown>): string {
  return hashAmoEntity(entityType, record);
}

async function buildLeadBody(
  organizationId: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (typeof record.title === 'string') body.name = record.title;
  const value = toNumberOrNull(record.value);
  if (value !== null) body.price = value;

  if (typeof record.stage_id === 'string') {
    const mapping = await loadMapping();
    const client = await loadClient();
    const amoStage = await mapping.ensureAmoStatusForLocalStage(organizationId, record.stage_id, client);
    // 4KUB stores won/lost as Deal.status even when the deal remains visually on the stage
    // where it closed. amoCRM represents those outcomes as reserved statuses 142/143, so a
    // mark-won/mark-lost mutation must override the ordinary mapped stage.
    body.status_id = record.status === DealStatus.won
      ? AMO_STATUS_WON
      : record.status === DealStatus.lost
        ? AMO_STATUS_LOST
        : amoStage.status_id;
    body.pipeline_id = amoStage.pipeline_id;
  }

  // responsible_user_id is deliberately absent: it needs a 4КУБ user <-> amoCRM user id map
  // that nothing in this schema holds yet. Sending a wrong one would silently reassign a
  // customer's deals to the wrong salesperson, which is worse than not syncing the field.
  return body;
}

function buildContactBody(
  record: Record<string, unknown>,
  clearMissingCustomFields: boolean,
): Record<string, unknown> {
  const first = typeof record.first_name === 'string' ? record.first_name : '';
  const last = typeof record.last_name === 'string' ? record.last_name : '';
  const body: Record<string, unknown> = { name: `${first} ${last}`.trim() };

  const customFields: unknown[] = [];
  const email = decryptField(typeof record.email === 'string' ? record.email : undefined);
  const phone = decryptField(typeof record.phone === 'string' ? record.phone : undefined);

  // // VERIFY: amoCRM accepts `field_code: 'EMAIL' | 'PHONE'` on /api/v4/contacts in place of a
  // // numeric field_id for the two system fields. The alternative is resolving the account's
  // // custom-field ids first, which is a second round trip per push.
  if (email) {
    customFields.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
  } else if (clearMissingCustomFields) {
    customFields.push({ field_code: 'EMAIL', values: null });
  }
  if (phone) {
    customFields.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] });
  } else if (clearMissingCustomFields) {
    customFields.push({ field_code: 'PHONE', values: null });
  }
  if (customFields.length > 0) {
    body.custom_fields_values = customFields;
  }

  return body;
}

function readCreatedAmoId(response: unknown, entityType: AmoEntityType): bigint | null {
  const root = asPlainObject(response);
  const embedded = root ? asPlainObject(root._embedded) : null;
  const collection = embedded ? embedded[entityType === 'lead' ? 'leads' : 'contacts'] : undefined;
  const first = Array.isArray(collection) ? asPlainObject(collection[0]) : null;
  return first ? toBigIntOrNull(first.id) : null;
}

// ─── Small conversions ────────────────────────────────────────────────────────

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null && typeof (value as { toString: () => string }).toString === 'function') {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toBigIntOrNull(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * amoCRM timestamps are unix SECONDS, not milliseconds.
 *
 * Getting this wrong does not throw — it produces a date in 1970, which makes the remote side
 * lose every conflict for the rest of time and hands amoCRM's edits silently to the local
 * copy. The heuristic below treats anything below ~year 2286 as seconds.
 */
export function toRemoteDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const asNumber = toNumberOrNull(value);
  if (asNumber !== null && asNumber > 0) {
    return new Date(asNumber < 1e11 ? asNumber * 1000 : asNumber);
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export { canonicalizeAmoEntity, hashAmoEntity };
