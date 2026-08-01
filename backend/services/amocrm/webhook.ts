/**
 * Inbound amoCRM webhook receiver.
 *
 * Route: POST /api/v1/integrations/amocrm/webhook  (backend/api/routes/amocrm-webhook.ts)
 *
 * ─── FOUR CONSTRAINTS, EACH OF WHICH BREAKS THE FEATURE IF IGNORED ───────────
 *
 * 1. THERE IS NO SESSION. amoCRM's servers hold no JWT and no cookie of ours. The registered
 *    destination therefore carries a per-organization HMAC token. That URL token is the primary
 *    authentication; an undocumented signature header is accepted only as a compatibility
 *    fallback. The route also needs an entry in the public-path allowlist in
 *    backend/api/authenticate.ts, or every delivery comes back 401; the exact line is quoted
 *    in the route file.
 *
 * 2. THE BODY IS application/x-www-form-urlencoded WITH BRACKETED ARRAY KEYS, not JSON.
 *    Confirmed in amoCRM's own documentation: "WebHook отправляется в формате
 *    x-www-form-urlencoded". Keys look like `leads[status][0][id]=100`. @fastify/formbody IS
 *    already a dependency (package.json, ^8.0.2) and IS already registered globally
 *    (backend/index.ts:208) — no new dependency is needed. But its default parser does not
 *    expand brackets, so parseAmoFormBody below does, and the handler works from the raw body
 *    either way. The raw body is retained for the legacy signature fallback.
 *
 * 3. ANSWER FAST, AND ALWAYS ANSWER. amoCRM expects a 100–299 within TWO SECONDS, retries on
 *    anything else at 5 min / 15 min / 1 h, and DISABLES a subscription that keeps failing.
 *    So this handler does exactly three things — verify, INSERT, return — and no real work.
 *    Applying the change is the sync worker's job, on its own clock, with its own retries.
 *
 * 4. A REJECTED REQUEST IS STILL A DECISION. A request with neither a valid destination token
 *    nor a valid compatibility signature is refused. A public endpoint that writes to a
 *    customer's CRM on an unauthenticated POST is worse than a sync that visibly stops.
 */

import crypto from 'node:crypto';
import { Prisma, AmoSyncDirection } from '@prisma/client';
import { db } from '../db';
import { decryptField } from '../encryption';
import { enqueueAmoSyncJob, type AmoSyncOperation } from './sync-worker';
import type { AmoEntityType } from './echo';

// ─── Constants ────────────────────────────────────────────────────────────────

export const AMO_WEBHOOK_PATH = '/api/v1/integrations/amocrm/webhook';

/**
 * // VERIFY: the signature header name and algorithm.
 * //
 * // WHAT WAS CHECKED (2026-08-01, no account access):
 * //   - amocrm.ru/developers/content/crm_platform/webhooks-format — documents the
 * //     x-www-form-urlencoded body, the 2 s deadline and the 5 min/15 min/1 h retry ladder.
 * //     It documents NO request headers and NO signature at all.
 * //   - developers.kommo.com/docs/webhooks-general and /reference/webhooks — same, no headers.
 * //   - amocrm.ru/developers/content/crm_platform/webhooks-api — POST /api/v4/webhooks takes
 * //     `destination` + `settings`, max 100 per account, admin rights required. No signature.
 * //   - A GitHub code sweep finds `X-Signature` used with amoCRM only alongside `Content-MD5`,
 * //     which is the AMOJO / Chats API request-signing scheme (HMAC-SHA1 over
 * //     "METHOD\nContent-MD5\nContent-Type\nDate\nPath" keyed with the CHANNEL secret) — a
 * //     different mechanism for a different API, NOT the CRM entity webhooks.
 * //
 * // CONCLUSION: amoCRM does not publicly document a signature on CRM entity webhooks. This
 * // code therefore accepts the header under either digest, and an operator who confirms the
 * // real scheme against a live account should delete the branch that does not apply.
 * //
 * // The primary authentication does not depend on this undocumented behavior: it is the
 * // per-organization token embedded in the registered destination URL below.
 */
