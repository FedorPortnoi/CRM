/**
 * The invite controller is where the four bearer secrets of the invite flow are
 * actually SPENT.
 *
 * `tests/unit/backend/invites.test.ts` covers the pure helpers in
 * backend/services/invites.ts — how the secrets are minted, hashed and judged —
 * and never imports the controller. So until this file existed, every decision
 * made *with* those secrets was unprotected: which column `accept` resolves
 * against, whether the consuming write is a compare-and-set, whether `revoke`
 * and `list` carry an organization_id, whether a failed redemption tells the
 * caller which kind of failure it was.
 *
 * A mutation audit confirmed it: ten independent removals of authentication,
 * tenancy, single-use and privilege boundaries in
 * backend/api/controllers/invites.ts all survived the full suite. Each describe
 * block below names the removal it refuses.
 *
 * ─── HOW THIS FILE IS BUILT, AND WHY IT MATTERS MORE THAN THE COVERAGE ───────
 *
 * The database double below is a plain row store: a generic WHERE matcher, a
 * generic `select` projection, and `updateMany` = "apply `data` to every row the
 * WHERE matches". It models Prisma. It does NOT model single use, tenancy or
 * expiry — those live entirely in the WHERE clauses the controller writes.
 *
 * That distinction is the whole point. A fake that implemented compare-and-set
 * semantics of its own would make every single-use test pass no matter what the
 * controller sent, and the test would be proving that the fake works. A test
 * that cannot fail is worse than no test, because it is also a claim.
 *
 * So the load-bearing assertions come in pairs:
 *   • on the ARGUMENTS the production code passes — e.g. that the consuming
 *     `updateMany` really carries `consumed_at: null` in its WHERE; and
 *   • on the OUTCOME the store then produces — a second redemption creates no
 *     second user, which only holds *because* the argument was there.
 *
 * And every negative test has a positive control in the same describe block, so
 * a rename, a moved export or a mis-wired mock cannot make this file vacuously
 * green.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks: only the edges, never the code under test ────────────────────────
//
// backend/api/controllers/invites.ts, backend/services/invites.ts,
// backend/services/capabilities.ts and backend/api/routes/auth.ts are all under
// test here and none of them is mocked. Only the four things that would reach
// outside the process are: the database, the audit sink, the session store and
// JWT signing.

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  invite: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  user: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

/**
 * The transaction client is a SEPARATE set of spies from `mockDb`, so the
 * consuming compare-and-set inside `accept`'s transaction can be inspected
 * without it being confused with the minting write `lookup` performs on the
 * same table.
 */
const mockTx = vi.hoisted(() => ({
  invite: { updateMany: vi.fn(), update: vi.fn() },
  user: { create: vi.fn() },
}));

const auditLog = vi.hoisted(() => vi.fn());
const createAuthSession = vi.hoisted(() => vi.fn());

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));

vi.mock('../../../backend/services/audit', () => ({
  auditLog,
  auditSensitiveApiRequest: vi.fn(),
  listAuditEvents: vi.fn(async () => ({ data: [], meta: { total: 0, page: 1, per_page: 50 } })),
}));

vi.mock('../../../backend/services/sessions', () => ({
  createAuthSession,
  validateAuthSession: vi.fn(async () => true),
  revokeAuthSession: vi.fn(),
  revokeAllUserSessions: vi.fn(),
  listActiveUserSessions: vi.fn(async () => []),
}));

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { InviteController } from '../../../backend/api/controllers/invites';
import authRoutes from '../../../backend/api/routes/auth';
import {
  ACCEPT_TTL_MS,
  CLAIM_TTL_MS,
  INVITE_TTL_MS,
  hashSecret,
} from '../../../backend/services/invites';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const OWNER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN_A = 'aaaaaaaa-0000-4000-8000-000000000002';
const OWNER_B = 'bbbbbbbb-0000-4000-8000-000000000003';
const INVITE_A = 'cccccccc-0000-4000-8000-00000000000a';
const INVITE_B = 'cccccccc-0000-4000-8000-00000000000b';

/** The four secrets, each a plausible shape for its own journey. */
const LINK_TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaQ'; // 32 bytes, the URL fragment
const HANDOFF = 'aGFuZG9mZi10b2tlbi0xMjM'; // 16 bytes, RuStore query string + iOS clipboard
const CLAIM_CODE = 'K7F3QP'; // six characters, retyped by a human
const ACCEPT_TOKEN = 'YWNjZXB0LXRva2VuLTAwMDE'; // 16 bytes, minted by lookup only

/** The single response every failed redemption must produce, byte for byte. */
const UNAVAILABLE_BODY = {
  error: {
    code: 'INVITE_UNAVAILABLE',
    message: 'Приглашение недействительно или уже использовано',
  },
};

const in_ = (ms: number) => new Date(Date.now() + ms);
const ago = (ms: number) => new Date(Date.now() - ms);

// ─── The row store ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Select = Record<string, unknown>;

let invites: Row[] = [];
let users: Row[] = [];
let nextUserId = 0;

/**
 * A faithful-enough Prisma WHERE: scalar equality, `null`, `{ gt }`, `{ lte }`,
 * `{ not }` and `OR`. Deliberately nothing more — every filter the controller
 * relies on for security has to be a filter it actually SENDS, because this
 * matcher has no idea what any of the columns mean.
 */
function matchesWhere(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Where[]).some((branch) => matchesWhere(row, branch));
    }
    const value = row[key];
    if (condition === null) return value === null;
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    if (typeof condition === 'object') {
      const c = condition as { gt?: Date; lte?: Date; not?: unknown };
      if (c.gt !== undefined && !(value instanceof Date && value > c.gt)) return false;
      if (c.lte !== undefined && !(value instanceof Date && value <= c.lte)) return false;
      if ('not' in c && value === c.not) return false;
      return true;
    }
    return value === condition;
  });
}

/**
 * Prisma's `select`, honoured rather than ignored, so a response can be asserted
 * to carry no hash column — the projection is part of what the controller
 * promises.
 */
function project(row: Row, select?: Select): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) {
      out[key] = row[key];
    } else if (value && typeof value === 'object') {
      const nested = row[key] as Row | null | undefined;
      out[key] = nested ? project(nested, (value as { select: Select }).select) : nested;
    }
  }
  return out;
}

function seedInvite(overrides: Row = {}): Row {
  const row: Row = {
    id: INVITE_A,
    organization_id: ORG_A,
    name: 'Пётр Смирнов',
    role: 'member',
    created_by: OWNER_A,
    token_hash: hashSecret(LINK_TOKEN),
    handoff_hash: hashSecret(HANDOFF),
    claim_hash: hashSecret(CLAIM_CODE),
    claim_expires_at: in_(CLAIM_TTL_MS),
    accept_hash: null,
    accept_expires_at: null,
    expires_at: in_(INVITE_TTL_MS),
    consumed_at: null,
    revoked_at: null,
    opened_at: null,
    user_id: null,
    created_at: new Date(),
    organization: { name: 'ООО «Ромашка»' },
    ...overrides,
  };
  invites.push(row);
  return row;
}

