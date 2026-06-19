import { FastifyRequest } from 'fastify';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function extractClientInfo(request: FastifyRequest): { ip: string; userAgent: string | null } {
  return {
    ip: request.ip,
    userAgent: firstHeader(request.headers['user-agent']) ?? null,
  };
}
