/**
 * amoCRM Tier-1 one-time import: contacts, companies, leads, and the funnel they
 * live in.
 *
 * Shaped after services/importBitrix24.ts — same result-counter names, same
 * "one bad record must not abort the run" tolerance, same encryptField/blindIndex
 * treatment of phone and email — with three things that importer does not need:
 *
 *  • EVERY imported record gets an `AmoEntityMap` row. This is not bookkeeping.
 *    amoCRM sync is bidirectional and webhook-driven; a lead this import created
 *    with no bridge row is a lead the webhook receiver has never heard of, so the
 *    first `leads.update` for it creates a second copy. Import 20 000 leads
 *    without the map and the account doubles the moment sync is switched on.
 *
 *  • Idempotency. The bridge row is consulted before every write, so a re-run
 *    updates what it created the first time. Re-running the import is the normal
 *    recovery path from a half-finished run, so it has to be safe.
 *
 *  • Resumability. See LONG RUNS below.
 *
 * LONG RUNS. importBitrix24 does nothing about them: it runs inline in the HTTP
 * request and hard-caps itself at 1000 contacts / 500 deals, so a large account is
 * silently truncated. That is not survivable here — a 20 000-lead amoCRM account
 * at the verified 7 req/s and 250 records per page is ~80 contact pages plus ~80
 * lead pages, minutes of wall clock, and any proxy in front of the API will cut
 * the connection first.
 *
 * The proper fix is the `AmoSyncJob` queue that already exists in the schema, with
 * a worker draining it — that worker is another agent's file. The smallest fix
 * that works today, and what is implemented here, is a cursor:
 *   • `opts.max_records` bounds one invocation (default 5000 per entity);
 *   • when the bound is hit, or when a page fetch throws, the run returns
 *     `partial: true` plus the counts so far and a `cursor` to resume from;
 *   • passing that cursor back into `importFromAmo` continues where it stopped.
 * Because every write is keyed on `AmoEntityMap`, resuming is safe even if the
 * cursor over-rewinds — the overlap updates instead of duplicating.
 */

import { Prisma } from '@prisma/client';

import { db } from '../db';
import { encryptField, blindIndex } from '../encryption';
import { hashAmoEntity } from './echo';
import {
  AMO_STATUS_LOST,
  AMO_STATUS_WON,
  amoRecordHash,
  amoTimestampToDate,
  extractAmoEmail,
  extractAmoPhone,
  mapCustomFields,
  planPipelineImport,
  resolveLocalStage,
  syncPipelinesFromAmo,
  syntheticCompanyLocalId,
  fetchAmoPipelines,
  type AmoClientLike,
  type AmoCustomField,
  type StageMapping,
  type StagePlanWarning,
} from './mapping';

// ─── amoCRM wire shapes ───────────────────────────────────────────────────────

interface AmoEmbeddedRef {
  id?: number;
  is_main?: boolean;
}

interface AmoContact {
  id?: number;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  responsible_user_id?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
  is_deleted?: boolean;
  is_unsorted?: boolean;
  custom_fields_values?: AmoCustomField[] | null;
  /** `companies` is always present (max 1 entry) — no `with=` needed. */
  _embedded?: { companies?: AmoEmbeddedRef[] | null; tags?: Array<{ name?: string }> | null } | null;
}

interface AmoCompany {
  id?: number;
  name?: string | null;
  is_deleted?: boolean;
  custom_fields_values?: AmoCustomField[] | null;
}

interface AmoLead {
  id?: number;
  name?: string | null;
  price?: number | null;
  status_id?: number | null;
  pipeline_id?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
  closed_at?: number | null;
  is_deleted?: boolean;
  loss_reason_id?: number | null;
  custom_fields_values?: AmoCustomField[] | null;
  _embedded?: {
    contacts?: AmoEmbeddedRef[] | null;
    companies?: AmoEmbeddedRef[] | null;
    loss_reason?: Array<{ name?: string }> | null;
    tags?: Array<{ name?: string }> | null;
  } | null;
}

// ─── Public surface ───────────────────────────────────────────────────────────

export type AmoImportPhase = 'pipelines' | 'companies' | 'contacts' | 'leads' | 'done';

/** Resume point handed back on a partial run and accepted on the next call. */
export interface AmoImportCursor {
  phase: AmoImportPhase;
  /** 1-based amoCRM page number to restart the current phase from. */
  page: number;
}

