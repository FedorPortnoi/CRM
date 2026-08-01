import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// amoCRM one-time import.
//
// No network: `amoRequest`/`paginate` are injected as fakes, and the database is
// an in-memory stand-in. What is being pinned here is the part that is invisible
// until it is too late — that EVERY imported record leaves an AmoEntityMap row.
// Without one, the webhook receiver has never heard of the row this import
// created, so the first inbound update for it creates a second copy. Import
// 20 000 leads with a broken bridge and the account doubles the moment sync is
// switched on, silently, after the import has already reported success.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({
  contact: { create: vi.fn(), update: vi.fn() },
  deal: { create: vi.fn(), update: vi.fn() },
  amoEntityMap: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), count: vi.fn() },
  pipeline: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  pipelineStage: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('../../../backend/services/db', () => ({ db: dbMock }));

const { importFromAmo, previewAmoImport } = await import('../../../backend/services/amocrm/import');
const { blindIndex, ENCRYPTED_FIELD_PREFIX, decryptField } = await import(
  '../../../backend/services/encryption'
);
const { AMO_STATUS_LOST, AMO_STATUS_WON, stageEntityType, syntheticCompanyLocalId } = await import(
  '../../../backend/services/amocrm/mapping'
);
const { hashAmoEntity } = await import('../../../backend/services/amocrm/echo');

const ORG = '66666666-6666-4666-8666-000000000001';
const USER = '66666666-6666-4666-8666-00000000000a';
const AMO_PIPELINE = 3177727;
const AMO_STAGE_WORK = 32392159;

// ── In-memory database ───────────────────────────────────────────────────────

interface Row {
  id: string;
  [key: string]: unknown;
}

function installFakeDb() {
  const contacts = new Map<string, Row>();
  const deals = new Map<string, Row>();
  const pipelines = new Map<string, Row>();
  const stages = new Map<string, Row>();
  const maps = new Map<string, { entity_type: string; amo_id: bigint; local_id: string; last_remote_hash?: string }>();
  let seq = 0;
  const uid = (p: string) => `${p}-${String(++seq).padStart(4, '0')}`;
  const key = (t: string, amoId: bigint) => `${ORG}|${t}|${amoId}`;

  function store(map: Map<string, Row>, prefix: string) {
    return {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => map.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: uid(prefix), ...data };
        map.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = map.get(where.id);
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of map.values()) {
          if (where.pipeline_id && row.pipeline_id !== where.pipeline_id) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      }),
    };
  }

  Object.assign(dbMock.contact, store(contacts, 'contact'));
  Object.assign(dbMock.deal, store(deals, 'deal'));
  Object.assign(dbMock.pipeline, store(pipelines, 'pipeline'));
  Object.assign(dbMock.pipelineStage, store(stages, 'stage'));

  dbMock.amoEntityMap.findUnique.mockImplementation(
    async ({ where }: { where: Record<string, { entity_type: string; amo_id: bigint }> }) => {
      const k = where.organization_id_entity_type_amo_id;
      return maps.get(key(k.entity_type, k.amo_id)) ?? null;
    },
  );
  dbMock.amoEntityMap.findMany.mockImplementation(async () => [...maps.values()]);
  dbMock.amoEntityMap.upsert.mockImplementation(
    async ({
      where,
      create,
    }: {
      where: Record<string, { entity_type: string; amo_id: bigint }>;
      create: { entity_type: string; amo_id: bigint; local_id: string; last_remote_hash?: string };
    }) => {
      const k = where.organization_id_entity_type_amo_id;
      maps.set(key(k.entity_type, k.amo_id), { ...create });
      return create;
    },
  );
  dbMock.amoEntityMap.count.mockImplementation(
    async ({ where }: { where: { entity_type: string } }) =>
      [...maps.values()].filter((m) => m.entity_type === where.entity_type).length,
  );

  return { contacts, deals, pipelines, stages, maps };
}

// ── amoCRM fixtures (shapes taken from amoCRM's published examples) ───────────

