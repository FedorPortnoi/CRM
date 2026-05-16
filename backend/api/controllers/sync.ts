import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../services/db';

type DeltaQuery = {
  since?: string;
};

async function delta(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { since } = request.query as DeltaQuery;

  const sinceDate = since
    ? new Date(since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const orgId = request.user.org_id;

  const [contacts, deals, tasks, events] = await Promise.all([
    db.contact.findMany({
      where: { organization_id: orgId, updated_at: { gt: sinceDate } },
      orderBy: { updated_at: 'asc' },
    }),
    db.deal.findMany({
      where: { organization_id: orgId, updated_at: { gt: sinceDate } },
      orderBy: { updated_at: 'asc' },
    }),
    db.task.findMany({
      where: { organization_id: orgId, updated_at: { gt: sinceDate } },
      orderBy: { updated_at: 'asc' },
    }),
    db.calendarEvent.findMany({
      where: { organization_id: orgId, updated_at: { gt: sinceDate } },
      orderBy: { updated_at: 'asc' },
    }),
  ]);

  reply.send({
    data: { contacts, deals, tasks, events },
    meta: {
      since: sinceDate.toISOString(),
      server_time: new Date().toISOString(),
    },
  });
}

export const SyncController = { delta };
