/**
 * Echo suppression for the amoCRM two-way sync.
 *
 * Without this file the sync is a loop: amoCRM pushes a change -> we apply it locally ->
 * the local write site enqueues an outbound job -> we push it back to amoCRM -> amoCRM's
 * webhook fires again -> forever, at whatever rate the queue drains, against a live customer
 * account that bans integrations for exactly this behaviour.
 *
 * TWO INDEPENDENT DEFENCES, both required. Either one alone has a hole:
 *
 *   1. ORIGIN TAGGING (in-process, cheap, covers the common case).
 *      A write performed while applying an inbound job is tagged `amo`, and the outbound
 *      enqueue helper refuses to queue anything tagged `amo` or `reconcile`.
 *
 *      MECHANISM CHOSEN: AsyncLocalStorage, not an explicit `origin` argument.
 *      Justification — the enqueue points are inside deal-domain.ts / contact-domain.ts, and
 *      those functions are called from at least five places (the HTTP controllers, the MCP
 *      tools, contact-import.ts, importBitrix24.ts and this sync worker). Threading an
 *      explicit `origin` through would mean changing the public signature of every one of
 *      those functions and every caller of them — a change that is both larger than this
 *      feature and, right now, in another agent's hands. ALS carries the tag across the
 *      `await` boundaries without touching a single intermediate signature, so the sync
 *      worker wraps its apply step and every write beneath it inherits the tag.
 *
 *      WHAT ALS DOES NOT COVER, and why defence 2 is not optional: a tag is lost the moment
 *      a write escapes the async context — a `void somePromise.then(...)` scheduled from
 *      inside the context but resolved outside it, a queue drained by a timer, or a second
 *      process. ALS is a hint, not a guarantee. It cannot be the only thing standing between
 *      the customer and an infinite loop.
 *
 *   2. HASH COMPARISON (durable, survives process boundaries, covers everything else).
 *      Before an outbound job is queued we hash the canonical projection of the entity and
 *      compare it with AmoEntityMap.last_remote_hash — the hash of the state the LAST INBOUND
 *      change produced. Equal means "this is the change we just received"; the job is dropped.
 *      last_local_hash is maintained symmetrically so the inbound side can tell an echo of our
 *      own push from a genuine remote edit.
 *
 * THE ONE THING THAT MAKES THE HASHES COMPARABLE. Both columns hold a hash of the LOCAL
 * canonical projection — never of amoCRM's wire format. If last_remote_hash were a hash of the
 * amoCRM JSON it could never equal the hash of a local row, the comparison would be false on
 * every call, and defence 2 would be dead code that still looked present in review. The
 * inbound applier therefore hashes what it WROTE, not what it RECEIVED.
 *
 * PII: contact email/phone/mobile are stored as ciphertext with a random IV, so the same
 * plaintext encrypts to a different string on every write. Hashing the ciphertext would make
 * every hash unique and, again, silently disable defence 2. canonicalizeAmoEntity therefore
 * decrypts those fields before hashing. The hash never leaves this process and is not
 * reversible, so no plaintext is persisted by doing so.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { db } from '../db';
import { decryptField } from '../encryption';

// ─── Origin tagging ───────────────────────────────────────────────────────────

/**
 * Where a write came from.
 *   local     — a human or an internal automation changed a 4КУБ row. Push it.
 *   amo       — we are applying something amoCRM sent us. Never push it back.
 *   reconcile — the nightly diff is healing a row from remote state. Never push it back.
 */
export type SyncOrigin = 'local' | 'amo' | 'reconcile';

const originStore = new AsyncLocalStorage<SyncOrigin>();

/** Run `fn` with every write beneath it tagged as coming from `origin`. */
export function runWithSyncOrigin<T>(origin: SyncOrigin, fn: () => T): T {
  return originStore.run(origin, fn);
}

/**
 * The ambient origin, defaulting to 'local'.
 *
 * Defaulting to 'local' is deliberate and is the fail-safe direction: an untagged write is
 * assumed to be a genuine user edit and gets pushed. The opposite default would make a
 * forgotten `runWithSyncOrigin` silently stop syncing, which nobody would notice for weeks.
 * A wrongly-pushed echo, by contrast, is caught by the hash comparison below.
 */
export function currentSyncOrigin(): SyncOrigin {
  return originStore.getStore() ?? 'local';
}

/** True for the two origins that must never produce an outbound job. */
export function isRemoteOrigin(origin: SyncOrigin = currentSyncOrigin()): boolean {
  return origin === 'amo' || origin === 'reconcile';
}

