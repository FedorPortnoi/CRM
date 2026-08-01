import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// amoCRM → 4КУБ funnel and field mapping.
//
// Everything here is offline: no amoCRM request is made, the pipelines payloads
// are the shapes amoCRM's own documentation prints, and the database is an
// in-memory stand-in that enforces the one invariant that matters — the two
// partial unique indexes from 20260801170000_reminders_push_amocrm_stages,
// "at most one won stage and one lost stage per pipeline".
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({
  amoEntityMap: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), count: vi.fn() },
  pipeline: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  pipelineStage: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const {
  AMO_STATUS_LOST,
  AMO_STATUS_WON,
  amoPipelineIdFromEntityType,
  amoRecordHash,
  amoTimestampToDate,
  applyPipelinePlan,
  extractAmoEmail,
  extractAmoPhone,
  ensureAmoStatusForLocalStage,
  isUnsortedStatus,
  isWonStatus,
  amoStatusForLocalStage,
  localStageForAmoStatus,
  loadStageMapping,
  mapCustomFields,
  planPipelineImport,
  resolveAmoStatus,
  resolveLocalStage,
  stageEntityType,
  syncPipelinesFromAmo,
} = await import('../../../backend/services/amocrm/mapping');

const ORG = '55555555-5555-4555-8555-000000000001';
const USER = '55555555-5555-4555-8555-00000000000a';

// ── An in-memory Prisma stand-in that enforces the partial unique indexes ─────

interface StageRow {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color?: string;
  is_won_stage: boolean;
  is_lost_stage: boolean;
}

class P2002 extends Error {
  code = 'P2002';
  meta: { target: string[] };
  constructor(target: string) {
    super('Unique constraint failed');
    this.meta = { target: [target] };
  }
}

function makeFakeDb() {
  const pipelines = new Map<string, { id: string; name: string }>();
  const stages = new Map<string, StageRow>();
  const maps = new Map<string, { entity_type: string; amo_id: bigint; local_id: string }>();
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;
  const mapKey = (t: string, amoId: bigint) => `${ORG}|${t}|${amoId}`;

  /** The database-level invariant, mirrored: one won and one lost per pipeline. */
  function assertTerminalFree(row: StageRow) {
    for (const other of stages.values()) {
      if (other.pipeline_id !== row.pipeline_id || other.id === row.id) continue;
      if (row.is_won_stage && other.is_won_stage) throw new P2002('pipeline_stage_one_won_per_pipeline');
      if (row.is_lost_stage && other.is_lost_stage) throw new P2002('pipeline_stage_one_lost_per_pipeline');
    }
  }

  return {
    _pipelines: pipelines,
    _stages: stages,
    _maps: maps,
    pipeline: {
      findUnique: async ({ where }: { where: { id: string } }) => pipelines.get(where.id) ?? null,
      create: async ({ data }: { data: { name: string } }) => {
        const row = { id: uid('pipeline'), name: data.name };
        pipelines.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: { name?: string } }) => {
        const row = pipelines.get(where.id);
        if (!row) throw new Error('P2025');
        Object.assign(row, data);
        return row;
      },
    },
    pipelineStage: {
      findUnique: async ({ where }: { where: { id: string } }) => stages.get(where.id) ?? null,
      create: async ({ data }: { data: Omit<StageRow, 'id'> }) => {
        const row: StageRow = { id: uid('stage'), ...data };
        assertTerminalFree(row);
        stages.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StageRow> }) => {
        const row = stages.get(where.id);
        if (!row) throw new Error('P2025');
        const next = { ...row, ...data };
        assertTerminalFree(next);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: { pipeline_id: string }; data: Partial<StageRow> }) => {
        let count = 0;
        for (const row of stages.values()) {
          if (row.pipeline_id !== where.pipeline_id) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      },
    },
    amoEntityMap: {
      findUnique: async ({ where }: { where: Record<string, { entity_type: string; amo_id: bigint }> }) => {
        const key = where.organization_id_entity_type_amo_id;
        return maps.get(mapKey(key.entity_type, key.amo_id)) ?? null;
      },
      findMany: async () => [...maps.values()],
      upsert: async ({
        where,
        create,
      }: {
        where: Record<string, { entity_type: string; amo_id: bigint }>;
        create: { entity_type: string; amo_id: bigint; local_id: string };
      }) => {
        const key = where.organization_id_entity_type_amo_id;
        maps.set(mapKey(key.entity_type, key.amo_id), {
          entity_type: create.entity_type,
          amo_id: create.amo_id,
          local_id: create.local_id,
        });
        return create;
      },
    },
  };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

// ── Fixtures shaped after amoCRM's documented /leads/pipelines payload ────────

function status(over: Partial<{ id: number; name: string; sort: number; color: string; type: number }>) {
  return {
    id: over.id ?? 1,
    name: over.name ?? 'Этап',
    sort: over.sort ?? 10,
    pipeline_id: 3177727,
    color: over.color ?? '#98cbff',
    type: over.type ?? 0,
    is_editable: true,
  };
}

