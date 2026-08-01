/**
 * amoCRM → 4КУБ field and funnel mapping.
 *
 * Two jobs live here:
 *
 *  1. FIELD MAPPING — turning amoCRM's `custom_fields_values` array into the flat
 *     `custom_fields Json` column, and pulling phone/email back out of it (amoCRM
 *     keeps them as custom fields, not as columns, unlike Bitrix24).
 *
 *  2. FUNNEL MAPPING — the part the whole integration hangs off. amoCRM models a
 *     funnel as `pipelines` → `_embedded.statuses`; 4КУБ models it as
 *     `Pipeline` → `PipelineStage`. Every inbound webhook carries
 *     `{pipeline_id, status_id}` and nothing else, so without a persisted
 *     translation table a lead moving stage in amoCRM cannot be placed anywhere
 *     locally.
 *
 * WHERE THE STAGE MAPPING LIVES, AND WHY
 * --------------------------------------
 * `AmoIntegration` has no JSON column to park it in and the schema is frozen for
 * this change, so the mapping is persisted as `AmoEntityMap` rows — the same
 * bridge table the contacts and leads use.
 *
 * The obvious encoding, `entity_type = 'stage'` with `amo_id = <status id>`, is
 * WRONG and would corrupt any account with more than one funnel. amoCRM's
 * terminal status ids are reserved constants that repeat verbatim in every
 * pipeline: status 142 ("Успешно реализовано") and 143 ("Закрыто и не
 * реализовано") exist in funnel A *and* funnel B. `AmoEntityMap` is unique on
 * `[organization_id, entity_type, amo_id]`, so the second funnel's 142 would
 * collide with the first funnel's 142 — one of the two won stages silently loses
 * its mapping, and every won lead in that funnel lands in the wrong pipeline.
 *
 * So stages are namespaced by their amo pipeline:
 *
 *     entity_type = 'pipeline'          amo_id = <amo pipeline id>  local_id = Pipeline.id
 *     entity_type = 'stage:<amo_pipeline_id>'  amo_id = <amo status id>  local_id = PipelineStage.id
 *
 * Both unique constraints then hold naturally: `[org, 'stage:7', 142]` and
 * `[org, 'stage:9', 142]` are different rows, and a local stage belongs to
 * exactly one pipeline so `[org, 'stage:7', <stage uuid>]` is unique too. The
 * prefix carries the amo pipeline id for free, which is what the reverse
 * direction (local stage → amo `{pipeline_id, status_id}`) needs.
 *
 * Readers should not hand-roll that encoding — use `loadStageMapping()` and the
 * `resolve*` helpers below.
 */

import crypto from 'node:crypto';

import { db } from '../db';

// ─── amoCRM wire shapes ───────────────────────────────────────────────────────
//
// Declared here rather than imported from ./types.ts: that file is owned by the
// auth/client agent and did not exist when this was written. These are the
// narrow read-only views this module needs; if ./types.ts lands with compatible
// names, collapse them.

export interface AmoCustomFieldValue {
  value?: unknown;
  enum_id?: number | null;
  enum_code?: string | null;
}

export interface AmoCustomField {
  field_id?: number;
  field_name?: string | null;
  field_code?: string | null;
  field_type?: string | null;
  values?: AmoCustomFieldValue[] | null;
}

export interface AmoStatus {
  id: number;
  name?: string | null;
  sort?: number | null;
  pipeline_id?: number | null;
  color?: string | null;
  /**
   * Confirmed: `1` = «Неразобранное» (the incoming/unsorted inbox), `0` = an
   * ordinary stage. Only those two values are documented, and — this is the trap —
   * `type: 1` does NOT mean "successful". Statuses 142 and 143 both carry
   * `type: 0`. Anything that treats `type === 1` as won files every unsorted lead
   * as a closed sale.
   * Source: amocrm.ru/developers/content/crm_platform/leads_pipelines
   */
  type?: number | null;
  is_editable?: boolean;
}

export interface AmoPipeline {
  id: number;
  name?: string | null;
  sort?: number | null;
  is_main?: boolean;
  is_unsorted_on?: boolean;
  is_archive?: boolean;
  _embedded?: { statuses?: AmoStatus[] | null } | null;
}

/**
 * The slice of `services/amocrm/client.ts` this module and import.ts consume.
 *
 * Taken as a parameter rather than imported so the two can be built in parallel
 * and so tests never need the real transport. `import.ts` falls back to the real
 * module when no client is supplied.
 */
export interface AmoClientLike {
  amoRequest(orgId: string, method: string, path: string, body?: unknown): Promise<unknown>;
  paginate(orgId: string, path: string, params?: Record<string, unknown>): AsyncGenerator<unknown[]>;
}

// ─── Reserved amoCRM status ids ───────────────────────────────────────────────

/**
 * "Успешно реализовано" / "Closed - won". Confirmed: amoCRM gives EVERY pipeline
 * a status with this exact id — `(pipeline_id, status_id)` is the real key, not
 * `status_id`. That is the whole reason the mapping is namespaced below.
 */
export const AMO_STATUS_WON = 142;
/** "Закрыто и не реализовано" / "Closed - lost". Also repeated in every pipeline. */
export const AMO_STATUS_LOST = 143;

export const PIPELINE_ENTITY_TYPE = 'pipeline';

/** The `AmoEntityMap.entity_type` that holds the statuses of one amo funnel. */
export function stageEntityType(amoPipelineId: number | bigint | string): string {
  return `stage:${amoPipelineId}`;
}

