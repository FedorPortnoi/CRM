/**
 * Echo suppression for the amoCRM two-way sync.
 *
 * The test that matters here is "a round trip terminates". Everything else in this file exists
 * to make that one honest: a canonicalization that is not stable, or a hash taken over
 * ciphertext, turns the suppression into a comparison that is never equal — and a defence that
 * is never equal is a defence that is never triggered, which passes review and loops in
 * production.
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

import { encryptField } from '../../../backend/services/encryption';
import {
  canonicalizeAmoEntity,
  currentSyncOrigin,
  decideOutbound,
  hashAmoEntity,
  isRemoteOrigin,
  recordRemoteHash,
  runWithSyncOrigin,
  stableStringify,
} from '../../../backend/services/amocrm/echo';
import {
  enqueueAmoOutbound,
  runAmoSyncTick,
  setAmoSyncDependencies,
  resetAmoSyncDependencies,
} from '../../../backend/services/amocrm/sync-worker';
import {
  createAmoWebhookToken,
  handleAmoWebhook,
  signAmoWebhookBody,
} from '../../../backend/services/amocrm/webhook';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SUBDOMAIN = 'acme';
const CLIENT_SECRET = 'amo-client-secret-value';
const PIPELINE_ID = '22222222-2222-4222-8222-222222222222';
const STAGE_ID = '33333333-3333-4333-8333-333333333333';
const AMO_LEAD_ID = 100n;

function form(pairs: Array<[string, string]>): string {
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function seedIntegration(status = 'active'): Promise<void> {
  await fake.db.amoIntegration.create({
    data: {
      organization_id: ORG_ID,
      subdomain: SUBDOMAIN,
      client_id: 'client-id',
      client_secret_enc: encryptField(CLIENT_SECRET),
      redirect_uri: 'https://4kub.ru/callback',
      status,
    },
  });
}

const mapping = {
  localStageForAmoStatus: async () => ({ pipeline_id: PIPELINE_ID, stage_id: STAGE_ID }),
  amoStatusForLocalStage: async () => ({ status_id: 142, pipeline_id: 3 }),
  ensureAmoStatusForLocalStage: async () => ({ status_id: 142, pipeline_id: 3 }),
};

const amoRequest = vi.fn(async (
  _orgId: string,
  _method: string,
  _path: string,
  _body?: unknown,
): Promise<unknown> => ({ _embedded: { links: [] } }));

async function* emptyPages(): AsyncGenerator<unknown[]> {
  // no pages
}

beforeEach(() => {
  fake.reset();
  resetAmoSyncDependencies();
  amoRequest.mockClear();
  setAmoSyncDependencies({ mapping, client: { amoRequest, paginate: emptyPages } });
  vi.restoreAllMocks();
});

// ─── Canonicalization ─────────────────────────────────────────────────────────

describe('canonical projection', () => {
  it('is insensitive to key order', () => {
    const a = hashAmoEntity('lead', { title: 'A', value: 10, stage_id: 's' });
    const b = hashAmoEntity('lead', { stage_id: 's', value: 10, title: 'A' });
    expect(a).toBe(b);
  });

  it('treats 1000, "1000" and "1000.00" as the same amount', () => {
    const a = hashAmoEntity('lead', { title: 'A', value: 1000 });
    const b = hashAmoEntity('lead', { title: 'A', value: '1000' });
    const c = hashAmoEntity('lead', { title: 'A', value: '1000.00' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('treats a Date and its ISO string as the same value', () => {
    const date = new Date('2026-08-01T10:00:00.000Z');
    expect(stableStringify({ x: date.toISOString() })).toBe(
      stableStringify({ x: date.toISOString() }),
    );
    expect(canonicalizeAmoEntity('lead', { title: date })).toEqual(
      canonicalizeAmoEntity('lead', { title: date.toISOString() }),
    );
  });

  it('treats null, undefined and the empty string alike', () => {
    const a = hashAmoEntity('contact', { first_name: 'Иван', company: null });
    const b = hashAmoEntity('contact', { first_name: 'Иван', company: '' });
    const c = hashAmoEntity('contact', { first_name: 'Иван' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  /**
   * The trap this whole mechanism dies on. Contact PII is AES-GCM with a random IV, so the
   * SAME phone number encrypts to a different string every single time. Hash the ciphertext
   * and no two hashes ever match — the suppression silently becomes a no-op.
   */
  it('hashes contact PII by plaintext, not by ciphertext', () => {
    const first = encryptField('ivan@example.ru');
    const second = encryptField('ivan@example.ru');

    expect(first).not.toBe(second);
    expect(hashAmoEntity('contact', { first_name: 'Иван', email: first })).toBe(
      hashAmoEntity('contact', { first_name: 'Иван', email: second }),
    );
  });

  it('changes when a synced field actually changes', () => {
    expect(hashAmoEntity('lead', { title: 'A' })).not.toBe(hashAmoEntity('lead', { title: 'B' }));
  });

  it('ignores fields outside the synced set', () => {
    expect(hashAmoEntity('lead', { title: 'A', updated_at: new Date(1) })).toBe(
      hashAmoEntity('lead', { title: 'A', updated_at: new Date(2) }),
    );
  });
});

