// The parts of an amoCRM account that amo-import-readonly.ts does not carry:
// amo users who own nothing (as inactive placeholders), files attached to deals /
// contacts / companies, and the event history (stage moves, reassignments, field
// edits…) as each record's activity log.
//
// Reads amoCRM ONLY with GET (file downloads); everything else comes from data
// already pulled read-only:
//   --snapshot      amo-snapshot-*.json written by amo-import-readonly.ts (one JSON)
//   --files-list    JSON array of /v1.0/files records from the account's drive
//   --entity-files  JSONL of {t, id, files:[file_uuid]} from GET /api/v4/<t>/<id>/files
//   --events        JSONL of /api/v4/events records
//
// Usage (from the repo root; prod env from .env.localprod, LOCAL_STORAGE_DIR set):
//   npx tsx scripts/amo-import-extras.ts --org <uuid> --user <owner uuid> \
//     --amo-env AMO_KOMANDAR --snapshot … --files-list … --entity-files … --events … \
//     [--only managers,files,history] [--dry]
//
// Re-run safe: users and file attachments are keyed in AmoEntityMap, history rows
// carry their amo event id and a re-run replaces the org's amo history wholesale.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const ORG_ID = arg('org');
const USER_ID = arg('user');
const AMO_ENV = arg('amo-env');
const DRY = process.argv.includes('--dry');
const ONLY = new Set((arg('only') ?? 'managers,files,history').split(','));
if (!ORG_ID || !USER_ID || !AMO_ENV) throw new Error('required: --org --user --amo-env');

const ENV_ROOT = process.env.CRM_ENV_ROOT ?? 'D:/crm';
function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
Object.assign(process.env, readEnv(path.join(ENV_ROOT, '.env.localprod')));
if (!process.env.DATABASE_URL?.includes('/crm_prod')) throw new Error('DATABASE_URL is not crm_prod');
const appEnv = readEnv(path.join(ENV_ROOT, '.env'));
const TOKEN = appEnv[`${AMO_ENV}_TOKEN`];
if (!TOKEN) throw new Error(`${AMO_ENV}_TOKEN missing in .env`);

const readJsonl = (file: string): any[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; } // a line cut by a killed writer
  });

// ── amo → 4КУБ lookups ─────────────────────────────────────────────────────────
let db: any;
const mapCache = new Map<string, Map<number, string>>();
async function mapOf(entityType: string): Promise<Map<number, string>> {
  let m = mapCache.get(entityType);
  if (!m) {
    const rows = await db.amoEntityMap.findMany({
      where: { organization_id: ORG_ID, entity_type: entityType },
      select: { amo_id: true, local_id: true },
    });
    m = new Map(rows.map((r: any) => [Number(r.amo_id), r.local_id as string]));
    mapCache.set(entityType, m);
  }
  return m;
}

type Target = { entity_type: 'deal' | 'contact' | 'task' | 'calendar_event'; entity_id: string };

/** Where an amo lead/contact/company/task lands in 4КУБ; companies → their first contact, else first deal. */
async function resolve(snap: any, amoType: string, amoId: number): Promise<Target | null> {
  const t = amoType.replace(/s$/, '');
  if (t === 'lead') {
    const id = (await mapOf('lead')).get(amoId);
    return id ? { entity_type: 'deal', entity_id: id } : null;
  }
  if (t === 'contact') {
    const id = (await mapOf('contact')).get(amoId);
    return id ? { entity_type: 'contact', entity_id: id } : null;
  }
  if (t === 'task') {
    const id = (await mapOf('task')).get(amoId);
    if (id) return { entity_type: 'task', entity_id: id };
    const ev = (await mapOf('meeting')).get(amoId);
    return ev ? { entity_type: 'calendar_event', entity_id: ev } : null;
  }
  if (t === 'company') {
    const company = companiesById(snap).get(amoId);
    for (const c of company?._embedded?.contacts ?? []) {
      const id = (await mapOf('contact')).get(c.id);
      if (id) return { entity_type: 'contact', entity_id: id };
    }
    for (const l of company?._embedded?.leads ?? []) {
      const id = (await mapOf('lead')).get(l.id);
      if (id) return { entity_type: 'deal', entity_id: id };
    }
  }
  return null;
}
let companiesIndex: Map<number, any> | null = null;
function companiesById(snap: any): Map<number, any> {
  return (companiesIndex ??= new Map((snap.companies ?? []).map((c: any) => [c.id, c])));
}