/** Inverse of `stageEntityType` — null for anything that is not a stage row. */
export function amoPipelineIdFromEntityType(entityType: string): number | null {
  if (!entityType.startsWith('stage:')) return null;
  const parsed = Number(entityType.slice('stage:'.length));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * amoCRM has a Company entity; 4КУБ does not — a company is a plain string on
 * `Contact.company` (confirmed against backend/prisma/schema.prisma: model
 * Contact has `company String?`, and there is no Company model).
 *
 * `AmoEntityMap.local_id` is a NOT NULL uuid, so a company row still needs
 * *some* local id. This derives a stable, deterministic one from the amo company
 * id, purely so the bridge row can exist: it lets the sync worker recognise
 * "amo company 4242 was already seen by the import" and skip re-creating
 * anything, and gives `last_remote_hash` somewhere to live for echo suppression.
 *
 * It does NOT address a real row. Nothing may dereference it. The genuine join
 * from an amo company back to local data is by name over `Contact.company`.
 * The clean fix is a nullable `local_id` (or an actual Company model) — see the
 * handover notes.
 */
export function syntheticCompanyLocalId(amoCompanyId: number | bigint): string {
  // UUIDv5-shaped but computed without a hash dependency: the amo id is embedded
  // verbatim so the value is trivially reproducible from either side.
  const hex = BigInt(amoCompanyId).toString(16).padStart(12, '0').slice(-12);
  return `a3000000-0000-5000-8000-${hex}`;
}

// ─── Custom fields ────────────────────────────────────────────────────────────

/**
 * Field codes that are NOT copied into `custom_fields`.
 *
 * PHONE and EMAIL are extracted into `Contact.phone` / `Contact.email`, which are
 * encrypted at rest and blind-indexed. `custom_fields` is a plain Json column
 * with neither. Copying the same number into both would hand back in cleartext
 * exactly what the encryption exists to protect, and would do it for a whole
 * customer base at once — an import is the moment that mistake scales.
 */
const PII_FIELD_CODES = new Set(['PHONE', 'EMAIL']);

function scalarFromValue(v: AmoCustomFieldValue): unknown {
  if (v === null || typeof v !== 'object') return null;
  // A select/multiselect carries the human label in `value` and the option id in
  // `enum_id`; the label is what a person recognises, so that is what is kept.
  if (v.value !== undefined) return v.value;
  // `chained_list` is the one documented type with no `value` key at all — it
  // carries {catalog_id, catalog_element_id}. Keeping the raw element beats
  // dropping the field silently.
  const raw = v as unknown as Record<string, unknown>;
  if (raw.catalog_element_id !== undefined) return raw;
  return null;
}

/**
 * `custom_fields_values` → the flat object stored in `custom_fields Json`.
 *
 * Keyed by `field_name` because that is what a user sees in amoCRM and what makes
 * the imported data legible without a second lookup table. A field with no name
 * falls back to `field_<id>`; two fields with the same name are disambiguated by
 * appending the id rather than one silently overwriting the other.
 *
 * Single-valued fields store a scalar, multi-valued fields an array — a field
 * that legitimately holds several values (multiselect, several phone entries)
 * must not be flattened to its first element.
 */
export function mapCustomFields(
  fields: AmoCustomField[] | null | undefined,
  options: { excludeCodes?: Set<string> } = {},
): Record<string, unknown> | undefined {
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  const exclude = options.excludeCodes ?? PII_FIELD_CODES;

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    const code = typeof field.field_code === 'string' ? field.field_code.toUpperCase() : null;
    if (code && exclude.has(code)) continue;

    const values = Array.isArray(field.values) ? field.values : [];
    const scalars = values.map(scalarFromValue).filter((v) => v !== null && v !== undefined && v !== '');
    if (scalars.length === 0) continue;

    const base =
      typeof field.field_name === 'string' && field.field_name.trim()
        ? field.field_name.trim()
        : field.field_id !== undefined
          ? `field_${field.field_id}`
          : null;
    if (!base) continue;

    const key = base in out && field.field_id !== undefined ? `${base} (${field.field_id})` : base;
    out[key] = scalars.length === 1 ? scalars[0] : scalars;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function firstValueByCode(fields: AmoCustomField[] | null | undefined, code: string): string | undefined {
  if (!Array.isArray(fields)) return undefined;
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    if (typeof field.field_code !== 'string' || field.field_code.toUpperCase() !== code) continue;
    for (const v of Array.isArray(field.values) ? field.values : []) {
      const raw = scalarFromValue(v);
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (typeof raw === 'number') return String(raw);
    }
  }
  return undefined;
}

/** First non-empty PHONE custom-field value, trimmed. */
export function extractAmoPhone(fields: AmoCustomField[] | null | undefined): string | undefined {
  return firstValueByCode(fields, 'PHONE');
}

/** First non-empty EMAIL custom-field value, trimmed. */
export function extractAmoEmail(fields: AmoCustomField[] | null | undefined): string | undefined {
  return firstValueByCode(fields, 'EMAIL');
}

/**
 * Canonical hash of an amoCRM record, written to `AmoEntityMap.last_remote_hash`.
 *
 * This is the echo suppressor: an outbound payload whose hash equals the stored
 * `last_remote_hash` is a change amoCRM itself just told us about, and must not be
 * pushed back. That only works if BOTH sides compute the hash the same way, so the
 * import and the sync worker must call this one function rather than each rolling
 * its own JSON.stringify (key order alone would make two hashes of one object
 * differ).
 *
 * Keys are sorted recursively; `updated_at`-style volatility is deliberately NOT
 * stripped, because a bare touch in amoCRM is still a remote event.
 */
export function amoRecordHash(record: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(record)).digest('hex');
}

