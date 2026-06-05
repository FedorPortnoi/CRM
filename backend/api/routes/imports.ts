import { FastifyRequest, FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ImportsController } from '../controllers/imports';

const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  await request.jwtVerify();
};

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
      schema: { body: z.object({ phone: z.string().min(7).max(20) }) },
    },
    ImportsController.telegramSendCode,
  );

  fastify.post(
    '/telegram/verify',
    {
      preHandler: [authenticate],
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
      schema: {
        body: z.object({
          webhook_url: z.string().url(),
          include_deals: z.boolean().optional(),
        }),
      },
    },
    ImportsController.bitrix24Import,
  );

  fastify.post(
    '/vcard',
    {
      preHandler: [authenticate],
      schema: { body: z.object({ contacts: z.array(VCardContactSchema).min(1).max(5000) }) },
    },
    ImportsController.vcardImport,
  );

  fastify.post(
    '/whatsapp',
    {
      preHandler: [authenticate],
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
