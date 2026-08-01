import { registerTool, type McpUser } from '../server';
import { requireMcpToolCapability } from '../validation';
import {
  PipelineDomainError,
  createStage,
  deleteStage,
  reorderStages,
  stageLibraryForPipeline,
  updateStage,
  type CreateStageInput,
  type UpdateStageInput,
} from '../../services/pipeline-domain';

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function invalidArgument(message: string) {
  return { error: { code: 'INVALID_ARGUMENT', message } };
}

function validHexColor(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value));
}

function validInteger(value: unknown, min: number, max: number): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max);
}

function domainError(error: unknown): { error: { code: string; message: string; details?: Record<string, unknown> } } {
  if (error instanceof PipelineDomainError) {
    return {
      error: {
        code: error.domainError.code,
        message: error.domainError.message,
        ...(error.domainError.details ? { details: error.domainError.details } : {}),
      },
    };
  }
  throw error;
}

registerTool(
  'get_stage_library',
  'List suggested sales-funnel stages and show which are already present in a pipeline',
  {
    type: 'object',
    properties: {
      pipeline_id: {
        type: 'string',
        description: 'Pipeline UUID. Omit to use the default or oldest pipeline.',
      },
    },
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const readErr = requireMcpToolCapability(user, 'get_stage_library');
    if (readErr) return readErr;

    try {
      const result = await stageLibraryForPipeline(user.org_id, optionalString(args.pipeline_id));
      return { data: result.entries, meta: { pipeline_id: result.pipeline_id, total: result.entries.length } };
    } catch (error) {
      return domainError(error);
    }
  },
);

registerTool(
  'create_pipeline_stage',
  'Add a stage to a sales funnel, either from the suggested library or with custom fields',
  {
    type: 'object',
    properties: {
      pipeline_id: { type: 'string', description: 'Pipeline UUID' },
      template_key: { type: 'string', description: 'Optional key returned by get_stage_library' },
      name: { type: 'string', description: 'Custom stage name (required without template_key)' },
      position: { type: 'integer', minimum: 0, maximum: 500 },
      color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      probability: { type: 'integer', minimum: 0, maximum: 100 },
      stale_after_days: { type: 'integer', minimum: 1, maximum: 365 },
      is_won_stage: { type: 'boolean' },
      is_lost_stage: { type: 'boolean' },
    },
    required: ['pipeline_id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'create_pipeline_stage');
    if (writeErr) return writeErr;

    if (!stringArg(args.pipeline_id)) return invalidArgument('pipeline_id is required');
    if (typeof args.name !== 'string' && typeof args.template_key !== 'string') {
      return invalidArgument('either name or template_key is required');
    }
    if (!validInteger(args.position, 0, 500)) return invalidArgument('position must be an integer from 0 to 500');
    if (!validHexColor(args.color)) return invalidArgument('color must be a #RRGGBB hex value');
    if (!validInteger(args.probability, 0, 100)) return invalidArgument('probability must be an integer from 0 to 100');
    if (!validInteger(args.stale_after_days, 1, 365)) return invalidArgument('stale_after_days must be an integer from 1 to 365');

    const input: CreateStageInput = {
      pipeline_id: stringArg(args.pipeline_id),
      template_key: optionalString(args.template_key),
      name: optionalString(args.name),
      position: optionalNumber(args.position),
      color: optionalString(args.color),
      probability: optionalNumber(args.probability),
      stale_after_days: optionalNumber(args.stale_after_days),
      is_won_stage: optionalBoolean(args.is_won_stage),
      is_lost_stage: optionalBoolean(args.is_lost_stage),
    };

    try {
      return { data: await createStage(user.org_id, input), meta: {} };
    } catch (error) {
      return domainError(error);
    }
  },
);

registerTool(
  'update_pipeline_stage',
  'Rename or configure a sales-funnel stage, including its colour, probability, stale threshold and won/lost flags',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stage UUID' },
      name: { type: 'string' },
      color: { type: ['string', 'null'], pattern: '^#[0-9A-Fa-f]{6}$' },
      probability: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
      stale_after_days: { type: ['integer', 'null'], minimum: 1, maximum: 365 },
      is_archived: { type: 'boolean' },
      is_won_stage: { type: 'boolean' },
      is_lost_stage: { type: 'boolean' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'update_pipeline_stage');
    if (writeErr) return writeErr;

    if (!stringArg(args.id)) return invalidArgument('id is required');
    if (!validHexColor(args.color)) return invalidArgument('color must be null or a #RRGGBB hex value');
    if (args.probability !== null && !validInteger(args.probability, 0, 100)) {
      return invalidArgument('probability must be null or an integer from 0 to 100');
    }
    if (args.stale_after_days !== null && !validInteger(args.stale_after_days, 1, 365)) {
      return invalidArgument('stale_after_days must be null or an integer from 1 to 365');
    }
    const updatable = ['name', 'color', 'probability', 'stale_after_days', 'is_archived', 'is_won_stage', 'is_lost_stage'];
    if (!updatable.some((field) => args[field] !== undefined)) return invalidArgument('no fields to update');

    const patch: UpdateStageInput = {};
    if (typeof args.name === 'string') patch.name = args.name;
    if (typeof args.color === 'string' || args.color === null) patch.color = args.color;
    if (typeof args.probability === 'number' || args.probability === null) patch.probability = args.probability;
    if (typeof args.stale_after_days === 'number' || args.stale_after_days === null) patch.stale_after_days = args.stale_after_days;
    if (typeof args.is_archived === 'boolean') patch.is_archived = args.is_archived;
    if (typeof args.is_won_stage === 'boolean') patch.is_won_stage = args.is_won_stage;
    if (typeof args.is_lost_stage === 'boolean') patch.is_lost_stage = args.is_lost_stage;

    try {
      return { data: await updateStage(stringArg(args.id), user.org_id, patch), meta: {} };
    } catch (error) {
      return domainError(error);
    }
  },
);