// ─── Defence 1: origin tagging ────────────────────────────────────────────────

describe('origin tagging', () => {
  it('defaults to local outside any context', () => {
    expect(currentSyncOrigin()).toBe('local');
    expect(isRemoteOrigin('local')).toBe(false);
    expect(isRemoteOrigin('amo')).toBe(true);
    expect(isRemoteOrigin('reconcile')).toBe(true);
  });

  it('propagates across await boundaries', async () => {
    const seen = await runWithSyncOrigin('amo', async () => {
      await Promise.resolve();
      return currentSyncOrigin();
    });
    expect(seen).toBe('amo');
    expect(currentSyncOrigin()).toBe('local');
  });

  it('refuses to enqueue an outbound job for a write tagged amo, without touching the database', async () => {
    await seedIntegration();

    const result = await runWithSyncOrigin('amo', () =>
      enqueueAmoOutbound({
        organizationId: ORG_ID,
        entityType: 'lead',
        operation: 'update',
        localId: PIPELINE_ID,
        record: { title: 'Anything' },
      }),
    );

    expect(result).toEqual({ enqueued: false, reason: 'remote_origin' });
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });
});

// ─── Defence 2: hash comparison ───────────────────────────────────────────────

describe('hash comparison', () => {
  it('suppresses a local change whose state equals last_remote_hash', async () => {
    const record = { title: 'Сделка', value: 1000, stage_id: STAGE_ID };
    await fake.db.amoEntityMap.create({
      data: {
        organization_id: ORG_ID,
        entity_type: 'lead',
        local_id: PIPELINE_ID,
        amo_id: AMO_LEAD_ID,
        last_remote_hash: hashAmoEntity('lead', record),
      },
    });

    const decision = await decideOutbound({
      organizationId: ORG_ID,
      entityType: 'lead',
      localId: PIPELINE_ID,
      record,
      origin: 'local',
    });

    expect(decision).toMatchObject({ suppress: true, reason: 'matches_last_remote_hash' });
  });

  it('lets a genuine local edit through', async () => {
    await fake.db.amoEntityMap.create({
      data: {
        organization_id: ORG_ID,
        entity_type: 'lead',
        local_id: PIPELINE_ID,
        amo_id: AMO_LEAD_ID,
        last_remote_hash: hashAmoEntity('lead', { title: 'Старое' }),
      },
    });

    const decision = await decideOutbound({
      organizationId: ORG_ID,
      entityType: 'lead',
      localId: PIPELINE_ID,
      record: { title: 'Новое' },
      origin: 'local',
    });

    expect(decision).toMatchObject({ suppress: false, reason: 'local_change' });
  });

  it('records the hash of what was WRITTEN, so the two sides are comparable', async () => {
    const written = { title: 'Итог', value: 4200, stage_id: STAGE_ID };
    await recordRemoteHash({
      organizationId: ORG_ID,
      entityType: 'lead',
      localId: PIPELINE_ID,
      amoId: AMO_LEAD_ID,
      hash: hashAmoEntity('lead', written),
    });

    const row = fake.db.amoEntityMap.rows[0];
    expect(row?.last_remote_hash).toBe(hashAmoEntity('lead', written));
    expect(row?.last_synced_at).toBeInstanceOf(Date);
  });
});

// ─── The proof ────────────────────────────────────────────────────────────────

