import { registerTool, type McpUser } from '../server';
import { requireMcpToolCapability } from '../validation';
import { db } from '../../services/db';
import { amoConfigured, getIntegration } from '../../services/amocrm/auth';
import {
  importFromAmo,
  previewAmoImport,
  type AmoImportCursor,
} from '../../services/amocrm/import';

async function requireConnected(orgId: string) {
  const integration = await getIntegration(orgId);
  if (!integration.connected) {
    return { ok: false as const, error: { code: 'AMO_NOT_CONNECTED', message: 'amoCRM is not connected for this organization' } };
  }
  if (integration.status === 'needs_reauth' || integration.needs_reauth_at) {
    return { ok: false as const, error: { code: 'AMO_NEEDS_REAUTH', message: 'The amoCRM connection requires manual re-authorization' } };
  }
  if (integration.status === 'paused') {
    return { ok: false as const, error: { code: 'AMO_PAUSED', message: 'The amoCRM connection is paused' } };
  }
  return { ok: true as const, integration };
}

registerTool(
  'get_amocrm_status',
  'Read the organization amoCRM connection status. Returns no OAuth tokens, client secret or authorization action.',
  { type: 'object', properties: {} },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const readErr = requireMcpToolCapability(user, 'get_amocrm_status');
    if (readErr) return readErr;

    return {
      data: { ...(await getIntegration(user.org_id)), configured: amoConfigured() },
      meta: {},
    };
  },
);

registerTool(
  'get_amocrm_sync_status',
  'Observe amoCRM sync queue health and recent job metadata without exposing payloads, conflict values or credentials',
  { type: 'object', properties: {} },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const readErr = requireMcpToolCapability(user, 'get_amocrm_sync_status');
    if (readErr) return readErr;

    const [integration, grouped, recent, conflictCount] = await Promise.all([
      getIntegration(user.org_id),
      db.amoSyncJob.groupBy({
        by: ['direction', 'status'],
        where: { organization_id: user.org_id },
        _count: { _all: true },
      }),
      db.amoSyncJob.findMany({
        where: { organization_id: user.org_id },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: {
          id: true,
          direction: true,
          entity_type: true,
          operation: true,
          status: true,
          attempts: true,
          next_attempt_at: true,
          processed_at: true,
          created_at: true,
          updated_at: true,
        },
      }),
      db.amoSyncConflict.count({ where: { organization_id: user.org_id } }),
    ]);

    return {
      data: {
        connection: integration,
        queue: grouped.map((row) => ({
          direction: row.direction,
          status: row.status,
          count: row._count._all,
        })),
        recent_jobs: recent,
        conflict_count: conflictCount,
      },
      meta: { recent_job_limit: 20 },
    };
  },
);

registerTool(
  'preview_amocrm_import',
  'Preview amoCRM funnels and first-page entity counts without writing local CRM data',
  { type: 'object', properties: {} },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const readErr = requireMcpToolCapability(user, 'preview_amocrm_import');
    if (readErr) return readErr;

    const connection = await requireConnected(user.org_id);
    if (!connection.ok) return { error: connection.error };

    try {
      return { data: await previewAmoImport(user.org_id), meta: {} };
    } catch (error) {
      return {
        error: {
          code: 'AMOCRM_PREVIEW_FAILED',
          message: error instanceof Error ? error.message : 'Could not preview amoCRM import',
        },
      };
    }
  },
);

registerTool(
  'import_amocrm',
  'Import amoCRM pipelines, stages, contacts, companies and leads into this organization. Use preview_amocrm_import first.',
  {
    type: 'object',
    properties: {
      include_leads: { type: 'boolean', default: true },
      include_companies: { type: 'boolean', default: true },
      max_records: { type: 'integer', minimum: 1, maximum: 50000 },
      cursor: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['pipelines', 'companies', 'contacts', 'leads', 'done'] },
          page: { type: 'integer', minimum: 1 },
        },
        required: ['phase', 'page'],
      },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'import_amocrm');
    if (writeErr) return writeErr;

    if (
      args.max_records !== undefined &&
      (typeof args.max_records !== 'number' || !Number.isInteger(args.max_records) || args.max_records < 1 || args.max_records > 50_000)
    ) {
      return { error: { code: 'INVALID_ARGUMENT', message: 'max_records must be an integer from 1 to 50000' } };
    }

    if (args.cursor !== undefined) {
      if (!args.cursor || typeof args.cursor !== 'object') {
        return { error: { code: 'INVALID_ARGUMENT', message: 'cursor must contain phase and page' } };
      }
      const candidate = args.cursor as Record<string, unknown>;
      const phases = ['pipelines', 'companies', 'contacts', 'leads', 'done'];
      if (!phases.includes(String(candidate.phase)) || typeof candidate.page !== 'number' || !Number.isInteger(candidate.page) || candidate.page < 1) {
        return { error: { code: 'INVALID_ARGUMENT', message: 'cursor must contain a valid phase and a positive integer page' } };
      }
    }

    const connection = await requireConnected(user.org_id);
    if (!connection.ok) return { error: connection.error };

    const rawCursor = args.cursor;
    const cursor =
      rawCursor && typeof rawCursor === 'object'
        ? (rawCursor as AmoImportCursor)
        : undefined;

    try {
      const result = await importFromAmo(user.org_id, user.sub, {
        include_leads: typeof args.include_leads === 'boolean' ? args.include_leads : undefined,
        include_companies:
          typeof args.include_companies === 'boolean' ? args.include_companies : undefined,
        max_records:
          typeof args.max_records === 'number' ? Math.floor(args.max_records) : undefined,
        cursor,
      });
      return { data: result, meta: { partial: result.partial } };
    } catch (error) {
      return {
        error: {
          code: 'AMOCRM_IMPORT_FAILED',
          message: error instanceof Error ? error.message : 'Could not import from amoCRM',
        },
      };
    }
  },
);
