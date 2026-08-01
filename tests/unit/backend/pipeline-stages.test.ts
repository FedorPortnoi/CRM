/**
 * Guards on the user-editable sales funnel (backend/services/pipeline-domain.ts).
 *
 * These are pure unit tests: `backend/services/db` is replaced with a small
 * in-memory store that understands the handful of Prisma query shapes the domain
 * layer actually issues. There is no test database in this repo — the only
 * reachable Postgres is single-copy production data — so a suite that needed one
 * could not be run at all, and a suite of `mockResolvedValue` stubs would assert
 * that the code calls Prisma rather than that the RULES hold. The store lets the
 * assertions be about state: what rows exist afterwards, and which rows were
 * left alone.
 *
 * The last point is the reason for the fixture's timestamps. `Deal.stage_entered_at`
 * is the only input to the stalled-deal report, so the test that reordering
 * columns does not touch it compares the actual stored values before and after,
 * not merely that some mock went uncalled.
 */

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
  process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? 'y'.repeat(48);
});

// ─── Fixture world ────────────────────────────────────────────────────────────

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001';

const P1 = 'aaaaaaaa-1111-4000-8000-000000000001'; // org A, default, four stages
const P2 = 'aaaaaaaa-1111-4000-8000-000000000002'; // org A, two stages, holds a deal
const P3 = 'aaaaaaaa-1111-4000-8000-000000000003'; // org A, ONE stage, no deals
const PB = 'bbbbbbbb-1111-4000-8000-000000000001'; // org B, its only pipeline

const S1 = 'aaaaaaaa-2222-4000-8000-000000000001';
const S2 = 'aaaaaaaa-2222-4000-8000-000000000002'; // holds two deals
const S3 = 'aaaaaaaa-2222-4000-8000-000000000003';
const S4 = 'aaaaaaaa-2222-4000-8000-000000000004'; // is_won_stage
const S5 = 'aaaaaaaa-2222-4000-8000-000000000005'; // in P2, holds a deal
const S6 = 'aaaaaaaa-2222-4000-8000-000000000006'; // in P2
const S7 = 'aaaaaaaa-2222-4000-8000-000000000007'; // in P3, the only one
const SB1 = 'bbbbbbbb-2222-4000-8000-000000000001'; // org B

const D1 = 'aaaaaaaa-3333-4000-8000-000000000001';
const D2 = 'aaaaaaaa-3333-4000-8000-000000000002';
const D3 = 'aaaaaaaa-3333-4000-8000-000000000003';

/** Three weeks stale — old enough that the report is already flagging them. */
const STALE_SINCE = new Date('2026-07-10T08:00:00.000Z');

type Row = Record<string, any>;

const state: { pipelines: Row[]; stages: Row[]; deals: Row[] } = {
  pipelines: [],
  stages: [],
  deals: [],
};

function stage(overrides: Row): Row {
  return {
    color: null,
    probability: null,
    stale_after_days: null,
    is_won_stage: false,
    is_lost_stage: false,
    is_archived: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function resetWorld(): void {
  state.pipelines = [
    { id: P1, organization_id: ORG_A, name: 'Воронка продаж', description: null, is_default: true, created_by: null, created_at: new Date('2026-01-01T00:00:00.000Z'), updated_at: new Date('2026-01-01T00:00:00.000Z') },
    { id: P2, organization_id: ORG_A, name: 'Партнёры', description: null, is_default: false, created_by: null, created_at: new Date('2026-02-01T00:00:00.000Z'), updated_at: new Date('2026-02-01T00:00:00.000Z') },
    { id: P3, organization_id: ORG_A, name: 'Тендеры', description: null, is_default: false, created_by: null, created_at: new Date('2026-03-01T00:00:00.000Z'), updated_at: new Date('2026-03-01T00:00:00.000Z') },
    { id: PB, organization_id: ORG_B, name: 'Чужая воронка', description: null, is_default: true, created_by: null, created_at: new Date('2026-01-01T00:00:00.000Z'), updated_at: new Date('2026-01-01T00:00:00.000Z') },
  ];

  state.stages = [
    stage({ id: S1, pipeline_id: P1, name: 'Новый лид', position: 0 }),
    stage({ id: S2, pipeline_id: P1, name: 'Квалификация', position: 1 }),
    stage({ id: S3, pipeline_id: P1, name: 'Предложение', position: 2 }),
    stage({ id: S4, pipeline_id: P1, name: 'Сделка выиграна', position: 3, is_won_stage: true }),
    stage({ id: S5, pipeline_id: P2, name: 'Заявка', position: 0 }),
    stage({ id: S6, pipeline_id: P2, name: 'Договор', position: 1, is_won_stage: true }),
    stage({ id: S7, pipeline_id: P3, name: 'Единственный', position: 0, is_won_stage: true }),
    stage({ id: SB1, pipeline_id: PB, name: 'Чужой этап', position: 0, is_won_stage: true }),
  ];

  state.deals = [
    { id: D1, organization_id: ORG_A, pipeline_id: P1, stage_id: S2, status: 'open', stage_entered_at: STALE_SINCE, updated_at: STALE_SINCE },
    { id: D2, organization_id: ORG_A, pipeline_id: P1, stage_id: S2, status: 'open', stage_entered_at: STALE_SINCE, updated_at: STALE_SINCE },
    // pipeline_id null on purpose: a deal can sit on a pipeline's stage while its
    // own pipeline_id is null, which is why deleting a pipeline has to look at
    // both columns.
    { id: D3, organization_id: ORG_A, pipeline_id: null, stage_id: S5, status: 'open', stage_entered_at: STALE_SINCE, updated_at: STALE_SINCE },
  ];
}

resetWorld();

// ─── Minimal Prisma stand-in ──────────────────────────────────────────────────

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition === 'object' && condition !== null) {
    const c = condition as Row;
    if ('not' in c) return !matchesCondition(value, c.not);
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('gte' in c) return (value as number) >= (c.gte as number);
    if ('lte' in c) return (value as number) <= (c.lte as number);
    throw new Error(`unsupported condition ${JSON.stringify(condition)}`);
  }
  return value === condition;
}