/** An invite that has already been through `lookup`: accept token live, handoff burned. */
function seedLookedUpInvite(overrides: Row = {}): Row {
  return seedInvite({
    handoff_hash: null,
    accept_hash: hashSecret(ACCEPT_TOKEN),
    accept_expires_at: in_(ACCEPT_TTL_MS),
    opened_at: new Date(),
    ...overrides,
  });
}

function wireDb() {
  mockDb.invite.create.mockImplementation(async ({ data, select }: { data: Row; select?: Select }) => {
    const row: Row = {
      id: INVITE_A,
      handoff_hash: null,
      claim_hash: null,
      claim_expires_at: null,
      accept_hash: null,
      accept_expires_at: null,
      consumed_at: null,
      revoked_at: null,
      opened_at: null,
      user_id: null,
      created_at: new Date(),
      organization: { name: 'ООО «Ромашка»' },
      ...data,
    };
    invites.push(row);
    return project(row, select);
  });

  mockDb.invite.findUnique.mockImplementation(async ({ where, select }: { where: Where; select?: Select }) => {
    const row = invites.find((r) => matchesWhere(r, where));
    return row ? project(row, select) : null;
  });

  mockDb.invite.findFirst.mockImplementation(async ({ where, select }: { where: Where; select?: Select }) => {
    const row = invites.find((r) => matchesWhere(r, where));
    return row ? project(row, select) : null;
  });

  mockDb.invite.findMany.mockImplementation(
    async ({ where, select, orderBy }: { where: Where; select?: Select; orderBy?: Row }) => {
      const rows = invites.filter((r) => matchesWhere(r, where));
      if (orderBy && orderBy.created_at === 'desc') {
        rows.sort((a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime());
      }
      return rows.map((r) => project(r, select));
    },
  );

  mockDb.invite.update.mockImplementation(async ({ where, data, select }: { where: Where; data: Row; select?: Select }) => {
    const row = invites.find((r) => matchesWhere(r, where));
    if (!row) throw new Error('P2025: record to update not found');
    Object.assign(row, data);
    return project(row, select);
  });

  // No compare-and-set logic of its own: it applies `data` to whatever the
  // caller's WHERE selects and reports how many rows that was. Single use is
  // whatever the controller puts in that WHERE.
  mockDb.invite.updateMany.mockImplementation(async ({ where, data }: { where: Where; data: Row }) => {
    const hits = invites.filter((r) => matchesWhere(r, where));
    for (const row of hits) Object.assign(row, data);
    return { count: hits.length };
  });

  mockDb.user.findUnique.mockImplementation(async ({ where, select }: { where: Where; select?: Select }) => {
    const row = users.find((r) => matchesWhere(r, where));
    return row ? project(row, select) : null;
  });

  mockDb.user.findFirst.mockImplementation(async ({ where, select }: { where: Where; select?: Select }) => {
    const row = users.find((r) => matchesWhere(r, where));
    return row ? project(row, select) : null;
  });

  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx));

  mockTx.invite.updateMany.mockImplementation(mockDb.invite.updateMany.getMockImplementation()!);
  mockTx.invite.update.mockImplementation(mockDb.invite.update.getMockImplementation()!);
  mockTx.user.create.mockImplementation(async ({ data, select }: { data: Row; select?: Select }) => {
    nextUserId += 1;
    const row: Row = { id: `user-${nextUserId}`, ...data };
    users.push(row);
    return project(row, select);
  });

  createAuthSession.mockResolvedValue('session-id');
}

beforeEach(() => {
  vi.resetAllMocks();
  invites = [];
  users = [];
  nextUserId = 0;
  wireDb();
});

// ─── Request / reply doubles ─────────────────────────────────────────────────

type TestReply = {
  statusCode: number | undefined;
  payload: unknown;
  code: (statusCode: number) => TestReply;
  status: (statusCode: number) => TestReply;
  send: (payload: unknown) => TestReply;
  jwtSign: (payload: unknown, options?: unknown) => Promise<string>;
};

function makeReply(): TestReply {
  const reply: TestReply = {
    statusCode: undefined,
    payload: undefined,
    code(statusCode: number) {
      reply.statusCode = statusCode;
      return reply;
    },
    status(statusCode: number) {
      reply.statusCode = statusCode;
      return reply;
    },
    send(payload: unknown) {
      reply.payload = payload;
      return reply;
    },
    jwtSign: async () => 'signed.jwt.token',
  };
  return reply;
}

function authed(user: { sub: string; org_id: string; role: string }, extra: Row = {}) {
  return {
    user,
    ip: '203.0.113.9',
    method: 'POST',
    url: '/api/auth/invites',
    headers: {},
    ...extra,
  } as never;
}

function anonymous(body: Row) {
  return {
    body,
    ip: '198.51.100.4',
    method: 'POST',
    url: '/api/auth/invites/lookup',
    headers: {},
  } as never;
}

function errorCode(reply: TestReply): string | undefined {
  return (reply.payload as { error?: { code: string } } | undefined)?.error?.code;
}

function data(reply: TestReply): Record<string, unknown> {
  return (reply.payload as { data: Record<string, unknown> }).data;
}

/** The arguments of a spied Prisma call, for asserting on what was SENT. */
function argsOf(spy: { mock: { calls: unknown[][] } }, index = 0): { where: Where; data: Row } {
  return spy.mock.calls[index]?.[0] as { where: Where; data: Row };
}

// ─── Handler wrappers ────────────────────────────────────────────────────────

async function callAccept(body: Row): Promise<TestReply> {
  const reply = makeReply();
  await InviteController.accept(anonymous(body), reply as never);
  return reply;
}

async function callLookup(body: Row): Promise<TestReply> {
  const reply = makeReply();
  await InviteController.lookup(anonymous(body), reply as never);
  return reply;
}

async function callOpen(body: Row): Promise<TestReply> {
  const reply = makeReply();
  await InviteController.open(anonymous(body), reply as never);
  return reply;
}

async function callCreate(
  user: { sub: string; org_id: string; role: string },
  body: Row,
): Promise<TestReply> {
  const reply = makeReply();
  await InviteController.create(authed(user, { body }), reply as never);
  return reply;
}

async function callList(user: { sub: string; org_id: string; role: string }): Promise<TestReply> {
  const reply = makeReply();
  await InviteController.list(authed(user, { method: 'GET' }), reply as never);
  return reply;
}