const PIPELINES_PAYLOAD = {
  _total_items: 1,
  _embedded: {
    pipelines: [
      {
        id: AMO_PIPELINE,
        name: 'Воронка продаж',
        sort: 1,
        is_main: true,
        is_unsorted_on: true,
        is_archive: false,
        _embedded: {
          statuses: [
            { id: 32392156, name: 'Неразобранное', sort: 10, pipeline_id: AMO_PIPELINE, color: '#c1c1c1', type: 1 },
            { id: AMO_STAGE_WORK, name: 'Переговоры', sort: 20, pipeline_id: AMO_PIPELINE, color: '#ffff99', type: 0 },
            { id: AMO_STATUS_WON, name: 'Успешно реализовано', sort: 10000, pipeline_id: AMO_PIPELINE, color: '#CCFF66', type: 0 },
            { id: AMO_STATUS_LOST, name: 'Закрыто и не реализовано', sort: 11000, pipeline_id: AMO_PIPELINE, color: '#D5D8DB', type: 0 },
          ],
        },
      },
    ],
  },
};

const PHONE = '+7 (999) 123-45-67';
const EMAIL = 'Ivan.Petrov@Example.RU';

function amoContact(over: Record<string, unknown> = {}) {
  return {
    id: 406322,
    name: 'Иван Петров',
    first_name: 'Иван',
    last_name: 'Петров',
    created_at: 1686670710,
    is_deleted: false,
    custom_fields_values: [
      { field_id: 178382, field_name: 'Телефон', field_code: 'PHONE', field_type: 'multitext', values: [{ value: PHONE, enum_code: 'WORK' }] },
      { field_id: 178384, field_name: 'Email', field_code: 'EMAIL', field_type: 'multitext', values: [{ value: EMAIL, enum_code: 'WORK' }] },
      { field_id: 5, field_name: 'Должность', field_type: 'text', values: [{ value: 'Директор' }] },
    ],
    _embedded: { tags: [], companies: [{ id: 406320 }] },
    ...over,
  };
}

function amoCompany(over: Record<string, unknown> = {}) {
  return { id: 406320, name: 'ООО «Ромашка»', is_deleted: false, custom_fields_values: null, ...over };
}

function amoLead(over: Record<string, unknown> = {}) {
  return {
    id: 10971465,
    name: 'Поставка станков',
    price: 250000,
    status_id: AMO_STAGE_WORK,
    pipeline_id: AMO_PIPELINE,
    created_at: 1686670710,
    closed_at: null,
    is_deleted: false,
    custom_fields_values: [{ field_id: 42, field_name: 'Источник заявки', field_type: 'text', values: [{ value: 'Сайт' }] }],
    _embedded: { contacts: [{ id: 406322, is_main: true }] },
    ...over,
  };
}

/** A `paginate` fake: one entry per path, each a list of pages. */
function makeClient(
  pages: Record<string, unknown[][]>,
  opts: { throwOnPath?: string; throwAfterPage?: number; accountCurrency?: string } = {},
) {
  const amoRequest = vi.fn(async (_org: string, _method: string, path: string) => {
    if (path === '/api/v4/account') return { currency: opts.accountCurrency ?? 'RUB' };
    if (path.startsWith('/api/v4/leads/pipelines')) return PIPELINES_PAYLOAD;
    const base = path.split('?')[0];
    const collection = base.replace('/api/v4/', '');
    const first = pages[base]?.[0] ?? [];
    return { _embedded: { [collection]: first }, _links: { next: (pages[base]?.length ?? 0) > 1 ? { href: 'x' } : undefined } };
  });

  const paginate = vi.fn((_org: string, path: string) => {
    const batches = pages[path] ?? [];
    return (async function* () {
      let index = 0;
      for (const batch of batches) {
        if (opts.throwOnPath === path && index === (opts.throwAfterPage ?? 0)) {
          throw new Error('amoCRM 429 Too Many Requests');
        }
        yield batch;
        index++;
      }
      if (opts.throwOnPath === path && index === (opts.throwAfterPage ?? -1)) {
        throw new Error('amoCRM 429 Too Many Requests');
      }
    })();
  });

  return { amoRequest, paginate };
}

let fake: ReturnType<typeof installFakeDb>;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.TOKEN_ENCRYPTION_KEY = 'd'.repeat(32);
  vi.clearAllMocks();
  fake = installFakeDb();
});

afterEach(() => {
  process.env = savedEnv;
});

// ── Contacts ─────────────────────────────────────────────────────────────────