function matches(row: Row, where: Row | undefined, table: 'pipeline' | 'stage' | 'deal'): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Row[]).some((sub) => matches(row, sub, table))) return false;
      continue;
    }
    if (key === 'pipeline') {
      const parent = state.pipelines.find((p) => p.id === row.pipeline_id);
      if (!parent || !matches(parent, condition as Row, 'pipeline')) return false;
      continue;
    }
    if (!matchesCondition(row[key], condition)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses as Row[]) {
      for (const [key, dir] of Object.entries(clause)) {
        const av = a[key];
        const bv = b[key];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in (value as Row)) {
      row[key] = (row[key] as number) + ((value as Row).increment as number);
      continue;
    }
    row[key] = value;
  }
  row.updated_at = new Date();
}

let nextId = 0;
function makeId(prefix: string): string {
  nextId += 1;
  return `${prefix}-new-${nextId}`;
}

/** Set by a test that wants a write to blow up the way Postgres would. */
let stageWriteFailure: unknown = null;

const mockDb = vi.hoisted(() => ({})) as Row;

Object.assign(mockDb, {
  pipeline: {
    findFirst: vi.fn(async ({ where, orderBy }: Row = {}) => {
      const found = sortRows(state.pipelines.filter((p) => matches(p, where, 'pipeline')), orderBy)[0];
      return found ? { ...found } : null;
    }),
    findMany: vi.fn(async ({ where, orderBy }: Row = {}) =>
      sortRows(state.pipelines.filter((p) => matches(p, where, 'pipeline')), orderBy).map((p) => ({ ...p }))),
    count: vi.fn(async ({ where }: Row = {}) => state.pipelines.filter((p) => matches(p, where, 'pipeline')).length),
    create: vi.fn(async ({ data }: Row) => {
      const row = {
        id: makeId('pipeline'),
        created_at: new Date(),
        updated_at: new Date(),
        description: null,
        is_default: false,
        ...data,
      };
      state.pipelines.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: Row) => {
      const row = state.pipelines.find((p) => p.id === where.id);
      if (!row) throw new Error('pipeline not found');
      applyData(row, data);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const rows = state.pipelines.filter((p) => matches(p, where, 'pipeline'));
      rows.forEach((row) => applyData(row, data));
      return { count: rows.length };
    }),
    delete: vi.fn(async ({ where }: Row) => {
      const index = state.pipelines.findIndex((p) => p.id === where.id);
      if (index < 0) throw new Error('pipeline not found');
      return state.pipelines.splice(index, 1)[0];
    }),
  },
  pipelineStage: {
    findFirst: vi.fn(async ({ where, orderBy }: Row = {}) => {
      const found = sortRows(state.stages.filter((s) => matches(s, where, 'stage')), orderBy)[0];
      return found ? { ...found } : null;
    }),
    findMany: vi.fn(async ({ where, orderBy }: Row = {}) =>
      sortRows(state.stages.filter((s) => matches(s, where, 'stage')), orderBy).map((s) => ({ ...s }))),
    count: vi.fn(async ({ where }: Row = {}) => state.stages.filter((s) => matches(s, where, 'stage')).length),
    create: vi.fn(async ({ data }: Row) => {
      if (stageWriteFailure) {
        const failure = stageWriteFailure;
        stageWriteFailure = null;
        throw failure;
      }
      const row = stage({ id: makeId('stage'), ...data });
      state.stages.push(row);
      return { ...row };
    }),
    createMany: vi.fn(async ({ data }: Row) => {
      const rows = (data as Row[]).map((d) => stage({ id: makeId('stage'), ...d }));
      state.stages.push(...rows);
      return { count: rows.length };
    }),
    update: vi.fn(async ({ where, data }: Row) => {
      if (stageWriteFailure) {
        const failure = stageWriteFailure;
        stageWriteFailure = null;
        throw failure;
      }
      const row = state.stages.find((s) => s.id === where.id);
      if (!row) throw new Error('stage not found');
      applyData(row, data);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const rows = state.stages.filter((s) => matches(s, where, 'stage'));
      rows.forEach((row) => applyData(row, data));
      return { count: rows.length };
    }),
    delete: vi.fn(async ({ where }: Row) => {
      const index = state.stages.findIndex((s) => s.id === where.id);
      if (index < 0) throw new Error('stage not found');
      return state.stages.splice(index, 1)[0];
    }),
    deleteMany: vi.fn(async ({ where }: Row = {}) => {
      const doomed = state.stages.filter((s) => matches(s, where, 'stage'));
      state.stages = state.stages.filter((s) => !doomed.includes(s));
      return { count: doomed.length };
    }),
  },
  deal: {
    count: vi.fn(async ({ where }: Row = {}) => state.deals.filter((d) => matches(d, where, 'deal')).length),
    findMany: vi.fn(async ({ where }: Row = {}) => state.deals.filter((d) => matches(d, where, 'deal')).map((d) => ({ ...d }))),
    update: vi.fn(async ({ where, data }: Row) => {
      const row = state.deals.find((d) => d.id === where.id);
      if (!row) throw new Error('deal not found');
      applyData(row, data);
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const rows = state.deals.filter((d) => matches(d, where, 'deal'));
      rows.forEach((row) => applyData(row, data));
      return { count: rows.length };
    }),
  },
  $transaction: vi.fn(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(mockDb)
      : Promise.all(arg as Promise<unknown>[])),
});

