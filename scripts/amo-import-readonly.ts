// Copy an amoCRM account into one 4КУБ organization WITHOUT touching amoCRM.
//
// Runs the real importer (backend/services/amocrm/import.ts) with an injected client
// that can only send GET: any other method throws before it leaves the process. No
// AmoIntegration row is created, so the API's outbound sync (fireAmoOutbound →
// 'no_integration') and webhooks never engage — edits made in 4КУБ afterwards cannot
// flow back. Proof, printed at the end: every request is logged, and the whole
// account is snapshotted before and after and compared section by section.
//
// Usage (from the repo root):
//   npx tsx scripts/amo-import-readonly.ts --org <uuid> --user <uuid> \
//     --amo-env AMO_KOMANDAR --out <dir outside the repo> [--dry]
//
//   --amo-env  prefix of two lines in .env: <prefix>_SUBDOMAIN and <prefix>_TOKEN
//   --user-map amoUserId=4kubUserId[,…] for people whose email differs between systems
//   --dry      snapshots only: reads amoCRM twice and compares; writes nothing to 4КУБ
//   --out      where snapshots go. They hold the customer's personal data — keep them
//              out of the repo and delete them when done.
//
// Env: the database and encryption keys come from .env.localprod (prod) — the rows
// must be encrypted with the keys the prod API decrypts with.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const ORG_ID = arg('org');
const USER_ID = arg('user');
const AMO_ENV = arg('amo-env');
const OUT = arg('out');
const DRY = process.argv.includes('--dry');
const USER_MAP: Record<number, string> = Object.fromEntries(
  (arg('user-map') ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [amo, local] = pair.split('=');
      if (!/^\d+$/.test(amo) || !/^[0-9a-f-]{36}$/.test(local ?? '')) throw new Error(`bad --user-map entry: ${pair}`);
      return [Number(amo), local];
    }),
);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const ENV_ROOT = process.env.CRM_ENV_ROOT ?? 'D:/crm'; // .env files are not in git worktrees
if (!ORG_ID || !USER_ID || !AMO_ENV || !OUT) {
  throw new Error('required: --org --user --amo-env --out');
}
if (path.resolve(OUT).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase())) {
  throw new Error('--out must be outside the repo: snapshots contain personal data');
}
fs.mkdirSync(OUT, { recursive: true });

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
const SUBDOMAIN = appEnv[`${AMO_ENV}_SUBDOMAIN`];
const TOKEN = appEnv[`${AMO_ENV}_TOKEN`];
if (!SUBDOMAIN || !/^[a-z0-9-]+$/.test(SUBDOMAIN) || !TOKEN) throw new Error(`${AMO_ENV}_SUBDOMAIN / _TOKEN missing in .env`);
const BASE = `https://${SUBDOMAIN}.amocrm.ru`;

