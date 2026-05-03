import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AnalyticsController } from '../controllers/analytics';

const DateRangeSchema = z.object({
  start: z.string().date().optional(),
  end: z.string().date().optional(),
  period: z.enum(['today', 'week', 'month', 'quarter', 'year', 'custom']).default('month'),
  pipeline_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
});

const RevenueSchema = DateRangeSchema.extend({
  group_by: z.enum(['day', 'week', 'month', 'quarter']).default('month'),
  currency: z.string().length(3).default('USD'),
});

const ExportSchema = z.object({
  format: z.enum(['csv', 'pdf']),
  report: z.enum(['funnel', 'revenue', 'team_activity', 'win_loss', 'lead_sources']),
  ...DateRangeSchema.shape,
});

const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

export default async function analyticsRoutes(fastify: FastifyInstance) {
  const f = fastify.withTypeProvider<ZodTypeProvider>();

  f.get('/dashboard', { preHandler: [authenticate] }, AnalyticsController.dashboard);

  f.get('/funnel', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.funnel);

  f.get('/conversion-rates', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.conversionRates);

  f.get('/stage-duration', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.stageDuration);

  f.get('/lead-sources', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.leadSources);

  f.get('/win-loss', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.winLoss);

  f.get('/revenue', {
    preHandler: [authenticate],
    schema: { querystring: RevenueSchema },
  }, AnalyticsController.revenue);

  f.get('/team-activity', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.teamActivity);

  f.get('/rep-performance', {
    preHandler: [authenticate],
    schema: { querystring: DateRangeSchema },
  }, AnalyticsController.repPerformance);

  f.post('/export', {
    preHandler: [authenticate],
    schema: { body: ExportSchema },
  }, AnalyticsController.exportReport);

  f.get('/export/:job_id/status', { preHandler: [authenticate] }, AnalyticsController.exportStatus);
  f.get('/export/:job_id/download', { preHandler: [authenticate] }, AnalyticsController.exportDownload);
}
