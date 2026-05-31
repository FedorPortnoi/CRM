import { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from './db';

type AuditOutcome = 'success' | 'failure' | 'denied';

type AuditInput = {
  action: string;
  outcome?: AuditOutcome;
  request?: FastifyRequest;
  organizationId?: string | null;
  userId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

type AuditListInput = {
  organizationId: string;
  action?: string;
  outcome?: string;
  userId?: string;
  start?: Date;
  end?: Date;
  page: number;
  perPage: number;
};

type AuditEventRow = {
  id: string;
  organization_id: string | null;
  user_id: string | null;
  action: string;
  outcome: string;
  target_type: string | null;
  target_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Prisma.JsonValue | null;
  created_at: Date;
};

type AuditCountRow = {
  total: bigint;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestUser(request: FastifyRequest | undefined): { sub?: string; org_id?: string } | undefined {
  return request?.user as { sub?: string; org_id?: string } | undefined;
}

export async function auditLog(input: AuditInput): Promise<void> {
  try {
    const user = requestUser(input.request);
    const metadata = input.metadata === undefined ? null : JSON.stringify(input.metadata);
    await db.$executeRaw`
      INSERT INTO "AuditEvent" (
        organization_id,
        user_id,
        action,
        outcome,
        target_type,
        target_id,
        ip_address,
        user_agent,
        metadata
      )
      VALUES (
        ${input.organizationId ?? user?.org_id ?? null}::uuid,
        ${input.userId ?? user?.sub ?? null}::uuid,
        ${input.action},
        ${input.outcome ?? 'success'},
        ${input.targetType ?? null},
        ${input.targetId ?? null},
        ${input.request?.ip ?? null},
        ${firstHeader(input.request?.headers?.['user-agent']) ?? null},
        CAST(${metadata} AS jsonb)
      )
    `;
  } catch (err: unknown) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[audit] failed to write audit event', err);
    }
  }
}

function actionForSensitiveRequest(request: FastifyRequest): string | null {
  const path = request.url.split('?')[0] ?? request.url;
  const method = request.method.toUpperCase();

  if (method === 'DELETE') {
    return 'api.delete';
  }

  if (method === 'POST' && path === '/api/v1/analytics/export') {
    return 'data.export';
  }

  if (method === 'GET' && path.startsWith('/api/v1/export/')) {
    return 'data.export';
  }

  return null;
}

export async function auditSensitiveApiRequest(
  request: FastifyRequest,
  statusCode: number,
): Promise<void> {
  const action = actionForSensitiveRequest(request);
  if (!action) {
    return;
  }

  await auditLog({
    action,
    outcome: statusCode < 400 ? 'success' : 'failure',
    request,
    metadata: {
      method: request.method.toUpperCase(),
      path: request.url.split('?')[0] ?? request.url,
      status_code: statusCode,
    },
  });
}

export async function listAuditEvents(input: AuditListInput): Promise<{
  data: AuditEventRow[];
  total: number;
}> {
  const filters: Prisma.Sql[] = [
    Prisma.sql`organization_id = ${input.organizationId}::uuid`,
  ];

  if (input.action) {
    filters.push(Prisma.sql`action = ${input.action}`);
  }

  if (input.outcome) {
    filters.push(Prisma.sql`outcome = ${input.outcome}`);
  }

  if (input.userId) {
    filters.push(Prisma.sql`user_id = ${input.userId}::uuid`);
  }

  if (input.start) {
    filters.push(Prisma.sql`created_at >= ${input.start}`);
  }

  if (input.end) {
    filters.push(Prisma.sql`created_at <= ${input.end}`);
  }

  const whereClause = Prisma.join(filters, ' AND ');
  const skip = (input.page - 1) * input.perPage;

  const [data, countRows] = await Promise.all([
    db.$queryRaw<AuditEventRow[]>`
      SELECT
        id::text,
        organization_id::text,
        user_id::text,
        action,
        outcome,
        target_type,
        target_id,
        ip_address,
        user_agent,
        metadata,
        created_at
      FROM "AuditEvent"
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${input.perPage}
      OFFSET ${skip}
    `,
    db.$queryRaw<AuditCountRow[]>`
      SELECT COUNT(*) AS total
      FROM "AuditEvent"
      WHERE ${whereClause}
    `,
  ]);

  return {
    data,
    total: Number(countRows[0]?.total ?? 0),
  };
}