vi.mock('../../../backend/services/db', () => ({ db: mockDb }));

// ─── Controller stand-in, for the route-shape suite at the bottom ─────────────

const handlerMocks = vi.hoisted(() => {
  const make = () =>
    vi.fn(async (_request: unknown, reply: { send: (payload: unknown) => unknown }) => {
      reply.send({ data: {}, meta: {} });
    });
  return {
    passthrough: make(),
    createPipeline: make(),
    updatePipeline: make(),
    deletePipeline: make(),
    stageLibrary: make(),
    createStage: make(),
    updateStage: make(),
    deleteStage: make(),
    reorderStages: make(),
  };
});

vi.mock('../../../backend/api/controllers/deals', () => ({
  DealsController: {
    list: handlerMocks.passthrough,
    evaluateStale: handlerMocks.passthrough,
    create: handlerMocks.passthrough,
    getById: handlerMocks.passthrough,
    update: handlerMocks.passthrough,
    moveStage: handlerMocks.passthrough,
    markWon: handlerMocks.passthrough,
    markLost: handlerMocks.passthrough,
    listPipelines: handlerMocks.passthrough,
    createPipeline: handlerMocks.createPipeline,
    updatePipeline: handlerMocks.updatePipeline,
    deletePipeline: handlerMocks.deletePipeline,
    stageLibrary: handlerMocks.stageLibrary,
    createStage: handlerMocks.createStage,
    updateStage: handlerMocks.updateStage,
    deleteStage: handlerMocks.deleteStage,
    reorderStages: handlerMocks.reorderStages,
  },
}));

import dealsRoutes from '../../../backend/api/routes/deals';
import { OPTIONAL_STAGE_LIBRARY } from '../../../backend/config/market';
import {
  PipelineDomainError,
  createPipeline,
  createStage,
  deletePipeline,
  deleteStage,
  normalizeStageName,
  orderedIdsMatchStageSet,
  reorderStages,
  resolveInsertPosition,
  stageLibraryForPipeline,
  stageUniqueViolation,
  updatePipeline,
  updateStage,
} from '../../../backend/services/pipeline-domain';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function refuses(
  promise: Promise<unknown>,
): Promise<{ httpStatus: number; code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PipelineDomainError) return err.domainError;
    throw err;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

function stageEnteredSnapshot(): Record<string, number> {
  return Object.fromEntries(state.deals.map((d) => [d.id, (d.stage_entered_at as Date).getTime()]));
}

beforeEach(() => {
  vi.clearAllMocks();
  stageWriteFailure = null;
  nextId = 0;
  resetWorld();
});

// ─── Guard 1: org scope ───────────────────────────────────────────────────────

describe('org scoping', () => {
  it('answers 404 — not 403 — for a stage that belongs to another org', async () => {
    const foreign = await refuses(updateStage(SB1, ORG_A, { name: 'Переименовано' }));
    const missing = await refuses(
      updateStage('aaaaaaaa-9999-4000-8000-00000000ffff', ORG_A, { name: 'Переименовано' }),
    );

    expect(foreign.httpStatus).toBe(404);
    // Byte-identical to the reply for an id that does not exist anywhere: a
    // different status or message would confirm to org A that this id is real.
    expect(foreign).toEqual(missing);

    // And nothing was written to the other tenant's row.
    expect(state.stages.find((s) => s.id === SB1)?.name).toBe('Чужой этап');
  });

  it('refuses to delete, reorder or extend another org\'s funnel', async () => {
    expect((await refuses(deleteStage(SB1, ORG_A))).code).toBe('STAGE_NOT_FOUND');
    expect((await refuses(reorderStages(PB, ORG_A, [SB1]))).code).toBe('PIPELINE_NOT_FOUND');
    expect((await refuses(createStage(ORG_A, { pipeline_id: PB, name: 'Врезка' }))).code)
      .toBe('PIPELINE_NOT_FOUND');
    expect((await refuses(updatePipeline(PB, ORG_A, { name: 'Захвачено' }))).code)
      .toBe('PIPELINE_NOT_FOUND');
    expect((await refuses(deletePipeline(PB, ORG_A))).code).toBe('PIPELINE_NOT_FOUND');
    expect((await refuses(stageLibraryForPipeline(ORG_A, PB))).code).toBe('PIPELINE_NOT_FOUND');

    // The other org's funnel is exactly as it was.
    expect(state.stages.filter((s) => s.pipeline_id === PB)).toHaveLength(1);
    expect(state.pipelines.find((p) => p.id === PB)?.name).toBe('Чужая воронка');
  });

  it('cannot smuggle a foreign stage into a reorder of its own pipeline', async () => {
    const refusal = await refuses(reorderStages(P2, ORG_A, [S5, SB1]));

    expect(refusal.httpStatus).toBe(400);
    expect(refusal.code).toBe('STAGE_ORDER_MISMATCH');
    expect(state.stages.find((s) => s.id === SB1)?.pipeline_id).toBe(PB);
  });

  it('cannot move deals onto a stage in another pipeline when deleting', async () => {
    const refusal = await refuses(deleteStage(S2, ORG_A, S5));

    expect(refusal.httpStatus).toBe(400);
    expect(refusal.code).toBe('STAGE_MOVE_TARGET_INVALID');
    expect(state.deals.filter((d) => d.stage_id === S2)).toHaveLength(2);
  });
});

// ─── Guard 2: the last stage ──────────────────────────────────────────────────

