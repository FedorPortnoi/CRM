/**
 * backend/db/seeds/index.ts — 4КУБ CRM development seed
 * =============================================================================
 * Run with:  npm run db:seed          (tsx backend/db/seeds/index.ts, from repo root)
 *
 * This seed exists to make features *testable*, not merely to put rows in tables.
 * Every record below is placed deliberately so that the queries the app already
 * ships — and the ones being built next — return something interesting:
 *
 *   backend/services/lastContacted.ts
 *     getLastContactedMap()                 → contacts with a spread of activity ages
 *     getContactIdsLastContactedBefore()    → contacts stale 45+ days, and contacts
 *                                             with NO activity at all (MAX(...) IS NULL)
 *   backend/services/reporting.ts
 *     getSalesFunnel()        → deals created inside the default 30-day window,
 *                               spread across the four RU stages + one unstaged deal
 *     getRepPerformance()     → won/lost deals with actual_close in-window, open
 *                               deals, stalled deals, done tasks, activity log rows
 *     getWinLossAnalysis()    → lost_reason and source populated on decided deals
 *     getRevenueOverTime()    → won deals in RUB across several months
 *     getPipelineHealth()     → won / lost / stalled mix inside one pipeline
 *   backend/api/controllers/deals.ts  GET /deals/stale
 *                             → open deals whose stage_entered_at predates
 *                               Org.stalled_threshold_days (30)
 *   backend/services/consent.ts  marketingRecipientWhere() / canSendMarketingEmail()
 *                             → a deliberate mix of consented, unconsented,
 *                               unsubscribed, and no-email contacts
 *
 * -----------------------------------------------------------------------------
 * ENCRYPTED CONTACT FIELDS — read this before adding rows
 * -----------------------------------------------------------------------------
 * Contact.email / phone / mobile are encrypted at rest and there is NO Prisma
 * middleware doing it: backend/services/db.ts is a bare `new PrismaClient()`.
 * Encryption is explicit at every write site (see backend/services/contact-domain.ts
 * createContactForUser, lines ~251-273), and each ciphertext column is written
 * together with its HMAC blind-index sibling:
 *
 *     email       = encryptField(plaintext)              // 'enc:v1:iv.tag.ct', AES-256-GCM
 *     email_bidx  = blindIndex(plaintext, 'email')       // HMAC-SHA256 hex, domain-separated
 *
 * Writing plaintext straight into those columns produces rows the app *appears*
 * to read (decryptField passes unprefixed values through untouched) but which can
 * never be found by exact-value search, because the *_bidx columns would be null.
 * That is why this seed goes through the same encryptField/blindIndex pair — see
 * the `pii()` helper below. Both keys derive from TOKEN_ENCRYPTION_KEY (falling
 * back to JWT_SECRET outside production) via backend/config/security.ts, so the
 * seed refuses to start if that secret is missing or too weak.
 *
 * -----------------------------------------------------------------------------
 * IDEMPOTENT — safe to re-run
 * -----------------------------------------------------------------------------
 *  1. Every primary key is a deterministic UUIDv5 derived from a stable string
 *     label (see `uuidFor`). Re-running therefore targets the exact same rows.
 *  2. Every write is an `upsert` keyed on that id, and the `update` branch carries
 *     the *same* payload as `create`. A second run rewrites the rows in place —
 *     it never inserts duplicates and never throws on a unique-constraint clash.
 *  3. Because the update branch rewrites the date columns too, all relative ages
 *     ("stale for 47 days", "closed 3 days ago") are re-anchored to the current
 *     `NOW` on every run. The 45-day-stale contact stays 45 days stale forever.
 *  4. Unique columns other than the id — Org.slug, Org.join_code, User.email,
 *     User.username, Contact.unsubscribe_token — are likewise derived from the
 *     same stable labels, so they only ever collide with their own previous value.
 *  5. The whole thing runs in a single interactive transaction: a failure halfway
 *     leaves the database exactly as it was, rather than half-seeded.
 *  6. It never DELETEs. Rows this seed owns are tagged `is_example_data = true`
 *     on the four models that have the column (Contact, Deal, Task, CalendarEvent),
 *     so they stay distinguishable from anything a human typed in.
 *
 * -----------------------------------------------------------------------------
 * DETERMINISTIC — with one documented exception
 * -----------------------------------------------------------------------------
 * No random values anywhere: no faker, no Math.random, no crypto.randomUUID.
 * Names, companies, amounts and offsets are all literals; dates are computed as
 * `NOW ± N days` with NOW floored to the second.
 *
 * The one exception is unavoidable and harmless: AES-GCM uses a fresh random IV
 * per call, so the *ciphertext bytes* in Contact.email/phone/mobile differ on
 * every run. The decrypted plaintext is stable and the blind indexes are stable
 * (HMAC is deterministic). Assert against plaintext or against *_bidx — never
 * against the raw ciphertext column.
 *
 * -----------------------------------------------------------------------------
 * REFUSES TO RUN AGAINST A NON-LOCAL DATABASE
 * -----------------------------------------------------------------------------
 * assertLocalDatabase() below parses DATABASE_URL (and DIRECT_URL when set) and
 * aborts unless the host is localhost / 127.0.0.1 / ::1. It also refuses when
 * NODE_ENV === 'production'. This is the guard that stops someone pointing
 * `npm run db:seed` at a real cluster.
 */

import '../../config/env';

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  CalendarEventStatus,
  ContactStatus,
  ContactType,
  DealStatus,
  MessageChannel,
  MessageDirection,
  MessageStatus,
  OrgPlan,
  Prisma,
  PrismaClient,
  SequenceStatus,
  TaskPriority,
  TaskStatus,
  UserRole,
} from '@prisma/client';
import {
  ENCRYPTED_FIELD_PREFIX,
  blindIndex,
  decryptField,
  encryptField,
} from '../../services/encryption';

// ---------------------------------------------------------------------------
// Safety guards
// ---------------------------------------------------------------------------

class SeedAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedAbort';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

/**
 * Abort unless `rawUrl` points at a Postgres running on this machine.
 *
 * Deliberately an allowlist, not a blocklist: an unparseable URL, a unix-socket
 * form we do not recognise, or any remote host all fail closed.
 */
