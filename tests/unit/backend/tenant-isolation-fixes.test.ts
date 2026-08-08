/**
 * Regression tests for four tenant-isolation defects in the attachment /
 * push-notification paths.
 *
 * 1. notifications.registerToken de-duplicated push tokens with an updateMany
 *    that had no organization_id — the only cross-tenant WRITE in the codebase.
 *    Anyone in any org could POST a victim's token and null it out, silently
 *    killing the victim's push notifications.
 * 2. storage.deriveOrgScopedKey enforced tenant ownership with a bare
 *    startsWith, so `uploads/<myOrg>/../<victimOrg>/x` (and its `%2e%2e` form)
 *    passed the check while resolving into another tenant's prefix.
 * 3. attachments.getUploadUrl validated entity_id as a uuid but never called
 *    canSeeEntity, unlike the other three handlers in the same file.
 * 4. CreateAttachmentSchema dropped the caps the upload route enforces — an
 *    unbounded filename and an unchecked mime_type — so POST /attachments
 *    bypassed both.
 *
 * Blocks 5–7 are not regressions. They are the CHOKEPOINT the four above did
 * not have: each of those bugs was a single forgotten organization_id, each was
 * found by hand, and nothing stopped the next one. See the header of block 5.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const VICTIM = 'aaaaaaaa-0000-4000-8000-000000000001';
const ATTACKER = 'bbbbbbbb-0000-4000-8000-000000000002';
const COLLEAGUE = 'aaaaaaaa-0000-4000-8000-000000000003';
const ENTITY = 'cccccccc-0000-4000-8000-000000000007';

// Not an Expo token — takes the raw-FCM branch of the format check.
const SHARED_TOKEN = 'fcmTokenVictimDevice0123456789abcdefghij';

const S3_ENDPOINT = 'https://storage.yandexcloud.net';
const S3_BUCKET = 'crm-uploads-users';

// --- In-memory user table ----------------------------------------------------
// Stateful rather than call-shape assertions: the claim under test is that the
// victim's row still HOLDS its token after the attacker's register call.

type UserRow = { id: string; organization_id: string; push_token: string | null };

type Where = {
  id?: string | { not?: string };
  organization_id?: string;
  push_token?: string | null;
};

let users: UserRow[] = [];

function matches(row: UserRow, where: Where): boolean {
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (typeof where.id === 'object' && where.id?.not !== undefined && row.id === where.id.not) return false;
  if (where.organization_id !== undefined && row.organization_id !== where.organization_id) return false;
  if (where.push_token !== undefined && row.push_token !== where.push_token) return false;
  return true;
}

vi.mock('../../../backend/services/db', () => ({
  db: {
    $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    user: {
      findFirst: ({ where }: { where: Where }) =>
        Promise.resolve(users.find((u) => matches(u, where)) ?? null),
      updateMany: ({ where, data }: { where: Where; data: { push_token: string | null } }) => {
        const hit = users.filter((u) => matches(u, where));
        for (const row of hit) row.push_token = data.push_token;
        return Promise.resolve({ count: hit.length });
      },
    },
    attachment: {
      create: ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'att-1', ...data }),
    },
    calendarEvent: { findFirst: () => Promise.resolve(null) },
  },
}));

vi.mock('../../../backend/services/push', () => ({
  sendPush: vi.fn(async () => ({ ok: true })),
  sendPushToUser: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, devices: [] })),
}));

const registerPushDevice = vi.hoisted(() => vi.fn(async (input: Record<string, unknown>) => ({
  id: 'device-1',
  user_id: input.userId,
  token: input.token,
  provider: input.provider,
  platform: input.platform,
  app_version: null,
  device_name: null,
})));

vi.mock('../../../backend/services/push-devices', () => ({
  isPushProvider: (value: unknown) => ['rustore', 'apns', 'expo', 'fcm'].includes(String(value)),
  isPushPlatform: (value: unknown) => ['android', 'ios', 'web'].includes(String(value)),
  registerPushDevice,
  PushDeviceOrgConflictError: class PushDeviceOrgConflictError extends Error {
    readonly code = 'PUSH_DEVICE_ORG_CONFLICT';
  },
}));

// Keep the real deriveOrgScopedKey and isAllowedUploadMimeType — both are under
// test — and stub only the presigned-POST minting.
const generateUploadUrl = vi.fn(async () => ({
  uploadUrl: `${S3_ENDPOINT}/${S3_BUCKET}`,
  fields: {},
  fileUrl: `${S3_ENDPOINT}/${S3_BUCKET}/uploads/${ORG_B}/contact/f.png`,
  key: `uploads/${ORG_B}/contact/f.png`,
}));

vi.mock('../../../backend/services/storage', async (importActual) => {
  const actual = await importActual<typeof import('../../../backend/services/storage')>();
  return { ...actual, generateUploadUrl: (...args: unknown[]) => generateUploadUrl(...(args as [])) };
});

const getContactForUser = vi.fn();

vi.mock('../../../backend/services/contact-domain', () => {
  class ContactNotFoundError extends Error {
    readonly code = 'NOT_FOUND';
  }
  return {
    ContactNotFoundError,
    getContactForUser: (...args: unknown[]) => getContactForUser(...args),
  };
});

import {
  TENANT_KEY_BY_MODEL,
  TENANT_OWNED_VIA_RELATION,
  GLOBAL_MODELS,
  identityKeysFor,
} from '../../../backend/services/tenant-scope';
import { NotificationsController } from '../../../backend/api/controllers/notifications';
import { deriveOrgScopedKey, buildKey, getPublicUrl } from '../../../backend/services/storage';
import { getUploadUrl, createAttachment } from '../../../backend/api/controllers/attachments';
import { ContactNotFoundError } from '../../../backend/services/contact-domain';

function makeReply() {
  const reply: Record<string, unknown> = { statusCode: undefined, payload: undefined };
  reply.status = vi.fn((c: number) => {
    reply.statusCode = c;
    return reply;
  });
  reply.send = vi.fn((b: unknown) => {
    reply.payload = b;
    return reply;
  });
  return reply;
}

function errorCode(reply: Record<string, unknown>): string | undefined {
  return (reply.payload as { error?: { code: string } } | undefined)?.error?.code;
}

// --- 1. The cross-tenant push-token write -----------------------------------

describe('registerToken de-duplication is org-scoped', () => {
  beforeEach(() => {
    users = [
      { id: VICTIM, organization_id: ORG_A, push_token: SHARED_TOKEN },
      { id: COLLEAGUE, organization_id: ORG_A, push_token: null },
      { id: ATTACKER, organization_id: ORG_B, push_token: null },
    ];
  });

  it("a register call from org B leaves org A's push token intact", async () => {
    const reply = makeReply();

    await NotificationsController.registerToken(
      { body: { token: SHARED_TOKEN, provider: 'fcm', platform: 'android' }, user: { sub: ATTACKER, org_id: ORG_B, role: 'member' } } as never,
      reply as never,
    );

    // The load-bearing assertion: the victim's device is still reachable.
    expect(users.find((u) => u.id === VICTIM)?.push_token).toBe(SHARED_TOKEN);
    expect(reply.statusCode).toBeUndefined();
  });

  it('the attacker still gets the token recorded on their own row', async () => {
    const reply = makeReply();

    await NotificationsController.registerToken(
      { body: { token: SHARED_TOKEN, provider: 'fcm', platform: 'android' }, user: { sub: ATTACKER, org_id: ORG_B, role: 'member' } } as never,
      reply as never,
    );

    expect(users.find((u) => u.id === ATTACKER)?.push_token).toBe(SHARED_TOKEN);
  });

  it('a duplicate held by a colleague in the same org is still cleared', async () => {
    const reply = makeReply();

    await NotificationsController.registerToken(
      { body: { token: SHARED_TOKEN, provider: 'fcm', platform: 'android' }, user: { sub: COLLEAGUE, org_id: ORG_A, role: 'member' } } as never,
      reply as never,
    );

    expect(users.find((u) => u.id === VICTIM)?.push_token).toBeNull();
    expect(users.find((u) => u.id === COLLEAGUE)?.push_token).toBe(SHARED_TOKEN);
  });
});

// --- 2. Path traversal in the S3 key check ----------------------------------

describe('deriveOrgScopedKey rejects traversal out of the org prefix', () => {
  const base = `${S3_ENDPOINT}/${S3_BUCKET}/`;

  beforeEach(() => {
    process.env.S3_ENDPOINT = S3_ENDPOINT;
    process.env.S3_BUCKET = S3_BUCKET;
  });

  it('accepts a key buildKey would actually produce', () => {
    const key = `uploads/${ORG_A}/contact/0f8f-report.pdf`;
    expect(deriveOrgScopedKey(`${base}${key}`, ORG_A)).toBe(key);
  });

  const traversals = [
    `uploads/${ORG_A}/../${ORG_B}/contact/x.pdf`,
    `uploads/${ORG_A}/%2e%2e/${ORG_B}/contact/x.pdf`,
    `uploads/${ORG_A}/%2E%2E/${ORG_B}/contact/x.pdf`,
    `uploads/${ORG_A}/..%2f${ORG_B}/contact/x.pdf`,
    `uploads/${ORG_A}/%252e%252e/${ORG_B}/contact/x.pdf`,
    `uploads/${ORG_A}/..\\${ORG_B}\\contact\\x.pdf`,
    `uploads/${ORG_A}/sub/../../${ORG_B}/contact/x.pdf`,
  ];

  for (const key of traversals) {
    it(`rejects ${key}`, () => {
      expect(deriveOrgScopedKey(`${base}${key}`, ORG_A)).toBeNull();
    });
  }

  it('rejects a malformed percent-escape rather than ignoring it', () => {
    expect(deriveOrgScopedKey(`${base}uploads/${ORG_A}/contact/%zz.pdf`, ORG_A)).toBeNull();
  });

  it('accepts every key buildKey mints, including from a percent-bearing filename', () => {
    for (const filename of ['report.pdf', 'Q3 margin 12.5%', 'счёт №7.pdf', 'a%2e%2eb.png']) {
      const key = buildKey(ORG_A, 'contact', filename);
      expect(deriveOrgScopedKey(getPublicUrl(key), ORG_A)).toBe(key);
    }
  });

  it("still rejects another org's prefix and a foreign host", () => {
    expect(deriveOrgScopedKey(`${base}uploads/${ORG_B}/contact/x.pdf`, ORG_A)).toBeNull();
    expect(deriveOrgScopedKey(`https://evil.example/${S3_BUCKET}/uploads/${ORG_A}/x.pdf`, ORG_A)).toBeNull();
  });
});

// --- 3. getUploadUrl must check the visibility cone -------------------------

describe('getUploadUrl gates on canSeeEntity', () => {
  function uploadRequest() {
    return {
      body: {
        entity_type: 'contact',
        entity_id: ENTITY,
        filename: 'photo.png',
        mime_type: 'image/png',
        size: 1024,
      },
      user: { sub: ATTACKER, org_id: ORG_B, role: 'member' },
    } as never;
  }

  beforeEach(() => {
    generateUploadUrl.mockClear();
    getContactForUser.mockReset();
  });

  it('refuses an entity the caller cannot see and mints no presigned URL', async () => {
    getContactForUser.mockRejectedValue(new ContactNotFoundError());
    const reply = makeReply();

    await getUploadUrl(uploadRequest(), reply as never);

    expect(generateUploadUrl).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(404);
    expect(errorCode(reply)).toBe('ENTITY_NOT_FOUND');
  });

  it('mints a presigned URL for an entity the caller can see', async () => {
    getContactForUser.mockResolvedValue({ id: ENTITY });
    const reply = makeReply();

    await getUploadUrl(uploadRequest(), reply as never);

    expect(generateUploadUrl).toHaveBeenCalledTimes(1);
    expect(reply.statusCode).toBeUndefined();
  });
});

// --- 4. CreateAttachmentSchema caps match the upload route ------------------

describe('POST /attachments cannot bypass the upload route caps', () => {
  const base = {
    entity_type: 'contact',
    entity_id: ENTITY,
    file_url: `${S3_ENDPOINT}/${S3_BUCKET}/uploads/${ORG_B}/contact/x.pdf`,
  };

  beforeEach(() => {
    process.env.S3_ENDPOINT = S3_ENDPOINT;
    process.env.S3_BUCKET = S3_BUCKET;
    getContactForUser.mockReset();
    getContactForUser.mockResolvedValue({ id: ENTITY });
  });

  async function create(body: Record<string, unknown>) {
    const reply = makeReply();
    await createAttachment(
      { body, user: { sub: ATTACKER, org_id: ORG_B, role: 'member' } } as never,
      reply as never,
    );
    return reply;
  }

  it('rejects a filename longer than 255 characters', async () => {
    const reply = await create({ ...base, filename: 'a'.repeat(256), mime_type: 'application/pdf' });

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('VALIDATION_ERROR');
  });

  it('rejects a mime type outside ALLOWED_UPLOAD_MIME_TYPES', async () => {
    const reply = await create({ ...base, filename: 'x.svg', mime_type: 'image/svg+xml' });

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('VALIDATION_ERROR');
  });

  it('still accepts an allowed mime type with a 255-character filename', async () => {
    const reply = await create({ ...base, filename: 'a'.repeat(255), mime_type: 'application/pdf' });

    expect(reply.statusCode).toBe(201);
  });

  it('still accepts a request that omits the optional mime type', async () => {
    const reply = await create({ ...base, filename: 'x.pdf' });

    expect(reply.statusCode).toBe(201);
  });
});

// ============================================================================
// Blocks 5–7: THE CHOKEPOINT
//
// The four bugs above were each a single forgotten organization_id, each was
// found by hand, and nothing stopped the next one. backend/services/db.ts now
// wraps the one shared PrismaClient in the runtime guard from
// backend/services/tenant-scope.ts — but that guard reports rather than throws,
// it is compiled out of the running production build until the next `npm run
// build`, and it is structurally blind to raw SQL and to the four models that
// own their tenant through a relation instead of a column.
//
// These three blocks are the static half, and they are the half that can be
// enforced today with no production risk at all: they read source text and
// fail the build. Between them they assert that every model is classified,
// that every Prisma call site on a tenant-owned model states a scope, and that
// every raw statement does too.
//
// HOW TO SILENCE A DELIBERATE CROSS-TENANT QUERY: put a comment
//   // tenant-scope: cross-tenant — <why>
// on one of the lines just above it. The exemption then travels with the code
// instead of with a line number, and the reason sits where the next reader is.
// Sites in files this change was not allowed to touch are listed in the two
// maps below instead; an entry that stops matching fails the test, so the maps
// cannot rot into permanent amnesty.
// ============================================================================

// Forward slashes throughout, so the same string arithmetic works on Windows —
// this repo's production box is a Windows laptop.
const REPO_ROOT = fileURLToPath(import.meta.url)
  .replace(/\\/g, '/')
  .replace(/\/tests\/unit\/backend\/[^/]+$/, '');
const BACKEND_DIR = `${REPO_ROOT}/backend/`;
const SCHEMA_PATH = `${REPO_ROOT}/backend/prisma/schema.prisma`;
const CROSS_TENANT_MARKER = 'tenant-scope: cross-tenant';

/** Prisma call sites in files outside this change's remit. */
const KNOWN_CROSS_TENANT: Readonly<Record<string, string>> = {
  'services/push-devices.ts::User.updateMany':
    'deletePushDeviceByToken clears the legacy User.push_token column for a token the push provider reported dead. It is called only from services/push.ts on a provider callback, never from a route, and the token is a globally unique bearer value — but it IS a cross-tenant write and it wants an organization_id or an in-source marker. Owner decision, see H9 output.',
};