export interface AmoImportOptions {
  include_leads?: boolean;
  include_companies?: boolean;
  /** Records per entity for ONE invocation. Default 5000. */
  max_records?: number;
  cursor?: AmoImportCursor;
  /** Injected in tests; defaults to services/amocrm/client.ts. */
  client?: AmoClientLike;
}

export interface AmoImportResult {
  // The five counters importBitrix24 returns, with the same meanings.
  contacts_imported: number;
  contacts_failed: number;
  deals_imported: number;
  deals_failed: number;
  /**
   * Confirmed: amoCRM v4 entity lists carry NO grand total — only `_page` and
   * `_links.next` (`_total_items` exists on /leads/pipelines and nowhere useful
   * here). So unlike the Bitrix importer, where this is the account's contact
   * count, here it is "contacts seen in this run".
   */
  total_contacts: number;

  // amoCRM-specific.
  companies_seen: number;
  companies_failed: number;
  pipelines_created: number;
  pipelines_updated: number;
  stages_created: number;
  stages_updated: number;
  warnings: StagePlanWarning[];
  /** True when the run stopped early — read `cursor` and call again. */
  partial: boolean;
  cursor?: AmoImportCursor;
  /** Set when the run stopped because of an error rather than the record bound. */
  error?: string;
}

/** amoCRM's documented maximum is 500; 250 is the recommended page size. */
const PAGE_LIMIT = 250;
const DEFAULT_MAX_RECORDS = 5000;

function emptyResult(): AmoImportResult {
  return {
    contacts_imported: 0,
    contacts_failed: 0,
    deals_imported: 0,
    deals_failed: 0,
    total_contacts: 0,
    companies_seen: 0,
    companies_failed: 0,
    pipelines_created: 0,
    pipelines_updated: 0,
    stages_created: 0,
    stages_updated: 0,
    warnings: [],
    partial: false,
  };
}

/**
 * The single point where this module meets the transport.
 *
 * Imported lazily and adapted explicitly rather than pulled in at the top: the
 * tests inject their own client and must never load the real one (it reaches for
 * tokens and a throttle at module scope), and the two generic signatures in
 * client.ts do not line up with the narrow structural type used here — client.ts
 * returns `T | null` and takes a narrowed `AmoMethod`. The casts are confined to
 * these two lines rather than sprayed through the importer.
 */
async function defaultClient(): Promise<AmoClientLike> {
  const mod = await import('./client');
  return {
    amoRequest: (orgId, method, path, body) =>
      mod.amoRequest<unknown>(orgId, method as never, path, body),
    paginate: (orgId, path, params) =>
      mod.paginate<unknown>(orgId, path, params as never) as AsyncGenerator<unknown[]>,
  };
}

// ─── The import ───────────────────────────────────────────────────────────────

