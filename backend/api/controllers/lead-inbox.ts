/**
 * Controller for the lead-inbox integration (Яндекс Бизнес «Заявки» → воронка).
 *
 * Same double gate as the amoCRM surface: adminRoutePolicy in api/authenticate.ts
 * answers first (and audits the denial), and every handler re-asks
 * `integrations.manage` here so the gate holds even if a route is ever mounted
 * past the policy chain.
 */

import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '../../services/capabilities';
import {
  LeadInboxError,
  deleteLeadInbox,
  getLeadInboxStatus,
  testLeadInbox,
  upsertLeadInbox,
} from '../../services/lead-inbox';

function requireIntegrationsManage(request: FastifyRequest, reply: FastifyReply): boolean {
  if (can(request.user?.role, 'integrations.manage')) {
    return true;
  }

  reply.status(403).send({
    error: {
      code: 'FORBIDDEN',
      message: 'Managing the lead inbox requires owner or admin',
    },
  });
  return false;
}

function sendDomainError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof LeadInboxError) {
    reply.status(error.httpStatus).send({
      error: { code: error.code, message: error.message },
    });
    return true;
  }
  return false;
}

const UpsertSchema = z
  .object({
    // Omitted entirely → collector mode: the server answers with a ready-made
    // intake address and the org never touches mail credentials.
    mode: z.enum(['collector', 'custom']).optional(),
    imap_host: z.string().trim().min(1).max(255).optional(),
    imap_port: z.number().int().min(1).max(65_535).optional(),
    imap_user: z.string().trim().min(3).max(255).optional(),
    imap_password: z.string().min(1).max(1_024).optional(),
    pipeline_id: z.string().uuid().nullish(),
    stage_id: z.string().uuid().nullish(),
    assigned_to: z.string().uuid().nullish(),
    source_label: z.string().trim().min(1).max(100).optional(),
    paused: z.boolean().optional(),
  })
  .strict();

async function status(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;
  const view = await getLeadInboxStatus(request.user.org_id);
  reply.send({ data: view, meta: {} });
}

async function upsert(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;

  const parsed = UpsertSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
        details: parsed.error.issues,
      },
    });
    return;
  }

  try {
    const view = await upsertLeadInbox(request.user.org_id, request.user.sub, parsed.data);
    reply.send({ data: view, meta: {} });
  } catch (error) {
    if (!sendDomainError(reply, error)) {
      throw error;
    }
  }
}

async function remove(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;

  try {
    await deleteLeadInbox(request.user.org_id);
    reply.send({ data: { deleted: true }, meta: {} });
  } catch (error) {
    if (!sendDomainError(reply, error)) {
      throw error;
    }
  }
}

/**
 * «Проверить подключение»: one immediate poll. A connection failure is a 200
 * with `ok: false` — from the app's perspective the test ran and produced an
 * answer; only a missing configuration is an error status.
 */
async function test(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireIntegrationsManage(request, reply)) return;

  try {
    const result = await testLeadInbox(request.user.org_id);
    reply.send({ data: result, meta: {} });
  } catch (error) {
    if (!sendDomainError(reply, error)) {
      throw error;
    }
  }
}

export const LeadInboxController = { status, upsert, remove, test };