// ── managers ───────────────────────────────────────────────────────────────────
/** amo user id → 4КУБ user id: existing members by email, placeholders by map. */
async function userMap(snap: any): Promise<Map<number, string>> {
  const local = await db.user.findMany({ where: { organization_id: ORG_ID }, select: { id: true, email: true } });
  const byEmail = new Map(local.filter((u: any) => u.email).map((u: any) => [String(u.email).toLowerCase(), u.id]));
  const out = new Map<number, string>();
  for (const u of snap.users) {
    const id = typeof u.email === 'string' ? byEmail.get(u.email.trim().toLowerCase()) : undefined;
    if (id) out.set(u.id, id);
  }
  for (const [amo, id] of await mapOf('user')) out.set(amo, id);
  // The amo profile the import was authorised with is the owner's own login.
  const current = snap.account?.current_user_id;
  if (typeof current === 'number' && !out.has(current)) out.set(current, USER_ID!);
  return out;
}

async function importManagers(snap: any): Promise<void> {
  const bcrypt = (await import('bcryptjs')).default;
  const known = await userMap(snap);
  const missing = snap.users.filter((u: any) => !known.has(u.id));
  console.log(`managers: ${snap.users.length} in amo, ${known.size} already here, ${missing.length} to add`);
  for (const u of missing) {
    console.log(`  + ${u.name} (${u.rights?.is_active ? 'active' : 'inactive'} in amo)`);
    if (DRY) continue;
    // No email and an unguessable password: a name on the records, never a login.
    const created = await db.user.create({
      data: {
        organization_id: ORG_ID,
        name: String(u.name || `amoCRM ${u.id}`),
        password_hash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        role: 'member',
        is_active: false,
        manager_id: USER_ID,
      },
      select: { id: true },
    });
    await db.amoEntityMap.create({
      data: { organization_id: ORG_ID, entity_type: 'user', amo_id: BigInt(u.id), local_id: created.id },
    });
  }
  mapCache.delete('user');
}

// ── files ──────────────────────────────────────────────────────────────────────
async function importFiles(snap: any, filesList: any[], entityFiles: any[]): Promise<void> {
  const { getPublicUrl, localPathForKey } = await import(new URL('../backend/services/storage.ts', import.meta.url).href);
  if (!process.env.LOCAL_STORAGE_DIR) throw new Error('LOCAL_STORAGE_DIR is not set');
  const users = await userMap(snap);

  const links = new Map<string, Array<{ t: string; id: number }>>();
  for (const r of entityFiles) for (const f of r.files ?? []) {
    if (!links.has(f)) links.set(f, []);
    links.get(f)!.push({ t: r.t, id: r.id });
  }
  const attached = await mapOf('file'); // amo file id → one attachment id (first target)
  const stats = { files: filesList.length, linked: 0, unlinked: 0, attachments: 0, skipped_existing: 0, bytes: 0, unresolved: 0 };
  const unlinked: string[] = [];

  for (const f of filesList) {
    const targets = links.get(f.uuid) ?? [];
    if (!targets.length) { stats.unlinked++; unlinked.push(f.name); continue; }
    stats.linked++;
    const ext = f.metadata?.extension ? `.${String(f.metadata.extension).replace(/[^A-Za-z0-9]/g, '')}` : '';
    const filename = String(f.name).toLowerCase().endsWith(ext.toLowerCase()) ? String(f.name) : `${f.name}${ext}`;

    const resolved: Target[] = [];
    for (const t of targets) {
      const r = await resolve(snap, t.t, t.id);
      if (r && !resolved.some((x) => x.entity_id === r.entity_id)) resolved.push(r);
    }
    if (!resolved.length) { stats.unresolved++; continue; }
    if (attached.has(Number(f.id))) { stats.skipped_existing++; continue; }

    // Deterministic key: the amo file uuid is already a uuid, so a re-run finds the bytes.
    const safe = String(f.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const key = `uploads/${ORG_ID}/${resolved[0].entity_type}/${f.uuid}-${safe}${ext}`;
    const full = localPathForKey(key);
    if (!DRY && !fs.existsSync(full)) {
      const res = await fetch(f._links.download.href, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!res.ok || !res.body) throw new Error(`download ${f.uuid}: ${res.status}`);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(`${full}.part`));
      await fs.promises.rename(`${full}.part`, full);
    }
    stats.bytes += Number(f.size ?? 0);
    if (DRY) { stats.attachments += resolved.length; continue; }

    const createdBy = typeof f.created_by?.id === 'number' ? users.get(f.created_by.id) : undefined;
    let first: string | null = null;
    for (const r of resolved) {
      const a = await db.attachment.create({
        data: {
          organization_id: ORG_ID,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          filename,
          file_url: getPublicUrl(key),
          size: Number(f.size ?? 0) || null,
          mime_type: f.metadata?.mime_type ?? null,
          uploaded_by: createdBy ?? USER_ID,
          created_at: new Date(f.created_at * 1000),
        },
        select: { id: true },
      });
      first ??= a.id;
      stats.attachments++;
    }
    await db.amoEntityMap.create({
      data: { organization_id: ORG_ID, entity_type: 'file', amo_id: BigInt(f.id), local_id: first! },
    });
  }
  console.log('files:', JSON.stringify({ ...stats, MB: (stats.bytes / 1e6).toFixed(1) }));
  if (unlinked.length) console.log(`  not attached to any deal/contact/company in amo (${unlinked.length}):`, unlinked.slice(0, 20).join(' | '));
}

