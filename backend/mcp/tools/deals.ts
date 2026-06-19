import { DealStatus, WorkflowTrigger } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';
import { requireMcpWrite } from '../validation';
import { DEFAULT_CURRENCY, normalizeCurrencyCode } from '../../config/market';
import { evaluateWorkflows } from '../../services/workflows';
import { logActivity } from '../../api/controllers/activities';
import { dispatchNotification, dealCtx } from '../../services/notificationEngine';
import {
  listDealsForUser,
  getDealForUser,
  createDealForUser,
  updateDealForUser,
  DealDomainError,
} from '../../services/deal-domain';

type DealStatusValue = 'open' | 'won' | 'lost' | 'archived';

function isDealStatus(v: unknown): v is DealStatusValue {
  return v === 'open' || v === 'won' || v === 'lost' || v === 'archived';
}

// ─── get_deals ────────────────────────────────────────────────────────────────

registerTool(
  'get_deals',
  'List deals for the authenticated org with optional filters',
  {
    type: 'object',
    properties: {
      pipeline_id: { type: 'string', description: 'Filter by pipeline UUID' },
      stage_id: { type: 'string', description: 'Filter by stage UUID' },
      assigned_to: { type: 'string', description: 'Filter by assigned user UUID' },
      status: { type: 'string', enum: ['open', 'won', 'lost', 'archived'] },
      contact_id: { type: 'string', description: 'Filter by contact UUID' },
      q: { type: 'string', description: 'Search by deal title' },
      page: { type: 'integer', default: 1 },
      per_page: { type: 'integer', default: 20, maximum: 100 },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : undefined;
    const stage_id = typeof args.stage_id === 'string' ? args.stage_id : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;
    const status = isDealStatus(args.status) ? args.status : undefined;
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : undefined;
    const q = typeof args.q === 'string' ? args.q : undefined;
    const page = typeof args.page === 'number' ? Math.max(1, Math.floor(args.page)) : 1;
    const per_page = typeof args.per_page === 'number' ? Math.min(100, Math.max(1, Math.floor(args.per_page))) : 20;

    // McpUser.role is a plain string from the JWT; cast to the Requester shape
    // that getVisibleUserIds expects.  The visibility service validates role
    // values at runtime; unknown roles fall through to the member branch.
    const requester = user as { sub: string; org_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' };

    const { data: deals, total } = await listDealsForUser(
      user.org_id,
      requester,
      { pipeline_id, stage_id, assigned_to, status, contact_id, q, page, per_page },
    );

    return { data: deals, meta: { total, page, per_page } };
  },
);

// ─── get_deal ─────────────────────────────────────────────────────────────────

registerTool(
  'get_deal',
  'Get a single deal by ID',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal UUID' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    try {
      const deal = await getDealForUser(id, user.org_id);
      return { data: deal };
    } catch (err) {
      if (err instanceof DealDomainError) {
        return { error: { code: err.domainError.code, message: err.domainError.message } };
      }
      throw err;
    }
  },
);

// ─── create_deal ──────────────────────────────────────────────────────────────

registerTool(
  'create_deal',
  'Create a new deal in the org',
  {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Deal title' },
      contact_id: { type: 'string', description: 'Contact UUID' },
      pipeline_id: { type: 'string', description: 'Pipeline UUID' },
      stage_id: { type: 'string', description: 'Stage UUID (must belong to the pipeline)' },
      currency: { type: 'string', description: `ISO currency code; defaults to ${DEFAULT_CURRENCY}` },
      value: { type: 'number', description: 'Deal value' },
      expected_close: { type: 'string', description: 'Expected close date (ISO 8601)' },
      probability: { type: 'number', description: 'Win probability 0-100' },
      source: { type: 'string' },
      assigned_to: { type: 'string', description: 'User UUID to assign to' },
    },
    required: ['title', 'contact_id', 'pipeline_id', 'stage_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const title = typeof args.title === 'string' ? args.title : '';
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : '';
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : '';
    const stage_id = typeof args.stage_id === 'string' ? args.stage_id : '';
    const currency = typeof args.currency === 'string'
      ? normalizeCurrencyCode(args.currency)
      : DEFAULT_CURRENCY;
    const value = typeof args.value === 'number' ? args.value : undefined;
    const expected_close = typeof args.expected_close === 'string' ? args.expected_close : undefined;
    const probability = typeof args.probability === 'number' ? args.probability : undefined;
    const source = typeof args.source === 'string' ? args.source : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;

    try {
      const deal = await createDealForUser(user.org_id, user.sub, {
        title,
        contact_id,
        pipeline_id,
        stage_id,
        currency,
        value,
        expected_close,
        probability,
        source,
        assigned_to,
      });
      return { data: deal };
    } catch (err) {
      if (err instanceof DealDomainError) {
        return { error: { code: err.domainError.code, message: err.domainError.message } };
      }
      throw err;
    }
  },
);

