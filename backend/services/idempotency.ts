/**
 * idempotency.ts
 *
 * `Idempotency-Key` support for unsafe public-API requests (POST / PATCH).
 *
 * The contract a client gets:
 *   • First request with a given key runs the operation and stores
 *     (status_code, response_body) against (organization_id, key).
 *   • A retry with the SAME key and the SAME request replays the stored
 *     response verbatim instead of acting twice.
 *   • The same key with a DIFFERENT endpoint or body is a 409 conflict, never a
 *     silent replay — that combination always means a client bug, and quietly
 *     returning the first response would hide it.
 *   • A retry that arrives while the first is still running is a 409, so two
 *     concurrent attempts cannot both execute — for as long as the first attempt
 *     is demonstrably alive. See "Liveness" below: that qualifier is load-bearing
 *     and it used to be missing, both from this comment and from the code.
 *
 * Records are keyed by `(organization_id, key)` — see the unique constraint on
 * IdempotencyKey — so one tenant can never observe or collide with another's
 * key. Everything here is org-scoped.
 *
 * ─── Liveness ───────────────────────────────────────────────────────────────
 *
 * A reservation has to be reclaimable: a process that dies between reserving the
 * key and storing the result would otherwise leave a key that answers 409
 * IDEMPOTENCY_IN_PROGRESS forever, and the client can never get its write done.
 *
 * The reclaim used to be a bare age test — any reservation older than five
 * minutes with no response stored was presumed crashed and deleted. Age is not
 * liveness. A bulk import, a slow third-party call, a contended write: anything
 * that legitimately runs longer than five minutes had its reservation handed to
 * its own retry, and then two attempts really did execute concurrently — exactly
 * the thing the third bullet above promises cannot happen, and promised the more
 * loudly the longer the operation ran.
 *
 * So the in-flight request now says so, continuously. `expires_at` is the row's
 * lease in both of its phases:
 *
 *   • while the operation runs, it sits IDEMPOTENCY_IN_PROGRESS_TTL_MS out and is
 *     pushed forward every IDEMPOTENCY_HEARTBEAT_INTERVAL_MS by the request that
 *     holds it, so a live operation is never mistaken for a corpse however long
 *     it takes;
 *   • once the response is stored it becomes the ordinary IDEMPOTENCY_TTL_MS
 *     replay window.
 *
 * One rule then covers both: a row is stale when `expires_at` has passed. What
 * remains true, and is a deliberate trade, is that a process wedged hard enough
 * that it cannot run a timer for a whole lease period looks dead and is treated
 * as dead. That is the only case in which two attempts can overlap, and it is a
 * far narrower window than "the operation took longer than five minutes".
 */

import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';

/**
 * How long a completed record is kept.  Long enough that an honest retry (a
 * dropped connection, a queue redelivery) still replays; short enough to bound
 * the table.  Enforced by `expires_at` and the sweeper below.
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead a reservation's lease is written, and therefore how long after
 * its last heartbeat an in-flight request is presumed crash-orphaned. Without
 * reclaiming those, the key would answer 409 IDEMPOTENCY_IN_PROGRESS forever —
 * a poison key that can never be retried.
 *
 * This is a lease, not an age limit: an operation that keeps beating holds the
 * key for as long as it runs.
 */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 5 * 60 * 1000;

/**
 * How often the in-flight request pushes its lease forward. Comfortably shorter
 * than the lease, so a single missed beat — a busy event loop, one failed
 * UPDATE — cannot let the reservation lapse under a request that is still
 * working.
 */
export const IDEMPOTENCY_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export class IdempotencyError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export type IdempotentResult = {
  statusCode: number;
  body: unknown;
  replayed: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise the raw header value.  `null` means "no key supplied" (the request
 * simply runs); a malformed key is rejected rather than ignored, so a client
 * that thinks it is protected is told otherwise.
 */
export function normalizeIdempotencyKey(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return null;
  }

  const key = value.trim();
  if (key.length === 0) {
    return null;
  }

  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new IdempotencyError(
      400,
      'BAD_IDEMPOTENCY_KEY',
      `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters from [A-Za-z0-9._:-]`,
    );
  }

  return key;
}

