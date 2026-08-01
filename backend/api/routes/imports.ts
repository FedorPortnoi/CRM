import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ImportsController } from '../controllers/imports';
import { authenticate } from '../preHandlers';

const VCardContactSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  company: z.string().optional(),
});

const importsRoutes: FastifyPluginAsyncZod = async (fastify: import('fastify').FastifyInstance) => {
  fastify.post(
    '/telegram/send-code',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
      schema: { body: z.object({ phone: z.string().min(7).max(20) }) },
    },
    ImportsController.telegramSendCode,
  );

  fastify.post(
    '/telegram/verify',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
      schema: {
        body: z.object({
          phone: z.string().min(7).max(20),
          code: z.string().min(4).max(10),
          phoneCodeHash: z.string().min(1),
        }),
      },
    },
    ImportsController.telegramVerify,
  );

  fastify.post(
    '/bitrix24',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        body: z.object({
          webhook_url: z.string().url(),
          include_deals: z.boolean().optional(),
        }),
      },
    },
    ImportsController.bitrix24Import,
  );

  // ── amoCRM (Tier 1: one-time import) ───────────────────────────────────────
  //
  // Same rate limit as the Bitrix24 import: this walks a whole account at amoCRM's
  // 7 req/s ceiling, and repeated limit violations get the customer's amoCRM
  // account blocked outright (HTTP 403 on everything), not just throttled.
  fastify.post(
    '/amocrm',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        body: z.object({
          include_leads: z.boolean().optional(),
          include_companies: z.boolean().optional(),
          // Bound for ONE invocation. A large account needs several calls; each
          // response carries the cursor for the next one.
          max_records: z.number().int().min(1).max(50_000).optional(),
          cursor: z
            .object({
              phase: z.enum(['pipelines', 'companies', 'contacts', 'leads', 'done']),
              page: z.number().int().min(1),
            })
            .optional(),
        }),
      },
    },
    ImportsController.amocrmImport,
  );

  // Read-only: shows the funnel mapping and first-page counts so a user can look
  // before committing. Writes nothing, so it gets a looser limit than the import.
  fastify.get(
    '/amocrm/preview',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    ImportsController.amocrmPreview,
  );

  fastify.post(
    '/vcard',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: { body: z.object({ contacts: z.array(VCardContactSchema).min(1).max(5000) }) },
    },
    ImportsController.vcardImport,
  );

  fastify.post(
    '/whatsapp',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        body: z.object({
          contacts: z.array(z.object({
            name: z.string().min(1),
            phone: z.string().optional(),
            message_count: z.number().optional(),
          })).min(1).max(5000),
        }),
      },
    },
    ImportsController.whatsappImport,
  );
};

export default importsRoutes;