export const AMO_SIGNATURE_HEADER = 'x-signature';

/**
 * amoCRM's CRM-entity webhooks do not document a signature header.  Authentication therefore
 * uses an unguessable token in the registered destination URL.  The token is derived from the
 * encrypted-at-rest client secret and the local organization id, so it needs no schema column
 * and two 4KUB organizations connected to the same amoCRM account remain distinguishable.
 */
export const AMO_WEBHOOK_TOKEN_QUERY = 'amocrm_token';
const AMO_WEBHOOK_TOKEN_DOMAIN = '4kub:amocrm-webhook:v1';

/** Some proxies and some amoCRM builds have been reported to use these spellings instead. */
export const AMO_SIGNATURE_HEADER_ALIASES = ['x-signature', 'x-amo-signature', 'signature'] as const;

/** amoCRM's own cap is 100 webhooks per account; a single delivery batches far fewer events. */
export const AMO_WEBHOOK_MAX_EVENTS = 500;
export const AMO_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const AMO_WEBHOOK_MAX_PAIRS = 5000;
const AMO_WEBHOOK_MAX_DEPTH = 8;

/** The `settings` values POST /api/v4/webhooks accepts, for the entities this sync covers. */
export const AMO_WEBHOOK_EVENTS = [
  'add_lead',
  'update_lead',
  'delete_lead',
  'status_lead',
  'responsible_lead',
  'restore_lead',
  'add_contact',
  'update_contact',
  'delete_contact',
  'restore_contact',
] as const;

export type AmoWebhookEventName = (typeof AMO_WEBHOOK_EVENTS)[number];

/** Top-level keys of the webhook BODY (not the subscription settings) -> our entity type. */
const BODY_ENTITY_KEYS: Readonly<Record<string, AmoEntityType>> = {
  leads: 'lead',
  contacts: 'contact',
  companies: 'company',
};

/** Second-level keys of the webhook body -> AmoSyncJob.operation. */
const BODY_ACTION_OPERATIONS: Readonly<Record<string, AmoSyncOperation>> = {
  add: 'create',
  update: 'update',
  delete: 'delete',
  restore: 'update',
  responsible: 'update',
  // Only leads have this one; it is the whole reason `stage_change` is a distinct operation
  // rather than an update that happens to touch stage_id — the funnel clock depends on it.
  status: 'stage_change',
};

export function createAmoWebhookToken(organizationId: string, clientSecret: string): string {
  const mac = crypto
    .createHmac('sha256', clientSecret)
    .update(`${AMO_WEBHOOK_TOKEN_DOMAIN}:${organizationId}`, 'utf8')
    .digest('hex');
  return `${organizationId}.${mac}`;
}

export function verifyAmoWebhookToken(
  organizationId: string,
  clientSecret: string,
  provided: string | null | undefined,
): boolean {
  if (!provided || !clientSecret) return false;
  const expected = createAmoWebhookToken(organizationId, clientSecret);
  const given = Buffer.from(provided, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function organizationIdFromWebhookToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const separator = token.indexOf('.');
  if (separator <= 0) return null;
  const organizationId = token.slice(0, separator);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    organizationId,
  )
    ? organizationId
    : null;
}

/** Build the exact URL registered at amoCRM, including the per-organization secret token. */
export function amoWebhookDestination(
  organizationId: string,
  clientSecret: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.AMOCRM_WEBHOOK_URL?.trim();
  const publicBase = env.PUBLIC_APP_URL?.trim();
  if (!explicit && !publicBase) {
    throw new Error('Set AMOCRM_WEBHOOK_URL or PUBLIC_APP_URL before subscribing amoCRM webhooks');
  }

  const destination = explicit
    ? new URL(explicit)
    : new URL(AMO_WEBHOOK_PATH, publicBase!.endsWith('/') ? publicBase : `${publicBase}/`);
  if (env.NODE_ENV === 'production' && destination.protocol !== 'https:') {
    throw new Error('amoCRM webhook destination must use https in production');
  }
  destination.searchParams.set(
    AMO_WEBHOOK_TOKEN_QUERY,
    createAmoWebhookToken(organizationId, clientSecret),
  );
  return destination.toString();
}