/** Raw statements in files outside this change's remit, and how many there are. */
const KNOWN_CROSS_TENANT_SQL: Readonly<Record<string, { reason: string; count: number }>> = {
  'api/controllers/auth.ts::WITH "User"': {
    reason:
      'Recursive CTE that walks the manager chain to detect a reporting cycle. The root manager_id is verified in-org immediately above, and the statement selects nothing but ids.',
    count: 1,
  },
  'services/sessions.ts::UPDATE "AuthSession"': {
    reason:
      'touchAuthSession updates by session id resolved from an organization_id-scoped SELECT on the line above; revokeWhere takes an already-scoped Prisma.Sql predicate from its callers.',
    count: 2,
  },
};

// --- source-walking helpers --------------------------------------------------

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };

function backendFiles(dir = BACKEND_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'seeds') continue;
      backendFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && entry.name !== 'tenant-scope.ts') {
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return file.slice(BACKEND_DIR.length);
}

/** Text between the delimiters starting at `open`, balanced. */
function balancedFrom(src: string, open: number): string {
  const close = OPENERS[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function isInsideComment(src: string, index: number): boolean {
  const prefix = src.slice(src.lastIndexOf('\n', index) + 1, index).trim();
  return prefix.startsWith('*') || prefix.startsWith('//') || prefix.startsWith('/*');
}

function hasMarkerAbove(src: string, index: number): boolean {
  const lines = src.slice(0, index).split('\n');
  return lines.slice(-6).some((l) => l.includes(CROSS_TENANT_MARKER));
}

/** Every `const/let X = …` initialiser, plus later `X.foo =` mutations. */
function declarationText(src: string, ident: string): string {
  let out = '';
  let m: RegExpExecArray | null;
  const decl = new RegExp(`(?:const|let|var)\\s+${ident}\\b[^=;]*=\\s*`, 'g');
  while ((m = decl.exec(src))) {
    const at = m.index + m[0].length;
    out += OPENERS[src[at]] ? balancedFrom(src, at) : src.slice(at, src.indexOf(';', at));
    out += ' ';
  }
  const mutate = new RegExp(`${ident}(?:\\.\\w+)*\\.(\\w+)\\s*=[^=]`, 'g');
  while ((m = mutate.exec(src))) out += `${m[1]}: _ `;
  const push = new RegExp(`${ident}\\.push\\s*\\(`, 'g');
  while ((m = push.exec(src))) out += `${balancedFrom(src, src.indexOf('(', m.index))} `;
  return out;
}

/** The body of a function declared in this file, for `where: buildScope(org)`. */
function functionBody(src: string, name: string): string {
  let out = '';
  let m: RegExpExecArray | null;
  const re = new RegExp(`(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\b[^=;]*=)`, 'g');
  while ((m = re.exec(src))) {
    const brace = src.indexOf('{', m.index);
    if (brace !== -1) out += `${balancedFrom(src, brace)} `;
  }
  return out;
}

function referencedIdentifiers(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const spread = /\.\.\.\s*([A-Za-z_$][\w$]*)/g;
  while ((m = spread.exec(text))) out.add(m[1]);
  const named = /(^|[\s,{(])where\s*:\s*([A-Za-z_$][\w$]*)/g;
  while ((m = named.exec(text))) out.add(m[2]);
  if (/(^|[\s,{])where\s*[,}]/.test(text)) out.add('where');
  const called = /([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = called.exec(text))) out.add(m[1]);
  // Arguments handed to a helper: `Prisma.join(filters, ' AND ')`.
  const argument = /[(,]\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  while ((m = argument.exec(text))) out.add(m[1]);
  // Raw SQL: `WHERE ${whereClause}` and `WHERE ${Prisma.join(conditions, ' AND ')}`
  // are how the tenant predicate reaches a $queryRaw template.
  const interpolated = /\$\{([^}]*)\}/g;
  while ((m = interpolated.exec(text))) {
    for (const ident of m[1].match(/[A-Za-z_$][\w$]*/g) ?? []) out.add(ident);
  }
  return [...out];
}

/**
 * Follow `{ where }`, `where: someVar` and `...buildScope(org)` back through the
 * file until the text names a tenant column or an identity key, or there is
 * nothing left to follow.
 */
function statesScope(src: string, args: string, keys: readonly string[]): boolean {
  const names = (text: string) =>
    keys.some((k) => new RegExp(`\\b${k}\\b`).test(text)) || /organization_id|org_id/.test(text);

  let text = args;
  const seen = new Set<string>();
  for (let hop = 0; hop < 4 && !names(text); hop++) {
    const idents = referencedIdentifiers(text).filter((i) => !seen.has(i));
    if (idents.length === 0) break;
    for (const ident of idents) {
      seen.add(ident);
      text += ` ${declarationText(src, ident)} ${functionBody(src, ident)}`;
    }
  }
  return names(text);
}

// --- 5. Every tenant-owned Prisma call site states its tenant scope ---------

const SCOPED_OPS = [
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'count', 'aggregate', 'groupBy',
];

const DELEGATE_TO_MODEL: Record<string, string> = {};
for (const model of Object.keys(TENANT_KEY_BY_MODEL)) {
  DELEGATE_TO_MODEL[model[0].toLowerCase() + model.slice(1)] = model;
}

type CallSite = { file: string; line: number; model: string; operation: string; args: string; index: number };

/**
 * Everything in this file that a Prisma delegate can hang off.
 *
 * Not a fixed list: `services/amocrm/mapping.ts` does
 * `const database = db as unknown as OutboundMappingDb` and then queries
 * `database.pipeline`, and an interactive transaction can name its client
 * anything. A hard-coded `db|tx` alternation would drop both out of the walk's
 * view while the suite stayed green.
 */
function clientReceivers(src: string): string[] {
  const names = new Set(['db', 'tx', 'client', 'prisma']);
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*db\b(?!\s*\.)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/\$transaction\s*\(\s*async\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return [...names];
}

function prismaCallSites(): { sites: CallSite[]; unscoped: CallSite[] } {
  const sites: CallSite[] = [];
  const unscoped: CallSite[] = [];
  for (const file of backendFiles()) {
    const src = readFileSync(file, 'utf8');
    const re = new RegExp(
      `\\b(?:${clientReceivers(src).join('|')})\\.([a-zA-Z][a-zA-Z0-9]*)\\.([a-zA-Z]+)\\s*\\(`,
      'g',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const model = DELEGATE_TO_MODEL[m[1]];
      if (!model || !SCOPED_OPS.includes(m[2])) continue;
      if (isInsideComment(src, m.index)) continue;
      const open = m.index + m[0].length - 1;
      const site: CallSite = {
        file: relative(file),
        line: lineOf(src, m.index),
        model,
        operation: m[2],
        args: balancedFrom(src, open),
        index: m.index,
      };
      sites.push(site);
      const keys = [TENANT_KEY_BY_MODEL[model], ...identityKeysFor(model)];
      if (statesScope(src, site.args, keys)) continue;
      if (hasMarkerAbove(src, m.index)) continue;
      unscoped.push(site);
    }
  }
  return { sites, unscoped };
}

describe('every tenant-owned query states its tenant scope', () => {
  const { sites, unscoped } = prismaCallSites();

  it('walks a plausible number of call sites — silence must not look like success', () => {
    // The walk asserts a property only over what its regex matched, so a call
    // site it fails to match is indistinguishable from one that passed. This is
    // the floor: ~480 tenant-owned sites exist today. If a refactor drops this
    // below the floor, RAISE the guard, do not lower the number.
    expect(sites.length).toBeGreaterThan(400);
  });

  it('never hides a Prisma delegate behind a local alias', () => {
    // `const contacts = db.contact; contacts.findMany(...)` would fall out of the
    // walk's view while staying perfectly green. Ban the shape instead of trying
    // to follow it.
    const aliases: string[] = [];
    for (const file of backendFiles()) {
      const src = readFileSync(file, 'utf8');
      const re = /=\s*(?:db|tx|prisma)\.([a-z][A-Za-z0-9]*)\s*[;,)]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (DELEGATE_TO_MODEL[m[1]]) aliases.push(`${relative(file)}:${lineOf(src, m.index)}`);
      }
    }
    expect(aliases).toEqual([]);
  });

  it('leaves no unscoped query that is not a declared cross-tenant one', () => {
    const survivors = unscoped
      .filter((s) => !KNOWN_CROSS_TENANT[`${s.file}::${s.model}.${s.operation}`])
      .map((s) => `${s.file}:${s.line} ${s.model}.${s.operation} ${s.args.replace(/\s+/g, ' ').slice(0, 90)}`);

    expect(survivors).toEqual([]);
  });

  it('has no stale entry in KNOWN_CROSS_TENANT', () => {
    const live = new Set(unscoped.map((s) => `${s.file}::${s.model}.${s.operation}`));
    const stale = Object.keys(KNOWN_CROSS_TENANT).filter((k) => !live.has(k));

    expect(stale).toEqual([]);
  });
});

// --- 6. Every model in the schema is classified ------------------------------

type SchemaModel = { name: string; table: string; columns: string[]; uniques: string[] };

function parseSchema(): SchemaModel[] {
  const src = readFileSync(SCHEMA_PATH, 'utf8');
  const out: SchemaModel[] = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[2];
    const mapped = /@@map\("([^"]+)"\)/.exec(body);
    out.push({
      name: m[1],
      table: mapped ? mapped[1] : m[1],
      columns: [...body.matchAll(/^\s{2}(\w+)\s+\S/gm)].map((c) => c[1]),
      uniques: [...body.matchAll(/^\s*(\w+)\s+\S+.*@unique/gm)].map((c) => c[1]),
    });
  }
  return out;
}

describe('tenant-scope.ts classifies every model in schema.prisma', () => {
  const models = parseSchema();

  it('found the schema', () => {
    expect(models.length).toBeGreaterThan(30);
  });

  it('classifies every model exactly once', () => {
    const buckets = [TENANT_KEY_BY_MODEL, TENANT_OWNED_VIA_RELATION, GLOBAL_MODELS];
    const unclassified: string[] = [];
    const doubled: string[] = [];
    for (const model of models) {
      const hits = buckets.filter((b) => model.name in b).length;
      if (hits === 0) unclassified.push(model.name);
      if (hits > 1) doubled.push(model.name);
    }

    // An unclassified model is silently exempt from the runtime guard forever.
    expect(unclassified).toEqual([]);
    expect(doubled).toEqual([]);
  });

  it('classifies nothing that is not a model', () => {
    const known = new Set(models.map((m) => m.name));
    const ghosts = [
      ...Object.keys(TENANT_KEY_BY_MODEL),
      ...Object.keys(TENANT_OWNED_VIA_RELATION),
      ...Object.keys(GLOBAL_MODELS),
    ].filter((name) => !known.has(name));

    expect(ghosts).toEqual([]);
  });

  it('names a tenant column the model actually declares', () => {
    const wrong = Object.entries(TENANT_KEY_BY_MODEL)
      .filter(([name, key]) => !models.find((m) => m.name === name)?.columns.includes(key))
      .map(([name, key]) => `${name}.${key}`);

    // This is the assertion that catches PendingCapture.org_id being renamed, or
    // a new model whose column is org_id being classified as organization_id.
    expect(wrong).toEqual([]);
  });

  it('treats exactly the field-level @unique columns as identity keys', () => {
    const mismatches: string[] = [];
    for (const model of models) {
      if (!(model.name in TENANT_KEY_BY_MODEL)) continue;
      const declared = [...identityKeysFor(model.name)].filter((k) => k !== 'id').sort();
      const unique = [...model.uniques].filter((k) => k !== 'id').sort();
      if (declared.join(',') !== unique.join(',')) {
        mismatches.push(`${model.name}: identity=[${declared}] @unique=[${unique}]`);
      }
    }

    // A new globally-unique bearer column — another invite hash, another tracking
    // token — has to be a deliberate decision in EXTRA_IDENTITY_KEYS, because a
    // lookup by one of those is the one shape that legitimately has no org yet.
    expect(mismatches).toEqual([]);
  });
});

// --- 7. Raw SQL, which the runtime guard cannot see at all -------------------

describe('every raw SQL statement states its tenant scope', () => {
  const models = parseSchema();
  const tableToModel = new Map(models.map((m) => [m.table.toLowerCase(), m.name]));

  type RawSite = { file: string; line: number; sql: string; fingerprint: string; unsafe: boolean };

  const rawSites: RawSite[] = [];
  const unscoped: RawSite[] = [];

  for (const file of backendFiles()) {
    const src = readFileSync(file, 'utf8');
    const re = /\$(queryRaw|executeRaw)(Unsafe)?\s*(<[^`(;]*>)?\s*[`(]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (isInsideComment(src, m.index)) continue;
      const start = src.indexOf('`', m.index);
      const end = start === -1 ? -1 : src.indexOf('`', start + 1);
      const sql = start === -1 || end === -1 ? '' : src.slice(start + 1, end).replace(/\s+/g, ' ').trim();
      const verb = /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE)/i.exec(sql)?.[1].toUpperCase() ?? '?';
      const tables = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([A-Za-z_]\w*)"?/gi)]
        .map((t) => t[1].toLowerCase())
        .filter((t) => tableToModel.has(t));
      const firstTable = tables[0] ? `"${tableToModel.get(tables[0])}"` : 'none';
      const site: RawSite = {
        file: relative(file),
        line: lineOf(src, m.index),
        sql,
        fingerprint: `${relative(file)}::${verb} ${firstTable}`,
        unsafe: Boolean(m[2]),
      };
      rawSites.push(site);

      // A statement that touches no model table (an advisory lock, `SELECT 1`) or
      // only globally-owned ones has no tenant boundary to state.
      const owned = tables.map((t) => tableToModel.get(t) as string).filter((n) => !(n in GLOBAL_MODELS));
      if (owned.length === 0) continue;
      if (statesScope(src, sql, ['organization_id', 'org_id'])) continue;
      if (hasMarkerAbove(src, m.index)) continue;
      unscoped.push(site);
    }
  }

  it('found the raw call sites', () => {
    expect(rawSites.length).toBeGreaterThan(15);
  });

  it('never uses $queryRawUnsafe or $executeRawUnsafe', () => {
    // String-concatenated SQL cannot be checked by anything here, and there are
    // currently zero. Keep it that way: use a Prisma.sql template.
    expect(rawSites.filter((s) => s.unsafe).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it('leaves no unscoped raw statement that is not a declared cross-tenant one', () => {
    const survivors = unscoped
      .filter((s) => KNOWN_CROSS_TENANT_SQL[s.fingerprint] === undefined)
      .map((s) => `${s.fingerprint} @ line ${s.line} :: ${s.sql.slice(0, 100)}`);

    expect(survivors).toEqual([]);
  });

  it('matches the declared count for every KNOWN_CROSS_TENANT_SQL entry', () => {
    const observed = new Map<string, number>();
    for (const s of unscoped) observed.set(s.fingerprint, (observed.get(s.fingerprint) ?? 0) + 1);

    const drift = Object.entries(KNOWN_CROSS_TENANT_SQL)
      .filter(([key, entry]) => (observed.get(key) ?? 0) !== entry.count)
      .map(([key, entry]) => `${key}: declared ${entry.count}, found ${observed.get(key) ?? 0}`);

    // Both directions matter. A second unscoped UPDATE on the same table in the
    // same file would otherwise inherit the first one's amnesty, and an entry
    // whose site was fixed would sit here forever pretending to cover something.
    expect(drift).toEqual([]);
  });
});
