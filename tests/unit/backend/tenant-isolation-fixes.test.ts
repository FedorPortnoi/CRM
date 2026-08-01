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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