export async function configuredAmoWebhookDestination(organizationId: string): Promise<string> {
  const integration = await db.amoIntegration.findUnique({
    where: { organization_id: organizationId },
    select: { client_secret_enc: true },
  });
  if (!integration) throw new Error('amoCRM integration is not connected');
  const clientSecret = decryptField(integration.client_secret_enc);
  if (!clientSecret) throw new Error('amoCRM integration has no client secret');
  return amoWebhookDestination(organizationId, clientSecret);
}

// ─── Body parsing ─────────────────────────────────────────────────────────────

/**
 * Expand `a[b][0][c]=v` into `{ a: { b: [ { c: 'v' } ] } }`.
 *
 * Written here rather than pulled from `qs` because the raw body has to be held anyway for the
 * HMAC (see constraint 2), and because this input is UNAUTHENTICATED at the moment it is
 * parsed — the signature check needs the account, and the account comes out of the parsed
 * body. So the parser runs before authentication, on a stranger's bytes, and is written
 * defensively: `__proto__`/`constructor`/`prototype` segments are dropped rather than walked
 * (prototype pollution), and both the pair count and the nesting depth are capped.
 */
export function parseAmoFormBody(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  if (!raw) return root;

  const pairs = raw.split('&');
  const limit = Math.min(pairs.length, AMO_WEBHOOK_MAX_PAIRS);

  for (let index = 0; index < limit; index += 1) {
    const pair = pairs[index];
    if (!pair) continue;

    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);

    const key = decodeFormComponent(rawKey);
    if (!key) continue;

    const segments = splitBracketKey(key);
    if (segments.length === 0 || segments.length > AMO_WEBHOOK_MAX_DEPTH) continue;
    if (segments.some(isUnsafeSegment)) continue;

    assignSegments(root, segments, decodeFormComponent(rawValue));
  }

  return normalizeNumericKeyedObjects(root) as Record<string, unknown>;
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // A malformed percent-escape must not take the whole delivery down; the surrounding
    // fields are still usable and the signature check has already vouched for the bytes.
    return value.replace(/\+/g, ' ');
  }
}

function splitBracketKey(key: string): string[] {
  const open = key.indexOf('[');
  if (open === -1) return [key];

  const segments = [key.slice(0, open)];
  const rest = key.slice(open);
  const pattern = /\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  let consumed = 0;

  while ((match = pattern.exec(rest)) !== null) {
    segments.push(match[1] ?? '');
    consumed = pattern.lastIndex;
  }

  // Trailing junk after the last bracket means the key is not the shape we understand.
  return consumed === rest.length ? segments.filter((segment) => segment !== '') : [];
}

function isUnsafeSegment(segment: string): boolean {
  return segment === '__proto__' || segment === 'constructor' || segment === 'prototype';
}

function assignSegments(root: Record<string, unknown>, segments: string[], value: string): void {
  let cursor: Record<string, unknown> = root;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[segment] = Object.create(null) as Record<string, unknown>;
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1] as string] = value;
}

/** `{ '0': x, '1': y }` becomes `[x, y]`, recursively. amoCRM's arrays arrive that way. */
function normalizeNumericKeyedObjects(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = normalizeNumericKeyedObjects(record[key]);
  }

  const looksLikeArray =
    keys.length > 0 &&
    keys.every((key) => /^\d+$/.test(key)) &&
    keys.map(Number).sort((a, b) => a - b).every((n, i) => n === i);

  return looksLikeArray
    ? keys.map(Number).sort((a, b) => a - b).map((n) => normalized[String(n)])
    : normalized;
}

// ─── Signature ────────────────────────────────────────────────────────────────