describe('the last stage of a pipeline', () => {
  it('cannot be deleted, even with no deals on it', async () => {
    const refusal = await refuses(deleteStage(S7, ORG_A));

    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('STAGE_LAST_IN_PIPELINE');
    expect(state.stages.some((s) => s.id === S7)).toBe(true);
  });

  it('cannot be archived either — an all-archived pipeline draws an empty board', async () => {
    const refusal = await refuses(updateStage(S7, ORG_A, { is_archived: true }));

    expect(refusal.code).toBe('STAGE_LAST_ACTIVE');
    expect(state.stages.find((s) => s.id === S7)?.is_archived).toBe(false);
  });

  it('archives a stage while others remain active', async () => {
    await updateStage(S3, ORG_A, { is_archived: true });
    expect(state.stages.find((s) => s.id === S3)?.is_archived).toBe(true);
  });

  it('does not hide a stage while it still contains open deals', async () => {
    const refusal = await refuses(updateStage(S2, ORG_A, { is_archived: true }));
    expect(refusal.code).toBe('STAGE_HAS_OPEN_DEALS');
    expect(refusal.details).toEqual({ deal_count: 2 });
    expect(state.stages.find((s) => s.id === S2)?.is_archived).toBe(false);
  });
});

// ─── Guard 3: deleting a stage that holds deals ───────────────────────────────