describe('contacts', () => {
  it('maps custom fields by name and keeps phone/email encrypted and indexed', async () => {
    const client = makeClient({
      '/api/v4/companies': [[amoCompany()]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[]],
    });

    const result = await importFromAmo(ORG, USER, { client });
    expect(result.contacts_imported).toBe(1);
    expect(result.contacts_failed).toBe(0);

    const contact = [...fake.contacts.values()][0];
    expect(contact.first_name).toBe('Иван');
    expect(contact.last_name).toBe('Петров');
    // The company arrives as a name on the contact — 4КУБ has no Company entity.
    expect(contact.company).toBe('ООО «Ромашка»');
    // Non-PII custom fields land in the Json column under their amoCRM names.
    expect(contact.custom_fields).toEqual({ Должность: 'Директор' });

    // Encrypted at rest…
    expect(contact.phone as string).toMatch(new RegExp(`^${ENCRYPTED_FIELD_PREFIX}`));
    expect(decryptField(contact.phone as string)).toBe(PHONE);
    // …and indexed from the PLAINTEXT, not the ciphertext. encryptField uses a
    // fresh IV per call, so an index taken from its output matches no lookup that
    // will ever run, and the whole imported base becomes unfindable by number.
    expect(contact.phone_bidx).toBe(blindIndex(PHONE, 'phone'));
    expect(contact.phone_bidx).not.toBe(blindIndex(contact.phone as string, 'phone'));
    expect(contact.email_bidx).toBe(blindIndex(EMAIL, 'email'));
  });

  it('never copies the phone or email into the unencrypted custom_fields column', async () => {
    const client = makeClient({ '/api/v4/companies': [[]], '/api/v4/contacts': [[amoContact()]], '/api/v4/leads': [[]] });
    await importFromAmo(ORG, USER, { client });

    const contact = [...fake.contacts.values()][0];
    expect(JSON.stringify(contact.custom_fields)).not.toContain('79991234567');
    expect(JSON.stringify(contact.custom_fields)).not.toContain('123-45-67');
    expect(JSON.stringify(contact.custom_fields).toLowerCase()).not.toContain('ivan.petrov');
  });

  it('falls back to splitting `name` when first_name/last_name are empty', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[amoContact({ first_name: '', last_name: '', name: 'Пётр Сидоров' })]],
      '/api/v4/leads': [[]],
    });
    await importFromAmo(ORG, USER, { client });

    const contact = [...fake.contacts.values()][0];
    expect(contact.first_name).toBe('Пётр');
    expect(contact.last_name).toBe('Сидоров');
  });

  it('skips a deleted contact without counting it as a failure', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[amoContact({ id: 1, is_deleted: true })]],
      '/api/v4/leads': [[]],
    });
    const result = await importFromAmo(ORG, USER, { client });

    expect(result.contacts_imported).toBe(0);
    expect(result.contacts_failed).toBe(0);
    expect(fake.contacts.size).toBe(0);
  });
});

// ── The bridge table ─────────────────────────────────────────────────────────