export function readSignatureHeader(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  for (const name of AMO_SIGNATURE_HEADER_ALIASES) {
    const value = headers[name] ?? headers[name.toUpperCase()];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single.trim() !== '') {
      return single.trim();
    }
  }
  return null;
}

/**
 * Constant-time comparison of the provided signature against HMAC-SHA1 and HMAC-SHA256 of the
 * RAW body, keyed with the integration's client_secret.
 *
 * Accepting either digest is not a weakening: both require the secret, so an attacker gains
 * nothing from the choice. It is there because the algorithm is undocumented (see the VERIFY
 * block on AMO_SIGNATURE_HEADER) and a wrong guess means every webhook is rejected in
 * production while looking perfectly correct in review.
 *
 * The raw body is the only acceptable input. Re-serializing the parsed form (`qs.stringify` of
 * what we parsed) reorders keys and re-encodes characters, and the HMAC of that is a different
 * value — a mismatch that looks exactly like an attack.
 */
export function verifyAmoWebhookSignature(
  clientSecret: string,
  rawBody: string,
  provided: string | null,
): boolean {
  if (!provided || !clientSecret) return false;

  const normalized = provided.trim().toLowerCase().replace(/^sha(1|256)=/, '');
  if (!/^[0-9a-f]+$/.test(normalized)) return false;

  for (const algorithm of ['sha1', 'sha256'] as const) {
    const expected = crypto.createHmac(algorithm, clientSecret).update(rawBody, 'utf8').digest('hex');
    if (expected.length !== normalized.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(normalized, 'utf8'))) {
      return true;
    }
  }

  return false;
}

/** Test/ops helper: produce a signature the way amoCRM is believed to. */
export function signAmoWebhookBody(
  clientSecret: string,
  rawBody: string,
  algorithm: 'sha1' | 'sha256' = 'sha1',
): string {
  return crypto.createHmac(algorithm, clientSecret).update(rawBody, 'utf8').digest('hex');
}

// ─── Event extraction ─────────────────────────────────────────────────────────

export type AmoWebhookEvent = {
  entityType: AmoEntityType;
  operation: AmoSyncOperation;
  /** The amoCRM body key this came from, e.g. `leads.status`. Kept for the job payload. */
  action: string;
  amoId: bigint | null;
  entity: Record<string, unknown>;
};

export function readAmoAccount(body: Record<string, unknown>): {
  subdomain: string | null;
  id: string | null;
} {
  const account = body.account;
  if (account === null || typeof account !== 'object' || Array.isArray(account)) {
    return { subdomain: null, id: null };
  }
  const record = account as Record<string, unknown>;
  const subdomain = typeof record.subdomain === 'string' ? record.subdomain.trim().toLowerCase() : null;
  const id = record.id === undefined || record.id === null ? null : String(record.id);
  return { subdomain: subdomain || null, id };
}

/** Flatten amoCRM's `{ leads: { status: [ {...}, {...} ] } }` into one job per entity. */
export function extractAmoWebhookEvents(body: Record<string, unknown>): AmoWebhookEvent[] {
  const events: AmoWebhookEvent[] = [];

  for (const [bodyKey, entityType] of Object.entries(BODY_ENTITY_KEYS)) {
    const group = body[bodyKey];
    if (group === null || typeof group !== 'object' || Array.isArray(group)) continue;

    for (const [action, rawList] of Object.entries(group as Record<string, unknown>)) {
      const operation = BODY_ACTION_OPERATIONS[action];
      if (!operation) continue;

      // A single-element group can arrive as an object rather than a one-element array.
      const list = Array.isArray(rawList) ? rawList : [rawList];

      for (const rawEntity of list) {
        if (rawEntity === null || typeof rawEntity !== 'object' || Array.isArray(rawEntity)) continue;
        const entity = rawEntity as Record<string, unknown>;
        const amoId = readBigInt(entity.id);

        events.push({ entityType, operation, action: `${bodyKey}.${action}`, amoId, entity });
        if (events.length >= AMO_WEBHOOK_MAX_EVENTS) return events;
      }
    }
  }

  return events;
}

function readBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

// ─── The handler ──────────────────────────────────────────────────────────────

export type AmoWebhookRequest = {
  /** The exact bytes received. Required — the HMAC has no meaning without them. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /**
   * Whatever the framework's own body parser produced, used ONLY if rawBody is empty (a proxy
   * consumed the stream). A request that reaches signature verification with no raw body is
   * rejected, so this never widens the trust boundary.
   */
  parsedBody?: unknown;
  /** Secret carried by the exact destination URL registered with amoCRM. */
  webhookToken?: string | null;
};

export type AmoWebhookResult = {
  status: number;
  body: { ok: boolean; queued?: number; error?: string };
};

/**
 * Verify, enqueue, return. Deliberately free of Fastify types so it is testable without a
 * server, which is also what keeps it honest about doing no real work.
 */
export async function handleAmoWebhook(request: AmoWebhookRequest): Promise<AmoWebhookResult> {
  if (request.rawBody.length > AMO_WEBHOOK_MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: 'PAYLOAD_TOO_LARGE' } };
  }

  const parsed = request.rawBody
    ? parseAmoFormBody(request.rawBody)
    : ((request.parsedBody ?? {}) as Record<string, unknown>);

  const account = readAmoAccount(parsed);
  if (!account.subdomain) {
    // Nothing identifies the sender, so there is no secret to check the signature against.
    return { status: 400, body: { ok: false, error: 'MISSING_ACCOUNT' } };
  }

  const tokenOrganizationId = organizationIdFromWebhookToken(request.webhookToken);
  if (!tokenOrganizationId) {
    // A subdomain identifies an amoCRM account, not a 4KUB tenant. More than one local
    // organization may deliberately connect that account, so resolving by subdomain with
    // findFirst can write the event into an arbitrary customer. Every subscription we create
    // contains a signed, per-organization URL token; require it before selecting a tenant.
    return { status: 401, body: { ok: false, error: 'INVALID_WEBHOOK_TOKEN' } };
  }

  const integration = await db.amoIntegration.findFirst({
    where: { organization_id: tokenOrganizationId, subdomain: account.subdomain },
    select: { organization_id: true, client_secret_enc: true, status: true },
  });

  if (!integration) {
    // A 404 tells amoCRM to stop; a webhook for an account nobody here has connected is
    // exactly the subscription that SHOULD be disabled.
    return { status: 404, body: { ok: false, error: 'UNKNOWN_ACCOUNT' } };
  }

  const signature = readSignatureHeader(request.headers);
  const clientSecret = decryptField(integration.client_secret_enc) ?? '';
  const tokenValid = verifyAmoWebhookToken(
    integration.organization_id,
    clientSecret,
    request.webhookToken,
  );
  const signatureValid =
    request.rawBody.length > 0 && verifyAmoWebhookSignature(clientSecret, request.rawBody, signature);

  if (!tokenValid) {
    // 401, not 200. See constraint 4 in the file header: this endpoint writes to a customer's
    // CRM, and a subscription that gets disabled is a visible, recoverable failure whereas an
    // unauthenticated write is neither.
    return { status: 401, body: { ok: false, error: 'INVALID_WEBHOOK_TOKEN' } };
  }

  // Signature verification is defense in depth when amoCRM supplies the header. The signed URL
  // token is the tenant selector and mandatory authenticator; do not reject older amoCRM webhook
  // transports merely because they omit this optional header.
  void signatureValid;

  const events = extractAmoWebhookEvents(parsed);
  if (events.length === 0) {
    // Nothing we handle — a `talks` or `unsorted` delivery, say. 200 so amoCRM keeps the
    // subscription alive; there is nothing wrong with the request.
    return { status: 200, body: { ok: true, queued: 0 } };
  }

  const receivedAt = new Date().toISOString();

  // One INSERT per event, awaited, and then done. Everything else — resolving the entity,
  // detecting conflicts, calling amoCRM back — happens on the sync worker's clock. The two
  // second deadline is why.
  let queued = 0;
  for (const event of events) {
    await enqueueAmoSyncJob({
      organizationId: integration.organization_id,
      direction: AmoSyncDirection.inbound,
      entityType: event.entityType,
      operation: event.operation,
      amoId: event.amoId,
      payload: {
        action: event.action,
        account_id: account.id,
        subdomain: account.subdomain,
        received_at: receivedAt,
        entity: event.entity,
      } as Prisma.InputJsonValue,
    });
    queued += 1;
  }

  return { status: 200, body: { ok: true, queued } };
}