function stableStringify(value: unknown): string {
  // Before the object test: JSON.stringify throws on a bigint, and amo ids arrive
  // as bigint out of Prisma.
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** amoCRM timestamps are unix seconds; anything else is treated as absent. */
export function amoTimestampToDate(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// ─── Funnel plan ──────────────────────────────────────────────────────────────

export interface PlannedStage {
  amo_status_id: number;
  name: string;
  position: number;
  color: string | null;
  is_won_stage: boolean;
  is_lost_stage: boolean;
}

export interface PlannedPipeline {
  amo_pipeline_id: number;
  name: string;
  is_main: boolean;
  is_archive: boolean;
  stages: PlannedStage[];
}

export interface StagePlanWarning {
  code: 'DUPLICATE_TERMINAL_STATUS' | 'EMPTY_PIPELINE' | 'MISSING_WON_STATUS';
  amo_pipeline_id: number;
  amo_status_id: number | null;
  stage_name: string | null;
  flag: 'won' | 'lost' | null;
  message: string;
}

export interface PipelineImportPlan {
  pipelines: PlannedPipeline[];
  warnings: StagePlanWarning[];
}

/**
 * The reserved id is the ONLY signal. amoCRM exposes no per-status "this one is
 * the win" flag: `type` distinguishes the unsorted inbox (1) from everything else
 * (0), and 142 carries `type: 0` like any ordinary stage.
 */
export function isWonStatus(status: AmoStatus): boolean {
  return status.id === AMO_STATUS_WON;
}

export function isLostStatus(status: AmoStatus): boolean {
  return status.id === AMO_STATUS_LOST;
}

/**
 * «Неразобранное» — amoCRM's incoming-leads inbox, present when the pipeline has
 * `is_unsorted_on`. Its id is GENERATED per pipeline (32392156, 58141803, …), not
 * the 1 that older v2-era material claims, so `type` is the only way to spot it.
 *
 * It is imported as an ordinary first stage rather than skipped: leads genuinely
 * sit in it, and a lead whose status maps to nothing cannot be placed.
 */
export function isUnsortedStatus(status: AmoStatus): boolean {
  return status.type === 1;
}

/**
 * Passed through as-is when it is a plain hex colour.
 *
 * Deliberately NOT validated against amoCRM's documented 21-colour palette: that
 * list is the write-side whitelist, and the values amoCRM actually *returns* fall
 * outside it (#c1c1c1 for unsorted, #CCFF66 for 142, #D5D8DB for 143 all appear in
 * amoCRM's own examples). Checking against the palette would strip the colour off
 * exactly the three system stages every account has.
 */
function normalizeColor(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const trimmed = color.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Turns amo funnels into the local rows that should exist, WITHOUT touching the
 * database — so the preview endpoint and the tests can both see the exact same
 * decision the importer will make.
 *
 * THE TWO-WON-STAGES PROBLEM. The database enforces at most one won stage and one
 * lost stage per pipeline with partial unique indexes
 * (`pipeline_stage_one_won_per_pipeline`, added in
 * 20260801170000_reminders_push_amocrm_stages) because reporting.ts resolves
 * "won" by finding THE stage with the flag. amoCRM has no such rule: an account
 * can carry a second successful status, and a naive import raises P2002 halfway
 * through and leaves a half-built funnel behind.
 *
 * This resolves it in the plan instead of at the write, so the outcome is
 * decided, visible in the preview, and reported — never a crash:
 *   • among the statuses that look won, the reserved id 142 wins; if 142 is
 *     absent, the one that sorts last wins (a terminal stage is at the end of a
 *     funnel);
 *   • the others are imported as ordinary stages with the flag cleared, and each
 *     demotion is recorded as a DUPLICATE_TERMINAL_STATUS warning.
 * Nothing is dropped: every amo status still becomes a local stage and still gets
 * a mapping row, so no lead becomes unplaceable. Only the flag moves.
 */
export function planPipelineImport(pipelines: AmoPipeline[] | null | undefined): PipelineImportPlan {
  const warnings: StagePlanWarning[] = [];
  const planned: PlannedPipeline[] = [];

  for (const pipeline of Array.isArray(pipelines) ? pipelines : []) {
    if (!pipeline || typeof pipeline.id !== 'number') continue;

    const statuses = (pipeline._embedded?.statuses ?? []).filter(
      (s): s is AmoStatus => !!s && typeof s.id === 'number',
    );

    if (statuses.length === 0) {
      warnings.push({
        code: 'EMPTY_PIPELINE',
        amo_pipeline_id: pipeline.id,
        amo_status_id: null,
        stage_name: null,
        flag: null,
        message: `Воронка «${pipeline.name ?? pipeline.id}» не содержит этапов; созданы безопасные этапы «Новый лид» и «Сделка выиграна».`,
      });
    }

    let ordered = [...statuses].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id);

    if (ordered.length === 0) {
      // amoCRM accounts normally always have system statuses 142/143. A truly
      // empty response is malformed, but creating an empty local pipeline would
      // violate the local funnel invariant and leave every deal unplaceable.
      ordered = [
        { id: -1, name: 'Новый лид', sort: 0, color: '#94a3b8', type: 0 },
        { id: -2, name: 'Сделка выиграна', sort: 10, color: '#34d399', type: 0 },
      ];
    }

    const wonCandidates = ordered.filter(isWonStatus);
    const lostCandidates = ordered.filter(isLostStatus);
    let wonKeeper = pickTerminal(wonCandidates, AMO_STATUS_WON);
    if (!wonKeeper) {
      // Prefer the last non-lost stage, preserving the user's ordering. If the
      // payload has only lost statuses, the synthetic won terminal above/below
      // keeps one stage from being marked as both outcomes.
      wonKeeper = [...ordered].reverse().find((stage) => !isLostStatus(stage)) ?? null;
      if (!wonKeeper) {
        wonKeeper = { id: -2, name: 'Сделка выиграна', sort: 10_000, color: '#34d399', type: 0 };
        ordered.push(wonKeeper);
      }
      if (statuses.length > 0) {
        warnings.push({
          code: 'MISSING_WON_STATUS',
          amo_pipeline_id: pipeline.id,
          amo_status_id: wonKeeper.id > 0 ? wonKeeper.id : null,
          stage_name: wonKeeper.name ?? null,
          flag: 'won',
          message: `Pipeline "${pipeline.name ?? pipeline.id}" had no won status; "${wonKeeper.name ?? wonKeeper.id}" is the local won stage.`,
        });
      }
    }
    const lostKeeper = pickTerminal(lostCandidates, AMO_STATUS_LOST);

    for (const [candidates, keeper, flag, label] of [
      [wonCandidates, wonKeeper, 'won', 'успешного завершения'] as const,
      [lostCandidates, lostKeeper, 'lost', 'проигрыша'] as const,
    ]) {
      for (const demoted of candidates) {
        // Compared by object identity, not by id: the duplicates this exists to
        // catch are two entries that BOTH carry id 142, so an id comparison would
        // treat each of them as the keeper and flag both.
        if (demoted === keeper) continue;
        warnings.push({
          code: 'DUPLICATE_TERMINAL_STATUS',
          amo_pipeline_id: pipeline.id,
          amo_status_id: demoted.id,
          stage_name: demoted.name ?? null,
          flag,
          message:
            `В воронке «${pipeline.name ?? pipeline.id}» несколько статусов ${label}. ` +
            `Этап «${demoted.name ?? demoted.id}» импортирован как обычный: ` +
            'в 4КУБ у воронки может быть только один такой этап.',
        });
      }
    }

    planned.push({
      amo_pipeline_id: pipeline.id,
      name: (typeof pipeline.name === 'string' && pipeline.name.trim()) || `Воронка ${pipeline.id}`,
      is_main: pipeline.is_main === true,
      is_archive: pipeline.is_archive === true,
      stages: ordered.map((status, index) => ({
        amo_status_id: status.id,
        name: (typeof status.name === 'string' && status.name.trim()) || `Этап ${status.id}`,
        // Position is the index in amo's own sort order, not amo's `sort` value:
        // amo leaves gaps (10, 20, 142…) and 4КУБ's kanban expects 0..n-1.
        position: index,
        color: normalizeColor(status.color),
        is_won_stage: status === wonKeeper,
        is_lost_stage: status === lostKeeper,
      })),
    });
  }

  return { pipelines: planned, warnings };
}

function pickTerminal(candidates: AmoStatus[], reservedId: number): AmoStatus | null {
  if (candidates.length === 0) return null;
  const reserved = candidates.find((s) => s.id === reservedId);
  if (reserved) return reserved;
  return candidates.reduce((best, s) => ((s.sort ?? 0) >= (best.sort ?? 0) ? s : best));
}

// ─── Reading the funnel out of amoCRM ─────────────────────────────────────────

/**
 * `GET /api/v4/leads/pipelines`.
 *
 * amoCRM answers a list request that matches nothing with **204 No Content and an
 * empty body** — not 200 with an empty array (amoCRM's own PHP SDK raises
 * AmoCRMApiNoContentException for it). So the client may hand back null/undefined
 * rather than an envelope, hence the defensive unwrap.
 */
export async function fetchAmoPipelines(client: AmoClientLike, orgId: string): Promise<AmoPipeline[]> {
  const res = (await client.amoRequest(orgId, 'GET', '/api/v4/leads/pipelines')) as
    | { _embedded?: { pipelines?: AmoPipeline[] } }
    | null
    | undefined;
  const list = res?._embedded?.pipelines;
  return Array.isArray(list) ? list : [];
}

// ─── Persisted mapping ────────────────────────────────────────────────────────

export interface StageMapping {
  /** `${amoPipelineId}:${amoStatusId}` → local PipelineStage.id */
  stageByAmo: Map<string, string>;
  /** local PipelineStage.id → the amo coordinates it came from */
  amoByStage: Map<string, { amo_pipeline_id: number; amo_status_id: number }>;
  /** amo pipeline id → local Pipeline.id */
  pipelineByAmo: Map<number, string>;
  /** local Pipeline.id → amo pipeline id */
  amoByPipeline: Map<string, number>;
}

export function emptyStageMapping(): StageMapping {
  return {
    stageByAmo: new Map(),
    amoByStage: new Map(),
    pipelineByAmo: new Map(),
    amoByPipeline: new Map(),
  };
}

function stageKey(amoPipelineId: number, amoStatusId: number): string {
  return `${amoPipelineId}:${amoStatusId}`;
}

/**
 * THE READ INTERFACE FOR THE SYNC WORKER.
 *
 * Load once per job batch and translate in memory; the table is small (one row
 * per status) and a per-webhook query would be a round trip on the hot path.
 */
export async function loadStageMapping(orgId: string): Promise<StageMapping> {
  const rows = await db.amoEntityMap.findMany({
    where: {
      organization_id: orgId,
      OR: [{ entity_type: PIPELINE_ENTITY_TYPE }, { entity_type: { startsWith: 'stage:' } }],
    },
    select: { entity_type: true, amo_id: true, local_id: true },
  });

  const mapping = emptyStageMapping();
  for (const row of rows) {
    const amoId = Number(row.amo_id);
    if (row.entity_type === PIPELINE_ENTITY_TYPE) {
      mapping.pipelineByAmo.set(amoId, row.local_id);
      mapping.amoByPipeline.set(row.local_id, amoId);
      continue;
    }
    const amoPipelineId = amoPipelineIdFromEntityType(row.entity_type);
    if (amoPipelineId === null) continue;
    mapping.stageByAmo.set(stageKey(amoPipelineId, amoId), row.local_id);
    mapping.amoByStage.set(row.local_id, { amo_pipeline_id: amoPipelineId, amo_status_id: amoId });
  }

  return mapping;
}

/** amo `{pipeline_id, status_id}` → local `{pipeline_id, stage_id}`, or null. */
export function resolveLocalStage(
  mapping: StageMapping,
  amoPipelineId: number,
  amoStatusId: number,
): { pipeline_id: string; stage_id: string } | null {
  const stageId = mapping.stageByAmo.get(stageKey(amoPipelineId, amoStatusId));
  const pipelineId = mapping.pipelineByAmo.get(amoPipelineId);
  if (!stageId || !pipelineId) return null;
  return { pipeline_id: pipelineId, stage_id: stageId };
}

/** local PipelineStage.id → amo `{pipeline_id, status_id}`, or null. */
export function resolveAmoStatus(
  mapping: StageMapping,
  localStageId: string,
): { amo_pipeline_id: number; amo_status_id: number } | null {
  return mapping.amoByStage.get(localStageId) ?? null;
}

// ─── The port sync-worker.ts imports ──────────────────────────────────────────
//
// services/amocrm/sync-worker.ts dynamically imports './mapping' and expects
// exactly these two names (its `AmoMappingModule`). They are single-row lookups
// rather than a full map load because the worker calls them once per job, and a
// job already has its own transaction budget.
//
// For a batch — the reconciler, a bulk push — prefer loadStageMapping() once and
// resolveLocalStage()/resolveAmoStatus() in memory.

/**
 * amo `status_id` (+ `pipeline_id`) → local `{pipeline_id, stage_id}`.
 *
 * `amoPipelineId` is not optional in practice for the two ids that matter. 142 and
 * 143 exist in EVERY amo funnel, so a status id alone does not identify a stage;
 * when the pipeline is unknown and the id is ambiguous this returns null rather
 * than guessing, because guessing puts a won deal in a stranger's funnel.
 */
export async function localStageForAmoStatus(
  orgId: string,
  amoStatusId: number,
  amoPipelineId?: number | null,
): Promise<{ pipeline_id: string; stage_id: string } | null> {
  if (typeof amoPipelineId === 'number' && Number.isFinite(amoPipelineId)) {
    const [stage, pipeline] = await Promise.all([
      db.amoEntityMap.findUnique({
        where: {
          organization_id_entity_type_amo_id: {
            organization_id: orgId,
            entity_type: stageEntityType(amoPipelineId),
            amo_id: BigInt(amoStatusId),
          },
        },
        select: { local_id: true },
      }),
      db.amoEntityMap.findUnique({
        where: {
          organization_id_entity_type_amo_id: {
            organization_id: orgId,
            entity_type: PIPELINE_ENTITY_TYPE,
            amo_id: BigInt(amoPipelineId),
          },
        },
        select: { local_id: true },
      }),
    ]);
    if (!stage || !pipeline) return null;
    return { pipeline_id: pipeline.local_id, stage_id: stage.local_id };
  }

  // No pipeline supplied: resolvable only when this status id occurs in exactly
  // one funnel.
  const candidates = await db.amoEntityMap.findMany({
    where: { organization_id: orgId, entity_type: { startsWith: 'stage:' }, amo_id: BigInt(amoStatusId) },
    select: { entity_type: true, local_id: true },
    take: 2,
  });
  if (candidates.length !== 1) return null;

  const pipelineAmoId = amoPipelineIdFromEntityType(candidates[0].entity_type);
  if (pipelineAmoId === null) return null;
  const pipeline = await db.amoEntityMap.findUnique({
    where: {
      organization_id_entity_type_amo_id: {
        organization_id: orgId,
        entity_type: PIPELINE_ENTITY_TYPE,
        amo_id: BigInt(pipelineAmoId),
      },
    },
    select: { local_id: true },
  });
  if (!pipeline) return null;
  return { pipeline_id: pipeline.local_id, stage_id: candidates[0].local_id };
}

/** local `PipelineStage.id` → amo `{status_id, pipeline_id}`. */
export async function amoStatusForLocalStage(
  orgId: string,
  localStageId: string,
): Promise<{ status_id: number; pipeline_id: number } | null> {
  const row = await db.amoEntityMap.findFirst({
    where: { organization_id: orgId, local_id: localStageId, entity_type: { startsWith: 'stage:' } },
    select: { entity_type: true, amo_id: true },
  });
  if (!row) return null;

  const pipelineId = amoPipelineIdFromEntityType(row.entity_type);
  if (pipelineId === null) return null;
  return { status_id: Number(row.amo_id), pipeline_id: pipelineId };
}

// ─── Writing the funnel into 4КУБ ─────────────────────────────────────────────

interface OutboundLocalPipeline {
  id: string;
  name: string;
}

interface OutboundLocalStage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color: string | null;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  is_archived: boolean;
}

interface OutboundMappingDb {
  pipeline: {
    findFirst(args: unknown): Promise<OutboundLocalPipeline | null>;
  };
  pipelineStage: {
    findUnique(args: unknown): Promise<OutboundLocalStage | null>;
    findMany(args: unknown): Promise<OutboundLocalStage[]>;
  };
  amoEntityMap: DbLike['amoEntityMap'] & {
    findFirst(args: unknown): Promise<{ entity_type: string; amo_id: bigint; local_id: string } | null>;
  };
}

interface RemoteStatus {
  id: number;
  pipeline_id: number;
  name: string;
  request_id: string | null;
}

const outboundEnsureInFlight = new Map<string, Promise<{ status_id: number; pipeline_id: number }>>();

function wireObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function responseCollection(value: unknown, key: 'pipelines' | 'statuses'): unknown[] {
  const root = wireObject(value);
  const embedded = root ? wireObject(root._embedded) : null;
  const collection = embedded?.[key];
  if (!Array.isArray(collection)) {
    throw new Error(`amoCRM returned a malformed ${key} response`);
  }
  return collection;
}

function parseRemoteStatus(value: unknown, expectedPipelineId: number): RemoteStatus {
  const row = wireObject(value);
  const id = positiveInteger(row?.id);
  const pipelineId = positiveInteger(row?.pipeline_id);
  if (!row || id === null || pipelineId !== expectedPipelineId || typeof row.name !== 'string') {
    throw new Error('amoCRM returned a malformed pipeline status');
  }
  return {
    id,
    pipeline_id: pipelineId,
    name: row.name,
    request_id: typeof row.request_id === 'string' ? row.request_id : null,
  };
}

function normalizedStageName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function remoteSort(position: number): number {
  return Math.min(9_900, Math.max(10, (position + 1) * 100));
}

function outboundStatusPayload(stage: OutboundLocalStage): Record<string, unknown> {
  return { name: stage.name, sort: remoteSort(stage.position), request_id: stage.id };
}

async function mapOutboundStage(
  database: OutboundMappingDb,
  orgId: string,
  amoPipelineId: number,
  amoStatusId: number,
  localStageId: string,
): Promise<{ status_id: number; pipeline_id: number }> {
  await upsertMap(database as unknown as DbLike, orgId, stageEntityType(amoPipelineId), amoStatusId, localStageId);
  return { status_id: amoStatusId, pipeline_id: amoPipelineId };
}

function matchCreatedStatus(
  stages: RemoteStatus[],
  localStage: OutboundLocalStage,
  usedIds: Set<number>,
): RemoteStatus | null {
  const byRequestId = stages.filter((stage) => stage.request_id === localStage.id && !usedIds.has(stage.id));
  if (byRequestId.length === 1) return byRequestId[0];
  if (byRequestId.length > 1) throw new Error(`amoCRM returned duplicate request_id for stage ${localStage.id}`);

  // Some amoCRM shards omit request_id on statuses nested under a pipeline create.
  // Local stage names are unique per funnel, so a unique normalized-name fallback is safe.
  const wanted = normalizedStageName(localStage.name);
  const byName = stages.filter(
    (stage) => !usedIds.has(stage.id) && normalizedStageName(stage.name) === wanted,
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`amoCRM returned ambiguous statuses for stage ${localStage.id}`);
  return null;
}

async function createAndMapRemotePipeline(
  database: OutboundMappingDb,
  client: AmoClientLike,
  orgId: string,
  pipeline: OutboundLocalPipeline,
  localStages: OutboundLocalStage[],
): Promise<number> {
  const wonStages = localStages.filter((stage) => stage.is_won_stage);
  const lostStages = localStages.filter((stage) => stage.is_lost_stage);
  if (wonStages.length !== 1 || lostStages.length > 1 || localStages.some((stage) => stage.is_won_stage && stage.is_lost_stage)) {
    throw new Error(`local pipeline ${pipeline.id} has invalid terminal stage flags`);
  }

  // Official v4 accepts a batch array. New funnels always receive reserved
  // statuses 142/143; their ids in this payload only set the local labels.
  const statuses = localStages.map((stage) => stage.is_won_stage
    ? { id: AMO_STATUS_WON, name: stage.name }
    : stage.is_lost_stage
      ? { id: AMO_STATUS_LOST, name: stage.name }
      : outboundStatusPayload(stage));
  const response = await client.amoRequest(orgId, 'POST', '/api/v4/leads/pipelines', [{
    name: pipeline.name,
    sort: 100,
    is_main: false,
    is_unsorted_on: false,
    request_id: pipeline.id,
    _embedded: { statuses },
  }]);

  const created = responseCollection(response, 'pipelines');
  if (created.length !== 1) throw new Error('amoCRM did not return exactly one created pipeline');
  const remotePipeline = wireObject(created[0]);
  const amoPipelineId = positiveInteger(remotePipeline?.id);
  if (!remotePipeline || amoPipelineId === null) {
    throw new Error('amoCRM did not return an id for the created pipeline');
  }

  // Record the pipeline before validating its nested response. A retry can then
  // repair statuses rather than create a duplicate remote funnel.
  await upsertMap(database as unknown as DbLike, orgId, PIPELINE_ENTITY_TYPE, amoPipelineId, pipeline.id);

  const embedded = wireObject(remotePipeline._embedded);
  const remoteValues = embedded?.statuses;
  if (!Array.isArray(remoteValues)) throw new Error('amoCRM returned a pipeline without statuses');
  const remoteStages = remoteValues.map((status) => parseRemoteStatus(status, amoPipelineId));
  const usedIds = new Set<number>();
  const matched: Array<{ local: OutboundLocalStage; remote: RemoteStatus }> = [];

  for (const localStage of localStages) {
    const reserved = localStage.is_won_stage ? AMO_STATUS_WON : localStage.is_lost_stage ? AMO_STATUS_LOST : null;
    const remote = reserved === null
      ? matchCreatedStatus(remoteStages, localStage, usedIds)
      : remoteStages.find((stage) => stage.id === reserved) ?? null;
    if (!remote) throw new Error(`amoCRM omitted created status for local stage ${localStage.id}`);
    if (usedIds.has(remote.id)) throw new Error(`amoCRM reused status ${remote.id} in its create response`);
    usedIds.add(remote.id);
    matched.push({ local: localStage, remote });
  }

  // Validate the whole response first; never persist a partially guessed mapping.
  for (const { local, remote } of matched) {
    await mapOutboundStage(database, orgId, amoPipelineId, remote.id, local.id);
  }
  return amoPipelineId;
}

async function ensureAmoStatusForLocalStageInner(
  orgId: string,
  localStageId: string,
  client: AmoClientLike,
): Promise<{ status_id: number; pipeline_id: number }> {
  const existing = await amoStatusForLocalStage(orgId, localStageId);
  if (existing) return existing;

  const database = db as unknown as OutboundMappingDb;
  const localStage = await database.pipelineStage.findUnique({
    where: { id: localStageId },
    select: {
      id: true,
      pipeline_id: true,
      name: true,
      position: true,
      color: true,
      is_won_stage: true,
      is_lost_stage: true,
      is_archived: true,
    },
  });
  if (!localStage || localStage.is_archived) {
    throw new Error(`local stage ${localStageId} is missing or archived`);
  }
  const pipeline = await database.pipeline.findFirst({
    where: { id: localStage.pipeline_id, organization_id: orgId },
    select: { id: true, name: true },
  });
  if (!pipeline) throw new Error(`local stage ${localStageId} does not belong to organization ${orgId}`);

  const pipelineMap = await database.amoEntityMap.findFirst({
    where: { organization_id: orgId, entity_type: PIPELINE_ENTITY_TYPE, local_id: pipeline.id },
    select: { entity_type: true, amo_id: true, local_id: true },
  });

  let amoPipelineId: number;
  if (!pipelineMap) {
    const stages = await database.pipelineStage.findMany({
      where: { pipeline_id: pipeline.id, is_archived: false },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        pipeline_id: true,
        name: true,
        position: true,
        color: true,
        is_won_stage: true,
        is_lost_stage: true,
        is_archived: true,
      },
    });
    amoPipelineId = await createAndMapRemotePipeline(database, client, orgId, pipeline, stages);
    const mapped = await amoStatusForLocalStage(orgId, localStageId);
    if (!mapped) throw new Error(`created amoCRM pipeline ${amoPipelineId} but did not map stage ${localStageId}`);
    return mapped;
  }

  amoPipelineId = Number(pipelineMap.amo_id);
  if (!Number.isSafeInteger(amoPipelineId) || amoPipelineId <= 0) {
    throw new Error(`pipeline ${pipeline.id} has an invalid amoCRM mapping`);
  }

  if (localStage.is_won_stage || localStage.is_lost_stage) {
    if (localStage.is_won_stage && localStage.is_lost_stage) {
      throw new Error(`local stage ${localStage.id} cannot be both won and lost`);
    }
    return mapOutboundStage(
      database,
      orgId,
      amoPipelineId,
      localStage.is_won_stage ? AMO_STATUS_WON : AMO_STATUS_LOST,
      localStage.id,
    );
  }

  // Recovery/idempotency path: a previous POST may have succeeded while its
  // response was lost. Reuse a unique, still-unclaimed remote status by name.
  const listed = await client.amoRequest(orgId, 'GET', `/api/v4/leads/pipelines/${amoPipelineId}/statuses`);
  const remoteStages = responseCollection(listed, 'statuses').map((status) => parseRemoteStatus(status, amoPipelineId));
  const matching = remoteStages.filter((stage) =>
    stage.id !== AMO_STATUS_WON &&
    stage.id !== AMO_STATUS_LOST &&
    normalizedStageName(stage.name) === normalizedStageName(localStage.name),
  );
  const reusable: RemoteStatus[] = [];
  for (const candidate of matching) {
    const claimed = await database.amoEntityMap.findUnique({
      where: {
        organization_id_entity_type_amo_id: {
          organization_id: orgId,
          entity_type: stageEntityType(amoPipelineId),
          amo_id: BigInt(candidate.id),
        },
      },
      select: { local_id: true },
    });
    if (!claimed || claimed.local_id === localStage.id) reusable.push(candidate);
  }
  if (reusable.length === 1) {
    return mapOutboundStage(database, orgId, amoPipelineId, reusable[0].id, localStage.id);
  }
  if (reusable.length > 1) {
    throw new Error(`amoCRM has ambiguous unmapped statuses named "${localStage.name}"`);
  }

  const created = await client.amoRequest(
    orgId,
    'POST',
    `/api/v4/leads/pipelines/${amoPipelineId}/statuses`,
    [outboundStatusPayload(localStage)],
  );
  const createdStatuses = responseCollection(created, 'statuses').map((status) => parseRemoteStatus(status, amoPipelineId));
  const remote = matchCreatedStatus(createdStatuses, localStage, new Set());
  if (!remote || createdStatuses.length !== 1 || remote.id === AMO_STATUS_WON || remote.id === AMO_STATUS_LOST) {
    throw new Error(`amoCRM did not return the created status for local stage ${localStage.id}`);
  }
  return mapOutboundStage(database, orgId, amoPipelineId, remote.id, localStage.id);
}