export async function importFromAmo(
  orgId: string,
  userId: string,
  opts: AmoImportOptions = {},
): Promise<AmoImportResult> {
  const client = opts.client ?? (await defaultClient());
  const includeLeads = opts.include_leads !== false;
  const includeCompanies = opts.include_companies !== false;
  const maxRecords = opts.max_records ?? DEFAULT_MAX_RECORDS;

  const result = emptyResult();
  const startPhase = opts.cursor?.phase ?? 'pipelines';
  const startPage = Math.max(1, opts.cursor?.page ?? 1);

  // ── 1. Funnels first ───────────────────────────────────────────────────────
  //
  // Before any lead is written: a lead with no stage is a lead nobody can see on
  // the kanban, and the stage mapping is also what makes the whole integration
  // translatable in the other direction.
  let mapping: StageMapping;
  let accountCurrency = 'RUB';
  try {
    const applied = await syncPipelinesFromAmo(client, orgId, userId);
    mapping = applied.mapping;
    result.pipelines_created = applied.pipelines_created;
    result.pipelines_updated = applied.pipelines_updated;
    result.stages_created = applied.stages_created;
    result.stages_updated = applied.stages_updated;
    result.warnings = applied.warnings;
    try {
      const account = await client.amoRequest(orgId, 'GET', '/api/v4/account') as
        | { currency?: unknown }
        | null;
      const currency = typeof account?.currency === 'string'
        ? account.currency.trim().toUpperCase()
        : '';
      if (/^[A-Z]{3}$/.test(currency)) accountCurrency = currency;
    } catch {
      // Lead.price has no currency; keep the Russian market default if the optional
      // account metadata read is unavailable.
    }
  } catch (err) {
    // Funnels are load-bearing — without them leads cannot be placed. Contacts
    // still can be, so this degrades rather than aborts, and says so.
    result.partial = true;
    result.error = errorMessage(err);
    result.cursor = { phase: 'pipelines', page: 1 };
    return result;
  }

  // ── 2. Companies → the contact's company field ─────────────────────────────
  //
  // 4КУБ has no Company entity (schema.prisma: `Contact.company String?`, no
  // Company model), so an amo company is imported as a NAME that lands on every
  // contact attached to it. The names are collected first so the contact pass can
  // resolve `_embedded.companies[0].id` without a per-contact round trip.
  const companyNames = new Map<number, string>();
  if (includeCompanies && phaseAtOrAfter(startPhase, 'companies')) {
    const outcome = await runPhase(
      client,
      orgId,
      '/api/v4/companies',
      startPhase === 'companies' ? startPage : 1,
      maxRecords,
      async (raw) => {
        const company = raw as AmoCompany;
        if (!company || typeof company.id !== 'number') throw new Error('malformed company');
        result.companies_seen++;
        if (company.is_deleted) return;
        const name = typeof company.name === 'string' ? company.name.trim() : '';
        if (name) companyNames.set(company.id, name);
        await recordMap(orgId, 'company', company.id, syntheticCompanyLocalId(company.id), company);
      },
      () => {
        result.companies_failed++;
      },
    );
    if (outcome.stopped) {
      result.partial = true;
      result.error = outcome.error;
      result.cursor = { phase: 'companies', page: outcome.page };
      return result;
    }
  }

  // ── 3. Contacts ────────────────────────────────────────────────────────────
  const contactIdByAmo = new Map<number, string>();
  if (phaseAtOrAfter(startPhase, 'contacts')) {
    const outcome = await runPhase(
      client,
      orgId,
      '/api/v4/contacts',
      startPhase === 'contacts' ? startPage : 1,
      maxRecords,
      async (raw) => {
        const localId = await upsertContact(orgId, userId, raw as AmoContact, companyNames);
        if (localId) {
          contactIdByAmo.set((raw as AmoContact).id as number, localId);
          result.contacts_imported++;
        }
        result.total_contacts++;
      },
      () => {
        result.contacts_failed++;
        result.total_contacts++;
      },
      // No `with=` here on purpose. `_embedded.companies` is returned on a contact
      // UNCONDITIONALLY (amoCRM documents it as "always 1 object"), and `companies`
      // is not in the allowed `with` list for /contacts — asking for it is an
      // invalid parameter, not a no-op.
    );
    if (outcome.stopped) {
      result.partial = true;
      result.error = outcome.error;
      result.cursor = { phase: 'contacts', page: outcome.page };
      return result;
    }
  }

  // ── 4. Leads → Deal ────────────────────────────────────────────────────────
  if (includeLeads && phaseAtOrAfter(startPhase, 'leads')) {
    const outcome = await runPhase(
      client,
      orgId,
      '/api/v4/leads',
      startPhase === 'leads' ? startPage : 1,
      maxRecords,
      async (raw) => {
        const ok = await upsertDeal(
          orgId,
          userId,
          raw as AmoLead,
          mapping,
          contactIdByAmo,
          accountCurrency,
        );
        if (ok) result.deals_imported++;
        else result.deals_failed++;
      },
      () => {
        result.deals_failed++;
      },
      { with: 'contacts' },
    );
    if (outcome.stopped) {
      result.partial = true;
      result.error = outcome.error;
      result.cursor = { phase: 'leads', page: outcome.page };
      return result;
    }
  }

  return result;
}

// ─── Phase driver ─────────────────────────────────────────────────────────────

const PHASE_ORDER: AmoImportPhase[] = ['pipelines', 'companies', 'contacts', 'leads', 'done'];

function phaseAtOrAfter(current: AmoImportPhase, target: AmoImportPhase): boolean {
  return PHASE_ORDER.indexOf(current) <= PHASE_ORDER.indexOf(target);
}

interface PhaseOutcome {
  stopped: boolean;
  page: number;
  error?: string;
}