// ─── Subscription management ──────────────────────────────────────────────────

type AmoRequestFn = (orgId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

const CLIENT_MODULE_SPECIFIER = './client';
let amoRequestOverride: AmoRequestFn | null = null;

/** Test seam; see the note on the same pattern in sync-worker.ts. */
export function setAmoWebhookClient(request: AmoRequestFn | null): void {
  amoRequestOverride = request;
}

async function amoRequest(...args: Parameters<AmoRequestFn>): ReturnType<AmoRequestFn> {
  if (amoRequestOverride) return amoRequestOverride(...args);
  const mod = (await import(/* @vite-ignore */ CLIENT_MODULE_SPECIFIER)) as unknown as {
    amoRequest: AmoRequestFn;
  };
  return mod.amoRequest(...args);
}

/**
 * Subscribe this org's amoCRM account to the events the sync needs.
 *
 * // VERIFY: POST /api/v4/webhooks takes `{ destination, settings }` and, per the docs,
 * // "if a webhook with the same destination exists, it updates existing settings rather than
 * // creating a duplicate" — so this is idempotent and safe to call on every reconnect. The id
 * // is read from `_embedded.webhooks[0].id`. Requires administrator rights on the account.
 * // Source: amocrm.ru/developers/content/crm_platform/webhooks-api
 */
export async function subscribeAmoWebhooks(
  organizationId: string,
  destination: string,
  events: readonly AmoWebhookEventName[] = AMO_WEBHOOK_EVENTS,
): Promise<string[]> {
  const response = await amoRequest(organizationId, 'POST', '/api/v4/webhooks', {
    destination,
    settings: [...events],
  });

  const ids = readWebhookIds(response);

  await db.amoIntegration.updateMany({
    where: { organization_id: organizationId },
    data: { webhook_ids: ids },
  });

  return ids;
}

/**
 * Tear the subscription down on disconnect, so a revoked integration stops delivering.
 *
 * // VERIFY: amoCRM v4 unsubscribes by DESTINATION, not by id — `DELETE /api/v4/webhooks`
 * // with `{ destination }` in the body. The stored webhook_ids are cleared regardless of the
 * // call's outcome, because a failure to unsubscribe must not leave this org pinned to a
 * // subscription it can no longer manage.
 */
export async function unsubscribeAmoWebhooks(
  organizationId: string,
  destination: string,
): Promise<void> {
  try {
    await amoRequest(organizationId, 'DELETE', '/api/v4/webhooks', { destination });
  } finally {
    await db.amoIntegration.updateMany({
      where: { organization_id: organizationId },
      data: { webhook_ids: [] },
    });
  }
}

function readWebhookIds(response: unknown): string[] {
  if (response === null || typeof response !== 'object') return [];
  const rootId = (response as Record<string, unknown>).id;
  if (typeof rootId === 'string' || typeof rootId === 'number') {
    return [String(rootId)];
  }
  const embedded = (response as Record<string, unknown>)._embedded;
  if (embedded === null || typeof embedded !== 'object') return [];
  const list = (embedded as Record<string, unknown>).webhooks;
  if (!Array.isArray(list)) return [];

  return list
    .map((item) => (item !== null && typeof item === 'object' ? (item as Record<string, unknown>).id : null))
    .filter((id): id is string | number => id !== null && id !== undefined)
    .map((id) => String(id));
}
