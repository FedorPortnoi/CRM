import crypto from 'node:crypto';
import { db } from './db';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export async function issueCode(userId: string, channel: 'sms' | 'email'): Promise<string> {
  const code = generateOtp();

  await db.verificationCode.deleteMany({
    where: { user_id: userId, channel, used_at: null },
  });

  await db.verificationCode.create({
    data: {
      user_id: userId,
      code_hash: hashCode(code),
      channel,
      expires_at: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  return code;
}

export async function verifyCode(userId: string, code: string, channel: 'sms' | 'email'): Promise<boolean> {
  const record = await db.verificationCode.findFirst({
    where: {
      user_id: userId,
      channel,
      code_hash: hashCode(code),
      used_at: null,
      expires_at: { gt: new Date() },
    },
  });

  if (!record) return false;

  await db.verificationCode.update({
    where: { id: record.id },
    data: { used_at: new Date() },
  });

  return true;
}