// ─── update_deal ──────────────────────────────────────────────────────────────

registerTool(
  'update_deal',
  'Update fields on an existing deal',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal UUID' },
      title: { type: 'string' },
      value: { type: 'number' },
      currency: { type: 'string' },
      expected_close: { type: 'string', description: 'ISO 8601 date or null to clear' },
      probability: { type: 'number' },
      source: { type: 'string' },
      assigned_to: { type: 'string' },
      stage_id: { type: 'string', description: 'Stage UUID (must belong to the deal pipeline)' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';

    // Build a patch that matches UpdateDealInput.  Null value/expected_close
    // clears the field; undefined means "not provided / leave as-is".
    const patch: Record<string, unknown> = {};
    if (typeof args.title === 'string') patch.title = args.title;
    if (typeof args.value === 'number') patch.value = args.value;
    if (args.value === null) patch.value = null;
    if (typeof args.currency === 'string') patch.currency = args.currency;
    if (typeof args.expected_close === 'string') patch.expected_close = args.expected_close;
    if (args.expected_close === null) patch.expected_close = null;
    if (typeof args.probability === 'number') patch.probability = args.probability;
    if (typeof args.source === 'string') patch.source = args.source;
    if (typeof args.assigned_to === 'string') patch.assigned_to = args.assigned_to;
    if (typeof args.stage_id === 'string') patch.stage_id = args.stage_id;

    try {
      const updated = await updateDealForUser(id, user.org_id, user.sub, patch);
      return { data: updated };
    } catch (err) {
      if (err instanceof DealDomainError) {
        return { error: { code: err.domainError.code, message: err.domainError.message } };
      }
      throw err;
    }
  },
);

// ─── move_deal_to_stage ───────────────────────────────────────────────────────

registerTool(
  'move_deal_to_stage',
  'Move an open deal to a different stage within its pipeline',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal UUID' },
      stage_id: { type: 'string', description: 'Target stage UUID (must be in the same pipeline)' },
    },
    required: ['id', 'stage_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpWrite(user);
    if (writeErr) return writeErr;

    const id = typeof args.id === 'string' ? args.id : '';
    const stage_id = typeof args.stage_id === 'string' ? args.stage_id : '';

    const deal = await db.deal.findFirst({
      where: { id, organization_id: user.org_id },
    });

    if (!deal) {
      return { error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } };
    }

    if (deal.status !== DealStatus.open) {
      return { error: { code: 'DEAL_NOT_OPEN', message: 'Only open deals can be moved between stages' } };
    }

    if (!deal.pipeline_id) {
      return { error: { code: 'STAGE_NOT_FOUND', message: "Stage not found in this deal's pipeline" } };
    }

    const stage = await db.pipelineStage.findFirst({
      where: { id: stage_id, pipeline_id: deal.pipeline_id, pipeline: { organization_id: user.org_id } },
    });

    if (!stage) {
      return { error: { code: 'STAGE_NOT_FOUND', message: "Stage not found in this deal's pipeline" } };
    }

    const updated = await db.deal.update({
      where: { id, organization_id: user.org_id },
      data: { stage_id, stage_entered_at: new Date() },
      include: {
        contact: { select: { id: true, first_name: true, last_name: true } },
        pipeline: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, position: true } },
      },
    });

    await evaluateWorkflows({
      organizationId: user.org_id,
      trigger: WorkflowTrigger.deal_stage_changed,
      record: updated as unknown as Record<string, unknown>,
      userId: user.sub,
      triggerRecordId: updated.id,
    });

    void logActivity({
      organizationId: user.org_id,
      userId: user.sub,
      entityType: 'deal',
      entityId: updated.id,
      action: 'stage_changed',
      changes: { stage_id },
    });

    void dealCtx(updated.id, updated.stage?.name).then((ctx) => {
      if (ctx) void dispatchNotification({ eventType: 'deal.stage_changed', orgId: user.org_id, deal: ctx });
    });

    return { data: updated };
  },
);

// ─── get_pipelines ────────────────────────────────────────────────────────────

registerTool(
  'get_pipelines',
  'List all pipelines for the authenticated org, including stages and deal counts',
  {
    type: 'object',
    properties: {},
  },
  async (_args: Record<string, unknown>, user: McpUser) => {
    const pipelines = await db.pipeline.findMany({
      where: { organization_id: user.org_id },
      include: {
        stages: { orderBy: { position: 'asc' } },
        _count: { select: { deals: true } },
      },
      orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
    });

    return { data: pipelines, meta: {} };
  },
);
