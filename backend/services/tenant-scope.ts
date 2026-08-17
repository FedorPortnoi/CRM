/**
 * The tenant chokepoint.
 *
 * Tenant isolation in this codebase is stated ~600 separate times, once per
 * `where` clause, and until now nothing anywhere asserted that any of those
 * statements exist. Two properties of Prisma make a missing one silent rather
 * than loud:
 *
 *   - `where: { organization_id: undefined }` is not an error. Prisma DROPS the
 *     key and runs the query unfiltered, so a refactor that threads an orgId
 *     through an options object and misses one caller turns a scoped read into
 *     a full-table read of every tenant's rows. deal-domain.ts:96 already
 *     carries a hand-written guard against exactly this shape.
 *   - `WhereInput` makes every field optional, so `db.contact.findMany({})`
 *     typechecks and returns everybody's contacts.
 *
 * There are two guards against that in this repo and they cover different
 * ground. The primary one is static: the `every tenant-owned query states its
 * tenant scope` block in tests/unit/backend/tenant-isolation-fixes.test.ts
 * walks schema.prisma and every Prisma call site in backend/ and fails the
 * build on an unscoped one. It sees code that has not run yet, and it sees the
 * raw-SQL and relation-only ("tier 3") cases this file structurally cannot.
 *
 * This file is the secondary one: a runtime net for the case the static walk
 * cannot decide, where the filter IS written but its value arrives undefined.
 *
 * ─── WHAT COUNTS AS A SCOPE IS AN ALLOW-LIST, NOT A DENY-LIST ───────────────
 *
 * `constrains()` treats a filter as tenant-binding only when it pins the column
 * to a value: a scalar, `{ equals: v }`, or `{ in: [...] }`. Every other Prisma
 * operator selects a RANGE, and a range over a tenant column spans tenants:
 * `{ organization_id: { not: myOrg } }` is literally "every other tenant's
 * rows", and `{ id: { gt: cursor } }` — ordinary keyset pagination — reads the
 * whole table. Enumerating the bad operators instead would leave every operator
 * nobody thought of counting as a scope, which is how a guard against forgotten
 * filters ends up forgetting filters. The allow-list also closes the shape this
 * file exists for one level down: `{ organization_id: { equals: orgId } }` with
 * `orgId` arriving undefined is dropped by Prisma exactly like the bare form.
 *
 * ─── IT DOES NOT THROW IN PRODUCTION, AND THAT IS DELIBERATE ────────────────
 *
 * `TENANT_SCOPE_ENFORCE=1` turns a miss into a thrown error. It is set NOWHERE
 * — not in .env, not in .env.localprod, not in the vitest config, and setting it
 * there would change nothing anyway because every unit test that touches `db`
 * replaces it with `vi.mock`, so this extension is never installed in them. The
 * throw path is covered instead by tests/unit/backend/tenant-scope.test.ts,
 * which installs the extension on a real client and asserts the rejection
 * happens before the query is issued (no database needed).
 *
 * In production this reports and continues, once per distinct call site per
 * process, because a false positive here is worse than the hole it guards: the
 * hole has injured nobody, while a walker that fails to recognise scoping
 * expressed as `pipeline: { organization_id }` or as an OR branch would 500
 * every live user's contact list. Before enforcement can be turned on, the
 * deliberately cross-tenant paths (the idempotency TTL sweep, the scheduler's
 * reminder claim, the dead-push-token cleanup) need an explicit opt-out, which
 * does not exist yet — they are marked in source with `tenant-scope:
 * cross-tenant` comments that the static walk reads, but nothing at runtime
 * honours those. Read the report log first.
 *
 * One caveat on the report log: `report()` derives its dedup key from the first
 * stack frame naming `backend`, and falls back to the literal 'unknown' when no
 * frame matches. Two distinct leaking sites whose frames both fail to resolve
 * are therefore logged once between them, so the log is a floor on the
 * inventory, not the inventory.
 *
 * ─── WHY NOT POSTGRESQL ROW-LEVEL SECURITY ─────────────────────────────────
 *
 * RLS is the strongest form of this control and it is rejected for THIS
 * deployment, not deferred:
 *
 *   1. Prisma has no per-request connection affinity. RLS needs `SET LOCAL
 *      app.current_org` on the same pooled connection that runs the query,
 *      which means wrapping every call site in an interactive `$transaction`.
 *      Getting that wrong leaks a GUC across a pooled connection and serves
 *      tenant A's setting to tenant B's query — RLS would INTRODUCE a
 *      cross-tenant bug class that does not exist today.
 *   2. The app connects as the table owner, and RLS does not apply to the
 *      owner. Fixing that means a new role, a re-grant of every privilege and a
 *      new DATABASE_URL on a single-box production server.
 *   3. The legitimately cross-tenant paths would each need BYPASSRLS or a
 *      second connection, reinstating exactly the unguarded path RLS was bought
 *      to remove.
 *   4. PipelineStage, UserCalendarSync, PushDevice, VerificationCode and
 *      TotpBackupCode have no tenant column and would need per-row subquery
 *      policies; NotificationSent has no path to an org at all.
 *   5. A policy that is wrong in the restrictive direction locks every live
 *      user out of their own data on the first query, and reverting it means a
 *      migration against production.
 */