// ── history ────────────────────────────────────────────────────────────────────
const STATUS_WON = 142;
const STATUS_LOST = 143;
const SKIP = new Set([
  // Already in 4КУБ as messages (calls, notes) or as the task itself.
  'incoming_call', 'outgoing_call', 'common_note_added', 'common_note_deleted',
  'task_result_added', 'geo_note_added', 'service_note_added', 'attachment_note_added',
]);

function short(s: unknown, n = 40): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

function describeEvent(e: any, names: { status: Map<number, string>; user: Map<number, string>; field: Map<number, string> }): string | null {
  const a = e.value_after?.[0] ?? {};
  const b = e.value_before?.[0] ?? {};
  switch (e.type) {
    case 'lead_added':
    case 'contact_added':
    case 'company_added':
    case 'task_added':
      return 'created';
    case 'lead_deleted': case 'contact_deleted': case 'company_deleted': case 'task_deleted':
      return 'Удалено в amoCRM';
    case 'lead_restored': case 'contact_restored': case 'company_restored':
      return 'Восстановлено';
    case 'lead_status_changed': {
      const id = a.lead_status?.id;
      if (id === STATUS_WON) return 'won';
      if (id === STATUS_LOST) return 'lost';
      // A stage (or whole pipeline) deleted in amo is gone from its API; amo's own
      // feed shows it as deleted too.
      return `Этап: ${short(names.status.get(id) ?? '(удалён в amoCRM)', 32)}`;
    }
    case 'entity_responsible_changed':
      return `Ответственный: ${short(names.user.get(a.responsible_user?.id) ?? a.responsible_user?.id)}`;
    case 'name_field_changed':
      return `Название: ${short(a.name_field_value?.name)}`;
    case 'sale_field_changed':
      return `Бюджет: ${Number(a.sale_field_value?.sale ?? 0).toLocaleString('ru-RU')} ₽`;
    case 'entity_tag_added':
      return `Тег: +${short(a.tag?.name, 30)}`;
    case 'entity_tag_deleted':
      return `Тег: −${short(b.tag?.name, 30)}`;
    case 'entity_linked': {
      const t = a.link?.entity?.type;
      return t === 'contact' ? 'Привязан контакт' : t === 'lead' ? 'Привязана сделка' : t === 'company' ? 'Привязана компания' : 'Привязка';
    }
    case 'entity_unlinked': {
      const t = b.link?.entity?.type;
      return t === 'contact' ? 'Отвязан контакт' : t === 'lead' ? 'Отвязана сделка' : t === 'company' ? 'Отвязана компания' : 'Отвязка';
    }
    case 'task_completed':
      return 'Выполнена';
    case 'task_text_changed':
      return 'Текст задачи изменён';
    case 'task_deadline_changed':
      return a.task_deadline?.timestamp ? `Срок: ${day(a.task_deadline.timestamp)}` : 'Срок изменён';
    case 'task_type_changed':
      return 'Тип задачи изменён';
    case 'incoming_chat_message':
      return 'Входящее сообщение (чат)';
    case 'outgoing_chat_message':
      return 'Исходящее сообщение (чат)';
    case 'incoming_sms':
      return 'Входящее SMS';
    case 'outgoing_sms':
      return 'Исходящее SMS';
    case 'incoming_lead':
      return 'Входящая заявка';
    case 'entity_direct_message':
      return 'Сообщение';
  }
  const m = /^custom_field_(\d+)_value_changed$/.exec(e.type);
  if (m) {
    const field = names.field.get(Number(m[1])) ?? 'Поле';
    const v = a.custom_field_value;
    const text = v?.text ?? (Array.isArray(e.value_after) && e.value_after.length === 0 ? '—' : '');
    return text ? `${short(field, 24)}: ${short(text, 32)}` : `${short(field, 30)} изменено`;
  }
  return null;
}

