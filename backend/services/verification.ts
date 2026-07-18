import crypto from 'node:crypto';
import { db } from './db';
import { sha256 } from './crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILED_OTP_ATTEMPTS = 5;

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

export async function issueCode(userId: string, channel: 'sms' | 'email'): Promise<string> {
  const code = generateOtp();

  await db.verificationCode.deleteMany({
    where: { user_id: userId, channel, used_at: null },
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

export async function verifyCode(userId: string, code: string, channel: 'sms' | 'email'): Promise<boolean> {
  const candidateDigest = hashCode(code);

  for (let retry = 0; retry <= MAX_FAILED_OTP_ATTEMPTS; retry++) {
    const now = new Date();
    const record = await db.verificationCode.findFirst({
      where: {
        user_id: userId,
        channel,
        used_at: null,
        expires_at: { gt: now },
      },
      select: { id: true, code_hash: true },
      orderBy: { created_at: 'desc' },
    });

    if (!record) return false;

    const { digest, failedAttempts } = parseStoredCodeHash(record.code_hash);
    if (failedAttempts >= MAX_FAILED_OTP_ATTEMPTS) {
      const invalidatedAt = new Date();
      const invalidated = await db.verificationCode.updateMany({
        where: {
          id: record.id,
          code_hash: record.code_hash,
          used_at: null,
          expires_at: { gt: invalidatedAt },
        },
        data: { used_at: invalidatedAt },
      });

      if (invalidated.count === 1) return false;
      continue;
    }

    if (digest !== candidateDigest) {
      const nextFailedAttempts = failedAttempts + 1;
      const attemptedAt = new Date();
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

      if (updated.count === 1) return false;
      continue;
    }

    const consumedAt = new Date();
    const consumed = await db.verificationCode.updateMany({
      where: {
        id: record.id,
        code_hash: record.code_hash,
        used_at: null,
        expires_at: { gt: consumedAt },
      },
      data: { used_at: consumedAt },
    });

    if (consumed.count === 1) return true;
  }

  return false;
}
