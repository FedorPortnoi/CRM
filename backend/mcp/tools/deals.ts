import { Prisma, DealStatus } from '@prisma/client';
import { db } from '../../services/db';
import { registerTool, McpUser } from '../server';
import { validateMcpWriteReferences } from '../validation';

type DealStatusValue = 'open' | 'won' | 'lost' | 'archived';

function isDealStatus(v: unknown): v is DealStatusValue {
  return v === 'open' || v === 'won' || v === 'lost' || v === 'archived';
}

const dealInclude = {
  contact: { select: { id: true, first_name: true, last_name: true } },
  pipeline: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true, position: true } },
} as const;

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

    const where: Prisma.DealWhereInput = {
      organization_id: user.org_id,
      ...(pipeline_id && { pipeline_id }),
      ...(stage_id && { stage_id }),
      ...(assigned_to && { assigned_to }),
      ...(status && { status }),
      ...(contact_id && { contact_id }),
      ...(q && { title: { contains: q, mode: 'insensitive' } }),
    };

    const [deals, total] = await Promise.all([
      db.deal.findMany({
        where,
        skip: (page - 1) * per_page,
        take: per_page,
        orderBy: { created_at: 'desc' },
        include: dealInclude,
      }),
      db.deal.count({ where }),
    ]);

    return { data: deals, meta: { total, page, per_page } };
  },
);

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

    const deal = await db.deal.findFirst({
      where: { id, organization_id: user.org_id },
      include: dealInclude,
    });

    if (!deal) {
      return { error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } };
    }

    return { data: deal };
  },
);

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
      currency: { type: 'string', description: 'ISO currency code e.g. USD' },
      value: { type: 'number', description: 'Deal value' },
      expected_close: { type: 'string', description: 'Expected close date (ISO 8601)' },
      probability: { type: 'number', description: 'Win probability 0-100' },
      source: { type: 'string' },
      assigned_to: { type: 'string', description: 'User UUID to assign to' },
    },
    required: ['title', 'contact_id', 'pipeline_id', 'stage_id', 'currency'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const title = typeof args.title === 'string' ? args.title : '';
    const contact_id = typeof args.contact_id === 'string' ? args.contact_id : '';
    const pipeline_id = typeof args.pipeline_id === 'string' ? args.pipeline_id : '';
    const stage_id = typeof args.stage_id === 'string' ? args.stage_id : '';
    const currency = typeof args.currency === 'string' ? args.currency : 'USD';
    const value = typeof args.value === 'number' ? args.value : undefined;
    const expected_close = typeof args.expected_close === 'string' ? args.expected_close : undefined;
    const probability = typeof args.probability === 'number' ? args.probability : undefined;
    const source = typeof args.source === 'string' ? args.source : undefined;
    const assigned_to = typeof args.assigned_to === 'string' ? args.assigned_to : undefined;

    const [contact, pipeline, stage] = await Promise.all([
      db.contact.findFirst({ where: { id: contact_id, organization_id: user.org_id }, select: { id: true } }),
      db.pipeline.findFirst({ where: { id: pipeline_id, organization_id: user.org_id }, select: { id: true } }),
      db.pipelineStage.findFirst({ where: { id: stage_id, pipeline_id }, select: { id: true } }),
    ]);

    if (!contact) {
      return { error: { code: 'FORBIDDEN', message: 'Contact does not belong to your organization' } };
    }
    if (!pipeline) {
      return { error: { code: 'PIPELINE_NOT_FOUND', message: 'Pipeline not found' } };
    }
    if (!stage) {
      return { error: { code: 'STAGE_PIPELINE_MISMATCH', message: 'Stage does not belong to the specified pipeline' } };
    }

    const referenceError = await validateMcpWriteReferences(user, { assigned_to });
    if (referenceError) {
      return referenceError;
    }

    const deal = await db.deal.create({
      data: {
        title,
        contact_id,
        pipeline_id,
        stage_id,
        currency,
        value,
        expected_close: expected_close ? new Date(expected_close) : undefined,
        probability,
        source,
        assigned_to,
        organization_id: user.org_id,
        created_by: user.sub,
      },
      include: dealInclude,
    });

    return { data: deal };
  },
);

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
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const id = typeof args.id === 'string' ? args.id : '';

    const deal = await db.deal.findFirst({
      where: { id, organization_id: user.org_id },
    });

    if (!deal) {
      return { error: { code: 'DEAL_NOT_FOUND', message: 'Deal not found' } };
    }

    const updateData: Prisma.DealUncheckedUpdateInput = {};
    if (typeof args.title === 'string') updateData.title = args.title;
    if (typeof args.value === 'number') updateData.value = args.value;
    if (args.value === null) updateData.value = null;
    if (typeof args.currency === 'string') updateData.currency = args.currency;
    if (typeof args.expected_close === 'string') {
      updateData.expected_close = args.expected_close ? new Date(args.expected_close) : null;
    }
    if (typeof args.probability === 'number') updateData.probability = args.probability;
    if (typeof args.source === 'string') updateData.source = args.source;
    if (typeof args.assigned_to === 'string') updateData.assigned_to = args.assigned_to;

    const referenceError = await validateMcpWriteReferences(user, {
      assigned_to: typeof args.assigned_to === 'string' ? args.assigned_to : undefined,
    });
    if (referenceError) {
      return referenceError;
    }

    const updated = await db.deal.update({
      where: { id },
      data: updateData,
      include: dealInclude,
    });

    return { data: updated };
  },
);

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

    const stage = await db.pipelineStage.findFirst({
      where: { id: stage_id, pipeline_id: deal.pipeline_id ?? undefined },
    });

    if (!stage) {
      return { error: { code: 'STAGE_NOT_FOUND', message: "Stage not found in this deal's pipeline" } };
    }

    const updated = await db.deal.update({
      where: { id },
      data: { stage_id },
      include: dealInclude,
    });

    return { data: updated };
  },
);

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