import type { PrismaClient } from '@prisma/client';

/**
 * Every model that owns a tenant column, and the name of that column.
 *
 * PendingCapture calls it `org_id`, not `organization_id` — it is the only
 * model in the schema that does, and any guard written against the literal
 * string 'organization_id' silently exempts it and its raw, unencrypted phone
 * numbers. That is why this is a map and not a grep.
 *
 * tenant-isolation-fixes.test.ts asserts this map against schema.prisma in both
 * directions, so a model added tomorrow fails the build until it is classified.
 */
export const TENANT_KEY_BY_MODEL: Readonly<Record<string, 'organization_id' | 'org_id'>> = {
  ActivityLog: 'organization_id',
  AmoEntityMap: 'organization_id',
  AmoIntegration: 'organization_id',
  AmoSyncConflict: 'organization_id',
  AmoSyncJob: 'organization_id',
  ApiKey: 'organization_id',
  AssistantConversation: 'organization_id',
  AssistantMessage: 'organization_id',
  Attachment: 'organization_id',
  AuditEvent: 'organization_id',
  AuthSession: 'organization_id',
  CalendarEvent: 'organization_id',
  ChatMessage: 'organization_id',
  ChatReadReceipt: 'organization_id',
  Contact: 'organization_id',
  Deal: 'organization_id',
  EmailSend: 'organization_id',
  EmailTemplate: 'organization_id',
  IdempotencyKey: 'organization_id',
  Invite: 'organization_id',
  LeadInbox: 'organization_id',
  LeadInboxMessage: 'organization_id',
  Message: 'organization_id',
  Notification: 'organization_id',
  PendingCapture: 'org_id',
  Pipeline: 'organization_id',
  Sequence: 'organization_id',
  SequenceEnrollment: 'organization_id',
  SequenceStep: 'organization_id',
  Task: 'organization_id',
  TaskReminder: 'organization_id',
  User: 'organization_id',
  WebhookDelivery: 'organization_id',
  WebhookEndpoint: 'organization_id',
  Workflow: 'organization_id',
  WorkflowRun: 'organization_id',
};

/**
 * Models with no tenant column of their own that are tenant-owned through a
 * required relation. The extension cannot check these — there is no key to look
 * for — so the static walk in tenant-isolation-fixes.test.ts owns them.
 */
export const TENANT_OWNED_VIA_RELATION: Readonly<Record<string, string>> = {
  PipelineStage: 'pipeline',
  PushDevice: 'user',
  TotpBackupCode: 'user',
  UserCalendarSync: 'user',
  VerificationCode: 'user',
};

/**
 * Models that are genuinely global, with the reason. Anything not in one of the
 * four sets in this file is unclassified and fails the schema test.
 */
export const GLOBAL_MODELS: Readonly<Record<string, string>> = {
  Org: 'The tenant itself. Org.id IS the organization_id every other model filters on.',
  NotificationSent:
    'A dedup ledger keyed on (event_type, entity_id, recipient_id). It holds no tenant column and has no relation to one; it is written and read only by notificationEngine, which has already resolved the recipient in-org.',
  RateLimitBucket:
    'Keyed on (scope, identifier) where the identifier is an IP or an email, both of them pre-authentication values that exist before any org is known. It has no tenant column and no relation to one, and it stores a counter rather than tenant data.',
};

/**
 * Keys that address at most one row on their own, so a `where` carrying one is
 * scoped by identity rather than by tenant.
 *
 * Everything past `id` is a globally-unique bearer secret looked up by a caller
 * that has no org yet by construction: the login-by-email path, the unsub and
 * open-tracking pixels, the invite token/handoff/claim/accept hashes, the API
 * key hash, the session token hash. The test asserts this map covers exactly
 * the field-level `@unique` columns schema.prisma declares on these models, so
 * a new bearer column forces a decision here rather than sliding in unnoticed.
 */
