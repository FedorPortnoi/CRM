/**
 * POST /auth/verify/resend TELLS AN ANONYMOUS CALLER NOTHING.
 *
 * This route is public — the person who needs it has no session — and it takes a
 * bare `user_id`. It used to answer in four distinguishable ways (404
 * USER_NOT_FOUND / 409 ALREADY_VERIFIED / 400 EMAIL_MISSING / 200 sent), which
 * is an account-state oracle for anyone holding an id. Ids are not secret:
 * register returns one, invite-accept returns one, and GET /auth/users lists
 * every colleague's to every org member. So a departed employee who kept that
 * list could watch the org's headcount and onboarding forever, from anywhere,
 * with no credentials — and the handler wrote no audit row, unlike every other
 * handler in that file, so none of it was visible to the owner.
 *
 * There was NO test of this handler before this file. Grepping tests/ for
 * `resendVerification` returned two path strings in authenticate.test.ts
 * asserting the route is on the public allowlist, and nothing that called it.
 *
 * Its own file rather than an addition to auth-messages.test.ts because it needs
 * services/verification, services/email and services/rate-limit-store mocked,
 * and auth-messages.test.ts deliberately runs the real ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  user: { findUnique: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const verificationMock = vi.hoisted(() => ({
  issueCode: vi.fn(async () => '123456'),
  verifyCode: vi.fn(async () => true),
}));

vi.mock('../../../backend/services/verification', () => verificationMock);

const emailMock = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  isEmailSendingEnabled: vi.fn(() => true),
}));

vi.mock('../../../backend/services/email', () => emailMock);

const auditMock = vi.hoisted(() => ({
  auditLog: vi.fn(async () => undefined),
  listAuditEvents: vi.fn(async () => ({ data: [], total: 0 })),
}));

vi.mock('../../../backend/services/audit', () => auditMock);

const rateLimitMock = vi.hoisted(() => ({
  consumeScopedBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
  consumeAuthIpBudget: vi.fn(async () => ({ allowed: true, retryAfterSec: 1 })),
}));

vi.mock('../../../backend/services/rate-limit-store', () => rateLimitMock);

import { AuthController } from '../../../backend/api/controllers/auth';

const orgId = '00000000-0000-4000-a000-000000000123';
const USER_ID = '00000000-0000-4000-a000-0000000000aa';
const UNIFORM_BODY = { data: { sent: true }, meta: {} };

type TestReply = {
  statusCode: number;
  payload: unknown;
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function createReply(): TestReply {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn(function setCode(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    status: vi.fn(function setStatus(this: TestReply, statusCode: number) {
      this.statusCode = statusCode;
      return this;
    }),
    send: vi.fn(function send(this: TestReply, payload: unknown) {
      this.payload = payload;
      return this;
    }),
  };
  return reply as unknown as TestReply;
}

const STATES: [string, Record<string, unknown> | null][] = [
  ['no such user', null],
  ['deactivated', { id: USER_ID, email: 'a@b.ru', is_verified: false, is_active: false, organization_id: orgId }],
  ['already verified', { id: USER_ID, email: 'a@b.ru', is_verified: true, is_active: true, organization_id: orgId }],
  ['unverified, no address on file', { id: USER_ID, email: null, is_verified: false, is_active: true, organization_id: orgId }],
  ['unverified, address on file', { id: USER_ID, email: 'a@b.ru', is_verified: false, is_active: true, organization_id: orgId }],
];

async function callResend(): Promise<TestReply> {
  const reply = createReply();
  await AuthController.resendVerification(
    {
      body: { user_id: USER_ID },
      headers: { 'user-agent': 'vitest' },
      ip: '127.0.0.1',
    } as never,
    reply as never,
  );
  return reply;
}

describe('AuthController.resendVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.$executeRaw.mockResolvedValue(1);
    dbMock.$queryRaw.mockResolvedValue([]);
    verificationMock.issueCode.mockResolvedValue('123456');
    emailMock.sendEmail.mockResolvedValue({ success: true });
    emailMock.isEmailSendingEnabled.mockReturnValue(true);
    rateLimitMock.consumeScopedBudget.mockResolvedValue({ allowed: true, retryAfterSec: 1 });
  });

  it('answers identically for every account state', async () => {
    const answers: { statusCode: number; payload: unknown }[] = [];

    for (const [, row] of STATES) {
      dbMock.user.findUnique.mockResolvedValue(row);
      const reply = await callResend();
      answers.push({ statusCode: reply.statusCode, payload: reply.payload });
    }

    // Against each other AND against a literal. Comparing only to each other
    // would still pass if a future change made all five uniformly wrong.
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
      expect(answer).toEqual({ statusCode: 202, payload: UNIFORM_BODY });
    }
  });

  it('still sends the code on the one path that deserves it', async () => {
    // The positive control. A fix that closes the oracle by breaking resend for
    // real users is not a fix — this endpoint is the ONLY recovery path for an
    // invitee now that requiresEmailVerification() gates every request.
    dbMock.user.findUnique.mockResolvedValue(STATES[4][1]);
    await callResend();

    expect(verificationMock.issueCode).toHaveBeenCalledWith(USER_ID, 'email');
    expect(emailMock.sendEmail).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3])('sends nothing on rejection path %i', async (index) => {
    // Without this, "make them all answer 202" could be implemented by mailing
    // in all four cases, which is strictly worse than the hole it replaces.
    dbMock.user.findUnique.mockResolvedValue(STATES[index][1]);
    await callResend();

    expect(verificationMock.issueCode).not.toHaveBeenCalled();
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
  });

  it('does not await the send, so the branches cannot be told apart by a clock', async () => {
    // Unifying the STATUS CODES alone leaves a timing oracle: the old success
    // path awaited a live Resend round trip (bounded at EMAIL_SEND_TIMEOUT_MS =
    // 20s) while the three rejections returned after a single findUnique. A
    // promise that never settles is the only mechanical way to pin that the send
    // is off the response path — this test hangs against the old handler.
    dbMock.user.findUnique.mockResolvedValue(STATES[4][1]);
    emailMock.sendEmail.mockReturnValue(new Promise(() => {}) as never);

    const reply = await callResend();

    expect(reply.statusCode).toBe(202);
    expect(reply.payload).toEqual(UNIFORM_BODY);
  });

  it('spends a budget keyed on the TARGET, not on the caller address', async () => {
    dbMock.user.findUnique.mockResolvedValue(STATES[4][1]);
    await callResend();

    // Every other limiter on this route keys on request.ip, which is blind by
    // construction to one attacker with many addresses against one victim.
    expect(rateLimitMock.consumeScopedBudget).toHaveBeenCalledWith(
      'verify-resend-user',
      USER_ID,
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('answers the same 202 when that budget is exhausted, and issues no code', async () => {
    dbMock.user.findUnique.mockResolvedValue(STATES[4][1]);
    rateLimitMock.consumeScopedBudget.mockResolvedValue({ allowed: false, retryAfterSec: 900 });

    const reply = await callResend();

    // NOT a 429: a refusal only the real account can trigger is the oracle again
    // from the other end. And issueCode must not run — that is what keeps the
    // victim's outstanding code alive while an attacker burns the budget.
    expect(reply.statusCode).toBe(202);
    expect(reply.payload).toEqual(UNIFORM_BODY);
    expect(verificationMock.issueCode).not.toHaveBeenCalled();
  });

  it.each([
    [0, 'not_found'],
    [2, 'already_verified'],
    [3, 'no_email'],
    [4, 'sent'],
  ])('records the real reason for state %i in the audit log', async (index, reason) => {
    // The trade this fix is built on: the owner keeps the diagnostic, the
    // anonymous caller loses the oracle. Asserted as a POSITIVE claim about the
    // reason string, so "unified the responses AND unified the audit log" fails.
    dbMock.user.findUnique.mockResolvedValue(STATES[index][1]);
    await callResend();

    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.verify_resend',
        metadata: expect.objectContaining({ reason }),
      }),
    );
  });

  it('writes the audit row against the org, so the owner can actually read it', async () => {
    // services/audit.ts stores organization_id and listAuditEvents filters on it
    // unconditionally — a row written org-NULL is invisible to every reader the
    // product has. The handler's original select did not fetch organization_id.
    dbMock.user.findUnique.mockResolvedValue(STATES[4][1]);
    await callResend();

    expect(auditMock.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: orgId }),
    );
  });
});