describe('AmoEntityMap', () => {
  it('writes a bridge row for every contact, company and lead it imports', async () => {
    const client = makeClient({
      '/api/v4/companies': [[amoCompany()]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[amoLead()]],
    });

    await importFromAmo(ORG, USER, { client });

    const rows = [...fake.maps.values()];
    const contactRow = rows.find((r) => r.entity_type === 'contact' && r.amo_id === 406322n);
    const companyRow = rows.find((r) => r.entity_type === 'company' && r.amo_id === 406320n);
    const leadRow = rows.find((r) => r.entity_type === 'lead' && r.amo_id === 10971465n);

    expect(contactRow).toBeTruthy();
    expect(companyRow).toBeTruthy();
    expect(leadRow).toBeTruthy();

    // The contact and lead rows address real local rows…
    expect(fake.contacts.has(contactRow!.local_id)).toBe(true);
    expect(fake.deals.has(leadRow!.local_id)).toBe(true);
    // …and each carries the hash of the amo payload, which is what lets the sync
    // worker recognise its own echo and refuse to push it back.
    expect(contactRow!.last_remote_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(leadRow!.last_remote_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(contactRow!.last_remote_hash).toBe(
      hashAmoEntity('contact', fake.contacts.get(contactRow!.local_id)!),
    );
    expect(leadRow!.last_remote_hash).toBe(
      hashAmoEntity('lead', fake.deals.get(leadRow!.local_id)!),
    );

    // A company has no local row at all (4КУБ stores it as a string on Contact),
    // so its bridge row carries the documented synthetic id.
    expect(companyRow!.local_id).toBe(syntheticCompanyLocalId(406320));

    // Funnels are bridged too, namespaced per amo pipeline.
    expect(rows.filter((r) => r.entity_type === 'pipeline')).toHaveLength(1);
    expect(rows.filter((r) => r.entity_type === stageEntityType(AMO_PIPELINE))).toHaveLength(4);
  });

  it('is idempotent — a second import updates instead of duplicating', async () => {
    const payload = {
      '/api/v4/companies': [[amoCompany()]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[amoLead()]],
    };

    const first = await importFromAmo(ORG, USER, { client: makeClient(payload) });
    expect(first.contacts_imported).toBe(1);
    expect(first.deals_imported).toBe(1);

    const second = await importFromAmo(ORG, USER, { client: makeClient(payload) });
    expect(second.contacts_imported).toBe(1);
    expect(second.deals_imported).toBe(1);

    // One of each, not two — the bridge row was consulted before the write.
    expect(fake.contacts.size).toBe(1);
    expect(fake.deals.size).toBe(1);
    expect(fake.pipelines.size).toBe(1);
    expect(fake.stages.size).toBe(4);
    expect(dbMock.contact.update).toHaveBeenCalledTimes(1);
    expect(dbMock.deal.update).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the local row when the bridge points at something deleted', async () => {
    const payload = {
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[]],
    };
    await importFromAmo(ORG, USER, { client: makeClient(payload) });

    // Somebody deleted the contact locally; the bridge row now dangles.
    fake.contacts.clear();

    const again = await importFromAmo(ORG, USER, { client: makeClient(payload) });
    expect(again.contacts_imported).toBe(1);
    expect(fake.contacts.size).toBe(1);
    // …and the bridge row was repointed at the new local id rather than left dangling.
    const row = [...fake.maps.values()].find((r) => r.entity_type === 'contact');
    expect(fake.contacts.has(row!.local_id)).toBe(true);
  });
});

// ── Leads ────────────────────────────────────────────────────────────────────

describe('leads', () => {
  it('places a lead in the mapped pipeline and stage and links its contact', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[amoLead()]],
    });
    await importFromAmo(ORG, USER, { client });

    const deal = [...fake.deals.values()][0];
    const stageRow = [...fake.maps.values()].find(
      (r) => r.entity_type === stageEntityType(AMO_PIPELINE) && r.amo_id === BigInt(AMO_STAGE_WORK),
    );
    const pipelineRow = [...fake.maps.values()].find((r) => r.entity_type === 'pipeline');
    const contactRow = [...fake.maps.values()].find((r) => r.entity_type === 'contact');

    expect(deal.title).toBe('Поставка станков');
    expect(deal.pipeline_id).toBe(pipelineRow!.local_id);
    expect(deal.stage_id).toBe(stageRow!.local_id);
    expect(deal.contact_id).toBe(contactRow!.local_id);
    expect(deal.status).toBe('open');
    expect(String(deal.value)).toBe('250000');
    expect(deal.custom_fields).toEqual({ 'Источник заявки': 'Сайт' });
  });

  it('uses the amoCRM account currency for imported lead values', async () => {
    const client = makeClient(
      {
        '/api/v4/companies': [[]],
        '/api/v4/contacts': [[]],
        '/api/v4/leads': [[amoLead({ _embedded: {} })]],
      },
      { accountCurrency: 'kzt' },
    );

    await importFromAmo(ORG, USER, { client });

    expect([...fake.deals.values()][0].currency).toBe('KZT');
    expect(client.amoRequest).toHaveBeenCalledWith(ORG, 'GET', '/api/v4/account');
  });

  it('reads status 142 as won and 143 as lost, with the close date', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[]],
      '/api/v4/leads': [
        [
          amoLead({ id: 1, name: 'Выиграна', status_id: AMO_STATUS_WON, closed_at: 1686670710, _embedded: {} }),
          amoLead({
            id: 2,
            name: 'Проиграна',
            status_id: AMO_STATUS_LOST,
            closed_at: 1686670999,
            _embedded: { loss_reason: [{ id: 3, name: 'Дорого' }] },
          }),
        ],
      ],
    });

    const result = await importFromAmo(ORG, USER, { client });
    expect(result.deals_imported).toBe(2);

    const deals = [...fake.deals.values()];
    const won = deals.find((d) => d.title === 'Выиграна')!;
    const lost = deals.find((d) => d.title === 'Проиграна')!;

    expect(won.status).toBe('won');
    expect((won.actual_close as Date).toISOString()).toBe('2023-06-13T15:38:30.000Z');
    expect(lost.status).toBe('lost');
    expect(lost.lost_reason).toBe('Дорого');

    // Both terminal stages still exist locally and both are mapped — 142 and 143
    // repeat in every amo funnel, so they are namespaced by pipeline.
    const stageRows = [...fake.maps.values()].filter((r) => r.entity_type === stageEntityType(AMO_PIPELINE));
    expect(stageRows.map((r) => Number(r.amo_id)).sort((a, b) => a - b)).toEqual([142, 143, 32392156, 32392159]);
  });

  it('imports a lead whose status was created after the funnel sync, unstaged', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[]],
      '/api/v4/leads': [[amoLead({ status_id: 99999999, _embedded: {} })]],
    });

    const result = await importFromAmo(ORG, USER, { client });
    expect(result.deals_imported).toBe(1);

    const deal = [...fake.deals.values()][0];
    // Right funnel, no stage — better than dropping the deal on the floor.
    expect(deal.pipeline_id).toBeTruthy();
    expect(deal.stage_id).toBeUndefined();
  });

  it('leaves contact_id null rather than manufacturing a placeholder contact', async () => {
    // The Bitrix importer creates a placeholder contact per deal. Deliberately not
    // copied: amoCRM leads routinely outnumber contacts, and a placeholder each
    // poisons the contact base and every consent count taken off it.
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[]],
      '/api/v4/leads': [[amoLead({ _embedded: { contacts: [{ id: 999999, is_main: true }] } })]],
    });

    await importFromAmo(ORG, USER, { client });
    expect(fake.contacts.size).toBe(0);
    expect([...fake.deals.values()][0].contact_id).toBeNull();
  });

  it('honours include_leads: false and include_companies: false', async () => {
    const client = makeClient({
      '/api/v4/companies': [[amoCompany()]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[amoLead()]],
    });

    const result = await importFromAmo(ORG, USER, { client, include_leads: false, include_companies: false });

    expect(result.deals_imported).toBe(0);
    expect(result.companies_seen).toBe(0);
    expect(fake.deals.size).toBe(0);
    expect(result.contacts_imported).toBe(1);
    // No company pass ran, so the name could not be resolved — the contact is still imported.
    expect([...fake.contacts.values()][0].company).toBeNull();
  });
});