// ── the GET-only transport ─────────────────────────────────────────────────────
const requestLog: string[] = [];
let last = 0;
async function get(p: string, attempt = 0): Promise<any> {
  // ≤ 6 req/s: under amoCRM's 7/s ceiling, whose repeated breach blocks the account's API.
  const wait = last + 170 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  let res: Response;
  try {
    res = await fetch(BASE + p, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
  } catch (err) {
    // A dropped connection on a 10 000+ request run is expected, not fatal. GETs are
    // safe to repeat; back off and retry rather than abandon an hour's work.
    requestLog.push(`GET ${p} -> network error (attempt ${attempt + 1})`);
    if (attempt >= 6) throw err;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return get(p, attempt + 1);
  }
  requestLog.push(`GET ${p} -> ${res.status}`);
  if (res.status === 204) return null;
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return get(p, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${p} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
function qs(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
const readOnlyClient = {
  async amoRequest(_org: string, method: string, p: string, body?: unknown) {
    if (method !== 'GET' || body !== undefined) {
      requestLog.push(`BLOCKED ${method} ${p}`);
      throw new Error(`read-only: refused ${method} ${p}`);
    }
    return get(p);
  },
  async *paginate(_org: string, p: string, params: Record<string, unknown> = {}) {
    for (let page = Number(params.page) || 1; ; page++) {
      const r = await get(`${p}${p.includes('?') ? '&' : '?'}${qs({ ...params, limit: params.limit ?? 250, page })}`);
      const emb = r?._embedded ?? {};
      const key = Object.keys(emb).find((k) => Array.isArray(emb[k]));
      const items = key ? emb[key] : [];
      if (items.length) yield items;
      if (!r?._links?.next || !items.length) return;
    }
  },
};

// ── full account snapshot ──────────────────────────────────────────────────────
async function all(p: string) {
  const out: any[] = [];
  for await (const b of readOnlyClient.paginate('', p)) out.push(...b);
  return out;
}
async function snapshot() {
  const pipelines = (await get('/api/v4/leads/pipelines'))?._embedded?.pipelines ?? [];
  // Unsorted leads are absent from an unfiltered /leads; read them per unsorted status.
  const unsorted: any[] = [];
  for (const p of pipelines) {
    for (const s of p._embedded?.statuses ?? []) {
      if (s.type !== 1) continue;
      for await (const b of readOnlyClient.paginate('', '/api/v4/leads', {
        with: 'contacts',
        'filter[statuses][0][pipeline_id]': p.id,
        'filter[statuses][0][status_id]': s.id,
      })) unsorted.push(...b);
    }
  }
  return {
    account: await get('/api/v4/account?with=amojo_id,version,datetime_settings,task_types'),
    users: await all('/api/v4/users'),
    pipelines,
    loss_reasons: (await get('/api/v4/leads/loss_reasons'))?._embedded?.loss_reasons ?? [],
    lead_fields: await all('/api/v4/leads/custom_fields'),
    contact_fields: await all('/api/v4/contacts/custom_fields'),
    company_fields: await all('/api/v4/companies/custom_fields'),
    companies: await all('/api/v4/companies?with=contacts,leads'),
    contacts: await all('/api/v4/contacts?with=leads,companies'),
    leads: await all('/api/v4/leads?with=contacts,companies,loss_reason'),
    unsorted_leads: unsorted,
    lead_notes: await all('/api/v4/leads/notes'),
    contact_notes: await all('/api/v4/contacts/notes'),
    company_notes: await all('/api/v4/companies/notes'),
    tasks: await all('/api/v4/tasks'),
    tags_leads: await all('/api/v4/leads/tags'),
    tags_contacts: await all('/api/v4/contacts/tags'),
    webhooks: (await get('/api/v4/webhooks'))?._embedded?.webhooks ?? [],
  };
}
function strip(o: unknown) {
  // `_links` echo the request URL (page/limit) and are not data.
  return JSON.parse(JSON.stringify(o, (k, v) => (k === '_links' ? undefined : v)));
}
function changedSections(a: Record<string, unknown>, b: Record<string, unknown>) {
  return Object.keys(a).filter((k) => {
    // /api/v4/account echoes the server clock in created_at/updated_at on every read.
    const norm = (v: any) => (k === 'account' ? { ...v, created_at: 0, updated_at: 0 } : v);
    return JSON.stringify(strip(norm(a[k]))) !== JSON.stringify(strip(norm(b[k])));
  });
}
const sizes = (s: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.length : '·']));

async function localCounts(db: any) {
  const q = (t: string) =>
    db.$queryRawUnsafe(`SELECT count(*)::int n FROM "${t}" WHERE organization_id = $1::uuid`, ORG_ID).then((r: any) => r[0].n);
  const out: Record<string, number> = {};
  for (const t of ['Contact', 'Deal', 'Pipeline', 'Task', 'CalendarEvent', 'Message', 'AmoIntegration', 'AmoSyncJob', 'AmoEntityMap']) out[t] = await q(t);
  return out;
}

function summarize(s: any) {
  const byPipeline: Record<string, number> = {};
  const names = new Map<number, string>();
  for (const p of s.pipelines) names.set(p.id, p.name);
  for (const l of [...s.leads, ...s.unsorted_leads]) {
    const n = names.get(l.pipeline_id) ?? String(l.pipeline_id);
    byPipeline[n] = (byPipeline[n] ?? 0) + 1;
  }
  const noteTypes: Record<string, number> = {};
  for (const n of [...s.lead_notes, ...s.contact_notes, ...s.company_notes]) noteTypes[n.note_type] = (noteTypes[n.note_type] ?? 0) + 1;
  const ts = (xs: any[], k: string) => xs.map((x) => x[k]).filter((v) => typeof v === 'number');
  const range = (xs: number[]) => (xs.length ? `${new Date(Math.min(...xs) * 1000).toISOString().slice(0, 10)} … ${new Date(Math.max(...xs) * 1000).toISOString().slice(0, 10)}` : '—');
  const now = Date.now() / 1000;
  return {
    account: { id: s.account.id, name: s.account.name, currency: s.account.currency },
    users: s.users.map((u: any) => ({ id: u.id, name: u.name, email_domain: String(u.email ?? '').split('@')[1] ?? '', admin: u.rights?.is_admin, active: u.rights?.is_active })),
    pipelines: s.pipelines.map((p: any) => `${p.name}${p.is_archive ? ' (архив)' : ''}: ${(p._embedded?.statuses ?? []).length} этапов`),
    deals_by_pipeline: byPipeline,
    deals_created: range(ts(s.leads, 'created_at')),
    contacts_created: range(ts(s.contacts, 'created_at')),
    tasks: {
      total: s.tasks.length,
      open_overdue: s.tasks.filter((t: any) => !t.is_completed && t.complete_till < now).length,
      open_upcoming: s.tasks.filter((t: any) => !t.is_completed && t.complete_till >= now).length,
      done: s.tasks.filter((t: any) => t.is_completed).length,
      by_type: s.tasks.reduce((a: any, t: any) => ((a[t.task_type_id] = (a[t.task_type_id] ?? 0) + 1), a), {}),
    },
    note_types: noteTypes,
    custom_fields: { leads: s.lead_fields.length, contacts: s.contact_fields.length, companies: s.company_fields.length },
    webhooks: s.webhooks.length,
  };
}

async function main() {
  const { db } = await import(new URL('../backend/services/db.ts', import.meta.url).href);
  const owner = await db.user.findUnique({ where: { id: USER_ID }, select: { organization_id: true, role: true } });
  if (owner?.organization_id !== ORG_ID || owner.role !== 'owner') throw new Error('--user is not the owner of --org');

  const localBefore = await localCounts(db);
  console.log('4КУБ before:', localBefore);
  if (localBefore.AmoIntegration !== 0) throw new Error('org has an AmoIntegration row (two-way sync) — aborting');

  const before = await snapshot();
  fs.writeFileSync(path.join(OUT!, 'amo-snapshot-before.json'), JSON.stringify(before));
  console.log('amoCRM sizes:', sizes(before));
  const summary = summarize(before);
  fs.writeFileSync(path.join(OUT!, 'amo-summary.json'), JSON.stringify(summary, null, 2));
  console.log('amoCRM summary:', JSON.stringify(summary, null, 2));

  if (!DRY) {
    const { importFromAmo } = await import(new URL('../backend/services/amocrm/import.ts', import.meta.url).href);
    let cursor: any;
    for (let run = 1; run <= 50; run++) {
      const r = await importFromAmo(ORG_ID, USER_ID, { client: readOnlyClient as any, cursor, user_map: USER_MAP });
      const { warnings, cursor: c, ...counts } = r;
      console.log(`import run ${run}:`, counts);
      if (warnings.length) console.log('warnings:', warnings.map((w: any) => w.message));
      if (!r.partial) break;
      cursor = c;
    }
  }

  const after = await snapshot();
  fs.writeFileSync(path.join(OUT!, 'amo-snapshot-after.json'), JSON.stringify(after));
  const changed = changedSections(before, after);
  const localAfter = await localCounts(db);
  console.log('4КУБ after:', localAfter);

  const writes = requestLog.filter((l) => !l.startsWith('GET '));
  fs.writeFileSync(path.join(OUT!, 'amo-requests.log'), requestLog.join('\n'));
  console.log(`\namoCRM requests: ${requestLog.length} total, ${writes.length} non-GET ${writes.join('; ')}`);
  console.log(changed.length ? `✗ amoCRM differs in: ${changed.join(', ')}` : '✓ amoCRM snapshot before == after (every section identical)');
  console.log(localAfter.AmoIntegration === 0 && localAfter.AmoSyncJob === 0
    ? '✓ no AmoIntegration row and no sync jobs — nothing can sync back'
    : '✗ integration/sync rows present!');
  await db.$disconnect();
}
main().catch((e) => { console.error('✗', e?.message ?? e); process.exit(1); });