registerTool(
  'delete_pipeline_stage',
  'Delete a sales-funnel stage. If it contains deals, move_to must name another stage in the same pipeline.',
  {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stage UUID' },
      move_to: { type: 'string', description: 'Target stage UUID for deals currently in the deleted stage' },
    },
    required: ['id'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'delete_pipeline_stage');
    if (writeErr) return writeErr;

    if (!stringArg(args.id)) return invalidArgument('id is required');

    try {
      return {
        data: await deleteStage(stringArg(args.id), user.org_id, optionalString(args.move_to)),
        meta: {},
      };
    } catch (error) {
      return domainError(error);
    }
  },
);

registerTool(
  'reorder_pipeline_stages',
  'Set the complete stage order for a pipeline without changing any deal stage or stall timestamp',
  {
    type: 'object',
    properties: {
      pipeline_id: { type: 'string', description: 'Pipeline UUID' },
      ordered_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { type: 'string' },
        description: 'Every stage UUID in the pipeline, exactly once, in the desired order',
      },
    },
    required: ['pipeline_id', 'ordered_ids'],
  },
  async (args: Record<string, unknown>, user: McpUser) => {
    const writeErr = requireMcpToolCapability(user, 'reorder_pipeline_stages');
    if (writeErr) return writeErr;

    if (!stringArg(args.pipeline_id)) return invalidArgument('pipeline_id is required');
    if (!Array.isArray(args.ordered_ids) || args.ordered_ids.length < 1 || args.ordered_ids.length > 100) {
      return invalidArgument('ordered_ids must contain 1 to 100 stage ids');
    }
    if (args.ordered_ids.some((id) => typeof id !== 'string')) {
      return invalidArgument('every ordered_ids entry must be a stage id string');
    }

    const orderedIds = Array.isArray(args.ordered_ids)
      ? args.ordered_ids.filter((id): id is string => typeof id === 'string')
      : [];

    try {
      const stages = await reorderStages(stringArg(args.pipeline_id), user.org_id, orderedIds);
      return { data: stages, meta: { total: stages.length } };
    } catch (error) {
      return domainError(error);
    }
  },
);