// ── Error tolerance ──────────────────────────────────────────────────────────

describe('one bad record does not abort the run', () => {
  it('skips a malformed contact and keeps importing the rest of the page', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [
        [
          amoContact({ id: 1, name: 'Первый' }),
          { name: 'сломанный, без id' },
          null,
          amoContact({ id: 3, name: 'Третий' }),
        ],
      ],
      '/api/v4/leads': [[]],
    });

    const result = await importFromAmo(ORG, USER, { client });

    expect(result.contacts_imported).toBe(2);
    expect(result.contacts_failed).toBe(2);
    expect(result.total_contacts).toBe(4);
    expect(fake.contacts.size).toBe(2);
    expect(result.partial).toBe(false);
  });

  it('skips a lead the database rejects and keeps going', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[]],
      '/api/v4/leads': [[amoLead({ id: 1, name: 'Плохая' }), amoLead({ id: 2, name: 'Хорошая' })]],
    });

    let first = true;
    dbMock.deal.create.mockImplementationOnce(async () => {
      first = false;
      throw new Error('value out of range for type numeric');
    });

    const result = await importFromAmo(ORG, USER, { client });

    expect(first).toBe(false);
    expect(result.deals_failed).toBe(1);
    expect(result.deals_imported).toBe(1);
  });
});