/**
 * Order-insensitive JSON encoding, so `{a:1,b:2}` and `{b:2,a:1}` hash the same
 * and a re-serialised retry is not mistaken for a different request.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

/** Fingerprint of "what was asked" — endpoint plus body. */
export function idempotencyRequestHash(endpoint: string, body: unknown): string {
  return createHash('sha256')
    .update(endpoint)
    .update('\n')
    .update(stableStringify(body))
    .digest('hex');
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function conflict(): IdempotencyError {
  return new IdempotencyError(
    409,
    'IDEMPOTENCY_KEY_CONFLICT',
    'This Idempotency-Key was already used for a different request',
  );
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export type RunIdempotentInput<T> = {
  /** Raw `Idempotency-Key` header value; absent means "just run it". */
  rawKey: string | string[] | undefined;
  organizationId: string;
  /** Method + concrete path, e.g. `POST /public/v1/contacts`. */
  endpoint: string;
  requestBody: unknown;
  /** Status returned on the first successful run, and replayed afterwards. */
  statusCode: number;
  operation: () => Promise<T>;
};

export async function runIdempotent<T>(input: RunIdempotentInput<T>): Promise<IdempotentResult> {
  const key = normalizeIdempotencyKey(input.rawKey);

  if (!key) {
    return { statusCode: input.statusCode, body: toJsonValue(await input.operation()), replayed: false };
  }

  const hash = idempotencyRequestHash(input.endpoint, input.requestBody);

  type Reservation =
    | { outcome: 'reserved'; reservationId: string }
    | { outcome: 'replay'; result: IdempotentResult }
    | { outcome: 'retry' };

  const reserve = async (): Promise<Reservation> => {
    // Read the clock per attempt rather than once for the whole call: `reserve` can be
    // entered a second time after a round trip to the database, and the staleness test below
    // must not be answered against a timestamp from before that trip.
    const now = new Date();

    try {
      const reservation = await db.idempotencyKey.create({
        data: {
          organization_id: input.organizationId,
          key,
          endpoint: input.endpoint,
          request_hash: hash,
          // A reservation is leased, not parked for a day: it carries the short in-progress
          // lease and is renewed by the heartbeat below for as long as the operation runs.
          // The full IDEMPOTENCY_TTL_MS replay window is written once a response exists,
          // measured from then — which is also when a client's retry clock really starts.
          expires_at: new Date(now.getTime() + IDEMPOTENCY_IN_PROGRESS_TTL_MS),
        },
        select: { id: true },
      });
      return { outcome: 'reserved', reservationId: reservation.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    const existing = await db.idempotencyKey.findFirst({
      where: { organization_id: input.organizationId, key },
    });

    if (!existing) {
      // Reaped between the failed insert and this read — try reserving again.
      return { outcome: 'retry' };
    }

    // One rule for both phases of the row's life: past its lease, whether that lease was the
    // replay window of a completed request or the heartbeat of an in-flight one. A request
    // that is still working has already pushed this forward, so it is never seen as stale.
    const stale = existing.expires_at.getTime() <= now.getTime();

    if (stale) {
      await db.idempotencyKey.deleteMany({
        where: { id: existing.id, organization_id: input.organizationId },
      });
      return { outcome: 'retry' };
    }

    if (existing.endpoint !== input.endpoint || existing.request_hash !== hash) {
      throw conflict();
    }

    if (existing.status_code === null) {
      throw new IdempotencyError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'A request with this Idempotency-Key is still being processed',
      );
    }

    return {
      outcome: 'replay',
      result: { statusCode: existing.status_code, body: existing.response_body, replayed: true },
    };
  };

  // Two attempts at most. The second only follows a 'retry', which means the
  // blocking row was deleted, so this cannot spin.
  let reservationId: string | null = null;
  for (let attempt = 0; attempt < 2 && reservationId === null; attempt += 1) {
    const reservation = await reserve();
    if (reservation.outcome === 'reserved') {
      reservationId = reservation.reservationId;
    } else if (reservation.outcome === 'replay') {
      return reservation.result;
    }
  }

  if (reservationId === null) {
    // Another request grabbed the key in the gap between our two attempts.
    throw new IdempotencyError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed',
    );
  }

  // Every write from here on is addressed by the row id this request created, never by
  // (organization_id, key). If this reservation were reclaimed anyway — a process frozen
  // past its lease — the key now belongs to a different row, and finishing late must not
  // overwrite, complete or delete the successor's reservation.
  const stopHeartbeat = startReservationHeartbeat(reservationId, input.organizationId);

  try {
    const body = toJsonValue(await input.operation());

    await db.idempotencyKey.updateMany({
      where: { id: reservationId, organization_id: input.organizationId },
      data: {
        status_code: input.statusCode,
        response_body: body,
        // The row stops being a lease and becomes a replay record, so its expiry stops being
        // the heartbeat deadline and becomes the retry window.
        expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });

    return { statusCode: input.statusCode, body, replayed: false };
  } catch (error) {
    // The operation failed, so nothing happened that a retry would duplicate.
    // Drop the reservation instead of caching the failure.
    await db.idempotencyKey.deleteMany({
      where: { id: reservationId, organization_id: input.organizationId, status_code: null },
    });
    throw error;
  } finally {
    stopHeartbeat();
  }
}

/**
 * Keep the reservation's lease ahead of the clock for as long as the operation runs, and
 * return the stop function. Called only on the path that actually holds a reservation.
 *
 * The update is narrowed to `status_code: null` so a beat that lands after the response was
 * stored cannot drag a completed record's 24 h replay window back down to five minutes; it is
 * addressed by row id so it can only ever renew this request's own row. Failures are ignored:
 * a beat that loses a connection is not a reason to fail the customer's operation, and the
 * next beat — or the lease lapsing, if the process really is in trouble — is the right answer.
 */
function startReservationHeartbeat(reservationId: string, organizationId: string): () => void {
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void db.idempotencyKey
      .updateMany({
        where: { id: reservationId, organization_id: organizationId, status_code: null },
        data: { expires_at: new Date(Date.now() + IDEMPOTENCY_IN_PROGRESS_TTL_MS) },
      })
      .catch(() => undefined);
  }, IDEMPOTENCY_HEARTBEAT_INTERVAL_MS);

  // A pending heartbeat must never be the reason the process stays alive at shutdown.
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') {
    unref.call(timer);
  }

  return () => clearInterval(timer);
}