// ─── Canonical projection ─────────────────────────────────────────────────────

export type AmoEntityType = 'lead' | 'contact' | 'company';

/**
 * The fields that participate in the sync, per entity type.
 *
 * Anything not listed here is invisible to echo suppression AND to conflict detection, which
 * is the point: `updated_at`, `stage_entered_at`, view counters and the like change on writes
 * that carry no information for amoCRM, and including them would make every hash differ and
 * turn defence 2 off.
 */
export const AMO_CANONICAL_FIELDS: Readonly<Record<AmoEntityType, readonly string[]>> = {
  lead: ['title', 'value', 'currency', 'status', 'pipeline_id', 'stage_id', 'contact_id', 'assigned_to'],
  contact: ['first_name', 'last_name', 'company', 'email', 'phone', 'mobile', 'type', 'status', 'assigned_to'],
  company: ['company', 'email', 'phone', 'status', 'assigned_to'],
};

/** Fields held as ciphertext on Contact. See the PII note in the file header. */
export const AMO_ENCRYPTED_FIELDS: ReadonlySet<string> = new Set(['email', 'phone', 'mobile']);

/**
 * Normalize one scalar into something that hashes identically regardless of how it arrived.
 *
 * The three shapes that would otherwise break equality:
 *   Date        — a Date and its ISO string are the same value to us.
 *   Decimal     — Prisma returns `value` as a Decimal; `1000`, `1000.00` and `"1000"` are one
 *                 number, and the string forms differ byte-for-byte.
 *   ''/null     — an empty string and a null both mean "not set" on both sides of this sync.
 */
export function normalizeCanonicalValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? normalizeNumeric(String(value)) : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return /^-?\d+(\.\d+)?$/.test(trimmed) ? normalizeNumeric(trimmed) : trimmed;
  }

  // Prisma.Decimal and anything else with a meaningful toString (BigInt included).
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const asString = String(value);
    if (asString === '[object Object]') {
      // A nested object (custom_fields). Stable-stringify it rather than collapsing it.
      return stableStringify(value);
    }
    return /^-?\d+(\.\d+)?$/.test(asString) ? normalizeNumeric(asString) : asString;
  }

  return String(value);
}

/** "1000.00" and "1000" are the same amount; trailing zeros must not change the hash. */
function normalizeNumeric(input: string): string {
  if (!input.includes('.')) {
    return input.replace(/^(-?)0+(\d)/, '$1$2');
  }
  const trimmed = input.replace(/0+$/, '').replace(/\.$/, '');
  return (trimmed === '' || trimmed === '-' ? '0' : trimmed).replace(/^(-?)0+(\d)/, '$1$2');
}

/** JSON with object keys sorted at every depth, so key insertion order cannot change a hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * Project a local row onto the fields that participate in the sync, decrypting PII on the way.
 *
 * Both directions call this on the LOCAL row — see the file header. The inbound applier calls
 * it on the row it has just written, which is what makes last_remote_hash comparable with the
 * hash the outbound enqueue computes a moment later.
 */
export function canonicalizeAmoEntity(
  entityType: AmoEntityType,
  record: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};

  for (const field of AMO_CANONICAL_FIELDS[entityType]) {
    const raw = record[field];
    const value = AMO_ENCRYPTED_FIELDS.has(field) && typeof raw === 'string'
      ? decryptField(raw)
      : raw;
    out[field] = normalizeCanonicalValue(value);
  }

  return out;
}

/** sha256 over the canonical projection. Hex, 64 chars, never stored anywhere but the map row. */
export function hashAmoPayload(canonical: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableStringify(canonical), 'utf8').digest('hex');
}

/** Convenience: project then hash. */
export function hashAmoEntity(
  entityType: AmoEntityType,
  record: Record<string, unknown>,
): string {
  return hashAmoPayload(canonicalizeAmoEntity(entityType, record));
}

// ─── The decision ─────────────────────────────────────────────────────────────

export type EchoDecision =
  | { suppress: true; reason: 'remote_origin' | 'matches_last_remote_hash'; hash: string }
  | { suppress: false; reason: 'local_change'; hash: string };

export type EchoDecisionInput = {
  organizationId: string;
  entityType: AmoEntityType;
  localId: string;
  /** The local row AFTER the write, exactly as Prisma returned it. */
  record: Record<string, unknown>;
  /** Defaults to the ambient AsyncLocalStorage tag. */
  origin?: SyncOrigin;
};