describe('long runs', () => {
  it('reports partial counts and a resume cursor when a page fetch fails', async () => {
    const client = makeClient(
      {
        '/api/v4/companies': [[]],
        '/api/v4/contacts': [[amoContact({ id: 1 })], [amoContact({ id: 2 })]],
        '/api/v4/leads': [[amoLead()]],
      },
      { throwOnPath: '/api/v4/contacts', throwAfterPage: 1 },
    );

    const result = await importFromAmo(ORG, USER, { client });

    // The first page's work is kept, not rolled back.
    expect(result.contacts_imported).toBe(1);
    expect(result.partial).toBe(true);
    expect(result.error).toContain('429');
    expect(result.cursor).toEqual({ phase: 'contacts', page: 2 });
    // Leads were not attempted — the run stopped where it broke.
    expect(result.deals_imported).toBe(0);
  });

  it('stops at max_records and hands back where to continue', async () => {
    const client = makeClient({
      '/api/v4/companies': [[]],
      '/api/v4/contacts': [[amoContact({ id: 1 }), amoContact({ id: 2 })], [amoContact({ id: 3 })]],
      '/api/v4/leads': [[]],
    });

    const result = await importFromAmo(ORG, USER, { client, max_records: 2 });

    expect(result.contacts_imported).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.cursor).toEqual({ phase: 'contacts', page: 2 });
  });

  it('resumes from a cursor, skipping the phases already done', async () => {
    const client = makeClient({
      '/api/v4/companies': [[amoCompany()]],
      '/api/v4/contacts': [[amoContact()]],
      '/api/v4/leads': [[amoLead({ _embedded: {} })]],
    });

    const result = await importFromAmo(ORG, USER, { client, cursor: { phase: 'leads', page: 1 } });

    expect(result.companies_seen).toBe(0);
    expect(result.contacts_imported).toBe(0);
    expect(result.deals_imported).toBe(1);
    // The funnel pass always runs — leads cannot be placed without it.
    expect(fake.stages.size).toBe(4);
    // And the resumed lead still landed on a mapped stage.
    expect([...fake.deals.values()][0].stage_id).toBeTruthy();
  });

  it('stops early and says so when the funnel pass itself fails', async () => {
    const client = {
      amoRequest: vi.fn(async () => {
        throw new Error('amoCRM 401 Unauthorized');
      }),
      paginate: vi.fn(),
    };

    const result = await importFromAmo(ORG, USER, { client: client as never });

    expect(result.partial).toBe(true);
    expect(result.error).toContain('401');
    expect(result.cursor).toEqual({ phase: 'pipelines', page: 1 });
    expect(client.paginate).not.toHaveBeenCalled();
  });
});

// ── Preview ──────────────────────────────────────────────────────────────────

describe('previewAmoImport', () => {
  it('returns the proposed funnel mapping and writes nothing', async () => {
    const client = makeClient({
      '/api/v4/companies': [[amoCompany()]],
      '/api/v4/contacts': [[amoContact(), amoContact({ id: 2 })]],
      '/api/v4/leads': [[amoLead()]],
    });

    const preview = await previewAmoImport(ORG, { client });

    expect(preview.pipelines).toHaveLength(1);
    expect(preview.pipelines[0].stages.map((s) => s.amo_status_id)).toEqual([
      32392156,
      AMO_STAGE_WORK,
      AMO_STATUS_WON,
      AMO_STATUS_LOST,
    ]);
    expect(preview.pipelines[0].stages.find((s) => s.amo_status_id === AMO_STATUS_WON)?.is_won_stage).toBe(true);
    expect(preview.sample).toEqual({ contacts: 2, companies: 1, leads: 1 });
    expect(preview.already_mapped).toEqual({ contacts: 0, companies: 0, leads: 0 });

    // A preview must be a pure read — nothing local, nothing bridged.
    expect(dbMock.contact.create).not.toHaveBeenCalled();
    expect(dbMock.deal.create).not.toHaveBeenCalled();
    expect(dbMock.pipeline.create).not.toHaveBeenCalled();
    expect(dbMock.amoEntityMap.upsert).not.toHaveBeenCalled();
  });

  it('surfaces the two-won-stage warning before anything is committed', async () => {
    const twoWon = {
      _embedded: {
        pipelines: [
          {
            id: 900,
            name: 'Странная воронка',
            _embedded: {
              statuses: [
                { id: AMO_STATUS_WON, name: 'Успешно реализовано', sort: 10000, type: 0 },
                { id: AMO_STATUS_WON, name: 'Успешно (дубль)', sort: 10500, type: 0 },
              ],
            },
          },
        ],
      },
    };

    const client = { amoRequest: vi.fn(async () => twoWon), paginate: vi.fn() };
    const preview = await previewAmoImport(ORG, { client: client as never });

    expect(preview.warnings.filter((w) => w.code === 'DUPLICATE_TERMINAL_STATUS')).toHaveLength(1);
    expect(preview.pipelines[0].stages.filter((s) => s.is_won_stage)).toHaveLength(1);
  });
});