/** One ordinary funnel: unsorted inbox, one working stage, 142, 143. */
function ordinaryPipeline(id = 3177727, name = 'Воронка продаж') {
  return {
    id,
    name,
    sort: 1,
    is_main: true,
    is_unsorted_on: true,
    is_archive: false,
    _embedded: {
      statuses: [
        status({ id: 32392156, name: 'Неразобранное', sort: 10, color: '#c1c1c1', type: 1 }),
        status({ id: 32392159, name: 'Переговоры', sort: 20, color: '#ffff99' }),
        status({ id: AMO_STATUS_WON, name: 'Успешно реализовано', sort: 10000, color: '#CCFF66' }),
        status({ id: AMO_STATUS_LOST, name: 'Закрыто и не реализовано', sort: 11000, color: '#D5D8DB' }),
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Custom fields ────────────────────────────────────────────────────────────

describe('mapCustomFields', () => {
  it('keys the local custom_fields object by amoCRM field_name', () => {
    const mapped = mapCustomFields([
      { field_id: 1, field_name: 'Должность', field_code: null, field_type: 'text', values: [{ value: 'Директор' }] },
      { field_id: 2, field_name: 'Бюджет', field_code: null, field_type: 'numeric', values: [{ value: 500000 }] },
    ]);

    expect(mapped).toEqual({ Должность: 'Директор', Бюджет: 500000 });
  });

  it('keeps a multi-valued field as an array rather than its first element', () => {
    const mapped = mapCustomFields([
      {
        field_id: 3,
        field_name: 'Интересы',
        field_type: 'multiselect',
        values: [{ value: 'CRM', enum_id: 10 }, { value: 'Аналитика', enum_id: 11 }],
      },
    ]);

    expect(mapped).toEqual({ Интересы: ['CRM', 'Аналитика'] });
  });

  it('never copies PHONE or EMAIL into the unencrypted custom_fields column', () => {
    // Contact.phone/email are encrypted at rest and blind-indexed. custom_fields is
    // a plain Json column. Copying the number into both hands back in cleartext
    // exactly what the encryption exists to protect — for the whole customer base
    // at once, because that is what an import is.
    const mapped = mapCustomFields([
      { field_id: 178382, field_name: 'Телефон', field_code: 'PHONE', field_type: 'multitext', values: [{ value: '+79991234567', enum_code: 'WORK' }] },
      { field_id: 178384, field_name: 'Email', field_code: 'EMAIL', field_type: 'multitext', values: [{ value: 'ivan@example.ru', enum_code: 'WORK' }] },
      { field_id: 5, field_name: 'Сайт', field_code: null, field_type: 'url', values: [{ value: 'https://example.ru' }] },
    ]);

    expect(mapped).toEqual({ Сайт: 'https://example.ru' });
    expect(JSON.stringify(mapped)).not.toContain('79991234567');
    expect(JSON.stringify(mapped)).not.toContain('ivan@example.ru');
  });

  it('disambiguates two fields sharing a name instead of dropping one', () => {
    const mapped = mapCustomFields([
      { field_id: 7, field_name: 'Комментарий', field_type: 'text', values: [{ value: 'первый' }] },
      { field_id: 8, field_name: 'Комментарий', field_type: 'text', values: [{ value: 'второй' }] },
    ]);

    expect(mapped).toEqual({ Комментарий: 'первый', 'Комментарий (8)': 'второй' });
  });

  it('drops empty fields and returns undefined when nothing survives', () => {
    expect(mapCustomFields([{ field_id: 9, field_name: 'Пусто', values: [] }])).toBeUndefined();
    expect(mapCustomFields(null)).toBeUndefined();
    expect(mapCustomFields(undefined)).toBeUndefined();
  });

  it('keeps a chained_list entry, which carries no `value` key at all', () => {
    const mapped = mapCustomFields([
      { field_id: 11, field_name: 'Каталог', field_type: 'chained_list', values: [{ catalog_id: 1001, catalog_element_id: 12235 } as never] },
    ]);

    expect(mapped).toEqual({ Каталог: { catalog_id: 1001, catalog_element_id: 12235 } });
  });
});

describe('phone and email extraction', () => {
  const fields = [
    { field_id: 178382, field_name: 'Телефон', field_code: 'PHONE', field_type: 'multitext', values: [{ value: ' +7 999 123-45-67 ', enum_code: 'WORK' }] },
    { field_id: 178384, field_name: 'Email', field_code: 'EMAIL', field_type: 'multitext', values: [{ value: 'ivan@example.ru', enum_code: 'PRIV' }] },
  ];

  it('reads them out of custom_fields_values, where amoCRM keeps them', () => {
    expect(extractAmoPhone(fields)).toBe('+7 999 123-45-67');
    expect(extractAmoEmail(fields)).toBe('ivan@example.ru');
  });

  it('returns undefined when the codes are absent', () => {
    expect(extractAmoPhone([{ field_id: 1, field_name: 'X', field_type: 'text', values: [{ value: 'y' }] }])).toBeUndefined();
    expect(extractAmoEmail(null)).toBeUndefined();
  });
});

describe('amoTimestampToDate', () => {
  it('reads unix seconds', () => {
    expect(amoTimestampToDate(1686670710)?.toISOString()).toBe('2023-06-13T15:38:30.000Z');
  });
  it('treats null / 0 / a string as absent', () => {
    expect(amoTimestampToDate(null)).toBeUndefined();
    expect(amoTimestampToDate(0)).toBeUndefined();
    expect(amoTimestampToDate('2023-06-13')).toBeUndefined();
  });
});

describe('amoRecordHash', () => {
  it('is stable across key order, so both sides of the sync agree', () => {
    expect(amoRecordHash({ a: 1, b: [2, { c: 3 }] })).toBe(amoRecordHash({ b: [2, { c: 3 }], a: 1 }));
  });
  it('changes when the record changes — that is what suppresses the echo', () => {
    expect(amoRecordHash({ name: 'Иван' })).not.toBe(amoRecordHash({ name: 'Пётр' }));
  });
});

// ── Terminal statuses ────────────────────────────────────────────────────────

describe('terminal status detection', () => {
  it('recognises 142 and 143 and nothing else', () => {
    expect(isWonStatus({ id: AMO_STATUS_WON })).toBe(true);
    expect(isWonStatus({ id: 32392159 })).toBe(false);
  });

  it('does NOT treat type:1 as successful — type:1 is the unsorted inbox', () => {
    // The trap: amoCRM's `type` distinguishes «Неразобранное» (1) from an ordinary
    // stage (0). Statuses 142 and 143 both carry type: 0. Reading type === 1 as
    // "won" files every unqualified inbound lead as a closed sale.
    const unsorted = status({ id: 32392156, name: 'Неразобранное', type: 1 });
    expect(isUnsortedStatus(unsorted)).toBe(true);
    expect(isWonStatus(unsorted)).toBe(false);
  });
});

describe('planPipelineImport', () => {
  it('maps 142 onto is_won_stage and 143 onto is_lost_stage', () => {
    const { pipelines, warnings } = planPipelineImport([ordinaryPipeline()]);

    expect(warnings).toEqual([]);
    const stages = pipelines[0].stages;
    expect(stages.find((s) => s.amo_status_id === AMO_STATUS_WON)).toMatchObject({ is_won_stage: true, is_lost_stage: false });
    expect(stages.find((s) => s.amo_status_id === AMO_STATUS_LOST)).toMatchObject({ is_won_stage: false, is_lost_stage: true });
    expect(stages.filter((s) => s.is_won_stage)).toHaveLength(1);
    expect(stages.filter((s) => s.is_lost_stage)).toHaveLength(1);
  });

  it('preserves amo order as 0..n-1 positions and keeps the colours', () => {
    const stages = planPipelineImport([ordinaryPipeline()]).pipelines[0].stages;

    expect(stages.map((s) => s.amo_status_id)).toEqual([32392156, 32392159, AMO_STATUS_WON, AMO_STATUS_LOST]);
    // amo's own `sort` leaves gaps (10, 20, 10000, 11000); the local kanban needs a dense order.
    expect(stages.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    // Read colours outside amoCRM's documented write-whitelist survive: #CCFF66 is
    // what amoCRM itself returns for status 142.
    expect(stages[2].color).toBe('#ccff66');
    expect(stages[0].color).toBe('#c1c1c1');
  });

  it('sorts by amo `sort`, not by the order statuses happen to arrive in', () => {
    const shuffled = {
      id: 1,
      name: 'Ф',
      _embedded: { statuses: [status({ id: 30, sort: 30 }), status({ id: 10, sort: 10 }), status({ id: 20, sort: 20 })] },
    };
    expect(planPipelineImport([shuffled]).pipelines[0].stages.map((s) => s.amo_status_id)).toEqual([10, 20, 30]);
  });

  it('keeps one won stage and demotes the rest when a funnel has two', () => {
    // The database allows one won stage per pipeline (partial unique index). An amo
    // payload carrying a second successful status must not become a P2002 halfway
    // through the import — the plan resolves it up front, visibly.
    const twoWon = {
      id: 900,
      name: 'Странная воронка',
      _embedded: {
        statuses: [
          status({ id: 500, name: 'Работа', sort: 10 }),
          status({ id: AMO_STATUS_WON, name: 'Успешно реализовано', sort: 10000 }),
          status({ id: AMO_STATUS_WON, name: 'Успешно (дубль)', sort: 10500 }),
          status({ id: AMO_STATUS_LOST, name: 'Проиграно', sort: 11000 }),
          status({ id: AMO_STATUS_LOST, name: 'Проиграно (дубль)', sort: 11500 }),
        ],
      },
    };

    const { pipelines, warnings } = planPipelineImport([twoWon]);
    const stages = pipelines[0].stages;

    expect(stages.filter((s) => s.is_won_stage)).toHaveLength(1);
    expect(stages.filter((s) => s.is_lost_stage)).toHaveLength(1);
    // Nothing is dropped — every amo status still becomes a local stage, so no lead
    // becomes unplaceable. Only the flag moves.
    expect(stages).toHaveLength(5);
    expect(warnings.filter((w) => w.code === 'DUPLICATE_TERMINAL_STATUS')).toHaveLength(2);
    expect(warnings.some((w) => w.flag === 'won')).toBe(true);
    expect(warnings.some((w) => w.flag === 'lost')).toBe(true);
  });

  it('warns about a funnel with no statuses instead of skipping it silently', () => {
    const { pipelines, warnings } = planPipelineImport([{ id: 7, name: 'Пустая', _embedded: { statuses: [] } }]);
    expect(pipelines).toHaveLength(1);
    expect(warnings[0].code).toBe('EMPTY_PIPELINE');
    expect(pipelines[0].stages).toHaveLength(2);
    expect(pipelines[0].stages.filter((stage) => stage.is_won_stage)).toHaveLength(1);
    expect(pipelines[0].stages.some((stage) => stage.name === 'Сделка выиграна')).toBe(true);
  });

  it('promotes the final non-lost stage when amoCRM omits status 142', () => {
    const pipeline = {
      id: 8,
      name: 'No terminal',
      _embedded: {
        statuses: [
          status({ id: 801, name: 'First', sort: 10 }),
          status({ id: 802, name: 'Final work', sort: 20 }),
          status({ id: AMO_STATUS_LOST, name: 'Lost', sort: 30 }),
        ],
      },
    };

    const { pipelines, warnings } = planPipelineImport([pipeline]);
    const stages = pipelines[0].stages;

    expect(stages.filter((stage) => stage.is_won_stage)).toHaveLength(1);
    expect(stages.find((stage) => stage.amo_status_id === 802)?.is_won_stage).toBe(true);
    expect(stages.find((stage) => stage.amo_status_id === AMO_STATUS_LOST)?.is_lost_stage).toBe(true);
    expect(warnings.some((warning) => warning.code === 'MISSING_WON_STATUS')).toBe(true);
  });

  it('adds a local-only won stage when every amoCRM status is lost', () => {
    const { pipelines, warnings } = planPipelineImport([{
      id: 9,
      name: 'Only lost',
      _embedded: { statuses: [status({ id: AMO_STATUS_LOST, name: 'Lost', sort: 10 })] },
    }]);
    const stages = pipelines[0].stages;

    expect(stages.filter((stage) => stage.is_won_stage)).toHaveLength(1);
    expect(stages.find((stage) => stage.is_won_stage)?.amo_status_id).toBeLessThan(0);
    expect(stages.find((stage) => stage.amo_status_id === AMO_STATUS_LOST)).toMatchObject({
      is_won_stage: false,
      is_lost_stage: true,
    });
    expect(warnings.some((warning) => warning.code === 'MISSING_WON_STATUS')).toBe(true);
  });

  it('tolerates null, a non-array, and entries with no id', () => {
    expect(planPipelineImport(null).pipelines).toEqual([]);
    expect(planPipelineImport(undefined).pipelines).toEqual([]);
    expect(planPipelineImport([{ name: 'без id' } as never]).pipelines).toEqual([]);
  });
});

// ── Persisting the mapping ───────────────────────────────────────────────────

describe('applyPipelinePlan', () => {
  it('creates the funnel and records every pipeline and stage in AmoEntityMap', async () => {
    const fake = makeFakeDb();
    const plan = planPipelineImport([ordinaryPipeline()]);
    const applied = await applyPipelinePlan(ORG, USER, plan, fake as never);

    expect(applied.pipelines_created).toBe(1);
    expect(applied.stages_created).toBe(4);

    // One 'pipeline' row plus one namespaced 'stage:<amo pipeline id>' row per status.
    const rows = [...fake._maps.values()];
    expect(rows.filter((r) => r.entity_type === 'pipeline')).toHaveLength(1);
    expect(rows.filter((r) => r.entity_type === stageEntityType(3177727))).toHaveLength(4);

    // Every recorded local_id addresses a row that actually exists.
    for (const row of rows) {
      const exists = fake._pipelines.has(row.local_id) || fake._stages.has(row.local_id);
      expect(exists).toBe(true);
    }
  });

  it('namespaces stages per funnel so two pipelines can both own status 142', async () => {
    // THE reason entity_type is 'stage:<amo pipeline id>' and not 'stage'.
    // AmoEntityMap is unique on (org, entity_type, amo_id); 142 exists verbatim in
    // every amo funnel. Flat 'stage' rows would collide and one funnel's won stage
    // would silently lose its mapping, sending every won lead to the wrong pipeline.
    const fake = makeFakeDb();
    const plan = planPipelineImport([ordinaryPipeline(111, 'Первая'), ordinaryPipeline(222, 'Вторая')]);
    const applied = await applyPipelinePlan(ORG, USER, plan, fake as never);

    expect(applied.pipelines_created).toBe(2);

    const a = applied.mapping.stageByAmo.get(`111:${AMO_STATUS_WON}`);
    const b = applied.mapping.stageByAmo.get(`222:${AMO_STATUS_WON}`);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);

    expect(fake._maps.has(`${ORG}|${stageEntityType(111)}|142`)).toBe(true);
    expect(fake._maps.has(`${ORG}|${stageEntityType(222)}|142`)).toBe(true);
    expect(amoPipelineIdFromEntityType(stageEntityType(222))).toBe(222);
  });

  it('is idempotent — a second run updates the same rows instead of duplicating', async () => {
    const fake = makeFakeDb();
    const plan = planPipelineImport([ordinaryPipeline()]);

    await applyPipelinePlan(ORG, USER, plan, fake as never);
    const second = await applyPipelinePlan(ORG, USER, plan, fake as never);

    expect(second.pipelines_created).toBe(0);
    expect(second.pipelines_updated).toBe(1);
    expect(second.stages_created).toBe(0);
    expect(second.stages_updated).toBe(4);
    expect(fake._pipelines.size).toBe(1);
    expect(fake._stages.size).toBe(4);
  });

  it('lets the won flag move to a different stage on re-import', async () => {
    // Wiping both terminal flags across the funnel before reassigning them is what
    // makes this legal — setting the new won stage while the old one still holds
    // the flag trips the partial unique index.
    const fake = makeFakeDb();
    await applyPipelinePlan(ORG, USER, planPipelineImport([ordinaryPipeline()]), fake as never);

    const moved = {
      id: 3177727,
      name: 'Воронка продаж',
      _embedded: {
        statuses: [
          status({ id: 32392159, name: 'Переговоры', sort: 20 }),
          // amo renamed 142 and the account now also sorts it differently.
          status({ id: AMO_STATUS_WON, name: 'Сделка закрыта', sort: 9000 }),
        ],
      },
    };
    const again = await applyPipelinePlan(ORG, USER, planPipelineImport([moved]), fake as never);

    expect(again.warnings.filter((w) => w.code === 'DUPLICATE_TERMINAL_STATUS')).toHaveLength(0);
    const won = [...fake._stages.values()].filter((s) => s.is_won_stage);
    expect(won).toHaveLength(1);
    expect(won[0].name).toBe('Сделка закрыта');
  });

  it('imports the funnel anyway when the local pipeline already owns a won stage', async () => {
    // Backstop the plan cannot see: a local pipeline carrying a won stage from
    // somewhere other than this import. Losing the flag costs a report column;
    // aborting would cost every stage and every lead behind it.
    const fake = makeFakeDb();
    const plan = planPipelineImport([ordinaryPipeline()]);

    let injected = false;
    const guarded = {
      ...fake,
      pipelineStage: {
        ...fake.pipelineStage,
        create: async (args: { data: StageRow }) => {
          if (!injected && args.data.is_won_stage) {
            injected = true;
            throw new P2002('pipeline_stage_one_won_per_pipeline');
          }
          return fake.pipelineStage.create(args as never);
        },
      },
    };

    const applied = await applyPipelinePlan(ORG, USER, plan, guarded as never);

    expect(injected).toBe(true);
    expect(applied.stages_created).toBe(4);
    expect(applied.warnings.some((w) => w.code === 'DUPLICATE_TERMINAL_STATUS')).toBe(true);
    // The stage exists and is mapped — just without the flag.
    expect(applied.mapping.stageByAmo.get(`3177727:${AMO_STATUS_WON}`)).toBeTruthy();
    expect([...fake._stages.values()].filter((s) => s.is_won_stage)).toHaveLength(0);
  });

  it('rethrows a unique violation that is not about the terminal flags', async () => {
    const fake = makeFakeDb();
    const guarded = {
      ...fake,
      pipelineStage: {
        ...fake.pipelineStage,
        create: async () => {
          throw new P2002('PipelineStage_pipeline_id_name_key');
        },
      },
    };

    await expect(
      applyPipelinePlan(ORG, USER, planPipelineImport([ordinaryPipeline()]), guarded as never),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('the read interface the sync worker uses', () => {
  it('round-trips amo {pipeline_id, status_id} ↔ local stage in both directions', async () => {
    const fake = makeFakeDb();
    const applied = await applyPipelinePlan(
      ORG,
      USER,
      planPipelineImport([ordinaryPipeline(111, 'Первая'), ordinaryPipeline(222, 'Вторая')]),
      fake as never,
    );

    // loadStageMapping reads what applyPipelinePlan wrote.
    dbMock.amoEntityMap.findMany.mockResolvedValue([...fake._maps.values()]);
    const loaded = await loadStageMapping(ORG);

    const forward = resolveLocalStage(loaded, 222, AMO_STATUS_WON);
    expect(forward).not.toBeNull();
    expect(forward?.stage_id).toBe(applied.mapping.stageByAmo.get(`222:${AMO_STATUS_WON}`));
    expect(forward?.pipeline_id).toBe(applied.mapping.pipelineByAmo.get(222));

    expect(resolveAmoStatus(loaded, forward!.stage_id)).toEqual({
      amo_pipeline_id: 222,
      amo_status_id: AMO_STATUS_WON,
    });
  });

  it('returns null for a status amoCRM created after the last funnel sync', async () => {
    dbMock.amoEntityMap.findMany.mockResolvedValue([]);
    const loaded = await loadStageMapping(ORG);
    expect(resolveLocalStage(loaded, 111, 999)).toBeNull();
    expect(resolveAmoStatus(loaded, 'stage-does-not-exist')).toBeNull();
  });

  it('ignores contact/lead rows that share the table', async () => {
    dbMock.amoEntityMap.findMany.mockResolvedValue([
      { entity_type: 'contact', amo_id: 406322n, local_id: 'contact-1' },
      { entity_type: 'pipeline', amo_id: 111n, local_id: 'pipeline-1' },
      { entity_type: stageEntityType(111), amo_id: 142n, local_id: 'stage-1' },
    ]);

    const loaded = await loadStageMapping(ORG);
    expect(loaded.stageByAmo.size).toBe(1);
    expect(loaded.pipelineByAmo.get(111)).toBe('pipeline-1');
    expect(resolveLocalStage(loaded, 111, 142)).toEqual({ pipeline_id: 'pipeline-1', stage_id: 'stage-1' });
  });
});

describe('the AmoMappingModule port sync-worker.ts imports by name', () => {
  function routeDbAt(fake: FakeDb) {
    dbMock.amoEntityMap.findUnique.mockImplementation(fake.amoEntityMap.findUnique as never);
    dbMock.amoEntityMap.findMany.mockImplementation(async ({ where }: { where: { amo_id?: bigint } }) =>
      [...fake._maps.values()].filter(
        (r) => r.entity_type.startsWith('stage:') && (where.amo_id === undefined || r.amo_id === where.amo_id),
      ),
    );
    dbMock.amoEntityMap.findFirst.mockImplementation(async ({ where }: { where: { local_id: string } }) =>
      [...fake._maps.values()].find(
        (r) => r.entity_type.startsWith('stage:') && r.local_id === where.local_id,
      ) ?? null,
    );
  }

  it('resolves both directions for a status disambiguated by its pipeline', async () => {
    const fake = makeFakeDb();
    const applied = await applyPipelinePlan(
      ORG,
      USER,
      planPipelineImport([ordinaryPipeline(111, 'Первая'), ordinaryPipeline(222, 'Вторая')]),
      fake as never,
    );
    routeDbAt(fake);

    const local = await localStageForAmoStatus(ORG, AMO_STATUS_WON, 222);
    expect(local).toEqual({
      pipeline_id: applied.mapping.pipelineByAmo.get(222),
      stage_id: applied.mapping.stageByAmo.get(`222:${AMO_STATUS_WON}`),
    });

    expect(await amoStatusForLocalStage(ORG, local!.stage_id)).toEqual({
      status_id: AMO_STATUS_WON,
      pipeline_id: 222,
    });
  });

  it('refuses to guess when 142 is ambiguous across two funnels', async () => {
    // Returning *a* funnel here would file a won deal into a stranger's pipeline.
    const fake = makeFakeDb();
    await applyPipelinePlan(
      ORG,
      USER,
      planPipelineImport([ordinaryPipeline(111, 'Первая'), ordinaryPipeline(222, 'Вторая')]),
      fake as never,
    );
    routeDbAt(fake);

    expect(await localStageForAmoStatus(ORG, AMO_STATUS_WON)).toBeNull();
  });

  it('resolves an unambiguous status even without a pipeline id', async () => {
    const fake = makeFakeDb();
    await applyPipelinePlan(ORG, USER, planPipelineImport([ordinaryPipeline(111, 'Первая')]), fake as never);
    routeDbAt(fake);

    const local = await localStageForAmoStatus(ORG, 32392159);
    expect(local?.stage_id).toBeTruthy();
    expect(await amoStatusForLocalStage(ORG, local!.stage_id)).toEqual({ status_id: 32392159, pipeline_id: 111 });
  });

  it('returns null for a stage that was never mapped', async () => {
    const fake = makeFakeDb();
    routeDbAt(fake);
    expect(await localStageForAmoStatus(ORG, 142, 111)).toBeNull();
    expect(await amoStatusForLocalStage(ORG, 'stage-unknown')).toBeNull();
  });
});

describe('syncPipelinesFromAmo', () => {
  it('reads /api/v4/leads/pipelines and writes the funnel through the default db', async () => {
    const fake: FakeDb = makeFakeDb();
    // syncPipelinesFromAmo goes through the module-level `db`, so route the mock at it.
    dbMock.amoEntityMap.findUnique.mockImplementation(fake.amoEntityMap.findUnique as never);
    dbMock.amoEntityMap.upsert.mockImplementation(fake.amoEntityMap.upsert as never);
    dbMock.pipeline.findUnique.mockImplementation(fake.pipeline.findUnique as never);
    dbMock.pipeline.create.mockImplementation(fake.pipeline.create as never);
    dbMock.pipeline.update.mockImplementation(fake.pipeline.update as never);
    dbMock.pipelineStage.findUnique.mockImplementation(fake.pipelineStage.findUnique as never);
    dbMock.pipelineStage.create.mockImplementation(fake.pipelineStage.create as never);
    dbMock.pipelineStage.update.mockImplementation(fake.pipelineStage.update as never);
    dbMock.pipelineStage.updateMany.mockImplementation(fake.pipelineStage.updateMany as never);

    const amoRequest = vi.fn().mockResolvedValue({ _embedded: { pipelines: [ordinaryPipeline()] } });
    const client = { amoRequest, paginate: vi.fn() };

    const applied = await syncPipelinesFromAmo(client as never, ORG, USER);

    expect(amoRequest).toHaveBeenCalledWith(ORG, 'GET', '/api/v4/leads/pipelines');
    expect(applied.pipelines_created).toBe(1);
    expect(applied.stages_created).toBe(4);
    expect(applied.plan.pipelines[0].name).toBe('Воронка продаж');
  });

  it('survives the 204 No Content amoCRM returns for an empty list', async () => {
    // amoCRM answers a list request that matches nothing with 204 and an empty
    // body, so the client hands back null rather than an envelope.
    const client = { amoRequest: vi.fn().mockResolvedValue(null), paginate: vi.fn() };
    const applied = await syncPipelinesFromAmo(client as never, ORG, USER);
    expect(applied.plan.pipelines).toEqual([]);
    expect(applied.pipelines_created).toBe(0);
  });
});

describe('outbound mapping for locally-created funnels and stages', () => {
  type LocalStage = {
    id: string;
    pipeline_id: string;
    name: string;
    position: number;
    color: string | null;
    is_won_stage: boolean;
    is_lost_stage: boolean;
    is_archived: boolean;
  };

  const PIPELINE = '55555555-5555-4555-8555-0000000000f0';
  const OPEN = '55555555-5555-4555-8555-0000000000f1';
  const WON = '55555555-5555-4555-8555-0000000000f2';
  const LOST = '55555555-5555-4555-8555-0000000000f3';

  function localStage(id: string, name: string, position: number, terminal?: 'won' | 'lost'): LocalStage {
    return {
      id,
      pipeline_id: PIPELINE,
      name,
      position,
      color: null,
      is_won_stage: terminal === 'won',
      is_lost_stage: terminal === 'lost',
      is_archived: false,
    };
  }

  function routeOutboundDb(stages: LocalStage[], initialMaps: Array<{ entity_type: string; amo_id: bigint; local_id: string }> = []) {
    const maps = [...initialMaps];
    dbMock.pipelineStage.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      stages.find((stage) => stage.id === where.id) ?? null,
    );
    dbMock.pipelineStage.findMany.mockResolvedValue(stages);
    dbMock.pipeline.findFirst.mockResolvedValue({ id: PIPELINE, name: 'Local sales' });
    dbMock.amoEntityMap.findFirst.mockImplementation(async ({ where }: { where: { entity_type?: unknown; local_id?: string } }) =>
      maps.find((row) => {
        if (where.local_id !== undefined && row.local_id !== where.local_id) return false;
        if (typeof where.entity_type === 'string' && row.entity_type !== where.entity_type) return false;
        if (where.entity_type && typeof where.entity_type === 'object' && !row.entity_type.startsWith('stage:')) return false;
        return true;
      }) ?? null,
    );
    dbMock.amoEntityMap.findUnique.mockImplementation(async ({ where }: {
      where: { organization_id_entity_type_amo_id: { entity_type: string; amo_id: bigint } };
    }) => {
      const key = where.organization_id_entity_type_amo_id;
      return maps.find((row) => row.entity_type === key.entity_type && row.amo_id === key.amo_id) ?? null;
    });
    dbMock.amoEntityMap.upsert.mockImplementation(async ({ create, update, where }: {
      create: { entity_type: string; amo_id: bigint; local_id: string };
      update: { local_id: string };
      where: { organization_id_entity_type_amo_id: { entity_type: string; amo_id: bigint } };
    }) => {
      const key = where.organization_id_entity_type_amo_id;
      const existing = maps.find((row) => row.entity_type === key.entity_type && row.amo_id === key.amo_id);
      if (existing) existing.local_id = update.local_id;
      else maps.push({ entity_type: create.entity_type, amo_id: create.amo_id, local_id: create.local_id });
      return existing ?? create;
    });
    return maps;
  }

  it('creates an unmapped remote pipeline with every active local stage and persists all coordinates', async () => {
    const stages = [
      localStage(OPEN, 'Qualification', 0),
      localStage(WON, 'Won locally', 1, 'won'),
      localStage(LOST, 'Lost locally', 2, 'lost'),
    ];
    const maps = routeOutboundDb(stages);
    const amoRequest = vi.fn().mockResolvedValue({
      _embedded: {
        pipelines: [{
          id: 901,
          _embedded: {
            statuses: [
              { id: 501, pipeline_id: 901, name: 'Qualification', request_id: OPEN },
              { id: AMO_STATUS_WON, pipeline_id: 901, name: 'Won locally' },
              { id: AMO_STATUS_LOST, pipeline_id: 901, name: 'Lost locally' },
            ],
          },
        }],
      },
    });

    await expect(ensureAmoStatusForLocalStage(ORG, OPEN, { amoRequest, paginate: vi.fn() } as never))
      .resolves.toEqual({ status_id: 501, pipeline_id: 901 });

    expect(amoRequest).toHaveBeenCalledWith(ORG, 'POST', '/api/v4/leads/pipelines', [expect.objectContaining({
      name: 'Local sales',
      is_main: false,
      is_unsorted_on: false,
      _embedded: {
        statuses: [
          { name: 'Qualification', sort: 100, request_id: OPEN },
          { id: AMO_STATUS_WON, name: 'Won locally' },
          { id: AMO_STATUS_LOST, name: 'Lost locally' },
        ],
      },
    })]);
    expect(maps).toEqual(expect.arrayContaining([
      { entity_type: 'pipeline', amo_id: 901n, local_id: PIPELINE },
      { entity_type: stageEntityType(901), amo_id: 501n, local_id: OPEN },
      { entity_type: stageEntityType(901), amo_id: 142n, local_id: WON },
      { entity_type: stageEntityType(901), amo_id: 143n, local_id: LOST },
    ]));
  });

  it('creates and maps a new ordinary status in an already-mapped pipeline', async () => {
    const stage = localStage(OPEN, 'Contract review', 4);
    const maps = routeOutboundDb([stage], [{ entity_type: 'pipeline', amo_id: 902n, local_id: PIPELINE }]);
    const amoRequest = vi.fn()
      .mockResolvedValueOnce({
        _embedded: { statuses: [{ id: 142, pipeline_id: 902, name: 'Won' }, { id: 143, pipeline_id: 902, name: 'Lost' }] },
      })
      .mockResolvedValueOnce({
        _embedded: { statuses: [{ id: 777, pipeline_id: 902, name: 'Contract review', request_id: OPEN }] },
      });

    await expect(ensureAmoStatusForLocalStage(ORG, OPEN, { amoRequest, paginate: vi.fn() } as never))
      .resolves.toEqual({ status_id: 777, pipeline_id: 902 });
    expect(amoRequest).toHaveBeenNthCalledWith(2, ORG, 'POST', '/api/v4/leads/pipelines/902/statuses', [
      { name: 'Contract review', sort: 500, request_id: OPEN },
    ]);
    expect(maps).toContainEqual({ entity_type: stageEntityType(902), amo_id: 777n, local_id: OPEN });
  });

  it('maps local terminal stages to reserved 142/143 without trying to create them', async () => {
    const won = localStage(WON, 'Closed', 5, 'won');
    const maps = routeOutboundDb([won], [{ entity_type: 'pipeline', amo_id: 903n, local_id: PIPELINE }]);
    const amoRequest = vi.fn();

    await expect(ensureAmoStatusForLocalStage(ORG, WON, { amoRequest, paginate: vi.fn() } as never))
      .resolves.toEqual({ status_id: AMO_STATUS_WON, pipeline_id: 903 });
    expect(amoRequest).not.toHaveBeenCalled();
    expect(maps).toContainEqual({ entity_type: stageEntityType(903), amo_id: 142n, local_id: WON });
  });

  it('throws on a malformed create response and never invents a stage mapping', async () => {
    const stage = localStage(OPEN, 'Negotiation', 1);
    const maps = routeOutboundDb([stage], [{ entity_type: 'pipeline', amo_id: 904n, local_id: PIPELINE }]);
    const amoRequest = vi.fn()
      .mockResolvedValueOnce({ _embedded: { statuses: [] } })
      .mockResolvedValueOnce({ unexpected: true });

    await expect(ensureAmoStatusForLocalStage(ORG, OPEN, { amoRequest, paginate: vi.fn() } as never))
      .rejects.toThrow('malformed statuses response');
    expect(maps.some((row) => row.entity_type === stageEntityType(904))).toBe(false);
  });
});
