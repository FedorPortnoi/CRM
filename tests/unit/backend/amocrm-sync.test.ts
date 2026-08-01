/**
 * The amoCRM inbound receiver and the two-way sync worker.
 *
 * No network: the amoCRM client and the stage mapping are injected, and every assertion about
 * "we did not call amoCRM" is made against those injected fakes rather than against a mocked
 * fetch — a test that stubs the transport still passes when the code calls the wrong endpoint.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48);
process.env.NODE_ENV = 'test';

// ─── In-memory Prisma stand-in ────────────────────────────────────────────────

const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  let counter = 0;
  const uuid = (): string => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`;

  const key = (value: unknown): string => {
    if (value === null || value === undefined) return 'null';
    if (value instanceof Date) return `n:${value.getTime()}`;
    if (typeof value === 'bigint' || typeof value === 'number') return `n:${value.toString()}`;
    if (typeof value === 'object') return `o:${JSON.stringify(value)}`;
    return `s:${String(value)}`;
  };

  const num = (value: unknown): number => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    if (value === null || value === undefined) return Number.NaN;
    return Number(value);
  };

  const matches = (row: Row, where: Row): boolean => {
    for (const [field, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      const value = row[field];

      if (
        condition !== null &&
        typeof condition === 'object' &&
        !(condition instanceof Date) &&
        !Array.isArray(condition)
      ) {
        const c = condition as Record<string, unknown>;
        if ('in' in c) {
          const list = (c.in as unknown[]) ?? [];
          if (!list.some((candidate) => key(candidate) === key(value))) return false;
        }
        if ('notIn' in c) {
          const list = (c.notIn as unknown[]) ?? [];
          if (list.some((candidate) => key(candidate) === key(value))) return false;
        }
        if ('not' in c && key(c.not) === key(value)) return false;
        if ('lte' in c && !(num(value) <= num(c.lte))) return false;
        if ('lt' in c && !(num(value) < num(c.lt))) return false;
        if ('gte' in c && !(num(value) >= num(c.gte))) return false;
        if ('gt' in c && !(num(value) > num(c.gt))) return false;
        continue;
      }

      if (key(condition) !== key(value)) return false;
    }
    return true;
  };

  const defined = (data: Row): Row => {
    const out: Row = {};
    for (const [field, value] of Object.entries(data)) {
      if (value !== undefined) out[field] = value;
    }
    return out;
  };

  const makeTable = (defaults: () => Row) => {
    const rows: Row[] = [];
    return {
      rows,
      reset(): void {
        rows.length = 0;
      },
      async create({ data }: { data: Row }): Promise<Row> {
        const row = { ...defaults(), ...defined(data) };
        rows.push(row);
        return row;
      },
      async createMany({ data }: { data: Row | Row[] }): Promise<{ count: number }> {
        const list = Array.isArray(data) ? data : [data];
        for (const item of list) rows.push({ ...defaults(), ...defined(item) });
        return { count: list.length };
      },
      async findFirst(args: { where?: Row } = {}): Promise<Row | null> {
        return rows.find((row) => matches(row, args.where ?? {})) ?? null;
      },
      async findMany(
        args: { where?: Row; orderBy?: Record<string, string>; take?: number } = {},
      ): Promise<Row[]> {
        let out = rows.filter((row) => matches(row, args.where ?? {}));
        if (args.orderBy) {
          const [field, direction] = Object.entries(args.orderBy)[0] as [string, string];
          out = [...out].sort(
            (a, b) => (num(a[field]) - num(b[field])) * (direction === 'desc' ? -1 : 1),
          );
        }
        if (typeof args.take === 'number') out = out.slice(0, args.take);
        return out;
      },
      async updateMany({ where, data }: { where?: Row; data: Row }): Promise<{ count: number }> {
        const hits = rows.filter((row) => matches(row, where ?? {}));
        for (const row of hits) {
          for (const [field, value] of Object.entries(data)) {
            if (value !== null && typeof value === 'object' && 'increment' in (value as Row)) {
              row[field] = ((row[field] as number) ?? 0) + Number((value as Row).increment);
            } else if (value !== undefined) {
              row[field] = value;
            }
          }
          if ('updated_at' in row && !('updated_at' in data)) row.updated_at = new Date();
        }
        return { count: hits.length };
      },
      async count(args: { where?: Row } = {}): Promise<number> {
        return rows.filter((row) => matches(row, args.where ?? {})).length;
      },
    };
  };

  const now = (): Date => new Date();

  const db = {
    amoIntegration: makeTable(() => ({
      id: uuid(), status: 'active', webhook_ids: [], last_sync_at: null,
      created_at: now(), updated_at: now(),
    })),
    amoEntityMap: makeTable(() => ({
      id: uuid(), last_synced_at: null, last_local_hash: null, last_remote_hash: null,
      created_at: now(), updated_at: now(),
    })),
    amoSyncJob: makeTable(() => ({
      id: uuid(), status: 'pending', attempts: 0, local_id: null, amo_id: null,
      error_message: null, processed_at: null, next_attempt_at: now(),
      created_at: now(), updated_at: now(),
    })),
    amoSyncConflict: makeTable(() => ({ id: uuid(), created_at: now() })),
    deal: makeTable(() => ({
      id: uuid(), status: 'open', currency: 'RUB', value: null, contact_id: null,
      pipeline_id: null, stage_id: null, assigned_to: null, stage_entered_at: now(),
      created_at: now(), updated_at: now(),
    })),
    contact: makeTable(() => ({
      id: uuid(), status: 'active', type: 'lead', last_name: null, company: null,
      email: null, phone: null, mobile: null, assigned_to: null,
      created_at: now(), updated_at: now(),
    })),
  };

  const reset = (): void => {
    for (const table of Object.values(db)) table.reset();
  };

  return { db, reset };
});

vi.mock('../../../backend/services/db', () => ({ db: fake.db }));

import { decryptField, encryptField } from '../../../backend/services/encryption';
import { hashAmoEntity } from '../../../backend/services/amocrm/echo';
import {
  AMO_SYNC_RETRY_DELAYS_MS,
  MAX_AMO_SYNC_ATTEMPTS,
  enqueueAmoOutbound,
  getAmoSyncRetryDelayMs,
  haltedOrganizationIds,
  nextAmoSyncAttemptAt,
  processAmoSyncJob,
  resetAmoSyncDependencies,
  resolveAmoFieldConflicts,
  runAmoSyncTick,
  setAmoSyncDependencies,
  toRemoteDate,
} from '../../../backend/services/amocrm/sync-worker';
import {
  extractAmoWebhookEvents,
  createAmoWebhookToken,
  amoWebhookDestination,
  handleAmoWebhook,
  parseAmoFormBody,
  readAmoAccount,
  signAmoWebhookBody,
  setAmoWebhookClient,
  subscribeAmoWebhooks,
  verifyAmoWebhookSignature,
  verifyAmoWebhookToken,
} from '../../../backend/services/amocrm/webhook';
import {
  reconcileOrganization,
  setAmoReconcileClient,
} from '../../../backend/services/amocrm/reconcile';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const SUBDOMAIN = 'acme';
const CLIENT_SECRET = 'amo-client-secret-value';
const PIPELINE_ID = '22222222-2222-4222-8222-222222222222';
const STAGE_ID = '33333333-3333-4333-8333-333333333333';
const AMO_LEAD_ID = 100n;
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CONTACT_ID = '55555555-5555-4555-8555-555555555555';

const T0 = new Date('2026-07-25T00:00:00.000Z'); // last successful sync
const T1 = new Date('2026-07-26T00:00:00.000Z'); // remote edit, older
const T2 = new Date('2026-07-27T00:00:00.000Z'); // local edit
const T3 = new Date('2026-07-28T00:00:00.000Z'); // remote edit, newer

function form(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function seedIntegration(status = 'active', organizationId = ORG_ID): Promise<void> {
  await fake.db.amoIntegration.create({
    data: {
      organization_id: organizationId,
      subdomain: organizationId === ORG_ID ? SUBDOMAIN : `${SUBDOMAIN}-other`,
      client_id: 'client-id',
      client_secret_enc: encryptField(CLIENT_SECRET),
      redirect_uri: 'https://4kub.ru/callback',
      status,
    },
  });
}

const amoRequest = vi.fn(async (
  _orgId: string,
  _method: string,
  _path: string,
  _body?: unknown,
): Promise<unknown> => ({ _embedded: { leads: [{ id: 555 }] } }));

const mapping = {
  localStageForAmoStatus: vi.fn(async () => ({ pipeline_id: PIPELINE_ID, stage_id: STAGE_ID })),
  amoStatusForLocalStage: vi.fn(async () => ({ status_id: 142, pipeline_id: 3 })),
  ensureAmoStatusForLocalStage: vi.fn(async () => ({ status_id: 142, pipeline_id: 3 })),
};

async function* emptyPages(): AsyncGenerator<unknown[]> {
  // nothing
}

beforeEach(() => {
  fake.reset();
  amoRequest.mockClear();
  mapping.localStageForAmoStatus.mockClear();
  mapping.amoStatusForLocalStage.mockClear();
  mapping.ensureAmoStatusForLocalStage.mockClear();
  mapping.localStageForAmoStatus.mockResolvedValue({ pipeline_id: PIPELINE_ID, stage_id: STAGE_ID });
  mapping.amoStatusForLocalStage.mockResolvedValue({ status_id: 142, pipeline_id: 3 });
  mapping.ensureAmoStatusForLocalStage.mockResolvedValue({ status_id: 142, pipeline_id: 3 });
  resetAmoSyncDependencies();
  setAmoSyncDependencies({
    client: { amoRequest, paginate: emptyPages },
    mapping,
  });
  setAmoReconcileClient(null);
  setAmoWebhookClient(null);
});

// ─── Body parsing ─────────────────────────────────────────────────────────────

describe('form-urlencoded body parsing', () => {
  it('expands bracketed array keys into nested arrays', () => {
    const parsed = parseAmoFormBody(
      form([
        ['account[subdomain]', 'acme'],
        ['leads[status][0][id]', '100'],
        ['leads[status][0][status_id]', '143'],
        ['leads[status][1][id]', '101'],
      ]),
    );

    expect(readAmoAccount(parsed)).toEqual({ subdomain: 'acme', id: null });
    expect(parsed.leads).toEqual({
      status: [
        { id: '100', status_id: '143' },
        { id: '101' },
      ],
    });
  });

  it('decodes + as space and percent escapes', () => {
    expect(parseAmoFormBody('leads[add][0][name]=%D0%9D%D0%BE%D0%B2%D0%B0%D1%8F+%D1%81%D0%B4%D0%B5%D0%BB%D0%BA%D0%B0'))
      .toMatchObject({ leads: { add: [{ name: 'Новая сделка' }] } });
  });

  it('drops prototype-polluting segments instead of walking them', () => {
    const parsed = parseAmoFormBody('a[__proto__][polluted]=yes&b[constructor][x]=1&ok=2');
    expect(parsed.ok).toBe('2');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('turns one delivery with several entities into one event each', () => {
    const events = extractAmoWebhookEvents(
      parseAmoFormBody(
        form([
          ['leads[add][0][id]', '1'],
          ['leads[status][0][id]', '2'],
          ['contacts[update][0][id]', '3'],
          ['contacts[delete][0][id]', '4'],
          ['talks[add][0][id]', '5'],
        ]),
      ),
    );

    expect(events.map((e) => [e.entityType, e.operation, e.amoId?.toString()])).toEqual([
      ['lead', 'create', '1'],
      ['lead', 'stage_change', '2'],
      ['contact', 'update', '3'],
      ['contact', 'delete', '4'],
    ]);
  });
});

// ─── Signature ────────────────────────────────────────────────────────────────

describe('webhook signature', () => {
  const body = form([['account[subdomain]', SUBDOMAIN], ['leads[add][0][id]', '100']]);

  it('accepts a correct HMAC-SHA1 and a correct HMAC-SHA256', () => {
    expect(verifyAmoWebhookSignature(CLIENT_SECRET, body, signAmoWebhookBody(CLIENT_SECRET, body, 'sha1'))).toBe(true);
    expect(verifyAmoWebhookSignature(CLIENT_SECRET, body, signAmoWebhookBody(CLIENT_SECRET, body, 'sha256'))).toBe(true);
  });

  it('rejects a signature made with the wrong secret, a tampered body, and nonsense', () => {
    expect(verifyAmoWebhookSignature(CLIENT_SECRET, body, signAmoWebhookBody('wrong', body))).toBe(false);
    expect(verifyAmoWebhookSignature(CLIENT_SECRET, `${body}&x=1`, signAmoWebhookBody(CLIENT_SECRET, body))).toBe(false);
    expect(verifyAmoWebhookSignature(CLIENT_SECRET, body, null)).toBe(false);
    expect(verifyAmoWebhookSignature(CLIENT_SECRET, body, 'not-hex')).toBe(false);
    expect(verifyAmoWebhookSignature('', body, signAmoWebhookBody('', body))).toBe(false);
  });

  it('authenticates the documented webhook transport with a per-organization URL token', async () => {
    await seedIntegration();
    const token = createAmoWebhookToken(ORG_ID, CLIENT_SECRET);
    expect(verifyAmoWebhookToken(ORG_ID, CLIENT_SECRET, token)).toBe(true);
    expect(verifyAmoWebhookToken(OTHER_ORG_ID, CLIENT_SECRET, token)).toBe(false);

    const result = await handleAmoWebhook({ rawBody: body, headers: {}, webhookToken: token });
    expect(result).toEqual({ status: 200, body: { ok: true, queued: 1 } });
  });

  it('rejects an unsigned request with 401 and enqueues nothing', async () => {
    await seedIntegration();

    const result = await handleAmoWebhook({ rawBody: body, headers: {} });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ ok: false, error: 'INVALID_WEBHOOK_TOKEN' });
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });

  it('rejects a forged signature with 401 and enqueues nothing', async () => {
    await seedIntegration();

    const result = await handleAmoWebhook({
      rawBody: body,
      headers: { 'x-signature': signAmoWebhookBody('attacker-secret', body) },
    });

    expect(result.status).toBe(401);
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });

  it('rejects a request whose raw body was never captured, even if the parsed body looks fine', async () => {
    await seedIntegration();

    const result = await handleAmoWebhook({
      rawBody: '',
      headers: { 'x-signature': signAmoWebhookBody(CLIENT_SECRET, '') },
      parsedBody: parseAmoFormBody(body),
    });

    expect(result.status).toBe(401);
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });
});

// ─── Receiver ─────────────────────────────────────────────────────────────────

describe('webhook receiver', () => {
  it('verifies, enqueues one job per event, and returns 200 without calling amoCRM', async () => {
    await seedIntegration();

    const body = form([
      ['account[subdomain]', SUBDOMAIN],
      ['account[id]', '777'],
      ['leads[add][0][id]', '100'],
      ['leads[add][0][name]', 'Сделка'],
      ['contacts[update][0][id]', '200'],
    ]);

    const result = await handleAmoWebhook({
      rawBody: body,
      headers: { 'x-signature': signAmoWebhookBody(CLIENT_SECRET, body) },
      webhookToken: createAmoWebhookToken(ORG_ID, CLIENT_SECRET),
    });

    expect(result).toEqual({ status: 200, body: { ok: true, queued: 2 } });
    // Answering fast is the requirement: amoCRM disables a subscription that misses its 2 s
    // window, so the handler must not talk to amoCRM (or do anything else slow) at all.
    expect(amoRequest).not.toHaveBeenCalled();

    const jobs = fake.db.amoSyncJob.rows;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.direction === 'inbound' && job.status === 'pending')).toBe(true);
    expect(jobs.map((job) => job.entity_type)).toEqual(['lead', 'contact']);
    expect(jobs[0]?.organization_id).toBe(ORG_ID);
  });

  it('answers 400 when nothing identifies the account', async () => {
    await seedIntegration();
    const body = form([['leads[add][0][id]', '100']]);

    const result = await handleAmoWebhook({
      rawBody: body,
      headers: { 'x-signature': signAmoWebhookBody(CLIENT_SECRET, body) },
      webhookToken: createAmoWebhookToken(ORG_ID, CLIENT_SECRET),
    });

    expect(result).toEqual({ status: 400, body: { ok: false, error: 'MISSING_ACCOUNT' } });
  });

  it('answers 404 for an account nobody here has connected', async () => {
    const body = form([['account[subdomain]', 'stranger'], ['leads[add][0][id]', '100']]);

    const result = await handleAmoWebhook({
      rawBody: body,
      headers: { 'x-signature': signAmoWebhookBody(CLIENT_SECRET, body) },
      webhookToken: createAmoWebhookToken(ORG_ID, CLIENT_SECRET),
    });

    expect(result).toEqual({ status: 404, body: { ok: false, error: 'UNKNOWN_ACCOUNT' } });
  });

  it('answers 200 to a delivery containing nothing it handles', async () => {
    await seedIntegration();
    const body = form([['account[subdomain]', SUBDOMAIN], ['talks[add][0][id]', '9']]);

    const result = await handleAmoWebhook({
      rawBody: body,
      headers: { 'x-signature': signAmoWebhookBody(CLIENT_SECRET, body) },
      webhookToken: createAmoWebhookToken(ORG_ID, CLIENT_SECRET),
    });

    expect(result).toEqual({ status: 200, body: { ok: true, queued: 0 } });
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });

  it('uses the signed URL token to isolate two local tenants connected to one amo account', async () => {
    await seedIntegration();
    await fake.db.amoIntegration.create({
      data: {
        organization_id: OTHER_ORG_ID,
        subdomain: SUBDOMAIN,
        client_id: 'client-id',
        client_secret_enc: encryptField(CLIENT_SECRET),
        redirect_uri: 'https://4kub.ru/callback',
        status: 'active',
      },
    });
    const body = form([['account[subdomain]', SUBDOMAIN], ['leads[add][0][id]', '100']]);

    const result = await handleAmoWebhook({
      rawBody: body,
      headers: {},
      webhookToken: createAmoWebhookToken(OTHER_ORG_ID, CLIENT_SECRET),
    });

    expect(result).toEqual({ status: 200, body: { ok: true, queued: 1 } });
    expect(fake.db.amoSyncJob.rows[0]?.organization_id).toBe(OTHER_ORG_ID);
  });
});

describe('webhook subscription', () => {
  it('registers an authenticated per-org destination and stores the root response id', async () => {
    await seedIntegration();
    const request = vi.fn().mockResolvedValue({ id: 1056949, destination: 'https://crm.example/hook' });
    setAmoWebhookClient(request);
    const destination = amoWebhookDestination(ORG_ID, CLIENT_SECRET, {
      NODE_ENV: 'production',
      AMOCRM_WEBHOOK_URL: 'https://crm.example/api/v1/integrations/amocrm/webhook',
    });

    const ids = await subscribeAmoWebhooks(ORG_ID, destination);

    expect(ids).toEqual(['1056949']);
    expect(new URL(destination).searchParams.get('amocrm_token')).toBe(
      createAmoWebhookToken(ORG_ID, CLIENT_SECRET),
    );
    expect(request).toHaveBeenCalledWith(
      ORG_ID,
      'POST',
      '/api/v4/webhooks',
      expect.objectContaining({ destination }),
    );
    expect(fake.db.amoIntegration.rows[0]?.webhook_ids).toEqual(['1056949']);
  });
});

// ─── Conflict resolution ──────────────────────────────────────────────────────

async function seedMappedDeal(localUpdatedAt: Date): Promise<Record<string, unknown>> {
  const deal = await fake.db.deal.create({
    data: {
      organization_id: ORG_ID,
      title: 'Локальное имя',
      value: 1000,
      pipeline_id: PIPELINE_ID,
      stage_id: STAGE_ID,
      status: 'open',
      actual_close: null,
      updated_at: localUpdatedAt,
    },
  });

  await fake.db.amoEntityMap.create({
    data: {
      organization_id: ORG_ID,
      entity_type: 'lead',
      local_id: deal.id,
      amo_id: AMO_LEAD_ID,
      last_synced_at: T0,
      last_remote_hash: hashAmoEntity('lead', deal),
    },
  });

  return deal;
}

async function seedMappedContact(
  localId: string,
  amoId: bigint,
  organizationId = ORG_ID,
): Promise<Record<string, unknown>> {
  const contact = await fake.db.contact.create({
    data: {
      id: localId,
      organization_id: organizationId,
      first_name: `Contact ${amoId.toString()}`,
    },
  });
  await fake.db.amoEntityMap.create({
    data: {
      organization_id: organizationId,
      entity_type: 'contact',
      local_id: contact.id,
      amo_id: amoId,
      last_synced_at: T0,
    },
  });
  return contact;
}

async function enqueueInboundLead(remoteName: string, remoteModified: Date): Promise<void> {
  await fake.db.amoSyncJob.create({
    data: {
      organization_id: ORG_ID,
      direction: 'inbound',
      entity_type: 'lead',
      operation: 'update',
      amo_id: AMO_LEAD_ID,
      payload: {
        action: 'leads.update',
        entity: {
          id: AMO_LEAD_ID.toString(),
          name: remoteName,
          status_id: '142',
          last_modified: String(Math.floor(remoteModified.getTime() / 1000)),
        },
      },
      next_attempt_at: new Date(Date.now() - 1000),
    },
  });
}

describe('conflict resolution', () => {
  it('is silent when only the remote side moved', async () => {
    await seedIntegration();
    // Local untouched since the last sync.
    await seedMappedDeal(T0);
    await enqueueInboundLead('Имя из amoCRM', T3);

    await runAmoSyncTick(new Date());

    expect(fake.db.deal.rows[0]?.title).toBe('Имя из amoCRM');
    expect(fake.db.amoSyncConflict.rows).toHaveLength(0);
  });

  it('gives the newer remote edit the win and writes the discarded local value down', async () => {
    await seedIntegration();
    await seedMappedDeal(T2);
    await enqueueInboundLead('Имя из amoCRM', T3);

    await runAmoSyncTick(new Date());

    expect(fake.db.deal.rows[0]?.title).toBe('Имя из amoCRM');

    const conflicts = fake.db.amoSyncConflict.rows;
    expect(conflicts.map((row) => row.field).sort()).toEqual(['actual_close', 'status', 'title']);
    expect(conflicts.find((row) => row.field === 'title')).toMatchObject({
      organization_id: ORG_ID,
      entity_type: 'lead',
      field: 'title',
      winner: 'remote',
      local_value: 'Локальное имя',
      remote_value: 'Имя из amoCRM',
    });
    // The losing value is recoverable from the row, which is the whole point.
    const titleConflict = conflicts.find((row) => row.field === 'title');
    expect(titleConflict?.local_updated_at).toEqual(T2);
    expect(titleConflict?.remote_updated_at).toEqual(T3);
  });

  it('keeps the newer local edit and writes the discarded remote value down', async () => {
    await seedIntegration();
    await seedMappedDeal(T2);
    await enqueueInboundLead('Имя из amoCRM', T1);

    await runAmoSyncTick(new Date());

    expect(fake.db.deal.rows[0]?.title).toBe('Локальное имя');

    const conflicts = fake.db.amoSyncConflict.rows;
    expect(conflicts.map((row) => row.field).sort()).toEqual(['actual_close', 'status', 'title']);
    expect(conflicts.find((row) => row.field === 'title')).toMatchObject({
      field: 'title',
      winner: 'local',
      local_value: 'Локальное имя',
      remote_value: 'Имя из amoCRM',
    });
  });

  it('breaks an unorderable tie in favour of local, and still records it', async () => {
    const resolution = await resolveAmoFieldConflicts({
      organizationId: ORG_ID,
      entityType: 'lead',
      localId: PIPELINE_ID,
      amoId: AMO_LEAD_ID,
      fields: [{ field: 'title', localValue: 'Локальное', remoteValue: 'Удалённое' }],
      localUpdatedAt: T2,
      remoteUpdatedAt: null,
      lastSyncedAt: T0,
    });

    expect(resolution.apply).toEqual({});
    expect(resolution.conflicts).toEqual([{ field: 'title', winner: 'local' }]);
    expect(fake.db.amoSyncConflict.rows[0]?.winner).toBe('local');
  });

  it('encrypts PII before it is written into the conflict table', async () => {
    await resolveAmoFieldConflicts({
      organizationId: ORG_ID,
      entityType: 'contact',
      localId: PIPELINE_ID,
      amoId: 7n,
      fields: [{ field: 'phone', localValue: '+79991234567', remoteValue: '+79990000000' }],
      localUpdatedAt: T2,
      remoteUpdatedAt: T1,
      lastSyncedAt: T0,
    });

    const row = fake.db.amoSyncConflict.rows[0];
    expect(String(row?.local_value)).toMatch(/^enc:v1:/);
    expect(decryptField(String(row?.local_value))).toBe('+79991234567');
    expect(decryptField(String(row?.remote_value))).toBe('+79990000000');
  });

  it('reads amoCRM timestamps as unix seconds, not milliseconds', () => {
    // Getting this wrong yields a 1970 date, which makes the remote side lose every conflict
    // forever while looking like it simply had nothing to say.
    const iso = '2026-07-29T12:00:00.000Z';
    const seconds = Math.floor(Date.parse(iso) / 1000);

    expect(toRemoteDate(String(seconds))).toEqual(new Date(iso));
    expect(toRemoteDate(seconds)).toEqual(new Date(iso));
    // ...and a value that is already in milliseconds must not be multiplied a second time.
    expect(toRemoteDate(Date.parse(iso))).toEqual(new Date(iso));
  });
});

// ─── Deletes ──────────────────────────────────────────────────────────────────

describe('deletes', () => {
  it('never enqueues an outbound delete', async () => {
    await seedIntegration();

    const result = await enqueueAmoOutbound({
      organizationId: ORG_ID,
      entityType: 'lead',
      operation: 'delete',
      localId: PIPELINE_ID,
      record: { title: 'Что угодно' },
    });

    expect(result).toEqual({ enqueued: false, reason: 'delete_not_propagated' });
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });

  it('drops an outbound delete that reached the queue some other way, without calling amoCRM', async () => {
    await seedIntegration();
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'delete',
        local_id: PIPELINE_ID,
        amo_id: AMO_LEAD_ID,
        payload: { record: {} },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).not.toHaveBeenCalled();
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('dropped');
  });

  it('archives the local deal on an inbound delete instead of deleting it', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T0);

    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'inbound',
        entity_type: 'lead',
        operation: 'delete',
        amo_id: AMO_LEAD_ID,
        payload: { action: 'leads.delete', entity: { id: AMO_LEAD_ID.toString() } },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(fake.db.deal.rows).toHaveLength(1);
    expect(fake.db.deal.rows[0]?.id).toBe(deal.id);
    expect(fake.db.deal.rows[0]?.status).toBe('archived');
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');
    // Archiving is a local write; it must not bounce back out as an outbound job.
    expect(fake.db.amoSyncJob.rows.filter((row) => row.direction === 'outbound')).toHaveLength(0);
  });
});

// ─── Halting ──────────────────────────────────────────────────────────────────

describe('needs_reauth halts the queue', () => {
  for (const status of ['needs_reauth', 'paused'] as const) {
    it(`leaves every job of a ${status} org untouched`, async () => {
      await seedIntegration(status);
      await seedMappedDeal(T0);
      await enqueueInboundLead('Имя из amoCRM', T3);

      const summary = await runAmoSyncTick(new Date());

      expect(summary.processed).toBe(0);
      expect(summary.haltedOrganizations).toBe(1);

      const job = fake.db.amoSyncJob.rows[0];
      // Not failed, not dropped, and — critically — attempts NOT burned, so nothing is lost
      // when a human re-authorizes.
      expect(job?.status).toBe('pending');
      expect(job?.attempts).toBe(0);
      expect(job?.error_message).toBeNull();
      expect(fake.db.deal.rows[0]?.title).toBe('Локальное имя');
      expect(amoRequest).not.toHaveBeenCalled();
    });
  }

  it('halts an org that has no integration row at all', async () => {
    const halted = await haltedOrganizationIds([ORG_ID]);
    expect(halted.get(ORG_ID)).toMatch(/no amoCRM integration/);
  });

  it('does not halt the other organizations in the same tick', async () => {
    await seedIntegration('needs_reauth', ORG_ID);
    await seedIntegration('active', OTHER_ORG_ID);

    const halted = await haltedOrganizationIds([ORG_ID, OTHER_ORG_ID]);
    expect([...halted.keys()]).toEqual([ORG_ID]);
  });

  it('refuses to enqueue outbound work for a halted org', async () => {
    await seedIntegration('needs_reauth');

    const result = await enqueueAmoOutbound({
      organizationId: ORG_ID,
      entityType: 'lead',
      operation: 'update',
      localId: PIPELINE_ID,
      record: { title: 'Новое' },
    });

    expect(result).toEqual({ enqueued: false, reason: 'integration_inactive' });
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });
});

// ─── Backoff and claiming ─────────────────────────────────────────────────────

describe('retry backoff', () => {
  it('grows strictly with each failed attempt and stops at the cap', () => {
    const delays = [1, 2, 3, 4].map((attempt) => getAmoSyncRetryDelayMs(attempt));
    expect(delays).toEqual([...AMO_SYNC_RETRY_DELAYS_MS]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i] as number).toBeGreaterThan(delays[i - 1] as number);
    }

    expect(getAmoSyncRetryDelayMs(MAX_AMO_SYNC_ATTEMPTS)).toBeNull();
    expect(getAmoSyncRetryDelayMs(0)).toBeNull();
    expect(nextAmoSyncAttemptAt(MAX_AMO_SYNC_ATTEMPTS, new Date())).toBeNull();
    expect(nextAmoSyncAttemptAt(1, new Date(0))).toEqual(new Date(AMO_SYNC_RETRY_DELAYS_MS[0]));
  });

  it('reschedules a failing job on a growing ladder and finally fails it with a reason', async () => {
    await seedIntegration();
    await seedMappedDeal(T0);
    // No local stage maps to this amoCRM status -> the applier throws on every attempt.
    mapping.localStageForAmoStatus.mockResolvedValue(null as never);
    await enqueueInboundLead('Имя из amoCRM', T3);

    const observed: number[] = [];
    // The queue row was made due a second ago, so the first tick has to be at or after real
    // "now" for it to be picked up at all.
    let clock = new Date(Date.now() + 1_000);

    for (let attempt = 1; attempt <= MAX_AMO_SYNC_ATTEMPTS; attempt += 1) {
      const failedAround = Date.now();
      await runAmoSyncTick(clock);
      const job = fake.db.amoSyncJob.rows[0] as Record<string, unknown>;
      expect(job.attempts).toBe(attempt);

      if (attempt < MAX_AMO_SYNC_ATTEMPTS) {
        const next = job.next_attempt_at as Date;
        expect(job.status).toBe('pending');
        // Measured from the failure, not from `clock`: the backoff is applied to the moment
        // the attempt actually failed, which is the property that matters.
        observed.push(next.getTime() - failedAround);
        clock = new Date(next.getTime() + 1);
      } else {
        expect(job.status).toBe('failed');
        expect(job.next_attempt_at).toBeNull();
        expect(String(job.error_message)).toMatch(/no local stage is mapped/);
      }
    }

    expect(observed).toHaveLength(AMO_SYNC_RETRY_DELAYS_MS.length);
    observed.forEach((delay, index) => {
      expect(delay).toBeGreaterThanOrEqual(AMO_SYNC_RETRY_DELAYS_MS[index] as number);
      expect(delay).toBeLessThan((AMO_SYNC_RETRY_DELAYS_MS[index] as number) + 5_000);
    });
    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i] as number).toBeGreaterThan(observed[i - 1] as number);
    }
  });

  it('leases a claimed row so a second pass in the same tick cannot steal it', async () => {
    await seedIntegration();
    await seedMappedDeal(T0);
    mapping.localStageForAmoStatus.mockResolvedValue(null as never);
    await enqueueInboundLead('Имя из amoCRM', T3);

    const now = new Date();
    const candidate = { id: String(fake.db.amoSyncJob.rows[0]?.id), organization_id: ORG_ID };

    expect(await processAmoSyncJob(candidate, now)).toBe(true);
    // The first pass pushed next_attempt_at into the future, so the second finds nothing due.
    expect(await processAmoSyncJob(candidate, now)).toBe(false);
    expect(fake.db.amoSyncJob.rows[0]?.attempts).toBe(1);
  });

  it('clears next_attempt_at on a settled job so it is never rescanned', async () => {
    await seedIntegration();
    await seedMappedDeal(T0);
    await enqueueInboundLead('Имя из amoCRM', T3);

    await runAmoSyncTick(new Date());

    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');
    expect(fake.db.amoSyncJob.rows[0]?.next_attempt_at).toBeNull();
    expect((await runAmoSyncTick(new Date())).processed).toBe(0);
  });
});

// ─── Outbound push ────────────────────────────────────────────────────────────

describe('outbound push', () => {
  it('PATCHes a mapped lead and records what it pushed', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);

    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: {
          record: { title: 'Переименовано', value: 7000, stage_id: STAGE_ID },
          local_hash: 'deadbeef',
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenCalledTimes(1);
    expect(amoRequest).toHaveBeenCalledWith(
      ORG_ID,
      'PATCH',
      `/api/v4/leads/${AMO_LEAD_ID.toString()}`,
      { name: 'Переименовано', price: 7000, status_id: 142, pipeline_id: 3 },
    );

    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');
    // last_local_hash is what lets the inbound side recognise amoCRM telling us about our own
    // push — the mirror image of last_remote_hash.
    expect(fake.db.amoEntityMap.rows[0]?.last_local_hash).toBe('deadbeef');
  });

  it('maps local won/lost outcomes to amoCRM reserved terminal statuses', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    mapping.ensureAmoStatusForLocalStage.mockResolvedValue({ status_id: 50, pipeline_id: 3 });
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: {
          record: { title: 'Lost deal', status: 'lost', stage_id: STAGE_ID },
          local_hash: 'lost-hash',
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenCalledWith(
      ORG_ID,
      'PATCH',
      `/api/v4/leads/${AMO_LEAD_ID.toString()}`,
      { name: 'Lost deal', status_id: 143, pipeline_id: 3 },
    );
  });

  it('POSTs an unmapped entity and stores the id amoCRM assigned', async () => {
    await seedIntegration();
    const deal = await fake.db.deal.create({
      data: { organization_id: ORG_ID, title: 'Новая', pipeline_id: PIPELINE_ID, stage_id: STAGE_ID },
    });

    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'create',
        local_id: deal.id,
        payload: { record: { title: 'Новая', stage_id: STAGE_ID }, local_hash: 'abc123' },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenCalledWith(ORG_ID, 'POST', '/api/v4/leads', [
      { name: 'Новая', status_id: 142, pipeline_id: 3 },
    ]);
    expect(fake.db.amoEntityMap.rows[0]).toMatchObject({
      local_id: deal.id,
      amo_id: 555n,
      last_local_hash: 'abc123',
    });
  });

  it('retries rather than settling when amoCRM rejects the call', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    amoRequest.mockRejectedValueOnce(new Error('429 Too Many Requests') as never);

    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: { record: { title: 'Переименовано' }, local_hash: 'x' },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    const job = fake.db.amoSyncJob.rows[0];
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
    expect(String(job?.error_message)).toContain('429');
    expect((job?.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not silently deliver a lead job when its local stage cannot be mapped or created', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    mapping.ensureAmoStatusForLocalStage.mockRejectedValueOnce(new Error('malformed statuses response'));

    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: { record: { title: 'Needs a funnel', stage_id: STAGE_ID }, local_hash: 'stage-gap' },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    const job = fake.db.amoSyncJob.rows[0];
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
    expect(String(job?.error_message)).toContain('malformed statuses response');
    expect(amoRequest).not.toHaveBeenCalledWith(
      ORG_ID,
      'PATCH',
      `/api/v4/leads/${AMO_LEAD_ID.toString()}`,
      expect.anything(),
    );
  });
});

describe('lead main-contact synchronization', () => {
  it('links a mapped local contact as main after creating a lead', async () => {
    await seedIntegration();
    await seedMappedContact(CONTACT_ID, 700n);
    const deal = await fake.db.deal.create({
      data: {
        organization_id: ORG_ID,
        title: 'Lead with contact',
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        contact_id: CONTACT_ID,
      },
    });
    amoRequest
      .mockResolvedValueOnce({ _embedded: { leads: [{ id: 555 }] } })
      .mockResolvedValueOnce({ _embedded: { links: [] } });
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'create',
        local_id: deal.id,
        payload: {
          record: { title: 'Lead with contact', stage_id: STAGE_ID, contact_id: CONTACT_ID },
          local_hash: 'lead-contact-create',
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenNthCalledWith(1, ORG_ID, 'POST', '/api/v4/leads', [
      { name: 'Lead with contact', status_id: 142, pipeline_id: 3 },
    ]);
    expect(amoRequest).toHaveBeenNthCalledWith(
      2,
      ORG_ID,
      'POST',
      '/api/v4/leads/555/link',
      [{ to_entity_id: 700, to_entity_type: 'contacts', metadata: { is_main: true } }],
    );
    expect(fake.db.amoEntityMap.rows.find((row) => row.entity_type === 'lead')).toMatchObject({
      local_id: deal.id,
      amo_id: 555n,
    });
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');
  });

  it('replaces only the previous main contact and preserves unrelated linked contacts', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    await seedMappedContact(CONTACT_ID, 702n);
    amoRequest
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        _embedded: {
          links: [
            { to_entity_id: 700, to_entity_type: 'contacts', metadata: { main_contact: true } },
            { to_entity_id: 701, to_entity_type: 'contacts', metadata: { main_contact: false } },
            { to_entity_id: 88, to_entity_type: 'companies', metadata: null },
          ],
        },
      })
      .mockResolvedValue({});
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: {
          record: { title: 'Changed contact', stage_id: STAGE_ID, contact_id: CONTACT_ID },
          local_hash: 'changed-contact',
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenCalledWith(
      ORG_ID,
      'POST',
      '/api/v4/leads/100/link',
      [{ to_entity_id: 702, to_entity_type: 'contacts', metadata: { is_main: true } }],
    );
    expect(amoRequest).toHaveBeenCalledWith(
      ORG_ID,
      'POST',
      '/api/v4/leads/100/unlink',
      [{ to_entity_id: 700, to_entity_type: 'contacts' }],
    );
    expect(JSON.stringify(amoRequest.mock.calls)).not.toContain('701');
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');
  });

  it('clears only the current main contact and leaves non-main links untouched', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    amoRequest
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        _embedded: {
          links: [
            { to_entity_id: 700, to_entity_type: 'contacts', metadata: { main_contact: true } },
            { to_entity_id: 701, to_entity_type: 'contacts', metadata: { main_contact: false } },
          ],
        },
      })
      .mockResolvedValueOnce({});
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: { record: { title: 'No contact', stage_id: STAGE_ID, contact_id: null } },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenCalledWith(
      ORG_ID,
      'POST',
      '/api/v4/leads/100/unlink',
      [{ to_entity_id: 700, to_entity_type: 'contacts' }],
    );
    expect(JSON.stringify(amoRequest.mock.calls)).not.toContain('701');
  });

  it('retries visibly and makes no remote write while the local contact is unmapped', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    await fake.db.contact.create({
      data: { id: CONTACT_ID, organization_id: ORG_ID, first_name: 'Not imported yet' },
    });
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'update',
        local_id: deal.id,
        payload: { record: { title: 'Must stay linked', stage_id: STAGE_ID, contact_id: CONTACT_ID } },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).not.toHaveBeenCalled();
    expect(fake.db.amoSyncJob.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(String(fake.db.amoSyncJob.rows[0]?.error_message)).toContain('has no amoCRM mapping');
  });

  it('records a newly assigned lead id before link failure so the retry cannot duplicate it', async () => {
    await seedIntegration();
    await seedMappedContact(CONTACT_ID, 700n);
    const deal = await fake.db.deal.create({
      data: {
        organization_id: ORG_ID,
        title: 'Retry-safe lead',
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        contact_id: CONTACT_ID,
      },
    });
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'outbound',
        entity_type: 'lead',
        operation: 'create',
        local_id: deal.id,
        payload: {
          record: { title: 'Retry-safe lead', stage_id: STAGE_ID, contact_id: CONTACT_ID },
          local_hash: 'retry-safe',
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });
    amoRequest
      .mockResolvedValueOnce({ _embedded: { leads: [{ id: 555 }] } })
      .mockRejectedValueOnce(new Error('link timed out') as never);

    await runAmoSyncTick(new Date());

    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('pending');
    expect(fake.db.amoEntityMap.rows.find((row) => row.entity_type === 'lead')).toMatchObject({
      local_id: deal.id,
      amo_id: 555n,
    });

    const retryAt = fake.db.amoSyncJob.rows[0]?.next_attempt_at as Date;
    amoRequest
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ _embedded: { links: [] } })
      .mockResolvedValueOnce({});
    await runAmoSyncTick(new Date(retryAt.getTime() + 1));

    const leadCreates = amoRequest.mock.calls.filter((call) => {
      const args = call as unknown[];
      return args[1] === 'POST' && args[2] === '/api/v4/leads';
    });
    expect(leadCreates).toHaveLength(1);
    expect(amoRequest).toHaveBeenCalledWith(ORG_ID, 'PATCH', '/api/v4/leads/555', expect.any(Object));
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');
  });

  it('uses an embedded amo main contact when creating a local deal', async () => {
    await seedIntegration();
    await seedMappedContact(CONTACT_ID, 700n);
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'inbound',
        entity_type: 'lead',
        operation: 'create',
        amo_id: AMO_LEAD_ID,
        payload: {
          entity: {
            id: 100,
            name: 'Inbound linked lead',
            status_id: 142,
            pipeline_id: 3,
            _embedded: { contacts: [{ id: 700, is_main: true }] },
          },
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(fake.db.deal.rows[0]).toMatchObject({ title: 'Inbound linked lead', contact_id: CONTACT_ID });
    expect(amoRequest).not.toHaveBeenCalled();
  });

  it('reads sparse webhook relationships from /links and logs a contact conflict', async () => {
    await seedIntegration();
    const deal = await seedMappedDeal(T2);
    await seedMappedContact(CONTACT_ID, 700n);
    await seedMappedContact(OTHER_CONTACT_ID, 701n);
    deal.contact_id = OTHER_CONTACT_ID;
    amoRequest.mockResolvedValueOnce({
      _embedded: {
        links: [{ to_entity_id: 700, to_entity_type: 'contacts', metadata: { main_contact: true } }],
      },
    });
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'inbound',
        entity_type: 'lead',
        operation: 'update',
        amo_id: AMO_LEAD_ID,
        payload: {
          received_at: T3.toISOString(),
          entity: {
            id: 100,
            name: deal.title,
            status_id: 142,
            pipeline_id: 3,
            updated_at: Math.floor(T3.getTime() / 1000),
          },
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(amoRequest).toHaveBeenCalledWith(ORG_ID, 'GET', '/api/v4/leads/100/links');
    expect(fake.db.deal.rows[0]?.contact_id).toBe(CONTACT_ID);
    expect(fake.db.amoSyncConflict.rows).toContainEqual(expect.objectContaining({
      field: 'contact_id',
      local_value: OTHER_CONTACT_ID,
      remote_value: CONTACT_ID,
      winner: 'remote',
    }));
  });

  it('does not resolve a contact map belonging to another organization', async () => {
    await seedIntegration();
    await seedMappedDeal(T0);
    await seedMappedContact(OTHER_CONTACT_ID, 700n, OTHER_ORG_ID);
    await fake.db.amoSyncJob.create({
      data: {
        organization_id: ORG_ID,
        direction: 'inbound',
        entity_type: 'lead',
        operation: 'update',
        amo_id: AMO_LEAD_ID,
        payload: {
          entity: {
            id: 100,
            status_id: 142,
            _embedded: { contacts: [{ id: 700, is_main: true }] },
          },
        },
        next_attempt_at: new Date(Date.now() - 1000),
      },
    });

    await runAmoSyncTick(new Date());

    expect(fake.db.deal.rows[0]?.contact_id).toBeNull();
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('pending');
    expect(String(fake.db.amoSyncJob.rows[0]?.error_message)).toContain('has no local mapping');
  });
});

describe('nightly reconciliation', () => {
  it('walks the full remote inventory, heals missed events, and counts only truly absent maps', async () => {
    await seedIntegration();
    await fake.db.amoEntityMap.create({
      data: {
        organization_id: ORG_ID,
        entity_type: 'lead',
        local_id: '44444444-4444-4444-8444-444444444444',
        amo_id: 100n,
        last_synced_at: T0,
      },
    });
    await fake.db.amoEntityMap.create({
      data: {
        organization_id: ORG_ID,
        entity_type: 'contact',
        local_id: '55555555-5555-4555-8555-555555555555',
        amo_id: 999n,
        last_synced_at: T0,
      },
    });

    const paginate = vi.fn(async function* (_org: string, path: string) {
      if (path.endsWith('/leads')) {
        yield [
          { id: 100, name: 'Changed', updated_at: Math.floor(T3.getTime() / 1000) },
          { id: 101, name: 'Missed create', updated_at: Math.floor(T3.getTime() / 1000) },
        ];
      } else {
        yield [];
      }
    });
    setAmoReconcileClient({ amoRequest, paginate });

    const now = new Date('2026-08-01T03:00:00.000Z');
    const result = await reconcileOrganization(ORG_ID, T0, now);

    expect(result).toEqual({ entitiesInspected: 2, healed: 2, localOnly: 1 });
    expect(fake.db.amoSyncJob.rows).toHaveLength(2);
    expect(paginate).toHaveBeenCalledWith(ORG_ID, '/api/v4/leads', { limit: 250 });
    expect(fake.db.amoIntegration.rows[0]?.last_sync_at).toEqual(now);
  });
});
