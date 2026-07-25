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
 *     concurrent attempts cannot both execute.
 *
 * Records are keyed by `(organization_id, key)` — see the unique constraint on
 * IdempotencyKey — so one tenant can never observe or collide with another's
 * key. Everything here is org-scoped.
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
 * A reservation with no response written yet is presumed crash-orphaned after
 * this long: the process died between reserving the key and storing the result.
 * Without reclaiming it, the key would answer 409 IDEMPOTENCY_IN_PROGRESS
 * forever — a poison key that can never be retried.
 */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 5 * 60 * 1000;

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
  const now = new Date();

  type Reservation =
    | { outcome: 'reserved' }
    | { outcome: 'replay'; result: IdempotentResult }
    | { outcome: 'retry' };

  const reserve = async (): Promise<Reservation> => {
    try {
      await db.idempotencyKey.create({
        data: {
          organization_id: input.organizationId,
          key,
          endpoint: input.endpoint,
          request_hash: hash,
          expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        },
      });
      return { outcome: 'reserved' };
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

    // Past its TTL, or a reservation whose request died before storing a
    // response: clear it out and let this request take the key.
    const stale =
      existing.expires_at.getTime() <= now.getTime() ||
      (existing.status_code === null &&
        existing.created_at.getTime() + IDEMPOTENCY_IN_PROGRESS_TTL_MS <= now.getTime());

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
  let reserved = false;
  for (let attempt = 0; attempt < 2 && !reserved; attempt += 1) {
    const reservation = await reserve();
    if (reservation.outcome === 'reserved') {
      reserved = true;
    } else if (reservation.outcome === 'replay') {
      return reservation.result;
    }
  }

  if (!reserved) {
    // Another request grabbed the key in the gap between our two attempts.
    throw new IdempotencyError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed',
    );
  }

  try {
    const body = toJsonValue(await input.operation());

    await db.idempotencyKey.updateMany({
      where: { organization_id: input.organizationId, key },
      data: { status_code: input.statusCode, response_body: body },
    });

    return { statusCode: input.statusCode, body, replayed: false };
  } catch (error) {
    // The operation failed, so nothing happened that a retry would duplicate.
    // Drop the reservation instead of caching the failure.
    await db.idempotencyKey.deleteMany({
      where: { organization_id: input.organizationId, key, status_code: null },
    });
    throw error;
  }
}

/**
 * Housekeeping for the durable idempotency table — safe to call from the
 * scheduler.  Deletes everything past `expires_at` (indexed) and reclaims
 * reservations orphaned by a crashed request.
 *
 * This is the one function here that is deliberately NOT org-scoped: it is a
 * TTL sweep run by the server itself, never on behalf of a tenant, and it
 * returns no row data.  Every request-path query above carries
 * `organization_id`.
 */
export async function reapIdempotencyKeys(
  now: Date = new Date(),
): Promise<{ expired: number; reclaimed: number }> {
  const expired = await db.idempotencyKey.deleteMany({
    where: { expires_at: { lte: now } },
  });

  const reclaimed = await db.idempotencyKey.deleteMany({
    where: {
      status_code: null,
      created_at: { lt: new Date(now.getTime() - IDEMPOTENCY_IN_PROGRESS_TTL_MS) },
    },
  });

  return { expired: expired.count, reclaimed: reclaimed.count };
}
