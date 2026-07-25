/**
 * api-keys.ts
 *
 * Credentials for the public REST API (`/public/v1`).
 *
 * A key is a 256-bit random token rendered as `kub_live_<base64url>`.  It is
 * returned to the caller EXACTLY ONCE, at creation time — the database only
 * ever holds `key_hash` (SHA-256 of the full token) plus `key_prefix`, a short
 * non-secret slice used by the UI to tell keys apart.  There is no recovery
 * path: a lost key is revoked and replaced.
 *
 * SHA-256 (not bcrypt/argon2) is deliberate.  Password hashes are slow because
 * passwords are low-entropy and brute-forceable; an API key carries 256 bits of
 * CSPRNG entropy, so a fast digest is safe and keeps the per-request auth
 * lookup a single indexed read.
 *
 * Every function here is org-scoped: `organization_id` is part of every `where`
 * clause. The one unavoidable exception is the authentication bootstrap lookup
 * in public-api-auth.ts, which is documented there.
 */

import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { sha256 } from './crypto';

// ─── Token shape ──────────────────────────────────────────────────────────────

export const API_KEY_TOKEN_PREFIX = 'kub_live_';
export const API_KEY_ENTROPY_BYTES = 32;
/** `kub_live_` (9) + 8 characters of the secret — enough to identify, useless to replay. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_TOKEN_PREFIX.length + 8;
/** 32 random bytes encode to 43 base64url characters. */
export const API_KEY_TOKEN_PATTERN = new RegExp(`^${API_KEY_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

/** Live (non-revoked) keys an org may hold at once. */
export const MAX_API_KEYS_PER_ORG = 20;

// ─── Scopes ───────────────────────────────────────────────────────────────────

/**
 * Scopes are stored as a JSON array of strings in `ApiKey.scopes`.  Read and
 * write are separate so an integration that only ingests data cannot mutate the
 * CRM.  A key with no recognised scope can do nothing.
 */
export const API_KEY_SCOPES = [
  'contacts:read',
  'contacts:write',
  'deals:read',
  'deals:write',
  'tasks:read',
  'tasks:write',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set<string>(API_KEY_SCOPES);

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}

/**
 * Defensive read of the `scopes` JSON column: anything that is not a known
 * scope string is dropped, so a hand-edited row cannot widen a key's reach.
 */
export function parseApiKeyScopes(value: Prisma.JsonValue | null | undefined): ApiKeyScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const scopes = value.filter(isApiKeyScope);
  return API_KEY_SCOPES.filter((scope) => scopes.includes(scope));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApiKeySummary = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  created_by: string | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/** Only ever returned by createApiKey — `key` is not recoverable afterwards. */
export type CreatedApiKey = ApiKeySummary & { key: string };

export class ApiKeyNotFoundError extends Error {
  readonly code = 'API_KEY_NOT_FOUND';
  readonly httpStatus = 404;

  constructor(message = 'API key not found') {
    super(message);
    this.name = 'ApiKeyNotFoundError';
  }
}

export class ApiKeyLimitError extends Error {
  readonly code = 'API_KEY_LIMIT_REACHED';
  readonly httpStatus = 409;

  constructor(message = `An organization may hold at most ${MAX_API_KEYS_PER_ORG} active API keys`) {
    super(message);
    this.name = 'ApiKeyLimitError';
  }
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/** Generate a credential carrying 256 bits of entropy. */
export function generateApiKey(randomSource: (size: number) => Buffer = randomBytes): string {
  return `${API_KEY_TOKEN_PREFIX}${randomSource(API_KEY_ENTROPY_BYTES).toString('base64url')}`;
}

/** The only representation of a key that is ever persisted. */
export function hashApiKey(key: string): string {
  return sha256(key);
}

/** Non-secret display slice shown in the UI and stored in `key_prefix`. */
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

export function looksLikeApiKey(value: string): boolean {
  return API_KEY_TOKEN_PATTERN.test(value);
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

// `key_hash` is deliberately absent: nothing outside this module needs it, and
// leaving it out of the select makes an accidental leak into a response
// impossible rather than merely unlikely.
const API_KEY_SUMMARY_SELECT = {
  id: true,
  name: true,
  key_prefix: true,
  scopes: true,
  created_by: true,
  last_used_at: true,
  revoked_at: true,
  expires_at: true,
  created_at: true,
  updated_at: true,
} as const;

type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: Prisma.JsonValue | null;
  created_by: string | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: parseApiKeyScopes(row.scopes),
    created_by: row.created_by,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A key is usable while it is neither revoked nor past its expiry. */
export function isApiKeyUsable(
  row: { revoked_at: Date | null; expires_at: Date | null },
  now: Date = new Date(),
): boolean {
  if (row.revoked_at !== null) return false;
  return row.expires_at === null || row.expires_at.getTime() > now.getTime();
}

// ─── Operations ───────────────────────────────────────────────────────────────

export async function createApiKey(input: {
  organizationId: string;
  createdBy: string;
  name: string;
  scopes: ApiKeyScope[];
  expiresAt?: Date | null;
}): Promise<CreatedApiKey> {
  const liveKeys = await db.apiKey.count({
    where: { organization_id: input.organizationId, revoked_at: null },
  });

  if (liveKeys >= MAX_API_KEYS_PER_ORG) {
    throw new ApiKeyLimitError();
  }

  const key = generateApiKey();

  const row = await db.apiKey.create({
    data: {
      organization_id: input.organizationId,
      created_by: input.createdBy,
      name: input.name.trim(),
      key_hash: hashApiKey(key),
      key_prefix: apiKeyDisplayPrefix(key),
      scopes: parseApiKeyScopes(input.scopes),
      expires_at: input.expiresAt ?? null,
    },
    select: API_KEY_SUMMARY_SELECT,
  });

  // The plaintext token exists only in this stack frame and the creation response.
  return { ...toSummary(row), key };
}

export async function listApiKeys(organizationId: string): Promise<ApiKeySummary[]> {
  const rows = await db.apiKey.findMany({
    where: { organization_id: organizationId },
    select: API_KEY_SUMMARY_SELECT,
    orderBy: { created_at: 'desc' },
  });

  return rows.map(toSummary);
}

export async function getApiKey(id: string, organizationId: string): Promise<ApiKeySummary> {
  const row = await db.apiKey.findFirst({
    where: { id, organization_id: organizationId },
    select: API_KEY_SUMMARY_SELECT,
  });

  if (!row) {
    throw new ApiKeyNotFoundError();
  }

  return toSummary(row);
}

/**
 * Revocation is one-way and idempotent: revoking an already-revoked key keeps
 * the original timestamp instead of resetting it.
 */
export async function revokeApiKey(
  id: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<ApiKeySummary> {
  const existing = await db.apiKey.findFirst({
    where: { id, organization_id: organizationId },
    select: { id: true },
  });

  if (!existing) {
    throw new ApiKeyNotFoundError();
  }

  await db.apiKey.updateMany({
    where: { id, organization_id: organizationId, revoked_at: null },
    data: { revoked_at: now },
  });

  return getApiKey(id, organizationId);
}
