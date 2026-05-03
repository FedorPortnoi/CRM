import { FastifyRequest, FastifyReply } from 'fastify';

export const CalendarController = {
  list: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  create: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  getAvailability: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  getById: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  update: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  cancel: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  addPostMeetingNotes: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  markCompleted: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  googleOAuthStart: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  googleOAuthCallback: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  googleDisconnect: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  syncStatus: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
  googleWebhook: async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(501).send({ error: 'Not implemented' });
  },
};
