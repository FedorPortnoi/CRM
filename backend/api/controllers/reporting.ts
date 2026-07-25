import { FastifyRequest, FastifyReply } from 'fastify';
import {
  getPipelineHealth,
  getRepPerformance,
  getRevenueOverTime,
  getSalesFunnel,
  getWinLossAnalysis,
  type ReportQuery,
  type RevenueQuery,
} from '../../services/reporting';

// Every handler is a thin wrapper: the service owns org scoping, the visibility cone and the
// aggregation, and already returns the `{ data, meta }` envelope.

async function funnel(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await getSalesFunnel(request.user, request.query as ReportQuery));
}

async function reps(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await getRepPerformance(request.user, request.query as ReportQuery));
}

async function winLoss(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await getWinLossAnalysis(request.user, request.query as ReportQuery));
}

async function revenue(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await getRevenueOverTime(request.user, request.query as RevenueQuery));
}

async function pipelineHealth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.send(await getPipelineHealth(request.user, request.query as ReportQuery));
}

export const ReportingController = {
  funnel,
  reps,
  winLoss,
  revenue,
  pipelineHealth,
};
