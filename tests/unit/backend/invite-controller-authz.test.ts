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

/**
 * The OTP leg of acceptance. Mocked because both of these reach outside the
 * process — `issueCode` writes a VerificationCode row, `sendEmail` calls a mail
 * provider — and for no other reason: the decision to issue at all, and to
 * answer 201 regardless of whether delivery worked, is the code under test.
 */
const issueCode = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const isEmailSendingEnabled = vi.hoisted(() => vi.fn());

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));

/**
 * The public invite routes now carry `enforceAuthIpFloor`, which spends a
 * durable per-IP budget before the controller runs. `mockDb` has no `$queryRaw`,
 * so the store's Postgres path throws a plain TypeError — and that is NOT the
 * "relation does not exist" message the degraded-mode detector looks for, so it
 * surfaces as a 500 and every assertion below reads it instead of the status the
 * controller actually returned. Stub the two budget helpers, same as
 * auth-routes-security.test.ts, so these tests keep measuring authorization.
 */
vi.mock('../../../backend/services/rate-limit-store', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../backend/services/rate-limit-store')
  >();
  return {
    ...actual,
    consumeAuthIpBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
    consumeScopedBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
    // Route registration still reads the real class off `store:`; swap in one
    // that never reaches a database.
    PostgresRateLimitStore: class {
      incr(_key: string, cb: (e: Error | null, r: { current: number; ttl: number }) => void) {
        cb(null, { current: 1, ttl: 900_000 });
      }

      child() {
        return this;
      }
    },
  };
});

vi.mock('../../../backend/services/verification', () => ({
  issueCode,
  verifyCode: vi.fn(async () => true),
  generateOtp: vi.fn(() => '000000'),
}));