/**
 * Housekeeping for the durable idempotency table — safe to call from the
 * scheduler.  Deletes everything past `expires_at` (indexed): completed records
 * whose replay window has closed, and reservations whose lease lapsed because
 * the request holding them stopped beating.
 *
 * Both sweeps are driven by `expires_at`, never by age. The reclaim used to be
 * `status_code IS NULL AND created_at < now - 5 min`, which is the same defect
 * the request path had: it deleted the reservation out from under any operation
 * that legitimately ran longer than five minutes, and it ran hourly with nothing
 * watching, so the first sign of it was a duplicate write. A lease that the
 * in-flight request keeps renewing is invisible to this sweep, which is the
 * point.
 *
 * The two deletes are kept apart only so the counts stay meaningful: `reclaimed`
 * is abandoned in-flight work, `expired` is ordinary TTL. A jump in the first is
 * worth looking at; a jump in the second is not.
 *
 * This is the one function here that is deliberately NOT org-scoped: it is a
 * TTL sweep run by the server itself, never on behalf of a tenant, and it
 * returns no row data.  Every request-path query above carries
 * `organization_id`.
 */
export async function reapIdempotencyKeys(
  now: Date = new Date(),
): Promise<{ expired: number; reclaimed: number }> {
  // tenant-scope: cross-tenant — TTL sweep run by the server itself, never on
  // behalf of a tenant; deletes expired leases in every org and returns no rows.
  const reclaimed = await db.idempotencyKey.deleteMany({
    where: { status_code: null, expires_at: { lte: now } },
  });

  // tenant-scope: cross-tenant — same sweep, ordinary TTL half. Split from the
  // one above only so `reclaimed` and `expired` stay separately countable.
  const expired = await db.idempotencyKey.deleteMany({
    where: { expires_at: { lte: now } },
  });

  return { expired: expired.count, reclaimed: reclaimed.count };
}