const EXTRA_IDENTITY_KEYS: Readonly<Record<string, readonly string[]>> = {
  // Redundant as a scope — organization_id is already this model's tenant key —
  // but the schema test asserts this map equals the field-level `@unique` set
  // exactly, and AmoIntegration.organization_id is `@unique` (one integration
  // per org). Dropping it would fail that assertion, not relax anything.
  AmoIntegration: ['organization_id'],
  ApiKey: ['key_hash'],
  // Same shape as AmoIntegration: one lead inbox per org, organization_id is
  // `@unique`, and the schema test wants the field-level unique set mirrored.
  // intake_token is the org's slice of the shared collector mailbox — a
  // globally unique routing key, addressing at most one row by construction.
  LeadInbox: ['organization_id', 'intake_token'],
  AuthSession: ['token_hash'],
  Contact: ['unsubscribe_token'],
  EmailSend: ['open_token'],
  Invite: ['token_hash', 'handoff_hash', 'claim_hash', 'accept_hash'],
  User: ['email'],
};

export function identityKeysFor(model: string): readonly string[] {
  return ['id', ...(EXTRA_IDENTITY_KEYS[model] ?? [])];
}

/** Operations whose `where` decides which rows are read or written. */
const SCOPED_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
  'count',
  'aggregate',
  'groupBy',
]);

// `create`/`createMany` are excluded on purpose: they carry no `where`, and a
// missing organization_id on an insert is a NOT NULL violation the database
// rejects on its own. The one nullable tenant column, AuditEvent.organization_id,
// is nullable BECAUSE pre-authentication events (a failed login, an invite
// claim) legitimately have no org — enforcing one there would break them.

const MAX_DEPTH = 6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * The only two Prisma filter operators that pin a column to a value.
 *
 * `equals` is one row's worth of column, `in` is a fixed list of them —
 * including `in: []`, which matches nothing and is therefore safe. Everything
 * else Prisma offers (`not`, `notIn`, `isNot`, `gt`, `gte`, `lt`, `lte`,
 * `contains`, `startsWith`, `endsWith`, `search`, …) describes a RANGE, and a
 * range over a tenant column is a read across tenants. This is an allow-list on
 * purpose: an operator added by a future Prisma release must not silently start
 * counting as a tenant scope.
 */
const BINDING_OPERATORS: readonly string[] = ['equals', 'in'];

/** Keys that widen rather than narrow, so descending into them proves nothing. */
const NEGATING_KEYS: ReadonlySet<string> = new Set(['NOT', 'not', 'notIn', 'isNot', 'none']);

/**
 * Does this filter value pin its column to a value?
 *
 * `undefined` and `null` do not: Prisma DROPS an undefined filter entirely, and
 * `organization_id: null` on the one nullable tenant column selects every
 * org-less row rather than one org's rows.
 */
function constrains(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (!isPlainObject(value)) return true;
  return BINDING_OPERATORS.some((op) => op in value && value[op] !== undefined && value[op] !== null);
}

/**
 * Does this `where` node pin the query to one tenant, or to one row?
 *
 * `AND` passes if ANY branch is scoped — every branch narrows. `OR` passes only
 * if EVERY branch is scoped, because one unscoped branch widens the whole query
 * back to the table. `NOT` and `none` never scope, so they are not descended
 * into: a filter for rows that are NOT in org A is a filter for every other
 * org's rows.
 */
function isScoped(node: unknown, tenantKey: string, identityKeys: readonly string[], depth = 0): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(node)) return false;

  if (constrains(node[tenantKey])) return true;
  for (const key of identityKeys) {
    if (constrains(node[key])) return true;
  }

  for (const [key, value] of Object.entries(node)) {
    if (NEGATING_KEYS.has(key)) continue;

    if (key === 'AND') {
      const branches = Array.isArray(value) ? value : [value];
      if (branches.some((b) => isScoped(b, tenantKey, identityKeys, depth + 1))) return true;
      continue;
    }

    if (key === 'OR') {
      const branches = Array.isArray(value) ? value : [value];
      if (branches.length > 0 && branches.every((b) => isScoped(b, tenantKey, identityKeys, depth + 1))) {
        return true;
      }
      continue;
    }

    // A relation filter — `pipeline: { organization_id }`, `task: { is: { ... } }`,
    // or a compound-unique key like `organization_id_key: { ... }`. Anything
    // nested that names a tenant column scopes the parent.
    if (isPlainObject(value) && namesTenantColumn(value, depth + 1)) return true;
  }

  return false;
}

