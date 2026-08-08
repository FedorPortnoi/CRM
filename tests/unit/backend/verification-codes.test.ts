/**
 * A STRANGER'S RESEND MUST NOT DESTROY THE VICTIM'S PENDING CODE.
 *
 * `issueCode` opened with
 * `deleteMany({ user_id, channel, used_at: null })` — every issuance wiped
 * whatever was outstanding. On an authenticated endpoint that is tidy. On
 * `POST /auth/verify/resend`, which is PUBLIC and takes a bare `user_id` that
 * GET /auth/users hands to every org member, it is a remote kill switch: call it
 * on a five-minute tick and the victim's code is already gone by the time they
 * finish typing it, so verifyOtp answers INVALID_CODE forever. Since
 * requiresEmailVerification() became a gate on every authenticated request, that
 * is denial of the entire product from an endpoint needing no credentials.
 *
 * Keeping a small window of codes alive removes the kill switch WITHOUT widening
 * the guessing surface: a failed attempt is charged against every live code, so
 * five wrong guesses still kill all of them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  user_id: string;
  channel: string;
  code_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

const rows: Row[] = [];
let nextId = 1;

const dbMock = vi.hoisted(() => ({
  verificationCode: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

import { issueCode, verifyCode } from '../../../backend/services/verification';

const USER = 'u-1';

function live(): Row[] {
  const now = Date.now();
  return rows
    .filter((r) => r.used_at === null && r.expires_at.getTime() > now)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  nextId = 1;

  dbMock.verificationCode.findMany.mockImplementation((args: {
    where: { channel: string };
    take?: number;
  }) => {
    const matched = live().filter((r) => r.channel === args.where.channel);
    return Promise.resolve(
      (args.take ? matched.slice(0, args.take) : matched)
        .map((r) => ({ id: r.id, code_hash: r.code_hash })),
    );
  });

  dbMock.verificationCode.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    const row: Row = {
      id: `c-${nextId++}`,
      user_id: args.data.user_id as string,
      channel: args.data.channel as string,
      code_hash: args.data.code_hash as string,
      expires_at: args.data.expires_at as Date,
      used_at: null,
      created_at: new Date(Date.now() + nextId), // strictly increasing
    };
    rows.push(row);
    return Promise.resolve(row);
  });

  dbMock.verificationCode.deleteMany.mockImplementation((args: {
    where: { OR?: Array<{ id?: { in: string[] }; expires_at?: { lte: Date } }> };
  }) => {
    const doomed = new Set(args.where.OR?.[0]?.id?.in ?? []);
    const now = Date.now();
    let count = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i] as Row;
      if (row.used_at !== null) continue;
      if (doomed.has(row.id) || row.expires_at.getTime() <= now) {
        rows.splice(i, 1);
        count++;
      }
    }
    return Promise.resolve({ count });
  });

  dbMock.verificationCode.updateMany.mockImplementation((args: {
    where: { id: string; code_hash: string };
    data: Record<string, unknown>;
  }) => {
    const row = rows.find((r) => r.id === args.where.id && r.code_hash === args.where.code_hash);
    if (!row || row.used_at !== null) return Promise.resolve({ count: 0 });
    if (args.data.used_at) row.used_at = args.data.used_at as Date;
    if (args.data.code_hash) row.code_hash = args.data.code_hash as string;
    return Promise.resolve({ count: 1 });
  });
});

describe('issueCode no longer destroys an outstanding code', () => {
  it('leaves the victim able to redeem the code they were sent', async () => {
    const victimsCode = await issueCode(USER, 'email');

    // The attacker's anonymous resend. Under the old deleteMany-everything the
    // victim's code is gone at this exact point.
    await issueCode(USER, 'email');

    expect(await verifyCode(USER, victimsCode, 'email')).toBe(true);
  });

  it('still bounds how many codes are alive at once', async () => {
    const first = await issueCode(USER, 'email');
    await issueCode(USER, 'email');
    await issueCode(USER, 'email');
    await issueCode(USER, 'email');

    // Three live at most, oldest retired first — so the table cannot grow per
    // user without bound and the guessing surface stays 3-in-a-million.
    expect(live().length).toBe(3);
    expect(await verifyCode(USER, first, 'email')).toBe(false);
  });

  it('the newest code still works, which is the ordinary case', async () => {
    await issueCode(USER, 'email');
    const newest = await issueCode(USER, 'email');

    expect(await verifyCode(USER, newest, 'email')).toBe(true);
  });
});

describe('holding more than one code buys an attacker no extra guesses', () => {
  it('spends a failed attempt against every live code', async () => {
    const a = await issueCode(USER, 'email');
    await issueCode(USER, 'email');
    await issueCode(USER, 'email');

    // Five wrong guesses is the per-user budget, and it must stay the per-user
    // budget however many codes are outstanding.
    for (let i = 0; i < 5; i++) {
      expect(await verifyCode(USER, '000000', 'email')).toBe(false);
    }

    expect(await verifyCode(USER, a, 'email')).toBe(false);
    expect(live().length).toBe(0);
  });

  it('a consumed code cannot be replayed', async () => {
    const code = await issueCode(USER, 'email');

    expect(await verifyCode(USER, code, 'email')).toBe(true);
    expect(await verifyCode(USER, code, 'email')).toBe(false);
  });
});

describe('channels are isolated', () => {
  it('a password_reset code is not redeemable as an email OTP', async () => {
    // Load-bearing, not tidiness: POST /auth/verify is public, takes a bare
    // user_id plus a six-digit code on channel 'email', and mints a seven-day
    // session. A reset code on that channel would be a password-free login.
    const resetCode = await issueCode(USER, 'password_reset');

    expect(await verifyCode(USER, resetCode, 'email')).toBe(false);
    expect(await verifyCode(USER, resetCode, 'password_reset')).toBe(true);
  });

  it('issuing on one channel does not retire codes on the other', async () => {
    const emailCode = await issueCode(USER, 'email');
    await issueCode(USER, 'password_reset');
    await issueCode(USER, 'password_reset');
    await issueCode(USER, 'password_reset');

    expect(await verifyCode(USER, emailCode, 'email')).toBe(true);
  });
});