describe('round trip termination', () => {
  /**
   * The whole feature in one test.
   *
   * amoCRM posts a signed change -> the receiver enqueues it -> the worker applies it locally
   * -> the domain layer, which cannot know where the write came from, tries to push it back.
   * Nothing must be queued outbound, and the queue must be empty on the next tick.
   *
   * The domain-layer call is deliberately made OUTSIDE any AsyncLocalStorage context — the
   * hardest case, and the realistic one, since a `void logActivity(...).then(...)` style write
   * has already escaped it. Defence 1 is unavailable here BY CONSTRUCTION, so the test is a
   * proof about defence 2.
   */
  it('inbound change -> applied -> no outbound job produced', async () => {
    await seedIntegration();

    const deal = await fake.db.deal.create({
      data: {
        organization_id: ORG_ID,
        title: 'Старое имя',
        value: 1000,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        updated_at: new Date('2026-07-30T00:00:00.000Z'),
      },
    });

    await fake.db.amoEntityMap.create({
      data: {
        organization_id: ORG_ID,
        entity_type: 'lead',
        local_id: deal.id,
        amo_id: AMO_LEAD_ID,
        last_synced_at: new Date('2026-07-31T00:00:00.000Z'),
        last_remote_hash: hashAmoEntity('lead', deal),
      },
    });

    // 1. amoCRM posts a signed webhook.
    const body = form([
      ['account[subdomain]', SUBDOMAIN],
      ['account[id]', '777'],
      ['leads[update][0][id]', AMO_LEAD_ID.toString()],
      ['leads[update][0][name]', 'Новое имя'],
      ['leads[update][0][price]', '5000'],
      ['leads[update][0][status_id]', '142'],
      ['leads[update][0][last_modified]', String(Math.floor(Date.UTC(2026, 7, 1) / 1000))],
    ]);

    const received = await handleAmoWebhook({
      rawBody: body,
      headers: { 'x-signature': signAmoWebhookBody(CLIENT_SECRET, body) },
      webhookToken: createAmoWebhookToken(ORG_ID, CLIENT_SECRET),
    });

    expect(received.status).toBe(200);
    expect(received.body).toEqual({ ok: true, queued: 1 });
    expect(fake.db.amoSyncJob.rows).toHaveLength(1);
    expect(fake.db.amoSyncJob.rows[0]).toMatchObject({ direction: 'inbound', status: 'pending' });

    // 2. The worker applies it.
    const summary = await runAmoSyncTick(new Date());
    expect(summary.processed).toBe(1);

    const applied = fake.db.deal.rows[0];
    expect(applied?.title).toBe('Новое имя');
    expect(applied?.value).toBe(5000);
    expect(fake.db.amoSyncJob.rows[0]?.status).toBe('delivered');

    // 3. The domain layer tries to push the change it has just observed — from outside any
    //    origin context, so only the hash can save us.
    expect(currentSyncOrigin()).toBe('local');
    const pushBack = await enqueueAmoOutbound({
      organizationId: ORG_ID,
      entityType: 'lead',
      operation: 'update',
      localId: String(applied?.id),
      record: applied as Record<string, unknown>,
    });

    expect(pushBack).toEqual({ enqueued: false, reason: 'matches_last_remote_hash' });

    // 4. Nothing outbound exists, and the loop is therefore closed.
    const outbound = fake.db.amoSyncJob.rows.filter((row) => row.direction === 'outbound');
    expect(outbound).toHaveLength(0);

    // 5. The next tick has nothing left to do.
    const second = await runAmoSyncTick(new Date());
    expect(second.processed).toBe(0);
  });

  it('an inbound apply cannot enqueue outbound even when the hash is stale', async () => {
    await seedIntegration();

    // No map row at all: the hash defence has nothing to compare against, so this isolates
    // defence 1. Both are needed; neither covers the other's blind spot.
    const result = await runWithSyncOrigin('amo', () =>
      enqueueAmoOutbound({
        organizationId: ORG_ID,
        entityType: 'contact',
        operation: 'create',
        localId: PIPELINE_ID,
        record: { first_name: 'Иван' },
      }),
    );

    expect(result.enqueued).toBe(false);
    expect(fake.db.amoSyncJob.rows).toHaveLength(0);
  });

  it('still pushes a real local edit made after an inbound apply', async () => {
    await seedIntegration();

    const deal = await fake.db.deal.create({
      data: {
        organization_id: ORG_ID,
        title: 'Из amoCRM',
        value: 5000,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
      },
    });

    await fake.db.amoEntityMap.create({
      data: {
        organization_id: ORG_ID,
        entity_type: 'lead',
        local_id: deal.id,
        amo_id: AMO_LEAD_ID,
        last_synced_at: new Date(),
        last_remote_hash: hashAmoEntity('lead', deal),
      },
    });

    // A human renames it. Different state, different hash, so it goes out.
    const edited = { ...deal, title: 'Переименовано человеком' };
    const result = await enqueueAmoOutbound({
      organizationId: ORG_ID,
      entityType: 'lead',
      operation: 'update',
      localId: deal.id as string,
      record: edited,
    });

    expect(result.enqueued).toBe(true);
    expect(fake.db.amoSyncJob.rows.filter((row) => row.direction === 'outbound')).toHaveLength(1);
  });
});
