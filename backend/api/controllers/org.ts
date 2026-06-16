import { FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';

async function getOrgSettings(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const org = await db.org.findUniqueOrThrow({
    where: { id: request.user.org_id },
    select: { id: true, name: true, slug: true, settings: true },
  });
  reply.send({ data: org, meta: {} });
}

async function updateOrgSettings(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { role } = request.user;
  if (role !== 'owner' && role !== 'admin') {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Only owner or admin can update org settings' } });
    return;
  }

  const body = request.body as { monthly_revenue_target?: number | null };

  const existing = await db.org.findUniqueOrThrow({
    where: { id: request.user.org_id },
    select: { settings: true },
  });

  const current = (existing.settings as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...current };

  if ('monthly_revenue_target' in body) {
    if (body.monthly_revenue_target === null || body.monthly_revenue_target === undefined) {
      delete merged.monthly_revenue_target;
    } else {
      merged.monthly_revenue_target = body.monthly_revenue_target;
    }
  }

  const updated = await db.org.update({
    where: { id: request.user.org_id },
    data: { settings: merged as Prisma.InputJsonValue },
    select: { id: true, name: true, settings: true },
  });

  reply.send({ data: updated, meta: {} });
}

export const OrgController = { getOrgSettings, updateOrgSettings };
