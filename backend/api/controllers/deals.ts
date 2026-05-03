import { FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '../../services/db';

export const DealsController = {
  list: async (request: FastifyRequest, reply: FastifyReply) => {
    const { pipeline_id, stage_id, assigned_to, status, contact_id, q, page, per_page, sort, order } =
      request.query as {
        pipeline_id?: string;
        stage_id?: string;
        assigned_to?: string;
        status?: 'open' | 'won' | 'lost' | 'archived';
        contact_id?: string;
        q?: string;
        page: number;
        per_page: number;
        sort: 'created_at' | 'updated_at' | 'value' | 'expected_close' | 'title';
        order: 'asc' | 'desc';
      };

    const where: Prisma.DealWhereInput = {
      organization_id: request.user.org_id,
      ...(pipeline_id && { pipeline_id }),
      ...(stage_id && { stage_id }),
      ...(assigned_to && { assigned_to }),
      ...(status && { status }),
      ...(contact_id && { contact_id }),
      ...(q && { title: { contains: q, mode: 'insensitive' } }),
    };

    const [deals, total] = await Promise.all([
      db.deal.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { [sort]: order },
        include: { contact: { select: { id: true, first_name: true, last_name: true } } },
      }),
      db.deal.count({ where }),
    ]);

    return reply.send({ data: deals, meta: { total, page, per_page } });
  },

  create: async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      title: string;
      contact_id: string;
      pipeline_id: string;
      stage_id: string;
      value?: number;
      currency: string;
      expected_close?: string;
      probability?: number;
      source?: string;
      assigned_to?: string;
      custom_fields?: Record<string, unknown>;
    };

    const deal = await db.deal.create({
      data: {
        title: body.title,
        contact_id: body.contact_id,
        pipeline_id: body.pipeline_id,
        stage_id: body.stage_id,
        value: body.value,
        currency: body.currency,
        expected_close: body.expected_close ? new Date(body.expected_close) : undefined,
        probability: body.probability,
        source: body.source,
        assigned_to: body.assigned_to,
        custom_fields: body.custom_fields,
        organization_id: request.user.org_id,
        created_by: request.user.sub,
      },
      include: { contact: { select: { id: true, first_name: true, last_name: true } } },
    });

    return reply.code(201).send({ data: deal });
  },

  getById: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  update: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  archive: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  moveStage: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  markWon: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  markLost: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  listPipelines: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  createPipeline: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  getPipeline: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  updatePipeline: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  deletePipeline: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  listStages: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  createStage: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  updateStage: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  deleteStage: async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
};