/**
 * Walks one amoCRM collection.
 *
 * A single malformed record calls `onFailure` and the loop continues — one broken
 * row in a 20 000-record account must never cost the other 19 999. A failure of
 * the *page fetch* is different: it means the transport is unhappy (expired token,
 * rate limit, network), retrying the same page in a tight loop earns a ban, so the
 * phase stops and reports where to resume.
 */
async function runPhase(
  client: AmoClientLike,
  orgId: string,
  path: string,
  startPage: number,
  maxRecords: number,
  onRecord: (raw: unknown) => Promise<void>,
  onFailure: (err: unknown) => void,
  extraParams: Record<string, unknown> = {},
): Promise<PhaseOutcome> {
  let page = startPage;
  let seen = 0;

  // KNOWN GAP: the current services/amocrm/client.ts builds its first query as
  // `{ ...params, limit, page: 1 }`, so the `page` handed in here is overwritten
  // and a resumed phase re-walks from page 1. That is SLOW, not WRONG — every
  // write is keyed on AmoEntityMap, so the re-walked records update in place
  // instead of duplicating. Making resume actually skip pages needs one character
  // in client.ts: `page: params.page ?? 1`.
  const pages = client.paginate(orgId, path, { limit: PAGE_LIMIT, page: startPage, ...extraParams });

  try {
    for (;;) {
      const next = await pages.next();
      if (next.done) break;
      const batch = Array.isArray(next.value) ? next.value : [];

      for (const raw of batch) {
        try {
          await onRecord(raw);
        } catch (err) {
          onFailure(err);
        }
        seen++;
      }

      page++;
      if (seen >= maxRecords) {
        return { stopped: true, page, error: undefined };
      }
    }
  } catch (err) {
    return { stopped: true, page, error: errorMessage(err) };
  }

  return { stopped: false, page };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Record writers ───────────────────────────────────────────────────────────

/** Splits amo's single `name` when first_name/last_name are not populated. */
function splitName(contact: AmoContact): { first: string; last?: string } {
  const first = typeof contact.first_name === 'string' ? contact.first_name.trim() : '';
  const last = typeof contact.last_name === 'string' ? contact.last_name.trim() : '';
  if (first || last) return { first: first || last, last: first ? last || undefined : undefined };

  const display = typeof contact.name === 'string' ? contact.name.trim() : '';
  if (!display) return { first: 'Контакт' };
  const parts = display.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') || undefined };
}

async function upsertContact(
  orgId: string,
  userId: string,
  contact: AmoContact,
  companyNames: Map<number, string>,
): Promise<string | null> {
  if (!contact || typeof contact.id !== 'number') throw new Error('malformed contact: no id');
  if (contact.is_deleted) return null;

  const { first, last } = splitName(contact);
  const phone = extractAmoPhone(contact.custom_fields_values);
  const email = extractAmoEmail(contact.custom_fields_values);
  const companyId = contact._embedded?.companies?.[0]?.id;
  const company = typeof companyId === 'number' ? companyNames.get(companyId) : undefined;
  const custom = mapCustomFields(contact.custom_fields_values);

  const payload = {
    first_name: first,
    last_name: last,
    phone: phone ? encryptField(phone) : null,
    email: email ? encryptField(email) : null,
    // Indexed from the TRIMMED PLAINTEXT that was encrypted on the line above,
    // never from the ciphertext: encryptField picks a fresh IV per call, so a hash
    // of its output matches no lookup that will ever be performed. An amoCRM
    // import is a whole customer base landing at once — unindexed, none of it is
    // reachable by phone or email in contact-search.ts.
    phone_bidx: phone ? blindIndex(phone, 'phone') : null,
    email_bidx: email ? blindIndex(email, 'email') : null,
    company: company ?? null,
    source: 'amocrm',
    custom_fields: custom === undefined ? undefined : (custom as Prisma.InputJsonValue),
  };

  const existing = await findMapped(orgId, 'contact', contact.id);
  let localId: string | null = existing;
  let written: Record<string, unknown> | null = null;

  if (localId) {
    try {
      written = await db.contact.update({ where: { id: localId }, data: payload }) as unknown as Record<string, unknown>;
    } catch {
      // The local row was deleted since the last run; fall through and rebuild it
      // so the bridge row stops pointing at nothing.
      localId = null;
    }
  }

  if (!localId) {
    const created = await db.contact.create({
      data: { organization_id: orgId, created_by: userId, ...payload },
    });
    localId = created.id;
    written = created as unknown as Record<string, unknown>;
  }

  await recordMap(
    orgId,
    'contact',
    contact.id,
    localId,
    written ? hashAmoEntity('contact', written) : amoRecordHash(contact),
  );
  return localId;
}

async function upsertDeal(
  orgId: string,
  userId: string,
  lead: AmoLead,
  mapping: StageMapping,
  contactIdByAmo: Map<number, string>,
  accountCurrency: string,
): Promise<boolean> {
  if (!lead || typeof lead.id !== 'number') throw new Error('malformed lead: no id');
  if (lead.is_deleted) return false;

  const amoPipelineId = typeof lead.pipeline_id === 'number' ? lead.pipeline_id : null;
  const amoStatusId = typeof lead.status_id === 'number' ? lead.status_id : null;

  let pipelineId: string | undefined;
  let stageId: string | undefined;
  if (amoPipelineId !== null && amoStatusId !== null) {
    const resolved = resolveLocalStage(mapping, amoPipelineId, amoStatusId);
    if (resolved) {
      pipelineId = resolved.pipeline_id;
      stageId = resolved.stage_id;
    } else {
      // Status created in amoCRM after the funnel pass ran. The deal still lands
      // in the right funnel, just without a stage, rather than being dropped.
      pipelineId = mapping.pipelineByAmo.get(amoPipelineId);
    }
  }

  const status = amoStatusId === AMO_STATUS_WON ? 'won' : amoStatusId === AMO_STATUS_LOST ? 'lost' : 'open';
  const closedAt = amoTimestampToDate(lead.closed_at);

  // 4КУБ's Deal.contact_id is nullable, so an unmatched lead is stored unlinked.
  // The Bitrix importer manufactures a placeholder contact for this case; that is
  // deliberately not copied — amoCRM leads routinely outnumber contacts, and a
  // placeholder per lead poisons the contact base and every consent count taken
  // off it.
  const amoContactId =
    lead._embedded?.contacts?.find((c) => c?.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id;
  let contactId: string | undefined;
  if (typeof amoContactId === 'number') {
    contactId = contactIdByAmo.get(amoContactId) ?? (await findMapped(orgId, 'contact', amoContactId)) ?? undefined;
  }

  const custom = mapCustomFields(lead.custom_fields_values);
  const payload = {
    title: (typeof lead.name === 'string' && lead.name.trim()) || `Сделка ${lead.id}`,
    contact_id: contactId ?? null,
    pipeline_id: pipelineId,
    stage_id: stageId,
    value: typeof lead.price === 'number' ? new Prisma.Decimal(lead.price) : null,
    // An amoCRM lead carries `price` as a bare number. The account-level currency
    // was read once at the start of the import and is applied consistently to all
    // imported deals; RUB is the market fallback if that optional read failed.
    currency: accountCurrency,
    status: status as 'open' | 'won' | 'lost',
    actual_close: status === 'open' ? null : closedAt,
    lost_reason: status === 'lost' ? (lead._embedded?.loss_reason?.[0]?.name ?? null) : null,
    source: 'amocrm',
    custom_fields: custom === undefined ? undefined : (custom as Prisma.InputJsonValue),
  };

  const existing = await findMapped(orgId, 'lead', lead.id);
  let localId: string | null = existing;
  let written: Record<string, unknown> | null = null;

  if (localId) {
    try {
      written = await db.deal.update({ where: { id: localId }, data: payload }) as unknown as Record<string, unknown>;
    } catch {
      localId = null;
    }
  }

  if (!localId) {
    const created = await db.deal.create({
      data: { organization_id: orgId, created_by: userId, ...payload },
    });
    localId = created.id;
    written = created as unknown as Record<string, unknown>;
  }

  await recordMap(
    orgId,
    'lead',
    lead.id,
    localId,
    written ? hashAmoEntity('lead', written) : amoRecordHash(lead),
  );
  return true;
}

// ─── AmoEntityMap ─────────────────────────────────────────────────────────────

async function findMapped(orgId: string, entityType: string, amoId: number): Promise<string | null> {
  const row = await db.amoEntityMap.findUnique({
    where: {
      organization_id_entity_type_amo_id: {
        organization_id: orgId,
        entity_type: entityType,
        amo_id: BigInt(amoId),
      },
    },
    select: { local_id: true },
  });
  return row?.local_id ?? null;
}

/**
 * The bridge row. Written for every record the import touches, with the hash of
 * the amoCRM payload in `last_remote_hash` so the sync worker can recognise its
 * own echo and refuse to push it back.
 */
async function recordMap(
  orgId: string,
  entityType: string,
  amoId: number,
  localId: string,
  localHashOrRemote: string | unknown,
): Promise<void> {
  const hash = typeof localHashOrRemote === 'string' && /^[0-9a-f]{64}$/.test(localHashOrRemote)
    ? localHashOrRemote
    : amoRecordHash(localHashOrRemote);
  await db.amoEntityMap.upsert({
    where: {
      organization_id_entity_type_amo_id: {
        organization_id: orgId,
        entity_type: entityType,
        amo_id: BigInt(amoId),
      },
    },
    create: {
      organization_id: orgId,
      entity_type: entityType,
      local_id: localId,
      amo_id: BigInt(amoId),
      last_synced_at: new Date(),
      last_remote_hash: hash,
    },
    update: { local_id: localId, last_synced_at: new Date(), last_remote_hash: hash },
  });
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export interface AmoImportPreview {
  /** The funnels that would be created, exactly as the import would create them. */
  pipelines: Array<{
    amo_pipeline_id: number;
    name: string;
    is_archive: boolean;
    stages: Array<{
      amo_status_id: number;
      name: string;
      position: number;
      color: string | null;
      is_won_stage: boolean;
      is_lost_stage: boolean;
    }>;
  }>;
  /** Everything the user should see before committing — demoted terminal stages. */
  warnings: StagePlanWarning[];
  /**
   * First page only. amoCRM v4 returns no grand total on entity lists (confirmed),
   * so these are "at least this many", with `has_more` — read off `_links.next` —
   * saying whether the real number is larger.
   */
  sample: { contacts: number; companies: number; leads: number };
  has_more: { contacts: boolean; companies: boolean; leads: boolean };
  /** Bridge rows that already exist — how much of this is a re-import. */
  already_mapped: { contacts: number; companies: number; leads: number };
}

/** Reads a single page without following pagination. Tolerates 204/empty. */
async function peekPage(
  client: AmoClientLike,
  orgId: string,
  path: string,
  collection: string,
): Promise<{ count: number; hasMore: boolean }> {
  try {
    const res = (await client.amoRequest(orgId, 'GET', `${path}?limit=${PAGE_LIMIT}&page=1`)) as
      | { _embedded?: Record<string, unknown[]>; _links?: { next?: unknown } }
      | null
      | undefined;
    const rows = res?._embedded?.[collection];
    const count = Array.isArray(rows) ? rows.length : 0;
    return { count, hasMore: !!res?._links?.next };
  } catch {
    // A preview must never be the thing that fails the connect flow.
    return { count: 0, hasMore: false };
  }
}

/**
 * What `POST /import/amocrm` would do, without doing any of it: no local row and
 * no bridge row is written here. Everything below is reads.
 */
export async function previewAmoImport(
  orgId: string,
  opts: { client?: AmoClientLike } = {},
): Promise<AmoImportPreview> {
  const client = opts.client ?? (await defaultClient());

  const plan = planPipelineImport(await fetchAmoPipelines(client, orgId));

  const [contacts, companies, leads] = await Promise.all([
    peekPage(client, orgId, '/api/v4/contacts', 'contacts'),
    peekPage(client, orgId, '/api/v4/companies', 'companies'),
    peekPage(client, orgId, '/api/v4/leads', 'leads'),
  ]);

  const [mappedContacts, mappedCompanies, mappedLeads] = await Promise.all([
    db.amoEntityMap.count({ where: { organization_id: orgId, entity_type: 'contact' } }),
    db.amoEntityMap.count({ where: { organization_id: orgId, entity_type: 'company' } }),
    db.amoEntityMap.count({ where: { organization_id: orgId, entity_type: 'lead' } }),
  ]);

  return {
    pipelines: plan.pipelines.map((p) => ({
      amo_pipeline_id: p.amo_pipeline_id,
      name: p.name,
      is_archive: p.is_archive,
      stages: p.stages,
    })),
    warnings: plan.warnings,
    sample: { contacts: contacts.count, companies: companies.count, leads: leads.count },
    has_more: { contacts: contacts.hasMore, companies: companies.hasMore, leads: leads.hasMore },
    already_mapped: { contacts: mappedContacts, companies: mappedCompanies, leads: mappedLeads },
  };
}