describe('deleting a stage that holds deals', () => {
  it('is refused without move_to, and reports how many deals are in the way', async () => {
    const refusal = await refuses(deleteStage(S2, ORG_A));

    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('STAGE_HAS_DEALS');
    expect(refusal.details).toEqual({ deal_count: 2 });
    expect(state.stages.some((s) => s.id === S2)).toBe(true);
    expect(mockDb.deal.updateMany).not.toHaveBeenCalled();
  });

  it('is refused when move_to is the stage being deleted', async () => {
    expect((await refuses(deleteStage(S2, ORG_A, S2))).code).toBe('STAGE_MOVE_TARGET_SAME');
    expect(state.stages.some((s) => s.id === S2)).toBe(true);
  });

  it('is refused when move_to does not exist at all', async () => {
    const refusal = await refuses(deleteStage(S2, ORG_A, 'aaaaaaaa-2222-4000-8000-0000000000ff'));
    expect(refusal.code).toBe('STAGE_MOVE_TARGET_INVALID');
  });

  it('moves the deals and deletes the stage when move_to is a sibling', async () => {
    const before = stageEnteredSnapshot();

    const result = await deleteStage(S2, ORG_A, S3);

    expect(result).toEqual({ deleted_stage_id: S2, moved_deals: 2, moved_to: S3 });
    expect(state.stages.some((s) => s.id === S2)).toBe(false);
    expect(state.deals.filter((d) => d.stage_id === S3).map((d) => d.id).sort()).toEqual([D1, D2]);

    // The deals did not progress — an admin reorganised the funnel under them —
    // so their stall clocks keep running. Resetting these would empty the
    // stalled-deal report for exactly the deals an admin was just touching.
    expect(stageEnteredSnapshot()).toEqual(before);
    const [[updateManyArgs]] = (mockDb.deal.updateMany as unknown as { mock: { calls: Row[][] } }).mock.calls;
    expect(updateManyArgs.data).not.toHaveProperty('stage_entered_at');
  });

  it('deletes a stage with no deals without asking for move_to', async () => {
    await deleteStage(S1, ORG_A);
    expect(state.stages.some((s) => s.id === S1)).toBe(false);
    expect(mockDb.deal.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Guard 4: reorder must not touch stage_entered_at ─────────────────────────

describe('reordering stages', () => {
  it('rewrites positions without touching a single deal', async () => {
    const before = stageEnteredSnapshot();
    expect(Object.keys(before)).toHaveLength(3);

    const result = await reorderStages(P1, ORG_A, [S4, S3, S2, S1]);

    expect(result.map((s) => s.id)).toEqual([S4, S3, S2, S1]);
    expect(result.map((s) => s.position)).toEqual([0, 1, 2, 3]);

    // THE assertion this file exists for. stage_entered_at drives the
    // stalled-deal report; a reorder that rewrote it would make every deal in
    // the org look freshly moved and silently blank the report for two weeks.
    expect(stageEnteredSnapshot()).toEqual(before);
    expect(mockDb.deal.update).not.toHaveBeenCalled();
    expect(mockDb.deal.updateMany).not.toHaveBeenCalled();

    // Not even Deal.updated_at moved.
    expect(state.deals.every((d) => (d.updated_at as Date).getTime() === STALE_SINCE.getTime())).toBe(true);
  });

  it('writes every position in ONE transaction', async () => {
    await reorderStages(P1, ORG_A, [S2, S1, S3, S4]);

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    const [batch] = (mockDb.$transaction as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch as unknown[]).toHaveLength(4);
  });

  it('only ever writes the position column on a stage', async () => {
    await reorderStages(P1, ORG_A, [S2, S1, S3, S4]);

    const writes = (mockDb.pipelineStage.update as unknown as { mock: { calls: Row[][] } }).mock.calls;
    expect(writes).toHaveLength(4);
    for (const [args] of writes) {
      expect(Object.keys(args.data)).toEqual(['position']);
    }
  });
});

// ─── Guard 7: the reorder set must match exactly ──────────────────────────────

describe('reorder rejects an ordered_ids set that is not the pipeline\'s', () => {
  const cases: Array<[string, string[]]> = [
    ['a subset', [S1, S2, S3]],
    ['a superset', [S1, S2, S3, S4, S5]],
    ['a repeated id', [S1, S1, S3, S4]],
    ['an id from a sibling pipeline', [S1, S2, S3, S5]],
    ['an empty list', []],
  ];

  for (const [label, orderedIds] of cases) {
    it(`refuses ${label}`, async () => {
      const positionsBefore = state.stages.filter((s) => s.pipeline_id === P1).map((s) => s.position);

      const refusal = await refuses(reorderStages(P1, ORG_A, orderedIds));

      expect(refusal.httpStatus).toBe(400);
      expect(refusal.code).toBe('STAGE_ORDER_MISMATCH');
      expect(mockDb.pipelineStage.update).not.toHaveBeenCalled();
      expect(state.stages.filter((s) => s.pipeline_id === P1).map((s) => s.position)).toEqual(positionsBefore);
    });
  }

  it('accepts the exact set in a new order (positive control)', async () => {
    const ok = await reorderStages(P1, ORG_A, [S3, S1, S4, S2]);
    expect(ok.map((s) => s.id)).toEqual([S3, S1, S4, S2]);
  });
});

// ─── Guard 5: one won stage and one lost stage per pipeline ───────────────────

describe('won and lost flags', () => {
  it('moves the won flag atomically instead of leaving zero or two won stages', async () => {
    const updated = await updateStage(S1, ORG_A, { is_won_stage: true });

    expect(updated.is_won_stage).toBe(true);
    expect(state.stages.find((s) => s.id === S4)?.is_won_stage).toBe(false);
    expect(state.stages.filter((s) => s.pipeline_id === P1 && s.is_won_stage)).toHaveLength(1);
  });

  it('refuses a second won stage on create', async () => {
    const refusal = await refuses(
      createStage(ORG_A, { pipeline_id: P1, name: 'Тоже победа', is_won_stage: true }),
    );

    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('STAGE_WON_ALREADY_EXISTS');
    expect(state.stages.filter((s) => s.pipeline_id === P1)).toHaveLength(4);
  });

  it('refuses a second lost stage', async () => {
    await updateStage(S3, ORG_A, { is_lost_stage: true });

    const refusal = await refuses(
      createStage(ORG_A, { pipeline_id: P1, template_key: 'lost' }),
    );

    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('STAGE_LOST_ALREADY_EXISTS');
    expect(refusal.message).toMatch(/[А-Яа-яЁё]/);
  });

  it('refuses a stage that is both won and lost', async () => {
    const refusal = await refuses(
      createStage(ORG_A, { pipeline_id: P2, name: 'Шрёдингер', is_won_stage: true, is_lost_stage: true }),
    );

    expect(refusal.httpStatus).toBe(400);
    expect(refusal.code).toBe('STAGE_FLAGS_CONFLICT');
  });

  it('moves the same flag independently in a DIFFERENT pipeline', async () => {
    const updated = await updateStage(S5, ORG_A, { is_won_stage: true });
    expect(updated.is_won_stage).toBe(true);
    expect(state.stages.find((s) => s.id === S6)?.is_won_stage).toBe(false);
    expect(state.stages.find((s) => s.id === S4)?.is_won_stage).toBe(true);
  });

  it('turns a racing P2002 into a 409, never a 500', async () => {
    // Simulate legacy data without a won stage, then have a concurrent writer
    // win between the pre-flight SELECT and INSERT. The partial index is the
    // final backstop for that race.
    const legacyWon = state.stages.find((s) => s.id === S6);
    if (legacyWon) legacyWon.is_won_stage = false;
    stageWriteFailure = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: 'pipeline_stage_one_won_per_pipeline' },
    });

    const refusal = await refuses(
      createStage(ORG_A, { pipeline_id: P2, name: 'Успех', is_won_stage: true }),
    );

    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('STAGE_WON_ALREADY_EXISTS');
    expect(refusal.message).toMatch(/[А-Яа-яЁё]/);
  });

  it('maps the lost index to its own message and leaves other errors alone', () => {
    expect(stageUniqueViolation({ code: 'P2002', meta: { target: ['pipeline_stage_one_lost_per_pipeline'] } }))
      .toMatchObject({ httpStatus: 409, code: 'STAGE_LOST_ALREADY_EXISTS' });
    expect(stageUniqueViolation({ code: 'P2002' })).toMatchObject({ httpStatus: 409, code: 'STAGE_CONFLICT' });
    // Not a unique violation: must NOT be swallowed into a 409, or a genuine
    // bug reaches the user as a business rule.
    expect(stageUniqueViolation({ code: 'P2025' })).toBeNull();
    expect(stageUniqueViolation(new Error('boom'))).toBeNull();
    expect(stageUniqueViolation(null)).toBeNull();
  });

  it('lets a stage keep its own won flag while being renamed', async () => {
    const updated = await updateStage(S4, ORG_A, { name: 'Успешно реализовано', is_won_stage: true });
    expect(updated.is_won_stage).toBe(true);
    expect(updated.name).toBe('Успешно реализовано');
  });

  it('does not allow the funnel to lose its only won stage', async () => {
    expect((await refuses(updateStage(S4, ORG_A, { is_won_stage: false }))).code)
      .toBe('STAGE_WON_REQUIRED');
    expect((await refuses(updateStage(S4, ORG_A, { is_archived: true }))).code)
      .toBe('STAGE_WON_REQUIRED');
    expect((await refuses(deleteStage(S4, ORG_A))).code)
      .toBe('STAGE_WON_REQUIRED');
    expect(state.stages.find((s) => s.id === S4)?.is_won_stage).toBe(true);
  });
});

// ─── Guard 6: deleting a pipeline that holds deals ────────────────────────────

describe('deleting a pipeline', () => {
  it('is refused while deals reference it', async () => {
    // P1 is the default one, so make P2 default first and P1 deletable on every
    // ground except the deals sitting in it.
    await updatePipeline(P2, ORG_A, { is_default: true });

    const refusal = await refuses(deletePipeline(P1, ORG_A));

    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('PIPELINE_HAS_DEALS');
    expect(refusal.details).toEqual({ deal_count: 2 });
    expect(state.pipelines.some((p) => p.id === P1)).toBe(true);
    expect(state.stages.filter((p) => p.pipeline_id === P1)).toHaveLength(4);
  });

  it('is refused for a deal that sits on its stage with a null pipeline_id', async () => {
    // D3 has pipeline_id null but stage_id S5, which belongs to P2. Counting
    // only pipeline_id would delete the stage out from under it and fail on the
    // foreign key — as a 500, after the pipeline row was already gone.
    const refusal = await refuses(deletePipeline(P2, ORG_A));

    expect(refusal.code).toBe('PIPELINE_HAS_DEALS');
    expect(refusal.details).toEqual({ deal_count: 1 });
  });

  it('is refused for the default pipeline and for the org\'s last one', async () => {
    expect((await refuses(deletePipeline(P1, ORG_A))).code).toBe('PIPELINE_IS_DEFAULT');
    expect((await refuses(deletePipeline(PB, ORG_B))).code).toBe('PIPELINE_LAST');
  });

  it('deletes an empty non-default pipeline together with its stages', async () => {
    const result = await deletePipeline(P3, ORG_A);

    expect(result).toEqual({ deleted_pipeline_id: P3, deleted_stages: 1 });
    expect(state.pipelines.some((p) => p.id === P3)).toBe(false);
    expect(state.stages.some((s) => s.pipeline_id === P3)).toBe(false);
    expect(state.deals).toHaveLength(3);
  });
});

// ─── Creating stages ──────────────────────────────────────────────────────────

describe('creating a stage', () => {
  it('appends to the end by default', async () => {
    const created = await createStage(ORG_A, { pipeline_id: P2, name: 'Оплата' });

    expect(created.position).toBe(2);
    expect(created.pipeline_id).toBe(P2);
    expect(created.is_archived).toBe(false);
  });

  it('inserts at a position and shifts the stages after it', async () => {
    const created = await createStage(ORG_A, { pipeline_id: P1, name: 'Переговоры', position: 2 });

    expect(created.position).toBe(2);
    const positions = Object.fromEntries(
      state.stages.filter((s) => s.pipeline_id === P1).map((s) => [s.id, s.position]),
    );
    expect(positions[S1]).toBe(0);
    expect(positions[S2]).toBe(1);
    expect(positions[S3]).toBe(3);
    expect(positions[S4]).toBe(4);
  });

  it('fills name, colour and probability from a library template', async () => {
    const created = await createStage(ORG_A, { pipeline_id: P2, template_key: 'invoice_issued' });

    expect(created.name).toBe('Выставлен счёт');
    expect(created.color).toBe('#FBBF24');
    expect(created.probability).toBe(85);
  });

  it('lets explicit fields override the template', async () => {
    const created = await createStage(ORG_A, {
      pipeline_id: P2,
      template_key: 'negotiation',
      name: 'Переговоры с юристом',
      probability: 55,
      stale_after_days: 30,
    });

    expect(created.name).toBe('Переговоры с юристом');
    expect(created.probability).toBe(55);
    expect(created.stale_after_days).toBe(30);
  });

  it('refuses an unknown template key', async () => {
    const refusal = await refuses(createStage(ORG_A, { pipeline_id: P2, template_key: 'not_a_stage' }));
    expect(refusal.httpStatus).toBe(400);
    expect(refusal.code).toBe('STAGE_TEMPLATE_NOT_FOUND');
  });

  it('refuses a duplicate name in the same pipeline, ignoring case and ё', async () => {
    const refusal = await refuses(createStage(ORG_A, { pipeline_id: P1, name: '  новый ЛИД ' }));
    expect(refusal.httpStatus).toBe(409);
    expect(refusal.code).toBe('STAGE_NAME_TAKEN');
    expect(state.stages.filter((s) => s.pipeline_id === P1)).toHaveLength(4);
  });

  it('refuses a blank name with no template', async () => {
    const refusal = await refuses(createStage(ORG_A, { pipeline_id: P2, name: '   ' }));
    expect(refusal.code).toBe('STAGE_NAME_REQUIRED');
  });
});

// ─── The template library ─────────────────────────────────────────────────────

describe('the stage library', () => {
  it('returns every template and marks the ones the pipeline already has', async () => {
    await createStage(ORG_A, { pipeline_id: P2, template_key: 'negotiation' });

    const { pipeline_id, entries } = await stageLibraryForPipeline(ORG_A, P2);

    expect(pipeline_id).toBe(P2);
    expect(entries).toHaveLength(OPTIONAL_STAGE_LIBRARY.length);
    expect(entries.find((e) => e.key === 'negotiation')?.already_added).toBe(true);
    expect(entries.find((e) => e.key === 'paid')?.already_added).toBe(false);
    // The template payload survives intact — the picker needs the rationale.
    expect(entries.find((e) => e.key === 'invoice_issued')?.rationale).toBeTruthy();
  });

  it('falls back to the org\'s default pipeline when none is named', async () => {
    const { pipeline_id } = await stageLibraryForPipeline(ORG_A);
    expect(pipeline_id).toBe(P1);
  });

  it('never marks a template from a different org\'s pipeline', async () => {
    const { entries } = await stageLibraryForPipeline(ORG_B);
    expect(entries.every((e) => !e.already_added)).toBe(true);
  });
});

// ─── Pipelines ────────────────────────────────────────────────────────────────

describe('pipeline CRUD', () => {
  it('creates a pipeline with the four default stages, the last one won', async () => {
    const created = (await createPipeline(ORG_A, null, { name: 'Новая воронка' })) as Row;

    const stages = state.stages.filter((s) => s.pipeline_id === created.id);
    expect(stages).toHaveLength(4);
    expect(stages.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    expect(stages.filter((s) => s.is_won_stage)).toHaveLength(1);
    expect(stages[3].is_won_stage).toBe(true);
  });

  it('honours supplied stage names and makes the final one the initial won stage', async () => {
    const created = (await createPipeline(ORG_A, null, {
      name: 'Сервис',
      stage_names: ['Обращение', 'В работе'],
    })) as Row;

    const stages = state.stages.filter((s) => s.pipeline_id === created.id);
    expect(stages.map((s) => s.name)).toEqual(['Обращение', 'В работе']);
    expect(stages.filter((s) => s.is_won_stage)).toHaveLength(1);
    expect(stages[1].is_won_stage).toBe(true);
  });

  it('refuses a duplicate pipeline name in the same org but allows it across orgs', async () => {
    expect((await refuses(createPipeline(ORG_A, null, { name: 'Партнёры' }))).code)
      .toBe('PIPELINE_NAME_TAKEN');
    await expect(createPipeline(ORG_B, null, { name: 'Партнёры' })).resolves.toBeTruthy();
  });

  it('moves the default flag rather than duplicating it', async () => {
    await updatePipeline(P2, ORG_A, { is_default: true });

    const defaults = state.pipelines.filter((p) => p.organization_id === ORG_A && p.is_default);
    expect(defaults.map((p) => p.id)).toEqual([P2]);
    // The other org's default is untouched.
    expect(state.pipelines.find((p) => p.id === PB)?.is_default).toBe(true);
  });
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('compares stage names case-, space- and ё-insensitively', () => {
    expect(normalizeStageName('  Сделка   Выиграна ')).toBe('сделка выиграна');
    expect(normalizeStageName('Отгружено')).toBe(normalizeStageName('отгружено'));
    expect(normalizeStageName('Учёт')).toBe(normalizeStageName('Учет'));
  });

  it('accepts only exact permutations of the stage set', () => {
    expect(orderedIdsMatchStageSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(orderedIdsMatchStageSet(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(orderedIdsMatchStageSet(['a'], ['a', 'b'])).toBe(false);
    expect(orderedIdsMatchStageSet(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(orderedIdsMatchStageSet([], [])).toBe(true);
  });

  it('clamps an out-of-range insert position instead of leaving a hole', () => {
    const siblings = [{ position: 0 }, { position: 1 }, { position: 2 }];
    expect(resolveInsertPosition(undefined, siblings)).toBe(3);
    expect(resolveInsertPosition(undefined, [])).toBe(0);
    expect(resolveInsertPosition(99, siblings)).toBe(3);
    expect(resolveInsertPosition(-4, siblings)).toBe(0);
    expect(resolveInsertPosition(1, siblings)).toBe(1);
    // Positions with a gap still append after the highest.
    expect(resolveInsertPosition(undefined, [{ position: 7 }])).toBe(8);
  });
});

// ─── The read contract the settings screen is built against ───────────────────

describe('GET /deals/pipelines', () => {
  it('asks Prisma for a deal count on every STAGE, not only on the pipeline', async () => {
    // The controller module is mocked at the top of this file for the route
    // suite below, so reach past the mock for the real handler.
    const { DealsController } = await vi.importActual<
      typeof import('../../../backend/api/controllers/deals')
    >('../../../backend/api/controllers/deals');

    const sent: Row[] = [];
    await DealsController.listPipelines(
      { user: { org_id: ORG_A, sub: 'user', role: 'owner' } } as never,
      { send: (payload: Row) => sent.push(payload) } as never,
    );

    const [args] = (mockDb.pipeline.findMany as unknown as { mock: { calls: Row[][] } }).mock.calls[0];
    expect(args.where).toEqual({ organization_id: ORG_A });
    // A stage-level count: `stage._count.deals` is what the funnel settings
    // screen reads to size the "N сделок" chip and to decide whether deleting a
    // stage will need move_to. A count only on the pipeline cannot answer that.
    expect(args.include.stages.include._count).toEqual({ select: { deals: true } });
    expect(args.include.stages.where).toEqual({ is_archived: false });
    expect(args.include.stages.orderBy).toEqual({ position: 'asc' });
    expect(args.include._count).toEqual({ select: { deals: true } });
    expect(sent).toHaveLength(1);
  });

  it('includes archived stages only for the administration screen', async () => {
    const { DealsController } = await vi.importActual<
      typeof import('../../../backend/api/controllers/deals')
    >('../../../backend/api/controllers/deals');

    await DealsController.listPipelines(
      {
        user: { org_id: ORG_A, sub: 'user', role: 'owner' },
        query: { include_archived: true },
      } as never,
      { send: vi.fn() } as never,
    );

    const calls = (mockDb.pipeline.findMany as unknown as { mock: { calls: Row[][] } }).mock.calls;
    const [args] = calls[calls.length - 1];
    expect(args.include.stages.where).toBeUndefined();
  });
});

// ─── The routes themselves ────────────────────────────────────────────────────
//
// Two things this suite exists to catch, neither of which the domain tests can:
// a handler wired to the wrong name (Fastify refuses to boot, but only when
// something registers the plugin), and a body reaching the controller unvalidated.

describe('funnel administration routes', () => {
  const UUID = 'aaaaaaaa-2222-4000-8000-000000000001';
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      return undefined;
    });
    await app.register(dealsRoutes, { prefix: '/deals' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const json = (payload: unknown) => ({
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

  it('routes the static stage paths ahead of /stages/:id and /deals/:id', async () => {
    const library = await app.inject({ method: 'GET', url: '/deals/stages/library' });
    expect(library.statusCode).toBe(200);
    expect(handlerMocks.stageLibrary).toHaveBeenCalledTimes(1);

    const reorder = await app.inject({
      method: 'POST',
      url: '/deals/stages/reorder',
      ...json({ pipeline_id: UUID, ordered_ids: [UUID] }),
    });
    expect(reorder.statusCode).toBe(200);
    expect(handlerMocks.reorderStages).toHaveBeenCalledTimes(1);

    // …and the parameterised ones still reach their own handlers.
    await app.inject({ method: 'DELETE', url: `/deals/stages/${UUID}?move_to=${UUID}` });
    expect(handlerMocks.deleteStage).toHaveBeenCalledTimes(1);

    await app.inject({ method: 'PATCH', url: `/deals/stages/${UUID}`, ...json({ name: 'Оплата' }) });
    expect(handlerMocks.updateStage).toHaveBeenCalledTimes(1);

    expect(handlerMocks.passthrough).not.toHaveBeenCalled();
  });

  const badCreateStage: Array<[string, Record<string, unknown>]> = [
    ['no pipeline_id', { name: 'Оплата' }],
    ['a pipeline_id that is not a uuid', { pipeline_id: 'main', name: 'Оплата' }],
    ['neither a name nor a template_key', { pipeline_id: UUID }],
    ['an empty name', { pipeline_id: UUID, name: '' }],
    ['a colour that is not hex', { pipeline_id: UUID, name: 'Оплата', color: 'red' }],
    ['a three-digit hex colour', { pipeline_id: UUID, name: 'Оплата', color: '#fff' }],
    ['a probability above 100', { pipeline_id: UUID, name: 'Оплата', probability: 101 }],
    ['a fractional probability', { pipeline_id: UUID, name: 'Оплата', probability: 12.5 }],
    ['a stale_after_days of zero', { pipeline_id: UUID, name: 'Оплата', stale_after_days: 0 }],
    ['a stale_after_days beyond a year', { pipeline_id: UUID, name: 'Оплата', stale_after_days: 366 }],
    ['a negative position', { pipeline_id: UUID, name: 'Оплата', position: -1 }],
    ['a non-boolean won flag', { pipeline_id: UUID, name: 'Оплата', is_won_stage: 'yes' }],
  ];

  for (const [label, payload] of badCreateStage) {
    it(`refuses POST /deals/stages with ${label}`, async () => {
      const response = await app.inject({ method: 'POST', url: '/deals/stages', ...json(payload) });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(handlerMocks.createStage).not.toHaveBeenCalled();
    });
  }

  it('accepts a stage created from a name or from a template key', async () => {
    for (const payload of [
      { pipeline_id: UUID, name: 'Оплата', color: '#34D399', probability: 95 },
      { pipeline_id: UUID, template_key: 'negotiation' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/deals/stages', ...json(payload) });
      expect(response.statusCode, JSON.stringify(payload)).toBe(200);
    }
    expect(handlerMocks.createStage).toHaveBeenCalledTimes(2);
  });

  it('refuses a stage id that is not a uuid, on both PATCH and DELETE', async () => {
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/deals/stages/../../etc/passwd',
        ...json({ name: 'x' }),
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(handlerMocks.updateStage).not.toHaveBeenCalled();
    expect(handlerMocks.deleteStage).not.toHaveBeenCalled();
  });

  it('refuses a move_to that is not a uuid', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/deals/stages/${UUID}?move_to=somewhere-else`,
    });
    expect(response.statusCode).toBe(400);
    expect(handlerMocks.deleteStage).not.toHaveBeenCalled();
  });

  it('refuses an empty PATCH body rather than issuing a no-op write', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/deals/stages/${UUID}`, ...json({}) });
    expect(response.statusCode).toBe(400);
    expect(handlerMocks.updateStage).not.toHaveBeenCalled();
  });

  const badReorder: Array<[string, Record<string, unknown>]> = [
    ['no pipeline_id', { ordered_ids: [UUID] }],
    ['no ordered_ids', { pipeline_id: UUID }],
    ['an empty ordered_ids', { pipeline_id: UUID, ordered_ids: [] }],
    ['ordered_ids that are not uuids', { pipeline_id: UUID, ordered_ids: ['first', 'second'] }],
    ['ordered_ids that is not an array', { pipeline_id: UUID, ordered_ids: UUID }],
  ];

  for (const [label, payload] of badReorder) {
    it(`refuses POST /deals/stages/reorder with ${label}`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/deals/stages/reorder',
        ...json(payload),
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(handlerMocks.reorderStages).not.toHaveBeenCalled();
    });
  }

  it('validates the pipeline routes', async () => {
    const noName = await app.inject({ method: 'POST', url: '/deals/pipelines', ...json({}) });
    expect(noName.statusCode).toBe(400);

    const emptyStageNames = await app.inject({
      method: 'POST',
      url: '/deals/pipelines',
      ...json({ name: 'Сервис', stage_names: [] }),
    });
    expect(emptyStageNames.statusCode).toBe(400);
    expect(handlerMocks.createPipeline).not.toHaveBeenCalled();

    const ok = await app.inject({
      method: 'POST',
      url: '/deals/pipelines',
      ...json({ name: 'Сервис', is_default: true }),
    });
    expect(ok.statusCode).toBe(200);
    expect(handlerMocks.createPipeline).toHaveBeenCalledTimes(1);

    const badId = await app.inject({
      method: 'DELETE',
      url: '/deals/pipelines/not-a-uuid',
    });
    expect(badId.statusCode).toBe(400);
    expect(handlerMocks.deletePipeline).not.toHaveBeenCalled();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/deals/pipelines/${UUID}`,
      ...json({ description: null }),
    });
    expect(patched.statusCode).toBe(200);
    expect(handlerMocks.updatePipeline).toHaveBeenCalledTimes(1);
  });

  it('refuses a pipeline_id that is not a uuid on the library route', async () => {
    const response = await app.inject({ method: 'GET', url: '/deals/stages/library?pipeline_id=main' });
    expect(response.statusCode).toBe(400);
    expect(handlerMocks.stageLibrary).not.toHaveBeenCalled();
  });
});