async function callRevoke(
  user: { sub: string; org_id: string; role: string },
  id: string,
): Promise<TestReply> {
  const reply = makeReply();
  await InviteController.revoke(authed(user, { method: 'DELETE', params: { id } }), reply as never);
  return reply;
}

/** A complete, valid accept body; individual tests vary one field at a time. */
const ACCEPT_BODY: Row = {
  accept_token: ACCEPT_TOKEN,
  phone: '+79161234567',
  email: 'Petr@Example.RU',
  password: 'Sekretnyj1!',
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. `accept` spends the accept token, never the handoff
//    MUTATION: `accept` resolving against handoff_hash instead of accept_hash.
// ═════════════════════════════════════════════════════════════════════════════

describe('accept resolves the token against accept_hash, never handoff_hash', () => {
  /**
   * The row here holds BOTH secrets at once — a state the real flow never
   * reaches, because `lookup` nulls the handoff in the same write that mints the
   * accept token. It is constructed deliberately: it is the only arrangement in
   * which "which column did you look in?" has an observable answer. If `accept`
   * ever reads the handoff column again, the string that travelled through
   * RuStore's query string and the iOS clipboard becomes a complete
   * account-creation credential — the exact regression the controller's comment
   * says it fixed.
   */
  function seedBothSecrets() {
    return seedInvite({
      handoff_hash: hashSecret(HANDOFF),
      accept_hash: hashSecret(ACCEPT_TOKEN),
      accept_expires_at: in_(ACCEPT_TTL_MS),
    });
  }

  it('refuses a handoff token presented at accept', async () => {
    seedBothSecrets();

    const reply = await callAccept({ ...ACCEPT_BODY, accept_token: HANDOFF });

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
    // Nothing was created and nothing was consumed: the refusal happened before
    // any write, not after one.
    expect(mockTx.user.create).not.toHaveBeenCalled();
    expect(mockTx.invite.updateMany).not.toHaveBeenCalled();
    expect(users).toHaveLength(0);
  });

  it('refuses the link token and the claim code at accept as well', async () => {
    // Same argument as the handoff: neither has been through the one step that
    // proves possession of an installed app, so neither may create a user.
    for (const secret of [LINK_TOKEN, CLAIM_CODE]) {
      invites = [];
      users = [];
      seedBothSecrets();

      const reply = await callAccept({ ...ACCEPT_BODY, accept_token: secret });

      expect(reply.statusCode).toBe(404);
      expect(users).toHaveLength(0);
    }
  });

  it('queries exactly one column, and that column is accept_hash', async () => {
    seedBothSecrets();

    await callAccept(ACCEPT_BODY);

    const { where } = argsOf(mockDb.invite.findUnique);
    expect(Object.keys(where)).toEqual(['accept_hash']);
    expect(where.accept_hash).toBe(hashSecret(ACCEPT_TOKEN));
    // The plaintext never reaches the query, and neither does any other column.
    expect(where).not.toHaveProperty('handoff_hash');
    expect(where).not.toHaveProperty('token_hash');
    expect(where).not.toHaveProperty('claim_hash');
    expect(JSON.stringify(where)).not.toContain(ACCEPT_TOKEN);
  });

  // Positive control: the accept token itself still works. Without this, the
  // three refusals above would still pass if `accept` refused everything.
  it('accepts the token minted by lookup and creates the account', async () => {
    seedBothSecrets();

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(users).toHaveLength(1);
    expect(data(reply).token).toBe('signed.jwt.token');
    expect((data(reply).user as Row).email).toBe('petr@example.ru');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. One invite, one account
//    MUTATION: dropping consumed_at / revoked_at / expires_at from the
//    consuming updateMany in `accept`.
// ═════════════════════════════════════════════════════════════════════════════

describe('the consuming write is a compare-and-set, so one invite makes one account', () => {
  /**
   * THIS IS THE LOAD-BEARING TEST OF THE BLOCK, and deliberately an assertion
   * about ARGUMENTS rather than about an outcome.
   *
   * Three of these five guards cannot be observed through behaviour at all with
   * the code as it stands: the winner's `data` also nulls `accept_expires_at`,
   * so in a double-redemption the accept-token guard alone already turns the
   * loser away, and dropping `consumed_at` / `revoked_at` / `expires_at` changes
   * nothing anyone can see. They are defence in depth — the moment a future
   * change stops nulling the accept token on consume, `consumed_at: null` is the
   * only thing between two devices and two accounts. A property that is real but
   * currently unobservable is exactly what an argument assertion is for; a test
   * that waited for it to become observable would be a test that never ran.
   */
  it('guards the consuming updateMany on every field that could have changed', async () => {
    const row = seedLookedUpInvite();

    await callAccept(ACCEPT_BODY);

    const { where } = argsOf(mockTx.invite.updateMany);

    // The exact set is asserted, not just its members: a field silently dropped
    // from this WHERE is precisely the mutation that survived the old suite.
    expect(Object.keys(where).sort()).toEqual([
      'accept_expires_at',
      'consumed_at',
      'expires_at',
      'id',
      'revoked_at',
    ]);
    expect(where.id).toBe(row.id);
    expect(where.consumed_at).toBeNull(); // not already redeemed
    expect(where.revoked_at).toBeNull(); // not revoked while the form was open
    expect((where.expires_at as { gt: Date }).gt).toBeInstanceOf(Date);
    // Both expiries are re-checked HERE and not only before the transaction:
    // bcrypt.hash sits in between, and an invite that lapses inside that window
    // would otherwise still create an account.
    expect((where.accept_expires_at as { gt: Date }).gt).toBeInstanceOf(Date);
  });

  it('burns every credential the invite still holds in the same statement', async () => {
    seedLookedUpInvite();

    await callAccept(ACCEPT_BODY);

    // The claim code's job was to survive as far as a successful accept — see
    // the lookup block below for why it outlives the handoff — and it ends here.
    const { data: written } = argsOf(mockTx.invite.updateMany);
    expect(Object.keys(written).sort()).toEqual([
      'accept_expires_at',
      'accept_hash',
      'claim_expires_at',
      'claim_hash',
      'consumed_at',
    ]);
    expect(written.consumed_at).toBeInstanceOf(Date);
    expect(written.accept_hash).toBeNull();
    expect(written.accept_expires_at).toBeNull();
    expect(written.claim_hash).toBeNull();
    expect(written.claim_expires_at).toBeNull();
  });

  it('creates no second account when two devices redeem the same token', async () => {
    const row = seedLookedUpInvite();
    // Both devices read the invite before either of them consumed it. That is
    // the only interleaving in which the CAS is load-bearing, so it is the one
    // reproduced here: the second lookup is served the pre-race snapshot while
    // the store already holds the consumed row.
    const staleRead = { ...row };

    const first = await callAccept({ ...ACCEPT_BODY, email: 'invitee@example.ru' });
    mockDb.invite.findUnique.mockResolvedValueOnce(staleRead);
    // A different address, so the EMAIL_TAKEN check cannot be what stops it —
    // this is a forwarded link redeemed by a second person, not a double submit.
    const second = await callAccept({ ...ACCEPT_BODY, email: 'stranger@example.ru' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(404);
    expect(second.payload).toEqual(UNAVAILABLE_BODY);
    expect(mockTx.user.create).toHaveBeenCalledTimes(1);
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('invitee@example.ru');
  });

  it('creates the user only after the compare-and-set has won', async () => {
    seedLookedUpInvite();
    // count 0 is the losing branch; it must abort before the user row exists,
    // not roll one back afterwards.
    mockTx.invite.updateMany.mockResolvedValueOnce({ count: 0 });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
    expect(mockTx.user.create).not.toHaveBeenCalled();
  });

  it('consumes with updateMany, never with update', async () => {
    seedLookedUpInvite();

    await callAccept(ACCEPT_BODY);

    // `update` addresses a row by unique id and cannot carry the guard at all,
    // so the consuming write has to be `updateMany`. The one `update` in this
    // path is the back-reference written after the winner is known.
    expect(mockTx.invite.updateMany).toHaveBeenCalledTimes(1);
    expect(mockTx.invite.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(argsOf(mockTx.invite.update).data)).toEqual(['user_id']);
  });

  it('refuses an invite that was revoked while the form was open', async () => {
    seedLookedUpInvite({ revoked_at: ago(1000) });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(404);
    expect(users).toHaveLength(0);
  });

  it('refuses an invite whose 24-hour life ran out while the form was open', async () => {
    seedLookedUpInvite({ expires_at: ago(1000) });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(404);
    expect(users).toHaveLength(0);
  });

  // Positive control: a clean redemption still succeeds, so the four refusals
  // above are refusals and not a broken handler.
  it('lets the first redemption through and marks the invite consumed', async () => {
    const row = seedLookedUpInvite();

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(row.consumed_at).toBeInstanceOf(Date);
    expect(row.accept_hash).toBeNull();
    expect(row.claim_hash).toBeNull();
    expect(row.user_id).toBe(users[0].id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. An admin cannot mint an owner
//    MUTATION: neutering the assignableRoles gate in `create`.
// ═════════════════════════════════════════════════════════════════════════════

describe('create cannot hand out a role the caller does not hold the power to assign', () => {
  const owner = { sub: OWNER_A, org_id: ORG_A, role: 'owner' };
  const admin = { sub: ADMIN_A, org_id: ORG_A, role: 'admin' };

  it('refuses an admin minting an owner invite', async () => {
    const reply = await callCreate(admin, { name: 'Новый владелец', role: 'owner' });

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_ROLE');
    // No row, so no link, so nothing to leak later.
    expect(mockDb.invite.create).not.toHaveBeenCalled();
    expect(invites).toHaveLength(0);
  });

  it('refuses an owner minting an owner invite too', async () => {
    // `owner` is established when the organisation is created and transferred,
    // never handed out — assignableRoles() omits it for every caller, including
    // the owner. A gate that only compared against the CALLER's role would let
    // this through.
    const reply = await callCreate(owner, { name: 'Второй владелец', role: 'owner' });

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_ROLE');
    expect(mockDb.invite.create).not.toHaveBeenCalled();
  });

  it('refuses an admin minting an admin invite', async () => {
    // "Admins cannot mint admins" is team.manage_admins, which only owner holds.
    const reply = await callCreate(admin, { name: 'Ещё админ', role: 'admin' });

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_ROLE');
    expect(mockDb.invite.create).not.toHaveBeenCalled();
  });

  it('refuses strings that are not roles at all', async () => {
    for (const role of ['superuser', '', 'OWNER', 'toString', 'constructor']) {
      const reply = await callCreate(owner, { name: 'Кто-то', role });
      expect(reply.statusCode).toBe(400);
      expect(errorCode(reply)).toBe('INVALID_ROLE');
    }
    expect(mockDb.invite.create).not.toHaveBeenCalled();
  });

  it('refuses a caller whose own role is unknown to the capability map', async () => {
    // A role string this build predates resolves to no capabilities, so the
    // caller can still assign the non-admin roles but never an admin.
    const reply = await callCreate(
      { sub: ADMIN_A, org_id: ORG_A, role: 'former_superadmin' },
      { name: 'Кто-то', role: 'admin' },
    );

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_ROLE');
  });

  // Positive controls: the gate is a filter, not a wall.
  it('lets an owner mint an admin invite', async () => {
    const reply = await callCreate(owner, { name: 'Админ', role: 'admin' });

    expect(reply.statusCode).toBe(201);
    expect(argsOf(mockDb.invite.create).data.role).toBe('admin');
  });

  it('lets an admin mint every non-admin role', async () => {
    for (const role of ['head', 'member', 'accountant', 'marketer', 'support', 'viewer']) {
      const reply = await callCreate(admin, { name: `Сотрудник ${role}`, role });
      expect(reply.statusCode).toBe(201);
    }
    expect(mockDb.invite.create).toHaveBeenCalledTimes(6);
  });

  it('rejects a blank name after the role gate, without writing a row', async () => {
    const reply = await callCreate(admin, { name: '   ', role: 'member' });

    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_NAME');
    expect(mockDb.invite.create).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. `revoke` is org-scoped
//    MUTATION: dropping organization_id from the WHERE in `revoke`.
// ═════════════════════════════════════════════════════════════════════════════

describe('revoke cannot reach across the tenant boundary', () => {
  const ownerA = { sub: OWNER_A, org_id: ORG_A, role: 'owner' };
  const ownerB = { sub: OWNER_B, org_id: ORG_B, role: 'owner' };

  it("leaves another organisation's invite untouched and reports not found", async () => {
    const victim = seedInvite({ id: INVITE_A, organization_id: ORG_A });

    const reply = await callRevoke(ownerB, INVITE_A);

    expect(reply.statusCode).toBe(404);
    expect(errorCode(reply)).toBe('NOT_FOUND');
    // The load-bearing assertion: org A's invite is still live.
    expect(victim.revoked_at).toBeNull();
    // A cross-tenant write that failed silently would still have audited a
    // success; nothing succeeded, so nothing is recorded as success.
    expect(auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invite.revoke', outcome: 'success' }),
    );
  });

  it('sends organization_id in the WHERE, not only the id', async () => {
    seedInvite({ id: INVITE_A, organization_id: ORG_A });

    await callRevoke(ownerB, INVITE_A);

    const { where } = argsOf(mockDb.invite.updateMany);
    expect(where.id).toBe(INVITE_A);
    expect(where.organization_id).toBe(ORG_B); // the CALLER's org, from the token
    // Already-consumed invites are not re-revoked: revocation would otherwise
    // rewrite the history of an account that already exists.
    expect(where.consumed_at).toBeNull();
    expect(Object.keys(where).sort()).toEqual(['consumed_at', 'id', 'organization_id']);
  });

  it('uses updateMany, never update: update() cannot carry the org filter', async () => {
    seedInvite({ id: INVITE_A, organization_id: ORG_A });

    await callRevoke(ownerB, INVITE_A);

    expect(mockDb.invite.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.invite.update).not.toHaveBeenCalled();
    expect(mockDb.invite.delete).not.toHaveBeenCalled();
  });

  // Positive control: revocation inside the tenant still works, so the refusal
  // above is about tenancy and not about a broken handler.
  it('revokes an invite belonging to the caller organisation', async () => {
    const own = seedInvite({ id: INVITE_A, organization_id: ORG_A });

    const reply = await callRevoke(ownerA, INVITE_A);

    expect(reply.statusCode).toBeUndefined(); // plain 200
    expect(data(reply)).toEqual({ revoked: true });
    expect(own.revoked_at).toBeInstanceOf(Date);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invite.revoke', outcome: 'success' }),
    );
  });

  it('reports not found for an already-consumed invite in the caller own org', async () => {
    const consumed = seedInvite({ id: INVITE_A, organization_id: ORG_A, consumed_at: ago(1000) });

    const reply = await callRevoke(ownerA, INVITE_A);

    expect(reply.statusCode).toBe(404);
    expect(consumed.revoked_at).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. `list` is org-scoped
//    MUTATION: dropping organization_id from `list`.
// ═════════════════════════════════════════════════════════════════════════════

describe('list shows only the caller own organisation pending invites', () => {
  const ownerA = { sub: OWNER_A, org_id: ORG_A, role: 'owner' };
  const ownerB = { sub: OWNER_B, org_id: ORG_B, role: 'owner' };

  beforeEach(() => {
    seedInvite({ id: INVITE_A, organization_id: ORG_A, name: 'Наш сотрудник', role: 'member' });
    seedInvite({
      id: INVITE_B,
      organization_id: ORG_B,
      name: 'Чужой финдиректор',
      role: 'accountant',
      created_at: ago(60_000),
    });
  });

  it("returns nothing belonging to another organisation", async () => {
    const reply = await callList(ownerA);

    const rows = (reply.payload as { data: Row[] }).data;
    expect(rows.map((r) => r.id)).toEqual([INVITE_A]);
    // The names and roles are the payload of this leak: who a rival is hiring,
    // and for what.
    expect(JSON.stringify(reply.payload)).not.toContain('Чужой финдиректор');
    expect(JSON.stringify(reply.payload)).not.toContain('accountant');
  });

  it('sends organization_id in the WHERE together with the pending filters', async () => {
    await callList(ownerA);

    const { where } = argsOf(mockDb.invite.findMany);
    expect(where.organization_id).toBe(ORG_A);
    expect(where.consumed_at).toBeNull();
    expect(where.revoked_at).toBeNull();
    expect((where.expires_at as { gt: Date }).gt).toBeInstanceOf(Date);
    expect(Object.keys(where).sort()).toEqual([
      'consumed_at',
      'expires_at',
      'organization_id',
      'revoked_at',
    ]);
  });

  it('never projects a hash column into the response', async () => {
    const reply = await callList(ownerA);

    const [row] = (reply.payload as { data: Row[] }).data;
    expect(Object.keys(row).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'name',
      'opened_at',
      'role',
    ]);
    expect(JSON.stringify(reply.payload)).not.toContain(hashSecret(LINK_TOKEN));
  });

  it('hides invites that are no longer pending', async () => {
    seedInvite({ id: 'consumed', organization_id: ORG_A, consumed_at: ago(1000) });
    seedInvite({ id: 'revoked', organization_id: ORG_A, revoked_at: ago(1000) });
    seedInvite({ id: 'expired', organization_id: ORG_A, expires_at: ago(1000) });

    const reply = await callList(ownerA);

    expect((reply.payload as { data: Row[] }).data.map((r) => r.id)).toEqual([INVITE_A]);
  });

  // Positive control: the org filter is a filter, not an empty result. Org B
  // sees exactly its own row, which also proves the seed above is reachable.
  it('shows org B its own invite', async () => {
    const reply = await callList(ownerB);

    const rows = (reply.payload as { data: Row[] }).data;
    expect(rows.map((r) => r.id)).toEqual([INVITE_B]);
    expect(rows[0].name).toBe('Чужой финдиректор');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The accept token expires
//    MUTATION: skipping the accept_expires_at check in `accept`.
// ═════════════════════════════════════════════════════════════════════════════

describe('an accept token stops working when it expires', () => {
  it('refuses a lapsed accept token before touching a password or a transaction', async () => {
    seedLookedUpInvite({ accept_expires_at: ago(60_000) });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
    // The pre-flight check exists so an expired token costs nothing: no email
    // probe, no bcrypt, no transaction. Asserting that it stopped HERE is what
    // distinguishes the pre-flight check from the guard inside the CAS, which
    // would also produce a 404.
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invite.accept',
        outcome: 'denied',
        metadata: expect.objectContaining({ reason: 'accept_token_expired' }),
      }),
    );
  });

  it('refuses an invite that never minted an accept token', async () => {
    // accept_hash somehow set with no expiry recorded: the `!accept_expires_at`
    // half of the check. A null expiry must read as "expired", never as "no
    // deadline".
    seedInvite({ accept_hash: hashSecret(ACCEPT_TOKEN), accept_expires_at: null });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(404);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(users).toHaveLength(0);
  });

  it('refuses a token that expires on the boundary', async () => {
    seedLookedUpInvite({ accept_expires_at: new Date(Date.now() - 1) });

    expect((await callAccept(ACCEPT_BODY)).statusCode).toBe(404);
    expect(users).toHaveLength(0);
  });

  // Positive control: a live token inside the window still redeems.
  it('accepts a token still inside its window', async () => {
    seedLookedUpInvite({ accept_expires_at: in_(60_000) });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(users).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The handoff dies at first use; the claim code does not
//    MUTATION: not nulling handoff_hash in `lookup`.
// ═════════════════════════════════════════════════════════════════════════════

describe('lookup burns the handoff and keeps the claim code alive', () => {
  it('nulls handoff_hash in the minting write and leaves the claim code alone', async () => {
    seedInvite();

    await callLookup({ handoff: HANDOFF });

    const { data: written } = argsOf(mockDb.invite.updateMany);
    // The exact key set, because both halves matter and in opposite directions:
    // handoff_hash MUST be here (it has been through RuStore's logs and the iOS
    // clipboard), claim_hash MUST NOT (it has only ever been on the invitee's own
    // screen, and it is what makes a killed app recoverable).
    expect(Object.keys(written).sort()).toEqual([
      'accept_expires_at',
      'accept_hash',
      'handoff_hash',
    ]);
    expect(written.handoff_hash).toBeNull();
    expect(written.accept_hash).toEqual(expect.any(String));
    expect(written.accept_expires_at).toBeInstanceOf(Date);
    expect(written).not.toHaveProperty('claim_hash');
    expect(written).not.toHaveProperty('claim_expires_at');
  });

  it('leaves the stored claim code intact after a lookup', async () => {
    const row = seedInvite();

    await callLookup({ handoff: HANDOFF });

    expect(row.handoff_hash).toBeNull();
    expect(row.claim_hash).toBe(hashSecret(CLAIM_CODE));
    expect(row.claim_expires_at).toBeInstanceOf(Date);
  });

  it('refuses the same handoff a second time', async () => {
    seedInvite();

    const first = await callLookup({ handoff: HANDOFF });
    const second = await callLookup({ handoff: HANDOFF });

    expect(first.statusCode).toBeUndefined(); // plain 200
    // 404, not 409: the credential no longer resolves to a row at all. A 409
    // here would mean the handoff had survived and was merely losing a race.
    expect(second.statusCode).toBe(404);
    expect(second.payload).toEqual(UNAVAILABLE_BODY);
  });

  /**
   * The contrast that makes the pair meaningful. The SAME second attempt, made
   * with the claim code instead of the handoff, still finds the row — it is
   * declined only because an accept token is already live on the first device,
   * which is a different answer with a different status and a different message.
   * Dead credential: 404. Live credential, busy invite: 409.
   */
  it('still resolves the claim code after the handoff has been burned', async () => {
    seedInvite();

    await callLookup({ handoff: HANDOFF });
    const viaClaim = await callLookup({ claim_code: CLAIM_CODE });

    expect(viaClaim.statusCode).toBe(409);
    expect(errorCode(viaClaim)).toBe('INVITE_IN_PROGRESS');
  });

  it('normalises a retyped claim code so spacing and case do not burn an attempt', async () => {
    seedInvite();

    const reply = await callLookup({ claim_code: ' k7f3-qp ' });

    expect(reply.statusCode).toBeUndefined();
    expect(data(reply).accept_token).toEqual(expect.any(String));
  });

  it('mints only when no accept token is currently live', async () => {
    seedInvite();

    await callLookup({ handoff: HANDOFF });

    const { where } = argsOf(mockDb.invite.updateMany);
    expect(where.consumed_at).toBeNull();
    expect(where.revoked_at).toBeNull();
    // The race guard: a second lookup inside the window is a no-op rather than a
    // rotation, so the loser cannot invalidate the token the winner already
    // handed to the form.
    expect(where.OR).toEqual([
      { accept_hash: null },
      { accept_expires_at: { lte: expect.any(Date) } },
    ]);
  });

  it('hands back no accept token when the conditional mint loses', async () => {
    seedInvite({ accept_hash: hashSecret('someone-elses'), accept_expires_at: in_(ACCEPT_TTL_MS) });

    const reply = await callLookup({ token: LINK_TOKEN });

    expect(reply.statusCode).toBe(409);
    expect(errorCode(reply)).toBe('INVITE_IN_PROGRESS');
    expect(JSON.stringify(reply.payload)).not.toContain('accept_token');
  });

  // Positive control: a first lookup returns a token, and that token is new —
  // not one of the secrets the caller already presented.
  it('returns a freshly minted accept token on the first lookup', async () => {
    const row = seedInvite();

    const reply = await callLookup({ handoff: HANDOFF });

    const token = data(reply).accept_token as string;
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(10);
    expect([HANDOFF, LINK_TOKEN, CLAIM_CODE]).not.toContain(token);
    expect(row.accept_hash).toBe(hashSecret(token));
    // The response carries the display data and nothing redeemable beyond it.
    expect(Object.keys(data(reply)).sort()).toEqual(['accept_token', 'name', 'org_name', 'role']);
  });

  it('accepts a token minted through the claim-code path just as well', async () => {
    seedInvite();

    const lookup = await callLookup({ claim_code: CLAIM_CODE });
    const accepted = await callAccept({
      ...ACCEPT_BODY,
      accept_token: data(lookup).accept_token as string,
    });

    expect(accepted.statusCode).toBe(201);
    expect(users).toHaveLength(1);
  });

  it('refuses a claim code whose 15 minutes have run out', async () => {
    seedInvite({ claim_expires_at: ago(1000) });

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBe(404);
    expect(mockDb.invite.updateMany).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. One answer for every failure
//    MUTATION: adding any distinguishing field to inviteUnavailable.
// ═════════════════════════════════════════════════════════════════════════════

describe('a failed redemption never says which kind of failure it was', () => {
  /**
   * Every way an invite can fail, at every endpoint that can fail that way. A
   * caller who can tell "expired" from "already used" from "never existed" has an
   * oracle: they can probe for real tokens without ever redeeming one. The reason
   * belongs in the audit log, where the owner can see it and an attacker cannot.
   */
  async function everyFailure(): Promise<TestReply[]> {
    const replies: TestReply[] = [];

    const cases: Array<[string, () => Promise<TestReply>]> = [
      ['accept: never existed', async () => callAccept({ ...ACCEPT_BODY, accept_token: 'nope-nope-nope' })],
      ['accept: accept token expired', async () => {
        seedLookedUpInvite({ accept_expires_at: ago(1000) });
        return callAccept(ACCEPT_BODY);
      }],
      ['accept: invite expired', async () => {
        seedLookedUpInvite({ expires_at: ago(1000) });
        return callAccept(ACCEPT_BODY);
      }],
      ['accept: already used', async () => {
        seedLookedUpInvite({ consumed_at: ago(1000) });
        return callAccept(ACCEPT_BODY);
      }],
      ['accept: revoked', async () => {
        seedLookedUpInvite({ revoked_at: ago(1000) });
        return callAccept(ACCEPT_BODY);
      }],
      ['accept: lost the compare-and-set', async () => {
        seedLookedUpInvite();
        mockTx.invite.updateMany.mockResolvedValueOnce({ count: 0 });
        return callAccept(ACCEPT_BODY);
      }],
      ['lookup: never existed', async () => callLookup({ handoff: 'no-such-handoff' })],
      ['lookup: revoked', async () => {
        seedInvite({ revoked_at: ago(1000) });
        return callLookup({ handoff: HANDOFF });
      }],
      ['lookup: already used', async () => {
        seedInvite({ consumed_at: ago(1000) });
        return callLookup({ token: LINK_TOKEN });
      }],
      ['lookup: expired', async () => {
        seedInvite({ expires_at: ago(1000) });
        return callLookup({ token: LINK_TOKEN });
      }],
      ['open: never existed', async () => callOpen({ token: 'no-such-link-token' })],
      ['open: revoked', async () => {
        seedInvite({ revoked_at: ago(1000) });
        return callOpen({ token: LINK_TOKEN });
      }],
      ['open: expired', async () => {
        seedInvite({ expires_at: ago(1000) });
        return callOpen({ token: LINK_TOKEN });
      }],
    ];

    for (const [, run] of cases) {
      invites = [];
      users = [];
      replies.push(await run());
    }
    return replies;
  }

  it('answers every failure with the same status and the same body', async () => {
    const replies = await everyFailure();

    for (const reply of replies) {
      expect(reply.statusCode).toBe(404);
      // Compared against a LITERAL, not merely against each other: a new field
      // added to inviteUnavailable would appear in all thirteen and mutual
      // equality would still hold.
      expect(reply.payload).toEqual(UNAVAILABLE_BODY);
      const body = reply.payload as { error: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    }
  });

  it('leaks nothing about the invite through the failure body', async () => {
    const replies = await everyFailure();

    for (const reply of replies) {
      const serialised = JSON.stringify(reply.payload);
      for (const secret of ['Пётр', 'Ромашка', ORG_A, INVITE_A, 'member', 'expired', 'revoked', 'already_used']) {
        expect(serialised).not.toContain(secret);
      }
    }
  });

  it('records the reason in the audit log, where the owner can see it', async () => {
    // The reason is not lost — it goes to the one reader entitled to it. This is
    // the positive half of the property: indistinguishable to the caller,
    // fully distinguished to the org.
    seedLookedUpInvite({ revoked_at: ago(1000) });

    await callAccept(ACCEPT_BODY);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invite.accept',
        outcome: 'denied',
        organizationId: ORG_A,
        metadata: expect.objectContaining({ reason: 'revoked' }),
      }),
    );
  });

  // Positive control: success is loudly different from failure, so the
  // uniformity above is uniformity among failures and not everywhere.
  it('answers a successful redemption with 201 and the account', async () => {
    seedLookedUpInvite();

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(reply.payload).not.toEqual(UNAVAILABLE_BODY);
    expect(data(reply).user).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. The invite decides the role and the organisation, never the client
// ═════════════════════════════════════════════════════════════════════════════

describe('accept takes the role and the organisation from the stored invite', () => {
  /** Everything a client might try to smuggle into the account it is creating. */
  const HOSTILE_EXTRAS: Row = {
    role: 'owner',
    organization_id: ORG_B,
    is_active: true,
    is_verified: true,
    email_verified: true,
    phone_verified: true,
    must_change_password: false,
    invited_by: 'somebody-else',
    id: 'chosen-user-id',
  };

  it('ignores a role supplied in the request body', async () => {
    seedLookedUpInvite({ role: 'member' });

    const reply = await callAccept({ ...ACCEPT_BODY, ...HOSTILE_EXTRAS });

    expect(reply.statusCode).toBe(201);
    expect(argsOf(mockTx.user.create).data.role).toBe('member');
    expect(users[0].role).toBe('member');
    expect((data(reply).user as Row).role).toBe('member');
  });

  it('ignores an organization_id supplied in the request body', async () => {
    seedLookedUpInvite({ organization_id: ORG_A });

    await callAccept({ ...ACCEPT_BODY, ...HOSTILE_EXTRAS });

    const created = argsOf(mockTx.user.create).data;
    expect(created.organization_id).toBe(ORG_A);
    // Nothing the caller sent reached the row at all.
    expect(JSON.stringify(created)).not.toContain(ORG_B);
    expect(JSON.stringify(created)).not.toContain('chosen-user-id');
    expect(JSON.stringify(created)).not.toContain('somebody-else');
  });

  it('carries the invite own role faithfully for every assignable role', async () => {
    // Positive control for the two refusals above: the role is not pinned to
    // 'member', it is pinned to the INVITE.
    for (const role of ['admin', 'head', 'accountant', 'marketer', 'support', 'viewer']) {
      invites = [];
      users = [];
      seedLookedUpInvite({ role });

      const reply = await callAccept({ ...ACCEPT_BODY, role: 'owner' });

      expect(reply.statusCode).toBe(201);
      expect(users[0].role).toBe(role);
    }
  });

  it('creates an unverified account attributed to the invite author', async () => {
    seedLookedUpInvite({ created_by: OWNER_A, name: 'Пётр Смирнов' });

    await callAccept({ ...ACCEPT_BODY, ...HOSTILE_EXTRAS });

    const created = argsOf(mockTx.user.create).data;
    expect(created.invited_by).toBe(OWNER_A);
    expect(created.name).toBe('Пётр Смирнов'); // the owner named them, not the invitee
    // Neither address nor number has been proven, whatever the body claimed.
    expect(created.is_verified).toBe(false);
    expect(created.email_verified).toBe(false);
    expect(created.phone_verified).toBe(false);
    // The role came from the invite and the credentials from the invitee, so
    // there is nothing left for a first-run screen to collect.
    expect(created.must_change_password).toBe(false);
    expect(created.must_change_email).toBe(false);
    expect(created.password_hash).toEqual(expect.any(String));
    expect(created.password_hash).not.toBe(ACCEPT_BODY.password);
  });

  it('signs the session for the account it just created, at that account role', async () => {
    seedLookedUpInvite({ role: 'support', organization_id: ORG_A });

    await callAccept({ ...ACCEPT_BODY, ...HOSTILE_EXTRAS });

    expect(createAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: users[0].id, organizationId: ORG_A }),
    );
  });

  it('refuses an email already in use without consuming the invite', async () => {
    const row = seedLookedUpInvite();
    users.push({ id: 'existing', email: 'petr@example.ru' });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(409);
    expect(errorCode(reply)).toBe('EMAIL_TAKEN');
    // The invite survives: the invitee retries with another address rather than
    // losing the link.
    expect(row.consumed_at).toBeNull();
    expect(row.accept_hash).toBe(hashSecret(ACCEPT_TOKEN));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. `create` writes the caller own organisation
// ═════════════════════════════════════════════════════════════════════════════

describe('create writes the caller own organisation and hashes the token', () => {
  const admin = { sub: ADMIN_A, org_id: ORG_A, role: 'admin' };

  it('takes organization_id and created_by from the token, never from the body', async () => {
    const reply = await callCreate(admin, {
      name: 'Новый сотрудник',
      role: 'member',
      organization_id: ORG_B,
      created_by: OWNER_B,
    });

    expect(reply.statusCode).toBe(201);
    const written = argsOf(mockDb.invite.create).data;
    expect(written.organization_id).toBe(ORG_A);
    expect(written.created_by).toBe(ADMIN_A);
    expect(JSON.stringify(written)).not.toContain(ORG_B);
    expect(JSON.stringify(written)).not.toContain(OWNER_B);
  });

  it('stores only the hash and returns the plaintext exactly once, in the fragment', async () => {
    const reply = await callCreate(admin, { name: 'Новый сотрудник', role: 'member' });

    const written = argsOf(mockDb.invite.create).data;
    const url = data(reply).invite_url as string;
    const token = url.split('#')[1];

    expect(token).toBeTruthy();
    expect(written.token_hash).toBe(hashSecret(token));
    // Plaintext is never written: reading the Invite table yields nothing
    // redeemable.
    expect(JSON.stringify(written)).not.toContain(token);
    // The fragment is never transmitted to a server, which keeps the token out
    // of nginx logs, Referer headers and link-preview crawlers.
    expect(url).toContain('/i#');
    expect(url.split('#')[0]).not.toContain(token);
  });

  it('never returns a hash column to the owner', async () => {
    const reply = await callCreate(admin, { name: 'Новый сотрудник', role: 'member' });

    const { select } = mockDb.invite.create.mock.calls[0][0] as { select: Select };
    expect(Object.keys(select).sort()).toEqual(['created_at', 'expires_at', 'id', 'name', 'role']);
    expect(JSON.stringify(reply.payload)).not.toContain('token_hash');
  });

  it('gives the invite a bounded life', async () => {
    const before = Date.now();
    await callCreate(admin, { name: 'Новый сотрудник', role: 'member' });

    const expires = argsOf(mockDb.invite.create).data.expires_at as Date;
    expect(expires.getTime()).toBeGreaterThanOrEqual(before + INVITE_TTL_MS - 5_000);
    expect(expires.getTime()).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. The route schemas
//     MUTATIONS: PasswordSchema weakened to z.string(); the exactly-one-
//     credential .refine dropped from LookupInviteSchema.
// ═════════════════════════════════════════════════════════════════════════════

describe('the public invite routes reject a bad body before the controller sees it', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      return undefined;
    });
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function post(url: string, payload: Row) {
    return app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  }

  const acceptBody = (password: string) => ({
    accept_token: ACCEPT_TOKEN,
    phone: '+79161234567',
    email: 'petr@example.ru',
    password,
  });

  // ── PasswordSchema ────────────────────────────────────────────────────────
  //
  // `accept` is where the invitee chooses the password their whole account will
  // rest on, and it is an unauthenticated route. If the schema degrades to
  // z.string(), an invite becomes a way to plant a one-character password inside
  // somebody else's organisation.

  const weakPasswords: Array<[string, string]> = [
    ['too short', 'Ab1!'],
    ['no uppercase', 'sekretnyj1!'],
    ['no lowercase', 'SEKRETNYJ1!'],
    ['no digit', 'Sekretnyjj!'],
    ['no symbol', 'Sekretnyj11'],
    ['empty', ''],
    ['a single character', 'a'],
  ];

  for (const [label, password] of weakPasswords) {
    it(`refuses a password that is ${label}, and never reaches the controller`, async () => {
      const response = await post('/auth/invites/accept', acceptBody(password));

      expect(response.statusCode).toBe(400);
      // The proof that the SCHEMA stopped it: the controller's first act is to
      // look the token up, and it never happened.
      expect(mockDb.invite.findUnique).not.toHaveBeenCalled();
    });
  }

  it('refuses a password longer than the bcrypt-safe cap', async () => {
    const response = await post('/auth/invites/accept', acceptBody(`Aa1!${'x'.repeat(200)}`));

    expect(response.statusCode).toBe(400);
    expect(mockDb.invite.findUnique).not.toHaveBeenCalled();
  });

  // Positive control: a strong password passes validation and the controller
  // runs. Without this, every assertion above would still hold if the route were
  // unregistered, renamed or broken.
  it('lets a strong password through to the controller', async () => {
    const response = await post('/auth/invites/accept', acceptBody('Sekretnyj1!'));

    expect(response.statusCode).toBe(404); // unknown token — the controller's answer
    expect(JSON.parse(response.body)).toEqual(UNAVAILABLE_BODY);
    expect(mockDb.invite.findUnique).toHaveBeenCalledTimes(1);
  });

  // ── LookupInviteSchema ────────────────────────────────────────────────────

  it('refuses a lookup carrying two credentials at once', async () => {
    const response = await post('/auth/invites/lookup', { token: LINK_TOKEN, handoff: HANDOFF });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Supply exactly one of token, handoff or claim_code');
    // Without the refine the controller would silently let the first branch win
    // — a client bug that then looks like a server bug.
    expect(mockDb.invite.findUnique).not.toHaveBeenCalled();
    expect(mockDb.invite.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a lookup carrying all three credentials', async () => {
    const response = await post('/auth/invites/lookup', {
      token: LINK_TOKEN,
      handoff: HANDOFF,
      claim_code: CLAIM_CODE,
    });

    expect(response.statusCode).toBe(400);
    expect(mockDb.invite.findUnique).not.toHaveBeenCalled();
    expect(mockDb.invite.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a lookup carrying none', async () => {
    const response = await post('/auth/invites/lookup', {});

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Supply exactly one of token, handoff or claim_code');
  });

  // Positive controls: each of the three credentials, alone, reaches the handler
  // it belongs to.
  it('lets a lone link token through to the findUnique on token_hash', async () => {
    const response = await post('/auth/invites/lookup', { token: LINK_TOKEN });

    expect(response.statusCode).toBe(404);
    expect(Object.keys(argsOf(mockDb.invite.findUnique).where)).toEqual(['token_hash']);
  });

  it('lets a lone handoff through to the findUnique on handoff_hash', async () => {
    const response = await post('/auth/invites/lookup', { handoff: HANDOFF });

    expect(response.statusCode).toBe(404);
    expect(Object.keys(argsOf(mockDb.invite.findUnique).where)).toEqual(['handoff_hash']);
  });

  it('lets a lone claim code through to the guarded findFirst', async () => {
    const response = await post('/auth/invites/lookup', { claim_code: CLAIM_CODE });

    expect(response.statusCode).toBe(404);
    const { where } = argsOf(mockDb.invite.findFirst);
    expect(Object.keys(where).sort()).toEqual([
      'claim_expires_at',
      'claim_hash',
      'consumed_at',
      'revoked_at',
    ]);
  });
});