function assertLocalDatabase(varName: string, rawUrl: string | undefined, required: boolean): void {
  if (!rawUrl || rawUrl.trim().length === 0) {
    if (required) {
      throw new SeedAbort(`${varName} is not set. Point it at your local Postgres and try again.`);
    }
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SeedAbort(`${varName} is not a parseable URL, so its host cannot be verified as local.`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new SeedAbort(`${varName} must be a postgresql:// URL (got "${parsed.protocol}").`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const isLocal = LOCAL_HOSTS.has(host) || host.endsWith('.localhost');

  if (!isLocal) {
    throw new SeedAbort(
      `${varName} points at host "${host}", which is not local.\n` +
        '       This seed only ever runs against localhost / 127.0.0.1 / ::1.',
    );
  }
}

/**
 * Validate the environment and return the connection string that will be handed
 * to Prisma. Returning it — rather than letting Prisma resolve env("DATABASE_URL")
 * on its own — is the point: the client is constructed further down with exactly
 * this string, so there is no window in which Prisma could connect to a URL that
 * was never checked. (@prisma/client runs its own dotenv loader at construction
 * time, which can repopulate DATABASE_URL behind our back; passing the URL
 * explicitly makes that irrelevant.)
 */
function assertSafeToSeed(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new SeedAbort('NODE_ENV is "production". This seed never runs in production.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  assertLocalDatabase('DATABASE_URL', databaseUrl, true);
  // Prisma uses DIRECT_URL for migrations; if it is configured it must be local too,
  // otherwise a "local" seed sits one command away from a remote schema push.
  assertLocalDatabase('DIRECT_URL', process.env.DIRECT_URL, false);

  // assertLocalDatabase already rejected undefined/empty for a required var.
  return databaseUrl as string;
}

/**
 * Verify the field-encryption secret round-trips before a single row is written.
 * Without this, a missing TOKEN_ENCRYPTION_KEY/JWT_SECRET would surface as an
 * opaque ConfigurationError partway through the transaction.
 */
function assertEncryptionUsable(): void {
  const probe = '4kub-seed-preflight';
  let ciphertext: string;

  try {
    ciphertext = encryptField(probe);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SeedAbort(
      `Field encryption is not configured: ${detail}\n` +
        '       Set TOKEN_ENCRYPTION_KEY (>= 32 chars) in .env — or JWT_SECRET, which it\n' +
        '       falls back to outside production. Contact PII cannot be seeded without it.',
    );
  }

  if (!ciphertext.startsWith(ENCRYPTED_FIELD_PREFIX) || decryptField(ciphertext) !== probe) {
    throw new SeedAbort('Field encryption did not round-trip. Refusing to write unreadable PII.');
  }

  if (!blindIndex('preflight@example.com', 'email')) {
    throw new SeedAbort('Blind index returned null for a valid email. Refusing to write unsearchable PII.');
  }
}

// ---------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------

// Fixed namespace for this seed's UUIDv5 derivation. Changing it orphans every
// previously seeded row (they would no longer be found by upsert), so don't.
const SEED_NAMESPACE = '3f2b0c1a-9d4e-4a76-8b21-5c7e0f9a1d34';
const SEED_NAMESPACE_BYTES = Buffer.from(SEED_NAMESPACE.replace(/-/g, ''), 'hex');

/** RFC 4122 v5 (SHA-1, name-based) UUID — same label always yields the same id. */
function uuidFor(label: string): string {
  const digest = crypto
    .createHash('sha1')
    .update(SEED_NAMESPACE_BYTES)
    .update(Buffer.from(label, 'utf8'))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic opaque token (unsubscribe links, etc.). */
function tokenFor(label: string): string {
  return crypto.createHash('sha256').update(`4kub-seed:${label}`).digest('hex').slice(0, 40);
}

// ---------------------------------------------------------------------------
// Time helpers — every date is relative to a single NOW captured at startup
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

// Floored to the second so repeated runs differ only by real elapsed time.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function daysAhead(days: number): Date {
  return new Date(NOW.getTime() + days * MS_PER_DAY);
}

function plusHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * MS_PER_HOUR);
}

// ---------------------------------------------------------------------------
// Fixed identity constants
// ---------------------------------------------------------------------------

const ORG_ID = uuidFor('org:romashka');
const PIPELINE_ID = uuidFor('pipeline:default');

const STAGE = {
  new: uuidFor('stage:novy-lid'),
  qualified: uuidFor('stage:kvalifikatsiya'),
  proposal: uuidFor('stage:predlozhenie'),
  won: uuidFor('stage:sdelka-vyigrana'),
} as const;

const USER = {
  owner: uuidFor('user:owner'),
  admin: uuidFor('user:admin'),
  member1: uuidFor('user:member1'),
  member2: uuidFor('user:member2'),
  viewer: uuidFor('user:viewer'),
} as const;

// Throwaway local-only credential. bcryptjs accepts a full salt string, and a
// fixed salt is what makes the hash byte-identical across runs — otherwise every
// re-seed would rewrite five password_hash values for no reason. This is only
// acceptable because the localhost guard above means these rows never leave
// this machine. The app itself uses a random salt at cost 12 (auth.ts:17).
const SEED_PASSWORD = 'SeedPass123!';
const FIXED_BCRYPT_SALT = '$2a$12$4kubseedlocalonlysalt.';

// ---------------------------------------------------------------------------
// PII helper — the ONLY correct way to write Contact email/phone/mobile
// ---------------------------------------------------------------------------

type PlainPii = { email?: string; phone?: string; mobile?: string };

/**
 * Mirror of backend/services/contact-domain.ts createContactForUser: ciphertext
 * and blind index written together, from the same plaintext. Absent values are
 * written as explicit nulls so the upsert's update branch clears a field rather
 * than leaving a stale hash behind.
 */
function pii(input: PlainPii) {
  return {
    email: input.email ? encryptField(input.email) : null,
    email_bidx: input.email ? blindIndex(input.email, 'email') : null,
    phone: input.phone ? encryptField(input.phone) : null,
    phone_bidx: input.phone ? blindIndex(input.phone, 'phone') : null,
    mobile: input.mobile ? encryptField(input.mobile) : null,
    mobile_bidx: input.mobile ? blindIndex(input.mobile, 'mobile') : null,
  };
}

// ---------------------------------------------------------------------------
// Row definitions
// ---------------------------------------------------------------------------

type UserSpec = {
  key: keyof typeof USER;
  name: string;
  username: string;
  email: string;
  role: UserRole;
  managerKey: keyof typeof USER | null;
};

// Hierarchy: owner → admin → {member1, member2} → viewer.
// getVisibleUserIds() walks manager_id recursively, so this shape exercises both
// the unrestricted owner/admin path and the restricted subtree path.
const USERS: UserSpec[] = [
  { key: 'owner', name: 'Владимир Орлов', username: 'vladimir', email: 'owner@seed.crm.local', role: UserRole.owner, managerKey: null },
  { key: 'admin', name: 'Анна Смирнова', username: 'anna', email: 'admin@seed.crm.local', role: UserRole.admin, managerKey: 'owner' },
  { key: 'member1', name: 'Дмитрий Кузнецов', username: 'dmitry', email: 'member1@seed.crm.local', role: UserRole.member, managerKey: 'admin' },
  { key: 'member2', name: 'Екатерина Волкова', username: 'ekaterina', email: 'member2@seed.crm.local', role: UserRole.member, managerKey: 'admin' },
  { key: 'viewer', name: 'Игорь Соколов', username: 'igor', email: 'viewer@seed.crm.local', role: UserRole.viewer, managerKey: 'member1' },
];

// Names, positions and the single is_won_stage flag are copied verbatim from
// backend/config/market.ts (DEFAULT_PIPELINE_NAME / DEFAULT_PIPELINE_STAGE_NAMES),
// which is what AuthController.register writes for a real new org. Note there is
// deliberately NO lost stage — the app does not create one; lost deals keep the
// stage they died on and carry status = 'lost'.
const STAGES = [
  { id: STAGE.new, name: 'Новый лид', position: 0, is_won_stage: false, is_lost_stage: false },
  { id: STAGE.qualified, name: 'Квалификация', position: 1, is_won_stage: false, is_lost_stage: false },
  { id: STAGE.proposal, name: 'Предложение', position: 2, is_won_stage: false, is_lost_stage: false },
  { id: STAGE.won, name: 'Сделка выиграна', position: 3, is_won_stage: true, is_lost_stage: false },
];

type ContactSpec = {
  key: string;
  first_name: string;
  last_name: string;
  company: string | null;
  type: ContactType;
  status: ContactStatus;
  assignee: keyof typeof USER;
  source: string;
  tags: string[];
  notes: string;
  createdDaysAgo: number;
  plain: PlainPii;
  /** true → marketing_consent + marketing_consent_at + marketing_consent_source all set */
  consent: { source: string; daysAgo: number } | null;
  /** set → contact has withdrawn consent; the sender must skip it even when consent = true */
  unsubscribedDaysAgo?: number;
};

/**
 * 12 contacts covering all four ContactType values, all three ContactStatus
 * values, and a deliberate consent spread. Activity ages are assigned by the
 * MESSAGES / EVENTS tables further down; the comment on each row states the
 * intended "last contacted" age so the two stay in sync.
 *
 * THE PII BELOW IS SYNTHETIC ON PURPOSE — keep it that way when adding rows.
 * This repository is public, and these rows carry marketing_consent, which the
 * Sequence / EmailSend path reads as permission to send. A plausible-looking
 * address here is therefore one misconfigured local run away from real mail to
 * a real person who never consented (ФЗ-38 ст.18), and a plausible-looking
 * number is personal data sitting in a public git history (ФЗ-152).
 *
 *   e-mail  → example.com / example.org, reserved by RFC 2606. They can never
 *             be registered and answer with a null MX, so nothing addressed to
 *             them can be delivered anywhere. example.ru is NOT reserved — .RU
 *             has no RFC 2606 equivalent — so do not reach for it *in this file*.
 *             That is a rule about seed rows, not a repo-wide ban: unit tests
 *             elsewhere do use example.ru, which is fine, because they build
 *             rows in memory and never reach the Sequence / EmailSend path.
 *             It is the marketing_consent on these rows that makes the address
 *             here dangerous and an address in a test harmless.
 *   phone   → the +7 900 000-00-XX block — a convention that buys LESS than it
 *             looks like, so do not lean on it. Russia has no reserved
 *             "fictional number" range the way NANP has 555-01XX, and an
 *             all-zero subscriber part is not an unassigned one: +7 900
 *             000-00-01 is a «красивый номер», the kind operators sell at a
 *             premium, so it is MORE likely to have a real owner than an
 *             arbitrary number, not less. These are placeholders that must
 *             never be dialled or messaged — not numbers that are safe because
 *             nobody holds them.
 *             Every value is distinct so the *_bidx columns stay distinct too.
 *
 * Realism buys nothing here — the name, company and notes already carry the
 * demo, and every screen that shows a contact shows those first.
 */
const CONTACTS: ContactSpec[] = [
  {
    // fresh — message 2 days ago
    key: 'lead-fresh', first_name: 'Сергей', last_name: 'Николаев', company: 'ООО «СтройМонтаж»',
    type: ContactType.lead, status: ContactStatus.active, assignee: 'member1',
    source: 'сайт', tags: ['входящий', 'горячий'], notes: 'Запросил демо после вебинара.',
    createdDaysAgo: 12,
    plain: { email: 'sergey.nikolaev@example.com', phone: '+7 (900) 000-00-01', mobile: '+7 900 000-00-02' },
    consent: { source: 'form', daysAgo: 11 },
  },
  {
    // warm — completed meeting 12 days ago
    key: 'lead-warm', first_name: 'Ольга', last_name: 'Петрова', company: 'ИП Петрова О. В.',
    type: ContactType.lead, status: ContactStatus.active, assignee: 'member2',
    source: 'реклама', tags: ['малый бизнес'], notes: 'Сравнивает нас с Битрикс24.',
    createdDaysAgo: 34,
    plain: { email: 'o.petrova@example.org', phone: '+7 (900) 000-00-03' },
    consent: null,
  },
  {
    // STALE — last message 47 days ago
    key: 'lead-stale', first_name: 'Артём', last_name: 'Белов', company: 'ООО «ТехноПром»',
    type: ContactType.lead, status: ContactStatus.active, assignee: 'member1',
    source: 'выставка', tags: ['производство'], notes: 'Взял паузу до нового бюджетного года.',
    createdDaysAgo: 95,
    plain: { email: 'a.belov@example.com', phone: '+7 (900) 000-00-04', mobile: '+7 900 000-00-05' },
    consent: { source: 'import', daysAgo: 90 },
  },
  {
    // STALE — no Message and no CalendarEvent at all (MAX(...) IS NULL branch)
    key: 'lead-never', first_name: 'Марина', last_name: 'Зайцева', company: 'ООО «Вектор»',
    type: ContactType.lead, status: ContactStatus.active, assignee: 'member1',
    source: 'холодный обзвон', tags: ['не в работе'], notes: 'Загружен из старой базы, ни разу не связывались.',
    createdDaysAgo: 78,
    plain: { email: 'm.zaytseva@example.org', phone: '+7 (900) 000-00-06' },
    consent: null,
  },
  {
    // fresh — call 3 days ago
    key: 'customer-fresh', first_name: 'Павел', last_name: 'Морозов', company: 'АО «Энергосбыт»',
    type: ContactType.customer, status: ContactStatus.active, assignee: 'member1',
    source: 'рекомендация', tags: ['ключевой', 'энергетика'], notes: 'Основной контакт по внедрению.',
    createdDaysAgo: 60,
    plain: { email: 'p.morozov@example.com', phone: '+7 (900) 000-00-07', mobile: '+7 900 000-00-08' },
    consent: { source: 'contract', daysAgo: 55 },
  },
  {
    // CONSENT CANARY — marketing_consent = true BUT unsubscribed 10 days ago.
    // marketingRecipientWhere() must exclude this row; canSendMarketingEmail()
    // must return CONTACT_UNSUBSCRIBED. If a bug drops the unsubscribed_at check,
    // this contact is the one that starts receiving illegal mail (ФЗ-38 ст.18).
    key: 'customer-unsub', first_name: 'Ирина', last_name: 'Лебедева', company: 'ООО «Медгарант»',
    type: ContactType.customer, status: ContactStatus.active, assignee: 'member2',
    source: 'выставка', tags: ['медицина'], notes: 'Отписалась от рассылки, но остаётся клиентом.',
    createdDaysAgo: 70,
    plain: { email: 'i.lebedeva@example.org', phone: '+7 (900) 000-00-09' },
    consent: { source: 'form', daysAgo: 65 },
    unsubscribedDaysAgo: 10,
  },
  {
    // STALE — last message 62 days ago
    key: 'customer-stale', first_name: 'Николай', last_name: 'Гусев', company: 'ООО «Агроторг»',
    type: ContactType.customer, status: ContactStatus.active, assignee: 'member2',
    source: 'холодный обзвон', tags: ['агро'], notes: 'Продлил лицензию, с тех пор тишина.',
    createdDaysAgo: 150,
    plain: { email: 'n.gusev@example.com', phone: '+7 (900) 000-00-10' },
    consent: null,
  },
  {
    // fresh — message 5 days ago + a scheduled meeting 4 days in the FUTURE.
    // Deliberate: getLastContactedMap takes MAX(start_time) over non-cancelled
    // events, so this contact's "last contacted" is a future timestamp. That is
    // the app's real behaviour and worth having one row that exposes it.
    key: 'partner-active', first_name: 'Юлия', last_name: 'Козлова', company: 'ООО «Логистик Плюс»',
    type: ContactType.partner, status: ContactStatus.active, assignee: 'member2',
    source: 'рекомендация', tags: ['партнёр', 'логистика'], notes: 'Реселлер в СЗФО.',
    createdDaysAgo: 200,
    plain: { email: 'yu.kozlova@example.org', phone: '+7 (900) 000-00-11', mobile: '+7 900 000-00-12' },
    consent: { source: 'verbal', daysAgo: 180 },
  },
  {
    // STALE — the ONLY activity is a CANCELLED event 20 days ago. Both
    // lastContacted queries exclude status = 'cancelled', so this contact reads
    // as never contacted. Catches a regression that forgets that exclusion.
    key: 'partner-stale', first_name: 'Роман', last_name: 'Фомин', company: 'ООО «Партнёр-Сервис»',
    type: ContactType.partner, status: ContactStatus.active, assignee: 'member2',
    source: 'сайт', tags: ['партнёр'], notes: 'Встреча сорвалась, не перенесли.',
    createdDaysAgo: 120,
    plain: { email: 'r.fomin@example.com', phone: '+7 (900) 000-00-13' },
    consent: null,
  },
  {
    // STALE + inactive — last message 91 days ago
    key: 'other-inactive', first_name: 'Алексей', last_name: 'Тарасов', company: 'ООО «Старт»',
    type: ContactType.other, status: ContactStatus.inactive, assignee: 'member1',
    source: 'реклама', tags: ['архивный интерес'], notes: 'Проект заморожен на неопределённый срок.',
    createdDaysAgo: 180,
    plain: { email: 'a.tarasov@example.org', phone: '+7 (900) 000-00-14' },
    consent: null,
  },
  {
    // CONSENT CANARY — marketing_consent = true but NO email address.
    // marketingRecipientWhere() happily selects this row; canSendMarketingEmail()
    // must then reject it with CONTACT_NO_EMAIL. Exercises the gap between the
    // bulk filter and the per-send check.
    key: 'other-noemail', first_name: 'Галина', last_name: 'Романова', company: null,
    type: ContactType.other, status: ContactStatus.active, assignee: 'admin',
    source: 'мероприятие', tags: ['только телефон'], notes: 'Согласие получено на бумаге, e-mail не оставила.',
    createdDaysAgo: 40,
    plain: { phone: '+7 (900) 000-00-15', mobile: '+7 900 000-00-16' },
    consent: { source: 'contract', daysAgo: 38 },
  },
  {
    // archived + STALE (message 120 days ago). Note the asymmetry this exposes:
    // getLastContactedMap() filters out status = 'archived', but
    // getContactIdsLastContactedBefore() does NOT — so this contact appears in
    // the absence-alert candidate list and nowhere else.
    key: 'archived', first_name: 'Виктор', last_name: 'Ершов', company: 'ООО «Закрытые Двери»',
    type: ContactType.lead, status: ContactStatus.archived, assignee: 'admin',
    source: 'сайт', tags: ['закрыт'], notes: 'Компания сменила направление деятельности.',
    createdDaysAgo: 240,
    plain: { email: 'v.ershov@example.com', phone: '+7 (900) 000-00-17' },
    consent: null,
  },
];

type DealSpec = {
  key: string;
  title: string;
  contactKey: string | null;
  stageId: string | null;
  status: DealStatus;
  value: number;
  assignee: keyof typeof USER;
  source: string;
  createdDaysAgo: number;
  /** Drives BOTH GET /deals/stale (stage_entered_at) and reporting's stalled count (updated_at). */
  stageEnteredDaysAgo: number;
  closedDaysAgo?: number;
  lostReason?: string;
  probability?: number;
  expectedCloseInDays?: number;
  nextAction?: string;
  /** negative = overdue, positive = upcoming, undefined = null in the DB */
  nextActionDueInDays?: number;
};

/**
 * 19 deals. Groups, and why each exists:
 *
 *   D01-D06  open, created inside the last 30 days → the sales funnel has a real
 *            shape (more deals early in the pipeline than late).
 *   D07-D09  won with actual_close inside the last 30 days → rep performance
 *            revenue, pipeline health "won", revenue-over-time current bucket.
 *   D10-D11  lost with actual_close in-window, distinct lost_reason and source →
 *            win/loss analysis has more than one bucket.
 *   D12-D14  open with stage_entered_at 45-88 days back, i.e. well past
 *            Org.stalled_threshold_days (30) → GET /deals/stale and the stalled
 *            term of pipelineHealthScore. One per rep.
 *   D15-D17  won 55/88/130 days back → revenue-over-time has several monthly
 *            buckets when the caller asks for period=year.
 *   D18      archived → proves reports honour status != archived.
 *   D19      stage_id = null → the funnel's unstaged_deal_count / unstaged_value.
 *
 * next_action_due is deliberately mixed: overdue (negative), upcoming (positive)
 * and null (undefined), so an "overdue next action" filter cannot pass by
 * accident on all-populated data.
 */
const DEALS: DealSpec[] = [
  { key: 'd01', title: 'Внедрение CRM — СтройМонтаж', contactKey: 'lead-fresh', stageId: STAGE.new, status: DealStatus.open, value: 450_000, assignee: 'member1', source: 'сайт', createdDaysAgo: 4, stageEnteredDaysAgo: 4, probability: 20, expectedCloseInDays: 45, nextAction: 'Позвонить и уточнить бюджет', nextActionDueInDays: -1 },
  { key: 'd02', title: 'Поставка оборудования — Петрова', contactKey: 'lead-warm', stageId: STAGE.new, status: DealStatus.open, value: 180_000, assignee: 'member2', source: 'реклама', createdDaysAgo: 9, stageEnteredDaysAgo: 9, probability: 10, expectedCloseInDays: 60, nextAction: 'Отправить прайс-лист' },
  { key: 'd03', title: 'Автоматизация склада — ТехноПром', contactKey: 'lead-stale', stageId: STAGE.qualified, status: DealStatus.open, value: 1_250_000, assignee: 'member1', source: 'выставка', createdDaysAgo: 14, stageEnteredDaysAgo: 7, probability: 40, expectedCloseInDays: 30, nextAction: 'Согласовать техническое задание', nextActionDueInDays: 3 },
  { key: 'd04', title: 'Годовая лицензия — Энергосбыт', contactKey: 'customer-fresh', stageId: STAGE.qualified, status: DealStatus.open, value: 890_000, assignee: 'admin', source: 'рекомендация', createdDaysAgo: 18, stageEnteredDaysAgo: 11, probability: 50, expectedCloseInDays: 21, nextAction: 'Подготовить расчёт на 50 рабочих мест', nextActionDueInDays: -5 },
  { key: 'd05', title: 'Пилотный проект — Медгарант', contactKey: 'customer-unsub', stageId: STAGE.proposal, status: DealStatus.open, value: 640_000, assignee: 'member2', source: 'выставка', createdDaysAgo: 22, stageEnteredDaysAgo: 6, probability: 65, expectedCloseInDays: 14, nextAction: 'Дождаться решения комитета' },
  { key: 'd06', title: 'Расширение лицензий — Логистик Плюс', contactKey: 'partner-active', stageId: STAGE.proposal, status: DealStatus.open, value: 320_000, assignee: 'member1', source: 'рекомендация', createdDaysAgo: 26, stageEnteredDaysAgo: 13, probability: 70, expectedCloseInDays: 10, nextAction: 'Выставить счёт', nextActionDueInDays: 7 },

  { key: 'd07', title: 'Внедрение CRM — Энергосбыт', contactKey: 'customer-fresh', stageId: STAGE.won, status: DealStatus.won, value: 1_450_000, assignee: 'member1', source: 'сайт', createdDaysAgo: 28, stageEnteredDaysAgo: 3, closedDaysAgo: 3, probability: 100 },
  { key: 'd08', title: 'Модуль отчётности — Логистик Плюс', contactKey: 'partner-active', stageId: STAGE.won, status: DealStatus.won, value: 520_000, assignee: 'member2', source: 'рекомендация', createdDaysAgo: 27, stageEnteredDaysAgo: 12, closedDaysAgo: 12, probability: 100 },
  { key: 'd09', title: 'Обучение персонала — Медгарант', contactKey: 'customer-unsub', stageId: STAGE.won, status: DealStatus.won, value: 260_000, assignee: 'admin', source: 'выставка', createdDaysAgo: 29, stageEnteredDaysAgo: 21, closedDaysAgo: 21, probability: 100 },

  { key: 'd10', title: 'Интеграция 1С — Агроторг', contactKey: 'customer-stale', stageId: STAGE.proposal, status: DealStatus.lost, value: 780_000, assignee: 'member2', source: 'холодный обзвон', createdDaysAgo: 29, stageEnteredDaysAgo: 8, closedDaysAgo: 8, lostReason: 'Дорого' },
  { key: 'd11', title: 'Миграция данных — Старт', contactKey: 'other-inactive', stageId: STAGE.qualified, status: DealStatus.lost, value: 210_000, assignee: 'member1', source: 'реклама', createdDaysAgo: 26, stageEnteredDaysAgo: 17, closedDaysAgo: 17, lostReason: 'Выбрали конкурента' },

  { key: 'd12', title: 'Комплексный проект — Вектор', contactKey: 'lead-never', stageId: STAGE.qualified, status: DealStatus.open, value: 2_100_000, assignee: 'member1', source: 'сайт', createdDaysAgo: 74, stageEnteredDaysAgo: 68, probability: 30, expectedCloseInDays: 20, nextAction: 'Реанимировать: назначить встречу', nextActionDueInDays: -40 },
  { key: 'd13', title: 'Поставка серверов — Партнёр-Сервис', contactKey: 'partner-stale', stageId: STAGE.proposal, status: DealStatus.open, value: 970_000, assignee: 'member2', source: 'рекомендация', createdDaysAgo: 61, stageEnteredDaysAgo: 45, probability: 45, expectedCloseInDays: 25 },
  { key: 'd14', title: 'Подписка на 3 года — Закрытые Двери', contactKey: 'archived', stageId: STAGE.new, status: DealStatus.open, value: 540_000, assignee: 'admin', source: 'холодный обзвон', createdDaysAgo: 96, stageEnteredDaysAgo: 88, probability: 10, nextAction: 'Проверить, жив ли контакт', nextActionDueInDays: -60 },

  { key: 'd15', title: 'Пакет «Рост» — СтройМонтаж', contactKey: 'lead-fresh', stageId: STAGE.won, status: DealStatus.won, value: 730_000, assignee: 'member1', source: 'сайт', createdDaysAgo: 80, stageEnteredDaysAgo: 55, closedDaysAgo: 55, probability: 100 },
  { key: 'd16', title: 'Внедрение под ключ — Агроторг', contactKey: 'customer-stale', stageId: STAGE.won, status: DealStatus.won, value: 1_180_000, assignee: 'member2', source: 'выставка', createdDaysAgo: 110, stageEnteredDaysAgo: 88, closedDaysAgo: 88, probability: 100 },
  { key: 'd17', title: 'Продление поддержки — Логистик Плюс', contactKey: 'partner-active', stageId: STAGE.won, status: DealStatus.won, value: 410_000, assignee: 'admin', source: 'рекомендация', createdDaysAgo: 150, stageEnteredDaysAgo: 130, closedDaysAgo: 130, probability: 100 },

  { key: 'd18', title: 'Отменённый пилот — Вектор', contactKey: 'lead-never', stageId: STAGE.new, status: DealStatus.archived, value: 150_000, assignee: 'member2', source: 'реклама', createdDaysAgo: 40, stageEnteredDaysAgo: 40 },
  { key: 'd19', title: 'Входящий запрос без этапа', contactKey: null, stageId: null, status: DealStatus.open, value: 95_000, assignee: 'member2', source: 'сайт', createdDaysAgo: 6, stageEnteredDaysAgo: 6 },
];

type TaskSpec = {
  key: string;
  title: string;
  description: string | null;
  assignee: keyof typeof USER;
  status: TaskStatus;
  priority: TaskPriority;
  contactKey?: string;
  dealKey?: string;
  dueInDays?: number;
  completedDaysAgo?: number;
  createdDaysAgo: number;
  isRecurring?: boolean;
  recurrenceRule?: string;
  reminderInDays?: number;
};

/**
 * 11 tasks. The four `done` ones carry completed_at inside the default 30-day
 * report window and a completed_by, which is what getRepPerformance counts.
 * The rest mix overdue / due-today-ish / future / no-due-date across every
 * TaskStatus value.
 */
const TASKS: TaskSpec[] = [
  { key: 't01', title: 'Позвонить в СтройМонтаж', description: 'Уточнить бюджет и сроки принятия решения.', assignee: 'member1', status: TaskStatus.pending, priority: TaskPriority.high, contactKey: 'lead-fresh', dealKey: 'd01', dueInDays: -1, createdDaysAgo: 4, reminderInDays: -1 },
  { key: 't02', title: 'Подготовить коммерческое предложение', description: 'Расчёт на 120 пользователей.', assignee: 'member1', status: TaskStatus.in_progress, priority: TaskPriority.urgent, dealKey: 'd03', dueInDays: 2, createdDaysAgo: 7 },
  { key: 't03', title: 'Согласовать договор с юристом', description: null, assignee: 'member2', status: TaskStatus.pending, priority: TaskPriority.medium, dealKey: 'd05', dueInDays: 5, createdDaysAgo: 6 },
  { key: 't04', title: 'Отправить счёт — Энергосбыт', description: 'Счёт на первый транш.', assignee: 'member1', status: TaskStatus.done, priority: TaskPriority.medium, dealKey: 'd07', dueInDays: -8, completedDaysAgo: 7, createdDaysAgo: 14 },
  { key: 't05', title: 'Провести демонстрацию модуля отчётности', description: null, assignee: 'member2', status: TaskStatus.done, priority: TaskPriority.high, dealKey: 'd08', dueInDays: -13, completedDaysAgo: 12, createdDaysAgo: 20 },
  { key: 't06', title: 'Собрать обратную связь после обучения', description: 'Анкета по итогам курса.', assignee: 'admin', status: TaskStatus.done, priority: TaskPriority.low, dealKey: 'd09', dueInDays: -22, completedDaysAgo: 21, createdDaysAgo: 26 },
  { key: 't07', title: 'Обновить карточку клиента', description: 'Реквизиты изменились.', assignee: 'member2', status: TaskStatus.cancelled, priority: TaskPriority.low, contactKey: 'customer-stale', dueInDays: -30, createdDaysAgo: 45 },
  { key: 't08', title: 'Напомнить о продлении лицензии', description: null, assignee: 'member2', status: TaskStatus.pending, priority: TaskPriority.low, contactKey: 'customer-fresh', dueInDays: 14, createdDaysAgo: 3, reminderInDays: 13 },
  { key: 't09', title: 'Реанимировать сделку с Вектор', description: 'Сделка стоит на месте больше двух месяцев.', assignee: 'member1', status: TaskStatus.pending, priority: TaskPriority.high, dealKey: 'd12', dueInDays: -40, createdDaysAgo: 68 },
  { key: 't10', title: 'Подготовить отчёт за квартал', description: null, assignee: 'admin', status: TaskStatus.in_progress, priority: TaskPriority.medium, dueInDays: 21, createdDaysAgo: 5, isRecurring: true, recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
  // No due date at all — proves a due-date filter handles NULL.
  { key: 't11', title: 'Проверить контакты без активности', description: 'Выгрузить всех, с кем не связывались 45+ дней.', assignee: 'member1', status: TaskStatus.done, priority: TaskPriority.medium, completedDaysAgo: 3, createdDaysAgo: 10 },
];

type MessageSpec = {
  key: string;
  contactKey: string;
  user: keyof typeof USER | null;
  direction: MessageDirection;
  channel: MessageChannel;
  body: string;
  status: MessageStatus;
  daysAgo: number;
};

/**
 * Messages are half of what getLastContactedMap() aggregates (the other half is
 * CalendarEvent.start_time). The `daysAgo` on the NEWEST message per contact is
 * what makes that contact fresh or stale — do not add anything newer than 45
 * days to lead-stale / customer-stale / other-inactive / archived, and nothing
 * at all to lead-never / partner-stale.
 */
const MESSAGES: MessageSpec[] = [
  { key: 'm01', contactKey: 'lead-fresh', user: 'member1', direction: MessageDirection.inbound, channel: MessageChannel.email, body: 'Здравствуйте! Посмотрели демо, готовы обсуждать внедрение.', status: MessageStatus.read, daysAgo: 2 },
  { key: 'm02', contactKey: 'lead-fresh', user: 'member1', direction: MessageDirection.outbound, channel: MessageChannel.email, body: 'Добрый день! Отправляю запись вебинара и презентацию.', status: MessageStatus.delivered, daysAgo: 9 },
  { key: 'm03', contactKey: 'lead-warm', user: 'member2', direction: MessageDirection.outbound, channel: MessageChannel.call, body: 'Созвон 20 минут: обсудили отличия от Битрикс24.', status: MessageStatus.sent, daysAgo: 30 },
  { key: 'm04', contactKey: 'lead-stale', user: 'member1', direction: MessageDirection.outbound, channel: MessageChannel.email, body: 'Напоминаю о нашем предложении, готов ответить на вопросы.', status: MessageStatus.delivered, daysAgo: 47 },
  { key: 'm05', contactKey: 'lead-stale', user: 'member1', direction: MessageDirection.inbound, channel: MessageChannel.email, body: 'Вернёмся к вопросу в новом бюджетном году.', status: MessageStatus.read, daysAgo: 60 },
  { key: 'm06', contactKey: 'customer-fresh', user: 'member1', direction: MessageDirection.outbound, channel: MessageChannel.call, body: 'Обсудили план внедрения на второй квартал.', status: MessageStatus.sent, daysAgo: 3 },
  { key: 'm07', contactKey: 'customer-fresh', user: 'member1', direction: MessageDirection.inbound, channel: MessageChannel.in_app, body: 'Подтверждаем состав рабочей группы.', status: MessageStatus.read, daysAgo: 24 },
  { key: 'm08', contactKey: 'customer-unsub', user: 'member2', direction: MessageDirection.outbound, channel: MessageChannel.email, body: 'Направляю акт по итогам обучения.', status: MessageStatus.delivered, daysAgo: 7 },
  { key: 'm09', contactKey: 'customer-stale', user: 'member2', direction: MessageDirection.outbound, channel: MessageChannel.email, body: 'Лицензия продлена, доступы отправлены.', status: MessageStatus.delivered, daysAgo: 62 },
  { key: 'm10', contactKey: 'partner-active', user: 'member2', direction: MessageDirection.inbound, channel: MessageChannel.in_app, body: 'Передаём двух клиентов из СЗФО, детали в письме.', status: MessageStatus.read, daysAgo: 5 },
  { key: 'm11', contactKey: 'other-inactive', user: 'member1', direction: MessageDirection.outbound, channel: MessageChannel.email, body: 'Проект заморожен — остаёмся на связи.', status: MessageStatus.sent, daysAgo: 91 },
  { key: 'm12', contactKey: 'other-noemail', user: 'admin', direction: MessageDirection.outbound, channel: MessageChannel.call, body: 'Согласие на рассылку получено на бумажном бланке.', status: MessageStatus.sent, daysAgo: 20 },
  { key: 'm13', contactKey: 'archived', user: 'admin', direction: MessageDirection.outbound, channel: MessageChannel.email, body: 'Уточняю, актуален ли ещё запрос.', status: MessageStatus.failed, daysAgo: 120 },
];

type EventSpec = {
  key: string;
  title: string;
  contactKey: string;
  dealKey?: string;
  creator: keyof typeof USER;
  status: CalendarEventStatus;
  /** negative = past, positive = future */
  startInDays: number;
  durationHours: number;
  location?: string;
  attendees: (keyof typeof USER)[];
};

const EVENTS: EventSpec[] = [
  { key: 'e01', title: 'Демонстрация системы', contactKey: 'lead-fresh', dealKey: 'd01', creator: 'member1', status: CalendarEventStatus.completed, startInDays: -9, durationHours: 1, location: 'Онлайн', attendees: ['member1'] },
  { key: 'e02', title: 'Встреча по сравнению решений', contactKey: 'lead-warm', creator: 'member2', status: CalendarEventStatus.completed, startInDays: -12, durationHours: 1.5, location: 'Офис клиента, Санкт-Петербург', attendees: ['member2'] },
  { key: 'e03', title: 'Установочная встреча по внедрению', contactKey: 'customer-fresh', dealKey: 'd07', creator: 'member1', status: CalendarEventStatus.completed, startInDays: -16, durationHours: 2, location: 'Онлайн', attendees: ['member1', 'admin'] },
  { key: 'e04', title: 'Квартальный обзор партнёрства', contactKey: 'partner-active', dealKey: 'd06', creator: 'member2', status: CalendarEventStatus.scheduled, startInDays: 4, durationHours: 1, location: 'Онлайн', attendees: ['member2', 'owner'] },
  // Cancelled: excluded by both lastContacted queries, which is the whole point.
  { key: 'e05', title: 'Презентация серверного решения (отменена)', contactKey: 'partner-stale', dealKey: 'd13', creator: 'member2', status: CalendarEventStatus.cancelled, startInDays: -20, durationHours: 1, attendees: ['member2'] },
  { key: 'e06', title: 'Защита пилотного проекта', contactKey: 'customer-unsub', dealKey: 'd05', creator: 'member2', status: CalendarEventStatus.scheduled, startInDays: 6, durationHours: 2, location: 'Онлайн', attendees: ['member2', 'admin'] },
];

type ActivitySpec = {
  key: string;
  user: keyof typeof USER;
  entityType: 'contact' | 'deal' | 'task';
  entityId: string;
  action: string;
  daysAgo: number;
  changes?: Record<string, unknown>;
};

// getRepPerformance counts ActivityLog rows per user inside the report window,
// so these all sit within the last 30 days with a non-null user_id. The
// entity_type/action pairs are the real ones written by contact-domain.ts,
// deal-domain.ts, deals.ts and task-domain.ts.
function buildActivityLog(contactId: (k: string) => string, dealId: (k: string) => string, taskId: (k: string) => string): ActivitySpec[] {
  return [
    { key: 'a01', user: 'member1', entityType: 'contact', entityId: contactId('lead-fresh'), action: 'created', daysAgo: 12 },
    { key: 'a02', user: 'member1', entityType: 'contact', entityId: contactId('lead-fresh'), action: 'updated', daysAgo: 2, changes: { email: '[changed]', source: { from: null, to: 'сайт' } } },
    { key: 'a03', user: 'member1', entityType: 'deal', entityId: dealId('d01'), action: 'created', daysAgo: 4 },
    { key: 'a04', user: 'member1', entityType: 'deal', entityId: dealId('d03'), action: 'stage_changed', daysAgo: 7, changes: { stage_id: STAGE.qualified } },
    { key: 'a05', user: 'member1', entityType: 'deal', entityId: dealId('d07'), action: 'won', daysAgo: 3 },
    { key: 'a06', user: 'member2', entityType: 'deal', entityId: dealId('d05'), action: 'stage_changed', daysAgo: 6, changes: { stage_id: STAGE.proposal } },
    { key: 'a07', user: 'member2', entityType: 'deal', entityId: dealId('d10'), action: 'lost', daysAgo: 8 },
    { key: 'a08', user: 'member2', entityType: 'deal', entityId: dealId('d08'), action: 'won', daysAgo: 12 },
    { key: 'a09', user: 'member1', entityType: 'task', entityId: taskId('t04'), action: 'completed', daysAgo: 7 },
    { key: 'a10', user: 'admin', entityType: 'task', entityId: taskId('t06'), action: 'completed', daysAgo: 21 },
    { key: 'a11', user: 'admin', entityType: 'deal', entityId: dealId('d09'), action: 'won', daysAgo: 21 },
    { key: 'a12', user: 'member1', entityType: 'contact', entityId: contactId('customer-fresh'), action: 'updated', daysAgo: 24, changes: { notes: { from: null, to: 'Основной контакт по внедрению.' } } },
  ];
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const contactId = (key: string): string => uuidFor(`contact:${key}`);
const dealId = (key: string): string => uuidFor(`deal:${key}`);
const taskId = (key: string): string => uuidFor(`task:${key}`);

async function seed(db: PrismaClient): Promise<void> {
  const passwordHash = bcrypt.hashSync(SEED_PASSWORD, FIXED_BCRYPT_SALT);

  await db.$transaction(
    async (tx) => {
      // --- Org -------------------------------------------------------------
      // owner_id is left alone here because the owning User does not exist yet;
      // it is set in a follow-up update once the users are in place.
      const orgData = {
        name: 'ООО «Ромашка» (демо-данные)',
        slug: 'seed-romashka',
        plan: OrgPlan.growth,
        settings: { currency: 'RUB', monthly_revenue_target: 5_000_000 },
        stalled_threshold_days: 30,
        decay_factor: 0.5,
        join_code: 'SEED01',
        join_code_expires_at: daysAhead(90),
        created_at: daysAgo(240),
      };

      await tx.org.upsert({
        where: { id: ORG_ID },
        create: { id: ORG_ID, ...orgData },
        update: orgData,
      });

      // --- Users -----------------------------------------------------------
      // Ordered so that every manager_id / invited_by target already exists.
      for (const spec of USERS) {
        const userData = {
          organization_id: ORG_ID,
          email: spec.email,
          username: spec.username,
          password_hash: passwordHash,
          name: spec.name,
          role: spec.role,
          is_active: true,
          is_verified: true,
          email_verified: true,
          phone_verified: false,
          must_change_password: false,
          must_change_email: false,
          manager_id: spec.managerKey ? USER[spec.managerKey] : null,
          invited_by: spec.key === 'owner' ? null : USER.owner,
          last_seen_at: daysAgo(1),
          created_at: daysAgo(240),
        };

        await tx.user.upsert({
          where: { id: USER[spec.key] },
          create: { id: USER[spec.key], ...userData },
          update: userData,
        });
      }

      await tx.org.update({ where: { id: ORG_ID }, data: { owner_id: USER.owner } });

      // --- Pipeline + stages ----------------------------------------------
      const pipelineData = {
        organization_id: ORG_ID,
        name: 'Воронка продаж',
        description: null,
        is_default: true,
        created_by: USER.owner,
        created_at: daysAgo(240),
      };

      await tx.pipeline.upsert({
        where: { id: PIPELINE_ID },
        create: { id: PIPELINE_ID, ...pipelineData },
        update: pipelineData,
      });

      for (const stage of STAGES) {
        const stageData = {
          pipeline_id: PIPELINE_ID,
          name: stage.name,
          position: stage.position,
          color: null,
          is_won_stage: stage.is_won_stage,
          is_lost_stage: stage.is_lost_stage,
          created_at: daysAgo(240),
        };

        await tx.pipelineStage.upsert({
          where: { id: stage.id },
          create: { id: stage.id, ...stageData },
          update: stageData,
        });
      }

      // --- Contacts --------------------------------------------------------
      for (const spec of CONTACTS) {
        const id = contactId(spec.key);
        const contactData = {
          organization_id: ORG_ID,
          first_name: spec.first_name,
          last_name: spec.last_name,
          company: spec.company,
          ...pii(spec.plain),
          tags: spec.tags,
          source: spec.source,
          notes: spec.notes,
          type: spec.type,
          status: spec.status,
          assigned_to: USER[spec.assignee],
          created_by: USER.owner,
          is_example_data: true,
          marketing_consent: spec.consent !== null,
          marketing_consent_at: spec.consent ? daysAgo(spec.consent.daysAgo) : null,
          marketing_consent_source: spec.consent ? spec.consent.source : null,
          unsubscribed_at: spec.unsubscribedDaysAgo ? daysAgo(spec.unsubscribedDaysAgo) : null,
          // Minted lazily by ensureUnsubscribeToken() in production; pre-seeding a
          // deterministic one makes the one-click unsubscribe link testable.
          unsubscribe_token: spec.consent ? tokenFor(`unsub:${spec.key}`) : null,
          created_at: daysAgo(spec.createdDaysAgo),
        };

        await tx.contact.upsert({
          where: { id },
          create: { id, ...contactData },
          update: contactData,
        });
      }

      // --- Deals -----------------------------------------------------------
      for (const spec of DEALS) {
        const id = dealId(spec.key);
        const dealData = {
          organization_id: ORG_ID,
          title: spec.title,
          contact_id: spec.contactKey ? contactId(spec.contactKey) : null,
          // d19 keeps pipeline_id so pipeline health still buckets it, but has no
          // stage_id — that is what the funnel reports as "unstaged".
          pipeline_id: PIPELINE_ID,
          stage_id: spec.stageId,
          value: spec.value,
          currency: 'RUB',
          expected_close: spec.expectedCloseInDays === undefined ? null : daysAhead(spec.expectedCloseInDays),
          actual_close: spec.closedDaysAgo === undefined ? null : daysAgo(spec.closedDaysAgo),
          probability: spec.probability ?? null,
          status: spec.status,
          lost_reason: spec.lostReason ?? null,
          next_action: spec.nextAction ?? null,
          next_action_due: spec.nextActionDueInDays === undefined ? null : daysAhead(spec.nextActionDueInDays),
          stage_entered_at: daysAgo(spec.stageEnteredDaysAgo),
          source: spec.source,
          assigned_to: USER[spec.assignee],
          created_by: USER.owner,
          is_example_data: true,
          created_at: daysAgo(spec.createdDaysAgo),
        };

        await tx.deal.upsert({
          where: { id },
          create: { id, ...dealData },
          update: dealData,
        });
      }

      // Deal.updated_at is @updatedAt, so Prisma stamps it with now() on every
      // create and update and ignores anything we pass. getRepPerformance and
      // getPipelineHealth count a deal as stalled when `updated_at < now -
      // stalled_threshold_days`, while GET /deals/stale uses stage_entered_at.
      // Aligning the two by raw UPDATE is the only way to make both agree — and
      // it must run last, because every upsert above re-stamps updated_at.
      await tx.$executeRaw`
        UPDATE "Deal"
        SET "updated_at" = "stage_entered_at"
        WHERE "organization_id" = ${ORG_ID}::uuid
          AND "is_example_data" = true
      `;

      // --- Tasks -----------------------------------------------------------
      for (const spec of TASKS) {
        const id = taskId(spec.key);
        const taskData = {
          organization_id: ORG_ID,
          title: spec.title,
          description: spec.description ?? null,
          contact_id: spec.contactKey ? contactId(spec.contactKey) : null,
          deal_id: spec.dealKey ? dealId(spec.dealKey) : null,
          assigned_to: USER[spec.assignee],
          created_by: USER.owner,
          due_date: spec.dueInDays === undefined ? null : daysAhead(spec.dueInDays),
          priority: spec.priority,
          status: spec.status,
          is_recurring: spec.isRecurring ?? false,
          recurrence_rule: spec.recurrenceRule ?? null,
          reminder_at: spec.reminderInDays === undefined ? null : daysAhead(spec.reminderInDays),
          completed_at: spec.completedDaysAgo === undefined ? null : daysAgo(spec.completedDaysAgo),
          completed_by: spec.completedDaysAgo === undefined ? null : USER[spec.assignee],
          is_example_data: true,
          created_at: daysAgo(spec.createdDaysAgo),
        };

        await tx.task.upsert({
          where: { id },
          create: { id, ...taskData },
          update: taskData,
        });
      }

      // --- Messages --------------------------------------------------------
      for (const spec of MESSAGES) {
        const id = uuidFor(`message:${spec.key}`);
        const messageData = {
          organization_id: ORG_ID,
          contact_id: contactId(spec.contactKey),
          user_id: spec.user ? USER[spec.user] : null,
          direction: spec.direction,
          channel: spec.channel,
          body: spec.body,
          status: spec.status,
          read_at: spec.status === MessageStatus.read ? daysAgo(spec.daysAgo) : null,
          delivered_at:
            spec.status === MessageStatus.delivered || spec.status === MessageStatus.read
              ? daysAgo(spec.daysAgo)
              : null,
          created_at: daysAgo(spec.daysAgo),
        };

        await tx.message.upsert({
          where: { id },
          create: { id, ...messageData },
          update: messageData,
        });
      }

      // --- Calendar events -------------------------------------------------
      for (const spec of EVENTS) {
        const id = uuidFor(`event:${spec.key}`);
        const start = daysAhead(spec.startInDays);
        const eventData = {
          organization_id: ORG_ID,
          title: spec.title,
          description: null,
          contact_id: contactId(spec.contactKey),
          deal_id: spec.dealKey ? dealId(spec.dealKey) : null,
          created_by: USER[spec.creator],
          attendee_ids: spec.attendees.map((key) => USER[key]),
          start_time: start,
          end_time: plusHours(start, spec.durationHours),
          location: spec.location ?? null,
          reminder_minutes: 30,
          status: spec.status,
          completed_at: spec.status === CalendarEventStatus.completed ? plusHours(start, spec.durationHours) : null,
          post_meeting_prompted: spec.status === CalendarEventStatus.completed,
          is_example_data: true,
          created_at: daysAgo(Math.max(1, Math.abs(spec.startInDays) + 3)),
        };

        await tx.calendarEvent.upsert({
          where: { id },
          create: { id, ...eventData },
          update: eventData,
        });
      }

      // --- Activity log ----------------------------------------------------
      for (const spec of buildActivityLog(contactId, dealId, taskId)) {
        const id = uuidFor(`activity:${spec.key}`);
        const activityData = {
          organization_id: ORG_ID,
          user_id: USER[spec.user],
          entity_type: spec.entityType,
          entity_id: spec.entityId,
          action: spec.action,
          // Same cast the real writer uses (activities.ts logActivity): a plain
          // object literal is a valid InputJsonValue but TS will not infer it.
          changes: (spec.changes as Prisma.InputJsonValue | undefined) ?? undefined,
          created_at: daysAgo(spec.daysAgo),
        };

        await tx.activityLog.upsert({
          where: { id },
          create: { id, ...activityData },
          update: activityData,
        });
      }

      // --- Email template + sequence (inert scaffolding) -------------------
      // Deliberately left in `draft` with ZERO enrollments: the scheduler polls
      // SequenceEnrollment where status = 'active', so nothing here can cause an
      // outbound send. It exists so the sequence editor and the consent gate have
      // something real to point at.
      const templateId = uuidFor('template:welcome');
      const templateData = {
        organization_id: ORG_ID,
        name: 'Приветственное письмо',
        subject: 'Спасибо за интерес к 4КУБ, {{first_name}}!',
        body:
          'Здравствуйте, {{first_name}}!\n\n' +
          'Спасибо за интерес к нашей CRM. Готов ответить на любые вопросы.\n\n' +
          'С уважением,\n{{sender_name}}',
        created_by: USER.owner,
        created_at: daysAgo(20),
      };
      await tx.emailTemplate.upsert({
        where: { id: templateId },
        create: { id: templateId, ...templateData },
        update: templateData,
      });

      const sequenceId = uuidFor('sequence:onboarding');
      const sequenceData = {
        organization_id: ORG_ID,
        name: 'Онбординг нового лида',
        description: 'Черновик. Перед запуском проверить согласия по ФЗ-38.',
        status: SequenceStatus.draft,
        created_by: USER.owner,
        created_at: daysAgo(18),
      };
      await tx.sequence.upsert({
        where: { id: sequenceId },
        create: { id: sequenceId, ...sequenceData },
        update: sequenceData,
      });

      const steps = [
        { key: 'step0', position: 0, delay_days: 0, template_id: templateId, subject: null, body: null },
        { key: 'step1', position: 1, delay_days: 3, template_id: null, subject: 'Не пропустите: короткое демо', body: 'Здравствуйте, {{first_name}}! Предлагаю 20-минутное демо на этой неделе.' },
      ];

      for (const step of steps) {
        const stepId = uuidFor(`sequence-step:${step.key}`);
        const stepData = {
          sequence_id: sequenceId,
          organization_id: ORG_ID,
          position: step.position,
          delay_days: step.delay_days,
          template_id: step.template_id,
          subject: step.subject,
          body: step.body,
          created_at: daysAgo(18),
        };

        await tx.sequenceStep.upsert({
          where: { id: stepId },
          create: { id: stepId, ...stepData },
          update: stepData,
        });
      }
    },
    { maxWait: 15_000, timeout: 180_000 },
  );
}

function summarise(): void {
  const consented = CONTACTS.filter((c) => c.consent !== null).length;
  const unsubscribed = CONTACTS.filter((c) => c.unsubscribedDaysAgo !== undefined).length;
  const stalledDeals = DEALS.filter((d) => d.status === DealStatus.open && d.stageEnteredDaysAgo > 30).length;
  const overdueActions = DEALS.filter((d) => (d.nextActionDueInDays ?? 0) < 0).length;
  const nullActions = DEALS.filter((d) => d.nextActionDueInDays === undefined).length;

  const lines = [
    '',
    '  Организация  ООО «Ромашка» (демо-данные)',
    `               org_id  ${ORG_ID}`,
    `               вход    ${USERS[0].email} / ${SEED_PASSWORD}  (и остальные четыре по той же схеме)`,
    '',
    `  Пользователи ${USERS.length}  (owner → admin → member×2 → viewer, связаны через manager_id)`,
    `  Воронка      «Воронка продаж» + ${STAGES.length} этапа (RU, как их создаёт AuthController.register)`,
    `  Контакты     ${CONTACTS.length}  — согласие на рассылку: ${consented} да / ${CONTACTS.length - consented} нет, из них ${unsubscribed} отписавшихся`,
    `  Сделки       ${DEALS.length}  — ${stalledDeals} застоявшихся (>30 дней на этапе), ${overdueActions} с просроченным next_action_due, ${nullActions} без него`,
    `  Задачи       ${TASKS.length}`,
    `  Сообщения    ${MESSAGES.length}`,
    `  Встречи      ${EVENTS.length}`,
    '',
    '  Контакты без активности 45+ дней (для getContactIdsLastContactedBefore):',
    '    lead-stale (47д), customer-stale (62д), other-inactive (91д), archived (120д),',
    '    lead-never (активности нет вообще), partner-stale (только отменённая встреча)',
    '',
  ];

  for (const line of lines) {
    console.log(line);
  }
}

function main(): void {
  let databaseUrl: string;

  try {
    databaseUrl = assertSafeToSeed();
    assertEncryptionUsable();
  } catch (error) {
    if (error instanceof SeedAbort) {
      console.error('');
      console.error('  ============================================================');
      console.error('   SEED ABORTED');
      console.error('  ============================================================');
      console.error(`   ${error.message}`);
      console.error('  ============================================================');
      console.error('');
      process.exit(1);
    }
    throw error;
  }

  console.log('  Заполнение локальной базы демо-данными 4КУБ…');

  // Constructed only after the guard passed, and pinned to the exact URL it
  // validated — Prisma never gets to resolve the datasource on its own.
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  seed(db)
    .then(() => {
      console.log('  Готово. Скрипт идемпотентен — можно запускать повторно.');
      summarise();
    })
    .catch((error: unknown) => {
      console.error('  Ошибка при заполнении базы:', error);
      process.exitCode = 1;
    })
    .finally(() => {
      void db.$disconnect();
    });
}

main();