vi.mock('../../../backend/services/email', () => ({
  sendEmail,
  isEmailSendingEnabled,
  getFromEmail: vi.fn(() => 'noreply@example.ru'),
  EMAIL_SEND_TIMEOUT_MS: 20_000,
}));

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
import { assignableRoles, can } from '../../../backend/services/capabilities';
import {
  ACCEPT_TTL_MS,
  CLAIM_TTL_MS,
  INSTALL_BUDGET_MS,
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

  // The happy path for the OTP leg: a code is minted and the provider is
  // configured and accepts it. Individual tests break one of these at a time.
  issueCode.mockResolvedValue('123456');
  isEmailSendingEnabled.mockReturnValue(true);
  sendEmail.mockResolvedValue({ success: true });
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
    // The account exists and is named by its id, so the invitee can go on to
    // prove the address. It does NOT come with a token — see the block at the
    // end of this file for why that is the whole point of the change.
    expect(data(reply).user_id).toBe(users[0].id);
    expect(data(reply).email).toBe('petr@example.ru');
    expect(data(reply).needs_verification).toBe(true);
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
   * The contrast that makes the pair meaningful, and the ONE assertion in this
   * file that was deliberately inverted rather than kept.
   *
   * IT USED TO ASSERT 409, and the reasoning was: dead credential 404, live
   * credential on a busy invite 409. The first half is still exactly right and
   * the test above pins it. The second half was pinning a bug.
   *
   * Held together with the two TTLs, "the claim code always loses to a live
   * accept token" made the recovery this block's own name promises unreachable
   * in every case rather than merely awkward. The claim code died 15 minutes
   * after the landing page opened; the accept token lived 30 minutes from
   * lookup, which is later. Retype early — 409, because a token is live.
   * Retype late enough for that token to lapse — 404, because the code has been
   * dead for 15+ minutes. There was no instant at which "the invitee can now
   * simply retype the code" was true, so the comment in the controller
   * describing that recovery described nothing that could happen.
   *
   * So the assertion changed with the behaviour it was describing, not to make
   * anything pass. What replaces it is stronger, because it pins the property
   * the 409 was a proxy for: the invite never ends up with two live accept
   * tokens. The re-mint SWAPS.
   */
  it('lets the typed claim code mint again after the handoff has been burned', async () => {
    const row = seedInvite();

    const viaHandoff = await callLookup({ handoff: HANDOFF });
    const firstToken = data(viaHandoff).accept_token as string;

    // The app died here. The token above is gone with it; the six characters on
    // the invitee's other screen are all that is left.
    const viaClaim = await callLookup({ claim_code: CLAIM_CODE });

    expect(viaClaim.statusCode).toBeUndefined(); // plain 200 — recovery works
    const secondToken = data(viaClaim).accept_token as string;
    expect(secondToken).toEqual(expect.any(String));
    expect(secondToken).not.toBe(firstToken);

    // A SWAP, not a second issue: exactly one accept token is live, and it is
    // the new one. The stranded device cannot also still redeem.
    expect(row.accept_hash).toBe(hashSecret(secondToken));
    expect(row.accept_hash).not.toBe(hashSecret(firstToken));

    // And the burned handoff stays burned — recovery did not resurrect the one
    // credential that has been through RuStore's logs and the iOS clipboard.
    expect(row.handoff_hash).toBeNull();
  });

  it('leaves the superseded accept token unusable at accept', async () => {
    // The other half of "at most one live token": the first device's form now
    // 404s, with the same body every other failure gets. Without this the swap
    // above could be satisfied by a controller that minted a second token and
    // left both spendable.
    seedInvite();

    const first = data(await callLookup({ handoff: HANDOFF })).accept_token as string;
    const second = data(await callLookup({ claim_code: CLAIM_CODE })).accept_token as string;

    const stale = await callAccept({ ...ACCEPT_BODY, accept_token: first });
    expect(stale.statusCode).toBe(404);
    expect(stale.payload).toEqual(UNAVAILABLE_BODY);
    expect(users).toHaveLength(0);

    // Positive control: the surviving token is the one that works, so the 404
    // above is about which token, not about a broken accept.
    const fresh = await callAccept({ ...ACCEPT_BODY, accept_token: second });
    expect(fresh.statusCode).toBe(201);
    expect(users).toHaveLength(1);
  });

  /**
   * The recovery exemption is for the TYPED code only, and this is the negative
   * half that gives that word meaning.
   *
   * The link is the credential most likely to have been forwarded into a group
   * chat, and it is the one the client fires automatically at launch —
   * discoverInvite() tries link, then install referrer, then clipboard, and
   * never the claim code. So a link lookup arriving while a token is live is the
   * ordinary two-racers-at-startup case the conditional mint exists to stop, and
   * it must still lose. If this ever returns 200, the exemption has quietly
   * become "any credential re-mints", which is the same as no conditional mint
   * at all.
   */
  it('refuses to re-mint for the link token while an accept token is live', async () => {
    const row = seedInvite();

    const viaClaim = await callLookup({ claim_code: CLAIM_CODE });
    const liveHash = row.accept_hash;

    const viaLink = await callLookup({ token: LINK_TOKEN });

    expect(viaLink.statusCode).toBe(409);
    expect(errorCode(viaLink)).toBe('INVITE_IN_PROGRESS');
    expect(JSON.stringify(viaLink.payload)).not.toContain('accept_token');
    // Nothing rotated, so the token already handed to the form still works.
    expect(row.accept_hash).toBe(liveHash);
    expect(row.accept_hash).toBe(hashSecret(data(viaClaim).accept_token as string));
  });

  /**
   * The same rule for the credential that has actually been through somebody
   * else's logs — and the answer is 404, not the 409 the link gets. That
   * difference is not an inconsistency, it is a stronger statement, and it took
   * a wrong first draft of this test to see it.
   *
   * The draft assumed a link lookup leaves handoff_hash intact, so that a later
   * handoff would reach the re-mint guard and be turned away by it. It does not:
   * the minting write nulls handoff_hash on EVERY successful lookup, whichever
   * credential opened it. So the handoff never reaches the guard at all — it
   * stops one step earlier, at a findUnique that matches no row.
   *
   * Which means the property here is not "the handoff is refused a re-mint" but
   * the stricter "the handoff is GONE". It cannot be refused a re-mint for the
   * same reason a burned match cannot be blown out. 404 is the honest answer:
   * the credential does not resolve, exactly as for a string that was never
   * issued, and the caller cannot tell those two apart.
   *
   * Pinned here as a pair — the null AND the status — because either alone is
   * weak. The status alone would also pass if the handoff survived and were
   * merely losing a race; the null alone would pass if the endpoint 500'd.
   */
  it('leaves a handoff no re-mint to refuse: any successful lookup burns it', async () => {
    const row = seedInvite();

    // Opened by the LINK, not by the handoff. The handoff is an innocent
    // bystander here and is still destroyed.
    await callLookup({ token: LINK_TOKEN });
    const liveHash = row.accept_hash;

    expect(row.handoff_hash).toBeNull();

    const viaHandoff = await callLookup({ handoff: HANDOFF });

    expect(viaHandoff.statusCode).toBe(404);
    expect(viaHandoff.payload).toEqual(UNAVAILABLE_BODY);
    expect(JSON.stringify(viaHandoff.payload)).not.toContain('accept_token');
    // Nothing rotated: the token already handed to the form is untouched, so a
    // string recovered from RuStore's access log cannot even disrupt the
    // registration it cannot take over.
    expect(row.accept_hash).toBe(liveHash);
    expect(mockDb.invite.updateMany).toHaveBeenCalledTimes(1); // the first lookup only
  });

  /**
   * The re-mint is a compare-and-SWAP on accept_hash, not a blanket exemption,
   * and the difference is what a second racer receives.
   *
   * Two claim-code lookups in flight at once — a double-tapped button, a retried
   * request — must produce one winner holding a token and one 409 holding
   * nothing. An unconditional re-mint would hand BOTH callers a token, store
   * only the last, and let the other discover the difference by filling in an
   * entire registration form and receiving a bare 404. Recovery for one person
   * is not worth a silent failure for the next.
   */
  it('gives the loser of two concurrent claim-code lookups a 409 and no token', async () => {
    const row = seedInvite();
    await callLookup({ handoff: HANDOFF });

    // Both requests read the row before either wrote: the only interleaving in
    // which the compare-and-swap is load-bearing.
    const staleRead = { ...row };

    const winner = await callLookup({ claim_code: CLAIM_CODE });
    mockDb.invite.findMany.mockResolvedValueOnce([staleRead]);
    const loser = await callLookup({ claim_code: CLAIM_CODE });

    expect(winner.statusCode).toBeUndefined();
    expect(loser.statusCode).toBe(409);
    expect(errorCode(loser)).toBe('INVITE_IN_PROGRESS');
    expect(JSON.stringify(loser.payload)).not.toContain('accept_token');
    // The winner's token is intact — the loser did not rotate it out from under
    // the form the winner is already filling in.
    expect(row.accept_hash).toBe(hashSecret(data(winner).accept_token as string));
  });

  it('names the exact token it is replacing in the re-mint guard', async () => {
    // The argument assertion behind the outcome above. `{ accept_hash: <the
    // value this request read> }` is what makes the write a swap; a third branch
    // of any other shape — `{}`, `{ id }`, a bare `NOT null` — would re-mint
    // unconditionally and the concurrency test would be the only thing standing
    // between that and production.
    const row = seedInvite();
    await callLookup({ handoff: HANDOFF });
    const liveHash = row.accept_hash;

    await callLookup({ claim_code: CLAIM_CODE });

    const { where } = argsOf(mockDb.invite.updateMany, 1);
    expect(where.OR).toEqual([
      { accept_hash: null },
      { accept_expires_at: { lte: expect.any(Date) } },
      { accept_hash: liveHash },
    ]);
    // Still guarded on the two states no credential may override.
    expect(where.consumed_at).toBeNull();
    expect(where.revoked_at).toBeNull();
  });

  it('adds no third branch when the claim code is the first credential used', async () => {
    // Nothing to swap, so nothing to name: a first claim-code lookup takes the
    // identical two-branch guard every other credential takes.
    seedInvite();

    await callLookup({ claim_code: CLAIM_CODE });

    expect(argsOf(mockDb.invite.updateMany).where.OR).toEqual([
      { accept_hash: null },
      { accept_expires_at: { lte: expect.any(Date) } },
    ]);
  });

  it('records the re-mint against the organisation, where the owner can see it', async () => {
    // A lookup that replaced a live token is either the invitee recovering a
    // killed app or a second holder of a forwarded link taking the registration
    // from them. The server cannot tell, so it does not guess — it tells the one
    // person who can revoke.
    seedInvite();

    await callLookup({ handoff: HANDOFF });
    await callLookup({ claim_code: CLAIM_CODE });

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invite.lookup',
        outcome: 'success',
        organizationId: ORG_A,
        metadata: expect.objectContaining({ via: 'claim_code', reminted: true }),
      }),
    );
    // The first, ordinary lookup is not labelled a re-mint — otherwise the flag
    // is noise and the owner learns to ignore it.
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invite.lookup',
        outcome: 'success',
        metadata: expect.objectContaining({ via: 'handoff', reminted: false }),
      }),
    );
  });

  it('refuses to re-mint on an invite that was revoked while the form was open', async () => {
    // The exemption is scoped to the accept token. Revocation and consumption
    // are not part of the OR and must still stop a typed code dead.
    const row = seedInvite();
    await callLookup({ handoff: HANDOFF });
    row.revoked_at = ago(1000);

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
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
// 7b. The recovery window is not empty
//     MUTATION: removing the claim-code branch from the re-mint guard, or
//     shrinking CLAIM_TTL_MS back below INSTALL_BUDGET_MS + ACCEPT_TTL_MS.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The controller has always carried a paragraph promising that an invitee whose
 * app dies between lookup and submit can retype the six-character code. Nothing
 * tested it, and it was false at every instant.
 *
 * Two guards closed on each other. The mint refused while an accept token was
 * live — 30 minutes, measured from LOOKUP — and the claim code expired 15
 * minutes after the landing page OPENED, which is always earlier than lookup.
 * Retype inside the accept window: 409. Wait it out: the code died 15+ minutes
 * ago, 404. The set of instants at which recovery worked was EMPTY, which is why
 * no amount of testing "does a claim code work" would have found it — a fresh
 * claim code works fine. What was never asked is whether it works SECOND.
 *
 * So this block does not test a call, it tests a REGION: every combination of
 * how long the install took and how long after the crash the invitee got round
 * to retyping. A single happy-path case would be satisfied by a fix that opened
 * a window one minute wide, which is the same bug with better luck.
 */
describe('a killed app can be recovered by retyping the claim code, at every point in the window', () => {
  /**
   * Rebuild the row exactly as it would be `d` milliseconds after a lookup that
   * itself happened `install` milliseconds after the landing page opened, with
   * "now" being the moment the invitee retypes the code.
   *
   *   landing page opened at   now − (install + d)
   *   claim code expires at    opened + CLAIM_TTL_MS
   *   lookup happened at       now − d      (handoff burned there)
   *   accept token expires at  lookup + ACCEPT_TTL_MS
   */
  function seedCrashedFlow(install: number, d: number): Row {
    const opened = new Date(Date.now() - install - d);
    return seedInvite({
      opened_at: opened,
      claim_expires_at: new Date(opened.getTime() + CLAIM_TTL_MS),
      handoff_hash: null, // burned by the lookup whose token is now lost
      accept_hash: hashSecret(ACCEPT_TOKEN),
      accept_expires_at: new Date(Date.now() - d + ACCEPT_TTL_MS),
    });
  }

  /**
   * How close to the far edge these cases are allowed to sit.
   *
   * The row is seeded from `Date.now()` and the handler reads its own clock a
   * moment later, so a case placed one millisecond inside the boundary is
   * measuring how fast the test runner is, not where the boundary is — it passes
   * alone and fails under a loaded suite, which is the worst possible way for a
   * security test to behave. Five seconds is far larger than a handler call and
   * far smaller than any TTL here, so it distinguishes the two sides of the edge
   * without racing the machine.
   */
  const EDGE_MARGIN_MS = 5000;

  /**
   * Every install time crossed with every delay, both edges of each included.
   *
   * `d` stops just short of ACCEPT_TTL_MS, and that is the region boundary
   * rather than a convenience. `accept` rejects on `accept_expires_at <= now`,
   * so the form the invitee is holding is submittable for d < ACCEPT_TTL and
   * dead at d = ACCEPT_TTL. The property being claimed is "at every instant at
   * which they could still have submitted, retyping buys them a new token" — at
   * d = ACCEPT_TTL there is no longer a form to recover, and the row has fallen
   * into the ordinary `accept_expires_at <= now` branch that every credential
   * may re-mint from anyway. The case below pins that exact instant.
   */
  const installs = [0, 1000, 60_000, INSTALL_BUDGET_MS / 2, INSTALL_BUDGET_MS - 1, INSTALL_BUDGET_MS];
  const delays = [1, 1000, 60_000, ACCEPT_TTL_MS / 2, ACCEPT_TTL_MS - EDGE_MARGIN_MS];

  it('mints a fresh accept token at every (install time, delay) in the window', async () => {
    for (const install of installs) {
      for (const d of delays) {
        invites = [];
        users = [];
        const row = seedCrashedFlow(install, d);

        const reply = await callLookup({ claim_code: CLAIM_CODE });

        // The failure message has to say WHICH point failed, or a red region
        // reads as one red test.
        const at = `install=${install / 60_000}min delay=${d / 60_000}min`;
        expect(reply.statusCode, at).toBeUndefined(); // plain 200
        const token = data(reply).accept_token as string;
        expect(token, at).toEqual(expect.any(String));
        expect(token, at).not.toBe(ACCEPT_TOKEN);
        expect(row.accept_hash, at).toBe(hashSecret(token));
      }
    }
  });

  it('carries the recovered token all the way to a created account', async () => {
    // The window being open is worth nothing if the token it yields cannot be
    // spent. This is the end of the journey the promise describes: crash,
    // retype, register.
    seedCrashedFlow(INSTALL_BUDGET_MS, ACCEPT_TTL_MS / 2);

    const recovered = await callLookup({ claim_code: CLAIM_CODE });
    const accepted = await callAccept({
      ...ACCEPT_BODY,
      accept_token: data(recovered).accept_token as string,
    });

    expect(accepted.statusCode).toBe(201);
    expect(users).toHaveLength(1);
    expect(users[0].organization_id).toBe(ORG_A);
  });

  it('closes both clocks together at the far corner, rather than leaving one dangling', async () => {
    // The worst case the budget admits: the install used all 15 minutes and the
    // invitee waited out the entire 30-minute form. CLAIM_TTL is exactly
    // INSTALL_BUDGET + ACCEPT_TTL, so at this instant the claim code and the
    // accept token expire together — the form was already unsubmittable, and the
    // code that would have replaced it dies in the same millisecond.
    //
    // Written down because "45 = 15 + 30" makes this corner exact rather than
    // approximate, and a reader who found the 404 by accident would reasonably
    // suspect the window was off by one. It is not a gap: there is nothing left
    // to recover, and the LINK is still good for 24 hours, which is the recourse
    // the product actually offers here.
    seedCrashedFlow(INSTALL_BUDGET_MS, ACCEPT_TTL_MS);

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);

    // A few seconds earlier, both are alive and recovery works — which is what
    // makes the line above a boundary rather than an off-by-one. Both halves are
    // required: the 404 alone would also be produced by a window that never
    // opened at all, which is precisely the bug being fixed.
    invites = [];
    seedCrashedFlow(INSTALL_BUDGET_MS, ACCEPT_TTL_MS - EDGE_MARGIN_MS);
    expect((await callLookup({ claim_code: CLAIM_CODE })).statusCode).toBeUndefined();
  });

  it('is bounded: a claim code past its own life recovers nothing', async () => {
    // The window is finite, and the boundary is the claim code's, not the accept
    // token's. Beyond it the invitee is not stranded either — the LINK is good
    // for 24 hours and re-opening the landing page mints a fresh code — but this
    // endpoint must say no.
    seedInvite({
      claim_expires_at: ago(1),
      accept_hash: hashSecret(ACCEPT_TOKEN),
      accept_expires_at: in_(ACCEPT_TTL_MS),
    });

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
    expect(mockDb.invite.updateMany).not.toHaveBeenCalled();
  });

  it('holds the arithmetic that makes the window non-empty', () => {
    // The behavioural tests above sample the region; this states why sampling it
    // is enough. The claim code's clock starts at OPEN and the accept token's at
    // LOOKUP, so the two TTLs are only comparable through the install time — and
    // deriving one from the other is what stops a future edit from re-inverting
    // them without touching a single test that looks like it is about invites.
    expect(CLAIM_TTL_MS).toBe(INSTALL_BUDGET_MS + ACCEPT_TTL_MS);
    for (const install of installs) {
      expect(install + ACCEPT_TTL_MS).toBeLessThanOrEqual(CLAIM_TTL_MS);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7c. A claim code answers for one organisation or for none
//     MUTATION: findFirst instead of findMany + the cardinality check; dropping
//     @unique from claim_hash.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The claim-code lookup is the only unauthenticated path in this product that
 * decides which COMPANY the caller is about to join, and the only branch of
 * `lookup` with no organization_id available to narrow on. Six characters over a
 * 32-symbol alphabet is 2^30 values shared by every tenant.
 *
 * While claim_hash was a bare, unindexed `String?` resolved with `findFirst`,
 * the tenancy argument was silently "no two live claim codes are ever equal
 * anywhere in the product" — an assumption stated in no comment and enforced by
 * nothing. Its failure mode was not an error: Postgres returns whichever row it
 * reaches first, so a collision hands the invitee an accept token for an
 * organisation that never invited them, at whatever role that organisation
 * chose. Every other cross-tenant boundary in this file is a WHERE clause; this
 * one was a probability.
 *
 * The schema now carries @unique on claim_hash so two live codes cannot coexist
 * at rest. That constraint cannot be exercised here — the store below is a row
 * list, not Postgres — and more to the point it is only true where the migration
 * has run, while this code ships everywhere first. So the controller checks the
 * cardinality itself, and that is what these tests pin.
 *
 * This is the same shape as the guard services/invites.ts:41-50 retracted, and
 * the difference is which half does the work. There, "only one candidate" was
 * asked to compensate for a discriminator (client IP behind nginx) that did not
 * discriminate. Here the discriminator is a real secret and the count is the
 * CHECK on it. Two rows means refuse. It never means choose.
 */
describe('a colliding claim code cannot cross an organisation boundary', () => {
  /** The same six characters minted, independently, inside two tenants. */
  function seedCollision() {
    const ours = seedInvite({
      id: INVITE_A,
      organization_id: ORG_A,
      name: 'Пётр Смирнов',
      role: 'member',
      organization: { name: 'ООО «Ромашка»' },
    });
    const theirs = seedInvite({
      id: INVITE_B,
      organization_id: ORG_B,
      name: 'Чужой финдиректор',
      role: 'accountant',
      created_by: OWNER_B,
      token_hash: hashSecret('another-org-link-token'),
      handoff_hash: hashSecret('another-org-handoff'),
      organization: { name: 'ЗАО «Конкурент»' },
    });
    return { ours, theirs };
  }

  it('refuses the lookup instead of picking one of the two invites', async () => {
    const { ours, theirs } = seedCollision();

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
    // THE LOAD-BEARING ASSERTION. Not "the right org was returned" — no org is.
    // A controller that resolved the ambiguity in favour of the caller's luck
    // would pass a test that only checked the response was not org B's.
    expect(mockDb.invite.updateMany).not.toHaveBeenCalled();
    expect(ours.accept_hash).toBeNull();
    expect(theirs.accept_hash).toBeNull();
  });

  it('leaks neither organisation through the refusal', async () => {
    seedCollision();

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    const serialised = JSON.stringify(reply.payload);
    for (const secret of ['Ромашка', 'Конкурент', 'Пётр', 'Чужой финдиректор', ORG_A, ORG_B, 'accountant']) {
      expect(serialised).not.toContain(secret);
    }
    // Byte-identical to every other failure: a caller who could tell "your code
    // collided" from "no such code" would learn that a second tenant exists
    // holding the code they just typed.
    expect(reply.payload).toEqual(UNAVAILABLE_BODY);
  });

  it('tells BOTH owners, because both had a hire that just failed to redeem', async () => {
    seedCollision();

    await callLookup({ claim_code: CLAIM_CODE });

    // listAuditEvents filters hard on organization_id, so one row would be
    // visible to at most one of the two organisations involved.
    for (const [org, invite] of [[ORG_A, INVITE_A], [ORG_B, INVITE_B]] as const) {
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invite.lookup',
          outcome: 'denied',
          organizationId: org,
          metadata: expect.objectContaining({ reason: 'claim_code_collision', invite_id: invite }),
        }),
      );
    }
  });

  it('asks the database for more than one row, so that counting is possible at all', async () => {
    seedCollision();

    await callLookup({ claim_code: CLAIM_CODE });

    // `findFirst` cannot see a collision by construction — it returns one row
    // whether one or five matched. The cardinality check is only meaningful if
    // the query is capable of returning a second row, and `take: 2` is the whole
    // of what is needed to decide "exactly one or not".
    expect(mockDb.invite.findFirst).not.toHaveBeenCalled();
    const call = mockDb.invite.findMany.mock.calls[0][0] as { where: Where; take?: number };
    expect(call.take).toBe(2);
    expect(Object.keys(call.where).sort()).toEqual([
      'claim_expires_at',
      'claim_hash',
      'consumed_at',
      'revoked_at',
    ]);
    // The plaintext is never sent to the database, only its digest.
    expect(call.where.claim_hash).toBe(hashSecret(CLAIM_CODE));
    expect(JSON.stringify(call.where)).not.toContain(CLAIM_CODE);
  });

  it('counts only LIVE candidates, so a dead twin does not block a good code', async () => {
    // Uniqueness at rest cannot cover expiry — a partial index cannot contain
    // `claim_expires_at > now()`, because the predicate is not immutable — so
    // stale digests do accumulate and the count has to be taken over the same
    // liveness filters the lookup already applies. Otherwise the fix for a
    // cross-tenant leak becomes a denial of service against the tenant whose
    // code happens to collide with an expired one.
    const ours = seedInvite({ id: INVITE_A, organization_id: ORG_A });
    seedInvite({ id: INVITE_B, organization_id: ORG_B, claim_expires_at: ago(1000) });
    seedInvite({ id: 'consumed-twin', organization_id: ORG_B, consumed_at: ago(1000) });
    seedInvite({ id: 'revoked-twin', organization_id: ORG_B, revoked_at: ago(1000) });

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBeUndefined(); // plain 200
    expect(data(reply).org_name).toBe('ООО «Ромашка»');
    expect(ours.accept_hash).toBe(hashSecret(data(reply).accept_token as string));
  });

  // Positive control: with no collision the code resolves to its own tenant and
  // to nobody else's. Without this, every refusal above would still pass if the
  // claim-code branch refused everything.
  it('resolves a unique claim code to its own organisation', async () => {
    seedInvite({ id: INVITE_A, organization_id: ORG_A });
    const theirs = seedInvite({
      id: INVITE_B,
      organization_id: ORG_B,
      name: 'Чужой финдиректор',
      role: 'accountant',
      created_by: OWNER_B,
      token_hash: hashSecret('another-org-link-token'),
      handoff_hash: hashSecret('another-org-handoff'),
      claim_hash: hashSecret('ZZZ999'),
      organization: { name: 'ЗАО «Конкурент»' },
    });

    const reply = await callLookup({ claim_code: CLAIM_CODE });

    expect(reply.statusCode).toBeUndefined();
    expect(data(reply).org_name).toBe('ООО «Ромашка»');
    expect(data(reply).role).toBe('member');
    expect(theirs.accept_hash).toBeNull();
    expect(JSON.stringify(reply.payload)).not.toContain('Конкурент');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7d. Minting a claim code survives the uniqueness constraint it now lives under
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @unique on claim_hash is what makes the branch above single-tenant, and the
 * bill for it lands on `open`: a constraint that is enforced is a constraint
 * that can be hit. 2^30 values, and the digests of live codes compete for them.
 *
 * The failure would arrive as a 500 on the invitee's very first screen, at a
 * rate proportional to how well the product is doing, and it would be
 * unreproducible. Drawing again is one loop; arguing that 2^30 is large enough
 * is what put an unenforced assumption in this column in the first place.
 */
describe('open draws a new claim code when the database says that one is taken', () => {
  /** Prisma's unique-violation shape, as the client actually throws it. */
  function uniqueViolation() {
    return Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['claim_hash'] },
    });
  }

  it('retries the mint and returns a usable claim code', async () => {
    const row = seedInvite({ handoff_hash: null, claim_hash: null, claim_expires_at: null });
    const realUpdate = mockDb.invite.update.getMockImplementation()!;
    mockDb.invite.update.mockRejectedValueOnce(uniqueViolation());

    const reply = await callOpen({ token: LINK_TOKEN });

    expect(reply.statusCode).toBeUndefined(); // plain 200
    expect(mockDb.invite.update).toHaveBeenCalledTimes(2);
    // The second draw is a DIFFERENT code, not the same one retried — retrying
    // an identical value against a uniqueness constraint is an infinite loop
    // with extra steps.
    const first = argsOf(mockDb.invite.update, 0).data.claim_hash;
    const second = argsOf(mockDb.invite.update, 1).data.claim_hash;
    expect(second).not.toBe(first);
    // And the code handed to the invitee is the one that was actually stored.
    expect(row.claim_hash).toBe(hashSecret(data(reply).claim_code as string));
    expect(realUpdate).toBeTruthy();
  });

  it('gives up after a bounded number of draws rather than spinning', async () => {
    seedInvite();
    mockDb.invite.update.mockRejectedValue(uniqueViolation());

    // Three independent draws all colliding is not a collision, it is a bug —
    // a corrupted alphabet, a constraint on the wrong column — and it has to
    // surface rather than being retried until the request times out.
    await expect(callOpen({ token: LINK_TOKEN })).rejects.toThrow('Unique constraint failed');
    expect(mockDb.invite.update).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that a new code cannot fix', async () => {
    seedInvite();
    mockDb.invite.update.mockRejectedValue(new Error('connection terminated'));

    await expect(callOpen({ token: LINK_TOKEN })).rejects.toThrow('connection terminated');
    // One attempt. Swallowing a dead connection into a retry loop turns a fault
    // into a slow request and hides it from whatever is watching.
    expect(mockDb.invite.update).toHaveBeenCalledTimes(1);
  });

  // Positive control: the ordinary path still writes exactly once.
  it('writes once when nothing collides', async () => {
    seedInvite({ handoff_hash: null, claim_hash: null, claim_expires_at: null });

    const reply = await callOpen({ token: LINK_TOKEN });

    expect(reply.statusCode).toBeUndefined();
    expect(mockDb.invite.update).toHaveBeenCalledTimes(1);
    expect((data(reply).claim_code as string)).toHaveLength(6);
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
    expect(data(reply).user_id).toBeTruthy();
    expect(data(reply).needs_verification).toBe(true);
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
    // The role is not echoed back at all now — the response is the user_id and
    // the address, nothing a caller could mistake for a grant.
    expect(JSON.stringify(reply.payload)).not.toContain('owner');
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

  it('mints no session for the account it just created, at any role', async () => {
    // The inverse of the test that used to stand here. Signing a session was the
    // defect, not the contract: see the block at the end of this file.
    seedLookedUpInvite({ role: 'support', organization_id: ORG_A });

    await callAccept({ ...ACCEPT_BODY, ...HOSTILE_EXTRAS });

    expect(createAuthSession).not.toHaveBeenCalled();
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
    // All three read shapes, not two: the claim branch moved from findFirst to
    // findMany, and a "nothing was queried" assertion that names only the reads
    // the code no longer performs is an assertion that cannot fail.
    expect(mockDb.invite.findUnique).not.toHaveBeenCalled();
    expect(mockDb.invite.findFirst).not.toHaveBeenCalled();
    expect(mockDb.invite.findMany).not.toHaveBeenCalled();
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
    expect(mockDb.invite.findMany).not.toHaveBeenCalled();
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

  /**
   * WAS: "lets a lone claim code through to the guarded findFirst", asserting
   * the WHERE of a `findFirst`. The query is now a `findMany(take: 2)`, so the
   * argument assertion has to move with it — and it is worth being explicit
   * about what did NOT change, because the obvious reading of "the claim-code
   * lookup was not org-scoped" is that the fix adds an organization_id to this
   * WHERE. It cannot. This route is unauthenticated; there is no caller identity
   * to scope by, and inventing one from the request would be the IP-matching
   * mistake services/invites.ts:41-50 already retracted.
   *
   * What replaces the missing org filter is uniqueness plus a count. @unique on
   * claim_hash makes "at most one invite answers to this code" a database
   * constraint rather than an assumption about 2^30 values, and `take: 2` is the
   * controller asking whether that constraint held — because it is only true
   * where the migration has run, and this code ships everywhere first. Two rows
   * is a refusal, never a choice; the behavioural half is in the collision block
   * above.
   *
   * So the assertion below is strictly stronger than the one it replaces: same
   * four liveness/secret filters, plus the `take` without which counting is not
   * even possible. Dropping `take` would leave a query that cannot see a
   * collision by construction, and this test would catch that.
   */
  it('lets a lone claim code through to the counted findMany', async () => {
    const response = await post('/auth/invites/lookup', { claim_code: CLAIM_CODE });

    expect(response.statusCode).toBe(404);
    const call = mockDb.invite.findMany.mock.calls[0][0] as { where: Where; take?: number };
    expect(Object.keys(call.where).sort()).toEqual([
      'claim_expires_at',
      'claim_hash',
      'consumed_at',
      'revoked_at',
    ]);
    expect(call.take).toBe(2);
    // Not findFirst: it returns one row whether one or five matched, which makes
    // the cardinality check unwritable.
    expect(mockDb.invite.findFirst).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Redemption creates an account; PROOF OF THE ADDRESS creates the session
//     MUTATION: restoring the signSessionToken call at the end of `accept`.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE HOLE THIS BLOCK REFUSES.
 *
 * `accept` used to sign a seven-day session the instant the row was written, on
 * an address nobody had proven — the row it writes says `email_verified: false`
 * in as many words. Anyone holding a forwarded invite link could therefore type
 * any address they liked, including one belonging to somebody else, and hold a
 * working account in that organisation: contacts, deals, revenue, the audit
 * trail, and (at admin) a long-lived public API key that outlives the JWT.
 *
 * The controller now ends the way `AuthController.register` ends — issue an OTP,
 * answer 201 with the id the client needs for POST /auth/verify — and that
 * endpoint is what mints the session, one screen later, on a proven address.
 *
 * Every test below has to be able to fail. The three that matter are:
 *   • no session is created (the hole itself);
 *   • a code IS issued and mailed (without which the fix is a bare token removal
 *     that strands every future invitee with a burned invite and no way in);
 *   • delivery failure still answers 201 and keeps the account (without which
 *     onboarding becomes hostage to the mail provider, and a provider outage
 *     burns single-use invites).
 */
describe('accept issues proof-of-address instead of a session', () => {
  it('does not mint a session for an unproven address', async () => {
    seedLookedUpInvite();

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    // No session row, no JWT, and nothing in the body a client could mistake for
    // one. All four assertions, because the account IS created either way and
    // only the credential it does not receive distinguishes fix from hole.
    expect(createAuthSession).not.toHaveBeenCalled();
    expect(data(reply).token).toBeUndefined();
    expect(data(reply).user).toBeUndefined();
    expect(JSON.stringify(reply.payload)).not.toContain('signed.jwt.token');
    expect(data(reply).needs_verification).toBe(true);
  });

  it('issues an email OTP to the address the invitee supplied', async () => {
    seedLookedUpInvite();

    const reply = await callAccept(ACCEPT_BODY);

    // Against the NORMALISED address, not the one as typed: the row stores
    // 'petr@example.ru' and a code mailed anywhere else proves nothing about the
    // account it unlocks.
    expect(issueCode).toHaveBeenCalledWith(users[0].id, 'email');
    expect(sendEmail).toHaveBeenCalledWith(
      'petr@example.ru',
      'Код подтверждения',
      expect.stringContaining('Ваш код: 123456'),
    );
    expect(data(reply).user_id).toBe(users[0].id);
    expect(reply.payload).toEqual(expect.objectContaining({ meta: { email_sent: true } }));
  });

  it('still returns 201 and keeps the account when email delivery fails', async () => {
    seedLookedUpInvite();
    sendEmail.mockResolvedValue({ success: false });

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(reply.payload).toEqual(expect.objectContaining({ meta: { email_sent: false } }));
    // The invite was consumed inside the transaction and the row is committed.
    // Throwing here would burn a single-use link and leave an account nobody can
    // reach; the caller retries through POST /auth/verify/resend instead.
    expect(users).toHaveLength(1);
    expect(invites[0].consumed_at).toBeInstanceOf(Date);
  });

  it('still returns 201 when the mail provider throws outright', async () => {
    seedLookedUpInvite();
    sendEmail.mockRejectedValue(new Error('ECONNRESET'));

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(data(reply).needs_verification).toBe(true);
    expect(users).toHaveLength(1);
  });

  it('still returns 201 when no mail provider is configured at all', async () => {
    // RESEND_API_KEY unset. `register` answers 201 with email_sent: false here
    // rather than failing, and this path must not diverge — a self-hosted
    // deployment with no mail credentials must still be able to add people.
    seedLookedUpInvite();
    isEmailSendingEnabled.mockReturnValue(false);

    const reply = await callAccept(ACCEPT_BODY);

    expect(reply.statusCode).toBe(201);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reply.payload).toEqual(expect.objectContaining({ meta: { email_sent: false } }));
  });

  /**
   * The revert switch, tested from the outside so it is known to be REAL.
   *
   * A kill switch nobody exercised is a claim, not a switch. This one exists
   * because the OTP leg needs a client that can enter a code, and binaries
   * already installed cannot; if field telemetry shows invitees stranded, this
   * env var puts the old behaviour back without a deploy. It must therefore
   * restore the WHOLE old shape — token and user — not half of it.
   */
  it('restores the pre-fix response when REQUIRE_EMAIL_VERIFICATION=false', async () => {
    const previous = process.env.REQUIRE_EMAIL_VERIFICATION;
    process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
    try {
      seedLookedUpInvite();

      const reply = await callAccept(ACCEPT_BODY);

      expect(reply.statusCode).toBe(201);
      expect(data(reply).token).toBe('signed.jwt.token');
      expect((data(reply).user as Row).email).toBe('petr@example.ru');
      expect(createAuthSession).toHaveBeenCalledWith(
        expect.objectContaining({ userId: users[0].id, organizationId: ORG_A }),
      );
      expect(issueCode).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
      else process.env.REQUIRE_EMAIL_VERIFICATION = previous;
    }
  });

  // Positive control for the switch: with it at its default, the gate is ON.
  // Without this, the test above would pass just as well against a controller
  // that had never been fixed.
  it('is enforced by default, with the switch unset', async () => {
    expect(process.env.REQUIRE_EMAIL_VERIFICATION).toBeUndefined();
    seedLookedUpInvite();

    await callAccept(ACCEPT_BODY);

    expect(createAuthSession).not.toHaveBeenCalled();
    expect(issueCode).toHaveBeenCalledTimes(1);
  });

  /**
   * Why the escalation this hole enabled was worth a 403 rather than a note.
   *
   * An owner may mint an ADMIN invite, and admin holds integrations.manage,
   * which is the whole gate on POST /api/v1/api-keys. An unverified
   * invite-accepted admin could therefore trade its seven-day JWT for a
   * long-lived API key and outlive the token entirely. Pinned here so that
   * editing the role table makes this visible rather than silent.
   */
  it('keeps admin an assignable role for owner, which is what made this reachable', async () => {
    expect(assignableRoles('owner')).toContain('admin');
    expect(can('admin', 'integrations.manage')).toBe(true);
  });
});
