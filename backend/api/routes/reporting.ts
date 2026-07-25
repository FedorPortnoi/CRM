import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ReportingController } from '../controllers/reporting';
import { normalizeCurrencyCode } from '../../config/market';
import { REPORT_PERIODS, REVENUE_GRANULARITIES } from '../../services/reporting';
import { authenticate } from '../preHandlers';

const DateBoundarySchema = z.union([z.string().date(), z.string().datetime()]);

const ReportRangeSchema = z.object({
  period: z.enum(REPORT_PERIODS).optional(),
  date_from: DateBoundarySchema.optional(),
  date_to: DateBoundarySchema.optional(),
  pipeline_id: z.string().uuid().optional(),
  scope: z.enum(['direct', 'subtree']).optional(),
});

const RevenueQuerySchema = ReportRangeSchema.extend({
  granularity: z.enum(REVENUE_GRANULARITIES).default('month'),
  currency: z.string().trim().length(3).transform(normalizeCurrencyCode).optional(),
});

export default async function reportingRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/funnel', {
    preHandler: [authenticate],
    schema: { querystring: ReportRangeSchema },
  }, ReportingController.funnel);

  f.get('/reps', {
    preHandler: [authenticate],
    schema: { querystring: ReportRangeSchema },
  }, ReportingController.reps);

  f.get('/win-loss', {
    preHandler: [authenticate],
    schema: { querystring: ReportRangeSchema },
  }, ReportingController.winLoss);

  f.get('/revenue', {
    preHandler: [authenticate],
    schema: { querystring: RevenueQuerySchema },
  }, ReportingController.revenue);

  f.get('/pipeline-health', {
    preHandler: [authenticate],
    schema: { querystring: ReportRangeSchema },
  }, ReportingController.pipelineHealth);
}