/** Recursive search for any tenant column, used for relation filters. */
function namesTenantColumn(node: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || !isPlainObject(node)) return false;
  if (constrains(node.organization_id) || constrains(node.org_id)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (NEGATING_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      if (value.some((v) => namesTenantColumn(v, depth + 1))) return true;
      continue;
    }
    if (isPlainObject(value) && namesTenantColumn(value, depth + 1)) return true;
  }
  return false;
}

export type TenantScopeVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'undefined' | 'unbound'; tenantKey: string };

/**
 * The whole rule, exported so it can be unit-tested without a database.
 */
export function checkTenantScope(model: string, operation: string, args: unknown): TenantScopeVerdict {
  const tenantKey = TENANT_KEY_BY_MODEL[model];
  if (!tenantKey) return { ok: true };
  if (!SCOPED_OPERATIONS.has(operation)) return { ok: true };

  const where = isPlainObject(args) ? args.where : undefined;

  // The tenant key is WRITTEN at the top level and still does not bind. Checked
  // before isScoped because these are the shapes a reviewer reading the source
  // cannot see, and because reporting them as 'missing' would send whoever reads
  // the log hunting for a filter that is right there:
  //   - 'undefined': the value, or the value inside `{ equals: … }` / `{ in: … }`,
  //     arrived undefined and Prisma dropped the whole filter.
  //   - 'unbound':   the filter is a range — `{ not: x }`, `{ gt: x }`,
  //     `organization_id: null` — which spans tenants instead of picking one.
  if (isPlainObject(where) && tenantKey in where && !constrains(where[tenantKey])) {
    const raw = where[tenantKey];
    const droppedByPrisma =
      raw === undefined ||
      (isPlainObject(raw) && Object.values(raw).every((v) => v === undefined));
    return { ok: false, reason: droppedByPrisma ? 'undefined' : 'unbound', tenantKey };
  }

  if (isScoped(where, tenantKey, identityKeysFor(model))) return { ok: true };
  return { ok: false, reason: 'missing', tenantKey };
}

function enforcing(): boolean {
  return process.env.TENANT_SCOPE_ENFORCE === '1';
}

export class TenantScopeError extends Error {
  readonly code = 'TENANT_SCOPE_MISSING';
  readonly statusCode = 500;

  constructor(model: string, operation: string, verdict: { reason: string; tenantKey: string }) {
    super(
      `${model}.${operation} ran without a tenant scope (${verdict.tenantKey} ${verdict.reason}). ` +
        `Every query on a tenant-owned model must filter on ${verdict.tenantKey}, on a unique key, ` +
        `or through a relation that carries one.`,
    );
    this.name = 'TenantScopeError';
  }
}

/**
 * Report each distinct call site once. The three deliberately cross-tenant
 * loops (idempotency TTL, scheduler reminder claim, dead push token) run on a
 * timer; without this the log would carry ~1400 identical lines a day and stop
 * being read. Once-per-site makes the log an inventory instead.
 */
const reported = new Set<string>();

/** Test seam — the report set is process-wide. */
export function resetTenantScopeReports(): void {
  reported.clear();
}

function report(model: string, operation: string, verdict: { reason: string; tenantKey: string }): void {
  // Prefer a frame inside backend/. When there is none — a query issued from a
  // compiled bundle, a worker thread, or through enough async hops that the
  // frames are gone — fall back to the first two frames that are not this file
  // rather than to a constant, so two different unscoped sites do not collapse
  // into a single log line and under-report the inventory.
  const frames =
    new Error().stack
      ?.split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => !l.includes('tenant-scope')) ?? [];
  const frame = frames.find((l) => l.includes('backend')) || frames.slice(0, 2).join(' <- ') || 'unknown';
  const key = `${model}.${operation}:${verdict.reason}:${frame}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(
    `[tenant-scope] ${model}.${operation} has no ${verdict.tenantKey} filter (${verdict.reason}) at ${frame}`,
  );
}

/**
 * Wrap a Prisma client so every query on a tenant-owned model is checked.
 *
 * The whole check is inside a try/catch that swallows its own failures: a bug
 * in the walker must never be able to break a query that would otherwise have
 * worked. That is what makes this safe to have running in production while it
 * is still only reporting.
 */
export function withTenantScope<T extends PrismaClient>(client: T): T {
  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          try {
            const verdict = checkTenantScope(model, operation, args);
            if (!verdict.ok) {
              if (enforcing()) throw new TenantScopeError(model, operation, verdict);
              report(model, operation, verdict);
            }
          } catch (error) {
            if (error instanceof TenantScopeError) throw error;
            // The guard failed, not the query. Never let that surface.
          }
          return query(args);
        },
      },
    },
  }) as unknown as T;
}