/**
 * Should this local change produce an outbound job?
 *
 * Order matters: the origin check is answered without a database round trip, so the hot path
 * for inbound-applied writes costs nothing. The hash lookup only happens for writes that
 * claim to be local.
 */
export async function decideOutbound(input: EchoDecisionInput): Promise<EchoDecision> {
  const hash = hashAmoEntity(input.entityType, input.record);
  const origin = input.origin ?? currentSyncOrigin();

  if (isRemoteOrigin(origin)) {
    return { suppress: true, reason: 'remote_origin', hash };
  }

  const map = await db.amoEntityMap.findFirst({
    where: {
      organization_id: input.organizationId,
      entity_type: input.entityType,
      local_id: input.localId,
    },
    select: { last_remote_hash: true },
  });

  // No map row means this entity has never been synced in either direction — it cannot be an
  // echo of anything, so it is a genuine local change (a create).
  if (map?.last_remote_hash && map.last_remote_hash === hash) {
    return { suppress: true, reason: 'matches_last_remote_hash', hash };
  }

  return { suppress: false, reason: 'local_change', hash };
}

// ─── Hash bookkeeping ─────────────────────────────────────────────────────────

type HashUpdate = {
  organizationId: string;
  entityType: AmoEntityType;
  localId: string;
  amoId: bigint | number | null;
  hash: string;
  syncedAt?: Date;
};

/**
 * Record the state an INBOUND change produced. This is the value the next outbound enqueue
 * compares against, so it must be written in the same step that applies the change — a gap
 * between the write and this call is a window in which the echo escapes.
 */
export async function recordRemoteHash(update: HashUpdate): Promise<void> {
  await upsertEntityMap(update, { last_remote_hash: update.hash });
}

/**
 * Record the state we last PUSHED. Lets the inbound side recognise amoCRM telling us about
 * our own push, which is the mirror image of the loop this file exists to break.
 */
export async function recordLocalHash(update: HashUpdate): Promise<void> {
  await upsertEntityMap(update, { last_local_hash: update.hash });
}

async function upsertEntityMap(
  update: HashUpdate,
  patch: { last_remote_hash?: string; last_local_hash?: string },
): Promise<void> {
  const syncedAt = update.syncedAt ?? new Date();
  const amoId = update.amoId === null || update.amoId === undefined
    ? null
    : BigInt(update.amoId);

  const updated = await db.amoEntityMap.updateMany({
    where: {
      organization_id: update.organizationId,
      entity_type: update.entityType,
      local_id: update.localId,
    },
    data: {
      ...patch,
      ...(amoId === null ? {} : { amo_id: amoId }),
      last_synced_at: syncedAt,
    },
  });

  if (updated.count > 0 || amoId === null) {
    // amo_id is NOT NULL on AmoEntityMap, so a row cannot be created before the amoCRM id is
    // known. That is not a gap: an entity with no amo_id has never been synced, so there is no
    // previous remote state for an echo check to match against, and decideOutbound correctly
    // treats it as a genuine local change.
    return;
  }

  await db.amoEntityMap.create({
    data: {
      organization_id: update.organizationId,
      entity_type: update.entityType,
      local_id: update.localId,
      amo_id: amoId,
      last_synced_at: syncedAt,
      ...patch,
    },
  });
}

/** Read the identity bridge for one local row. */
export async function findEntityMapByLocalId(
  organizationId: string,
  entityType: AmoEntityType,
  localId: string,
): Promise<{ amo_id: bigint; last_synced_at: Date | null; last_local_hash: string | null; last_remote_hash: string | null } | null> {
  return db.amoEntityMap.findFirst({
    where: { organization_id: organizationId, entity_type: entityType, local_id: localId },
    select: { amo_id: true, last_synced_at: true, last_local_hash: true, last_remote_hash: true },
  });
}

/** Read the identity bridge for one amoCRM id. */
export async function findEntityMapByAmoId(
  organizationId: string,
  entityType: AmoEntityType,
  amoId: bigint | number,
): Promise<{ local_id: string; last_synced_at: Date | null; last_local_hash: string | null; last_remote_hash: string | null } | null> {
  return db.amoEntityMap.findFirst({
    where: { organization_id: organizationId, entity_type: entityType, amo_id: BigInt(amoId) },
    select: { local_id: true, last_synced_at: true, last_local_hash: true, last_remote_hash: true },
  });
}
