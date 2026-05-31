import { FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';

// --- Types -------------------------------------------------------------------

type ListQuery = {
  entity_type?: string;
  entity_id?: string;
  page?: number;
  per_page?: number;
};

// --- Handlers ----------------------------------------------------------------

export async function listActivities(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await request.jwtVerify();

  const { entity_type, entity_id, page = 1, per_page = 20 } = request.query as ListQuery;

  if (!entity_type || typeof entity_type !== 'string') {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'entity_type is required' },
    });
    return;
  }

  if (!entity_id || typeof entity_id !== 'string') {
    reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'entity_id is required' },
    });
    return;
  }

  const pageNum = Number(page);
  const perPageNum = Number(per_page);
  const skip = (pageNum - 1) * perPageNum;

  const where = {
    organization_id: request.user.org_id,
    entity_type,
    entity_id,
  };

  const [logs, total] = await Promise.all([
    db.activityLog.findMany({
      where,
      skip,
      take: perPageNum,
      orderBy: { created_at: 'desc' },
    }),
    db.activityLog.count({ where }),
  ]);

  reply.send({ data: logs, meta: { total, page: pageNum, per_page: perPageNum } });
}

// --- Helper ------------------------------------------------------------------

export async function logActivity(params: {
  organizationId: string;
  userId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  changes?: Record<string, unknown>;
}): Promise<void> {
  await db.activityLog.create({
    data: {
      organization_id: params.organizationId,
      user_id: params.userId ?? undefined,
      entity_type: params.entityType,
      entity_id: params.entityId,
      action: params.action,
      changes: params.changes as Prisma.InputJsonValue ?? undefined,
    },
  });
}

