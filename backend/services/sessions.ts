import crypto from 'crypto';
import { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { sha256 } from './crypto';
import { extractClientInfo } from './request-utils';

type SessionRequestInput = {
  request: FastifyRequest;
  userId: string;
  organizationId: string;
  expiresIn?: string;
};

type SessionValidationInput = {
  sessionId: string;
  userId: string;
  organizationId: string;
};

type ActiveSession = {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  last_seen_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
};

function sessionHash(sessionId: string): string {
  return sha256(sessionId);
}

function parseDurationMs(value: string): number | null {
  const match = value.trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2]?.toLowerCase() ?? 's';
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return amount * multipliers[unit];
}

function sessionExpiresAt(expiresIn = process.env.JWT_EXPIRES_IN ?? '7d'): Date | undefined {
  const durationMs = parseDurationMs(expiresIn);
  return durationMs ? new Date(Date.now() + durationMs) : undefined;
}

export async function createAuthSession(input: SessionRequestInput): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const { ip, userAgent } = extractClientInfo(input.request);
  await db.$executeRaw`
    INSERT INTO "AuthSession" (
      id,
      organization_id,
      user_id,
      token_hash,
      ip_address,
      user_agent,
      last_seen_at,
      expires_at,
      updated_at
    )
    VALUES (
      ${sessionId}::uuid,
      ${input.organizationId}::uuid,
      ${input.userId}::uuid,
      ${sessionHash(sessionId)},
      ${ip},
      ${userAgent},
      ${now},
      ${sessionExpiresAt(input.expiresIn) ?? null},
      ${now}
    )
  `;

  return sessionId;
}

export async function validateAuthSession(input: SessionValidationInput): Promise<boolean> {
  const now = new Date();
  const sessions = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "AuthSession"
    WHERE token_hash = ${sessionHash(input.sessionId)}
      AND user_id = ${input.userId}::uuid
      AND organization_id = ${input.organizationId}::uuid
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${now})
    LIMIT 1
  `;
  const session = sessions[0];

  if (!session) {
    return false;
  }

  await db.$executeRaw`
    UPDATE "AuthSession"
    SET last_seen_at = ${now}, updated_at = ${now}
    WHERE id = ${session.id}::uuid AND revoked_at IS NULL
  `;

  return true;
}

async function revokeWhere(where: Prisma.Sql, reason: string): Promise<number> {
  const now = new Date();
  return db.$executeRaw(Prisma.sql`
    UPDATE "AuthSession"
    SET revoked_at = ${now}, revoked_reason = ${reason}, updated_at = ${now}
    WHERE ${where}
      AND revoked_at IS NULL
  `);
}

export async function revokeAuthSession(
  sessionId: string,
  userId: string,
  organizationId: string,
  reason: string,
): Promise<number> {
  return revokeWhere(
    Prisma.sql`token_hash = ${sessionHash(sessionId)}
      AND user_id = ${userId}::uuid
      AND organization_id = ${organizationId}::uuid`,
    reason,
  );
}

export async function revokeAllUserSessions(
  userId: string,
  organizationId: string,
  reason: string,
): Promise<number> {
  return revokeWhere(
    Prisma.sql`user_id = ${userId}::uuid
      AND organization_id = ${organizationId}::uuid`,
    reason,
  );
}

export async function listActiveUserSessions(userId: string, organizationId: string): Promise<ActiveSession[]> {
  return db.$queryRaw<ActiveSession[]>`
    SELECT id, user_agent, ip_address, last_seen_at, expires_at, created_at
    FROM "AuthSession"
    WHERE user_id = ${userId}::uuid
      AND organization_id = ${organizationId}::uuid
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${new Date()})
    ORDER BY created_at DESC
  `;
}
