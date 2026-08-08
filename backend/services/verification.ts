import crypto from 'node:crypto';
import { db } from './db';
import { sha256 } from './crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILED_OTP_ATTEMPTS = 5;

/**
 * HOW MANY UNUSED CODES MAY BE ALIVE FOR ONE USER AND CHANNEL AT ONCE.
 *
 * This used to be one, enforced by `deleteMany({ user_id, channel, used_at: null })`
 * at the top of issueCode — every issuance destroyed whatever was outstanding.
 * On an UNAUTHENTICATED endpoint (POST /auth/verify/resend takes a bare user_id
 * and nothing else) that is a remote kill switch: a stranger who holds a
 * colleague's id — GET /auth/users hands them out to every org member — could
 * call resend on a five-minute tick and the victim's code was already gone by
 * the time they finished typing it. They could never verify, and since
 * requiresEmailVerification() now gates every authenticated request, never
 * verifying means never getting into the product at all.
 *
 * Keeping a small window of codes alive removes the kill switch: an attacker's
 * resend no longer invalidates the victim's code, it only queues behind it.
 * The guessing surface does NOT grow with the count, because verifyCode spends a
 * failed attempt against EVERY live code — five wrong guesses still kill all of
 * them, exactly as before.
 *
 * Three, not thirty: the oldest are still retired, so the table cannot grow per
 * user without bound, and 3/1e6 is the same order of magnitude as 1/1e6.
 */
const MAX_LIVE_CODES = 3;

/**
 * Which flow a code belongs to. Codes are scoped by channel on every query, so a
 * code minted for one flow can never be redeemed by another.
 *
 * That isolation is load-bearing, not tidiness: POST /auth/verify is PUBLIC,
 * takes a bare user_id plus a six-digit code on channel 'email', and mints a
 * full seven-day session on success. A password-reset code issued on 'email'
 * would therefore be redeemable there for a session on any account that is not
 * yet verified. 'password_reset' is a separate channel for exactly that reason.
 */
export type VerificationChannel = 'email' | 'password_reset';

export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return sha256(code);
}

function parseStoredCodeHash(value: string): { digest: string; failedAttempts: number } {
  const separatorIndex = value.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { digest: value, failedAttempts: 0 };
  }

  const rawAttempts = value.slice(separatorIndex + 1);
  const failedAttempts = /^\d+$/.test(rawAttempts)
    ? Number.parseInt(rawAttempts, 10)
    : MAX_FAILED_OTP_ATTEMPTS;
  return { digest: value.slice(0, separatorIndex), failedAttempts };
}

export async function issueCode(userId: string, channel: VerificationChannel): Promise<string> {
  const code = generateOtp();
  const now = new Date();

  // Retire only what has to be retired: everything already expired, plus the
  // oldest live codes beyond MAX_LIVE_CODES - 1 so the new one fits. The
  // still-valid code the user is holding right now is the newest and survives.
  const live = await db.verificationCode.findMany({
    where: { user_id: userId, channel, used_at: null, expires_at: { gt: now } },
    select: { id: true },
    orderBy: { created_at: 'desc' },
  });
  const doomed = live.slice(Math.max(0, MAX_LIVE_CODES - 1)).map((row) => row.id);

  await db.verificationCode.deleteMany({
    where: {
      user_id: userId,
      channel,
      used_at: null,
      OR: [{ id: { in: doomed } }, { expires_at: { lte: now } }],
    },
  });

  await db.verificationCode.create({
    data: {
      user_id: userId,
      code_hash: `${hashCode(code)}:0`,
      channel,
      expires_at: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  return code;
}

export async function verifyCode(
  userId: string,
  code: string,
  channel: VerificationChannel,
): Promise<boolean> {
  const candidateDigest = hashCode(code);

  for (let retry = 0; retry <= MAX_FAILED_OTP_ATTEMPTS; retry++) {
    const now = new Date();
    const records = await db.verificationCode.findMany({
      where: {
        user_id: userId,
        channel,
        used_at: null,
        expires_at: { gt: now },
      },
      select: { id: true, code_hash: true },
      orderBy: { created_at: 'desc' },
      take: MAX_LIVE_CODES,
    });

    if (records.length === 0) return false;

    const match = records.find((record) => {
      const { digest, failedAttempts } = parseStoredCodeHash(record.code_hash);
      return digest === candidateDigest && failedAttempts < MAX_FAILED_OTP_ATTEMPTS;
    });

    if (match) {
      const consumedAt = new Date();
      const consumed = await db.verificationCode.updateMany({
        where: {
          id: match.id,
          code_hash: match.code_hash,
          used_at: null,
          expires_at: { gt: consumedAt },
        },
        data: { used_at: consumedAt },
      });

      if (consumed.count === 1) return true;
      // Someone else moved the row between the read and the write. Re-read.
      continue;
    }

    // Wrong code (or one whose attempts are already spent). The attempt is
    // charged against EVERY live code, so the per-user guess budget stays at
    // MAX_FAILED_OTP_ATTEMPTS however many codes are outstanding — holding more
    // than one code alive must not buy an attacker more guesses.
    const attemptedAt = new Date();
    let progressed = 0;
    for (const record of records) {
      const { digest, failedAttempts } = parseStoredCodeHash(record.code_hash);
      const nextFailedAttempts = failedAttempts + 1;
      const updated = await db.verificationCode.updateMany({
        where: {
          id: record.id,
          code_hash: record.code_hash,
          used_at: null,
          expires_at: { gt: attemptedAt },
        },
        data: nextFailedAttempts >= MAX_FAILED_OTP_ATTEMPTS
          ? { used_at: attemptedAt }
          : { code_hash: `${digest}:${nextFailedAttempts}` },
      });
      progressed += updated.count;
    }

    if (progressed > 0) return false;
    // Every row moved under us; re-read and try again.
  }

  return false;
}