/** Resolve a local stage for outbound sync, creating its remote funnel/status if needed. */
export async function ensureAmoStatusForLocalStage(
  orgId: string,
  localStageId: string,
  client: AmoClientLike,
): Promise<{ status_id: number; pipeline_id: number }> {
  const key = `${orgId}:${localStageId}`;
  const pending = outboundEnsureInFlight.get(key);
  if (pending) return pending;
  const operation = ensureAmoStatusForLocalStageInner(orgId, localStageId, client);
  outboundEnsureInFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    outboundEnsureInFlight.delete(key);
  }
}

export interface ApplyPlanResult {
  mapping: StageMapping;
  pipelines_created: number;
  pipelines_updated: number;
  stages_created: number;
  stages_updated: number;
  warnings: StagePlanWarning[];
}

interface DbLike {
  pipeline: {
    findUnique(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
    update(args: unknown): Promise<{ id: string }>;
  };
  pipelineStage: {
    findUnique(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
    update(args: unknown): Promise<{ id: string }>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  amoEntityMap: {
    findUnique(args: unknown): Promise<{ local_id: string } | null>;
    findMany(args: unknown): Promise<Array<{ entity_type: string; amo_id: bigint; local_id: string }>>;
    upsert(args: unknown): Promise<unknown>;
  };
}

/** True for the P2002 raised by the two partial unique indexes on PipelineStage. */
export function isTerminalStageConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const joined = (Array.isArray(target) ? target.join(',') : String(target ?? '')).toLowerCase();
  return joined.includes('won') || joined.includes('lost');
}

/**
 * Creates (or refreshes) the local Pipeline/PipelineStage rows for an amo account
 * and records every one of them in `AmoEntityMap`.
 *
 * Idempotent: the bridge row is consulted first, so a second run updates the same
 * local rows instead of building a parallel set of funnels.
 */
export async function applyPipelinePlan(
  orgId: string,
  userId: string | null,
  plan: PipelineImportPlan,
  client: DbLike = db as unknown as DbLike,
): Promise<ApplyPlanResult> {
  const result: ApplyPlanResult = {
    mapping: emptyStageMapping(),
    pipelines_created: 0,
    pipelines_updated: 0,
    stages_created: 0,
    stages_updated: 0,
    warnings: [...plan.warnings],
  };

  for (const planned of plan.pipelines) {
    const pipelineMap = await client.amoEntityMap.findUnique({
      where: {
        organization_id_entity_type_amo_id: {
          organization_id: orgId,
          entity_type: PIPELINE_ENTITY_TYPE,
          amo_id: BigInt(planned.amo_pipeline_id),
        },
      },
      select: { local_id: true },
    });

    let localPipelineId: string;
    const existing = pipelineMap
      ? await client.pipeline.findUnique({ where: { id: pipelineMap.local_id }, select: { id: true } })
      : null;

    if (existing) {
      await client.pipeline.update({ where: { id: existing.id }, data: { name: planned.name } });
      localPipelineId = existing.id;
      result.pipelines_updated++;
    } else {
      const created = await client.pipeline.create({
        data: {
          organization_id: orgId,
          name: planned.name,
          description: `Импортировано из amoCRM (воронка ${planned.amo_pipeline_id})`,
          // Never steals is_default from the org's own funnel: an import must not
          // move where new deals land for people who are still working locally.
          is_default: false,
          created_by: userId ?? undefined,
        },
        select: { id: true },
      });
      localPipelineId = created.id;
      result.pipelines_created++;
    }

    await upsertMap(client, orgId, PIPELINE_ENTITY_TYPE, planned.amo_pipeline_id, localPipelineId);
    result.mapping.pipelineByAmo.set(planned.amo_pipeline_id, localPipelineId);
    result.mapping.amoByPipeline.set(localPipelineId, planned.amo_pipeline_id);

    // Clear both terminal flags across the funnel BEFORE reassigning them. On a
    // re-import where the won stage moved (amo renamed/reordered its statuses),
    // setting the new one while the old one still holds the flag trips the
    // partial unique index; wiping first makes the reassignment always legal.
    await client.pipelineStage.updateMany({
      where: { pipeline_id: localPipelineId },
      data: { is_won_stage: false, is_lost_stage: false },
    });

    const entityType = stageEntityType(planned.amo_pipeline_id);

    for (const stage of planned.stages) {
      const stageMap = await client.amoEntityMap.findUnique({
        where: {
          organization_id_entity_type_amo_id: {
            organization_id: orgId,
            entity_type: entityType,
            amo_id: BigInt(stage.amo_status_id),
          },
        },
        select: { local_id: true },
      });

      const data = {
        name: stage.name,
        position: stage.position,
        color: stage.color ?? undefined,
        is_won_stage: stage.is_won_stage,
        is_lost_stage: stage.is_lost_stage,
      };

      let localStageId: string | null = null;
      const existingStage = stageMap
        ? await client.pipelineStage.findUnique({ where: { id: stageMap.local_id }, select: { id: true } })
        : null;

      try {
        if (existingStage) {
          await client.pipelineStage.update({ where: { id: existingStage.id }, data });
          localStageId = existingStage.id;
          result.stages_updated++;
        } else {
          const created = await client.pipelineStage.create({
            data: { pipeline_id: localPipelineId, ...data },
            select: { id: true },
          });
          localStageId = created.id;
          result.stages_created++;
        }
      } catch (err) {
        // Backstop for the case the plan cannot see: a local pipeline that already
        // carried a won/lost stage from somewhere other than this import. Retry
        // once with the flags cleared rather than aborting the whole funnel —
        // losing a flag costs a report column, losing the funnel costs every lead.
        if (!isTerminalStageConflict(err)) throw err;
        result.warnings.push({
          code: 'DUPLICATE_TERMINAL_STATUS',
          amo_pipeline_id: planned.amo_pipeline_id,
          amo_status_id: stage.amo_status_id,
          stage_name: stage.name,
          flag: stage.is_won_stage ? 'won' : 'lost',
          message:
            `Этап «${stage.name}» импортирован без признака завершения: ` +
            'в этой воронке такой этап уже есть.',
        });
        const relaxed = { ...data, is_won_stage: false, is_lost_stage: false };
        if (existingStage) {
          await client.pipelineStage.update({ where: { id: existingStage.id }, data: relaxed });
          localStageId = existingStage.id;
          result.stages_updated++;
        } else {
          const created = await client.pipelineStage.create({
            data: { pipeline_id: localPipelineId, ...relaxed },
            select: { id: true },
          });
          localStageId = created.id;
          result.stages_created++;
        }
      }

      if (!localStageId) continue;
      await upsertMap(client, orgId, entityType, stage.amo_status_id, localStageId);
      result.mapping.stageByAmo.set(stageKey(planned.amo_pipeline_id, stage.amo_status_id), localStageId);
      result.mapping.amoByStage.set(localStageId, {
        amo_pipeline_id: planned.amo_pipeline_id,
        amo_status_id: stage.amo_status_id,
      });
    }
  }

  return result;
}

async function upsertMap(
  client: DbLike,
  orgId: string,
  entityType: string,
  amoId: number,
  localId: string,
): Promise<void> {
  await client.amoEntityMap.upsert({
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
    },
    update: { local_id: localId, last_synced_at: new Date() },
  });
}

/**
 * One call: read the funnels out of amoCRM, plan them, write them, return the
 * mapping. This is what both the importer and the "connect account" flow use.
 */
export async function syncPipelinesFromAmo(
  client: AmoClientLike,
  orgId: string,
  userId: string | null,
): Promise<ApplyPlanResult & { plan: PipelineImportPlan }> {
  const pipelines = await fetchAmoPipelines(client, orgId);
  const plan = planPipelineImport(pipelines);
  // Clearing the old won/lost flags and assigning the new ones must be one visible change.
  // Without a transaction, a failed import can leave reporting with no terminal stage at all.
  const transaction = (db as unknown as {
    $transaction?: <T>(fn: (tx: unknown) => Promise<T>, options?: unknown) => Promise<T>;
  }).$transaction;
  const applied: ApplyPlanResult = transaction
    ? await (transaction as (
        fn: (tx: unknown) => Promise<ApplyPlanResult>,
        options?: unknown,
      ) => Promise<ApplyPlanResult>).call(
        db,
        (tx: unknown) => applyPipelinePlan(orgId, userId, plan, tx as DbLike),
        { timeout: 60_000, maxWait: 10_000 },
      )
    : await applyPipelinePlan(orgId, userId, plan);
  return { ...applied, plan };
}