async function importHistory(snap: any, events: any[]): Promise<void> {
  const users = await userMap(snap);
  const names = {
    status: new Map<number, string>(),
    user: new Map<number, string>(snap.users.map((u: any) => [u.id, u.name])),
    field: new Map<number, string>(),
  };
  for (const p of snap.pipelines) for (const s of p._embedded?.statuses ?? []) names.status.set(s.id, s.name);
  for (const f of [...snap.lead_fields, ...snap.contact_fields, ...snap.company_fields]) names.field.set(f.id, f.name);

  const rows: any[] = [];
  const stats: Record<string, number> = { events: events.length, rows: 0, skipped_type: 0, no_target: 0, unknown_type: 0 };
  const unknown: Record<string, number> = {};
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue; // page drift can repeat an event
    seen.add(e.id);
    if (SKIP.has(e.type)) { stats.skipped_type++; continue; }
    const action = describeEvent(e, names);
    if (!action) { stats.unknown_type++; unknown[e.type] = (unknown[e.type] ?? 0) + 1; continue; }
    const target = await resolve(snap, e.entity_type, e.entity_id);
    if (!target) { stats.no_target++; continue; }
    rows.push({
      organization_id: ORG_ID,
      user_id: typeof e.created_by === 'number' ? users.get(e.created_by) ?? null : null,
      entity_type: target.entity_type,
      entity_id: target.entity_id,
      action,
      changes: { source: 'amocrm', amo_event_id: e.id, type: e.type, before: e.value_before ?? [], after: e.value_after ?? [] },
      created_at: new Date(e.created_at * 1000),
    });
  }
  stats.rows = rows.length;
  console.log('history:', JSON.stringify(stats));
  if (Object.keys(unknown).length) console.log('  event types not carried:', JSON.stringify(unknown));
  if (DRY) return;

  // Wholesale replace of this org's amo-sourced history, then insert in batches.
  const removed = await db.activityLog.deleteMany({
    where: { organization_id: ORG_ID, changes: { path: ['source'], equals: 'amocrm' } },
  });
  if (removed.count) console.log(`  replaced ${removed.count} earlier amo history rows`);
  for (let i = 0; i < rows.length; i += 5000) {
    await db.activityLog.createMany({ data: rows.slice(i, i + 5000) });
  }
}

async function main() {
  ({ db } = await import(new URL('../backend/services/db.ts', import.meta.url).href));
  const owner = await db.user.findUnique({ where: { id: USER_ID }, select: { organization_id: true, role: true } });
  if (owner?.organization_id !== ORG_ID || owner.role !== 'owner') throw new Error('--user is not the owner of --org');
  if (await db.amoIntegration.count({ where: { organization_id: ORG_ID } })) throw new Error('org has an AmoIntegration row — aborting');

  const snap = JSON.parse(fs.readFileSync(arg('snapshot')!, 'utf8'));
  if (ONLY.has('managers')) await importManagers(snap);
  if (ONLY.has('files')) {
    await importFiles(snap, JSON.parse(fs.readFileSync(arg('files-list')!, 'utf8')), readJsonl(arg('entity-files')!));
  }
  if (ONLY.has('history')) await importHistory(snap, readJsonl(arg('events')!));
  console.log(DRY ? '(dry run — nothing written)' : 'done');
  await db.$disconnect();
}
main().catch((e) => { console.error('✗', e?.message ?? e); process.exit(1); });
