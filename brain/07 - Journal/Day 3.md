---
tags: [journal, day-3, sprint-1, phase-1, backend, auth, contacts, deals]
status: complete
related: ["Decision Log", "API Design", "Data Models", "Sprint Log", "Open Questions"]
created: 2026-05-02
---

# Day 3 — May 2, 2026

## What Happened Today

Session 3 was the biggest coding session so far. We completed two full phases in one sitting:

- **Phase 1** — Environment: Supabase project live, `.env` filled, nullable fixes, Prisma migration applied, Prisma Client generated, `CLAUDE.md` created
- **Phase 2** — Sprint 1: All 9 planned API handlers written and audited (auth register + login, contacts list/getById/create/update/archive, deals list/create)

The backend can now handle user registration, login, full contacts CRUD, and basic deals — all against a live Supabase PostgreSQL database.

---

## Phase 1 — Environment Setup

### P1-1: Supabase Project + `.env`

User created a new Supabase project (AWS us-east-1):

| Variable | Value |
|----------|-------|
| Project ID | `tiufcjxeiorvteuypaxl` |
| DATABASE_URL | Supabase pooler, port 6543, `pgbouncer=true` — used by Prisma queries |
| DIRECT_URL | Supabase direct, port 5432 — used by Prisma migrations only |
| JWT_SECRET | Base64 string (set by user) |
| JWT_EXPIRES_IN | `7d` |

**Problem encountered:** DATABASE_URL uses PgBouncer (`pgbouncer=true`) which breaks Prisma migrations — PgBouncer does not support the `SET` commands Prisma uses during migration. Fix: add `DIRECT_URL` for the direct (non-pooled) connection, and add `directUrl = env("DIRECT_URL")` to the datasource block in `schema.prisma`. Prisma automatically uses `directUrl` for migrations and `url` (pooler) for all other queries.

**Second problem:** The initial `.env` had `[YOUR-PASSWORD]` placeholder in both URLs. User provided the actual password (`HofstraNY2026`) and we filled both URLs.

**Third problem:** `JWT_EXPIRES_IN` was initially set as `60480` (a number). `@fastify/jwt` requires a string like `"7d"` (zeit/ms format). Fixed by updating `.env` to `JWT_EXPIRES_IN=7d`.

### P1-2: Schema Nullable Fixes

Four model fields corrected in `backend/prisma/schema.prisma` before running the first migration:

| Field | Before | After | Reason |
|-------|--------|-------|--------|
| `Deal.contact_id` | `String?` (nullable) | `String @db.Uuid` (non-nullable) | A deal must always have a contact |
| `Message.contact_id` | `String?` (nullable) | `String @db.Uuid` (non-nullable) | A message always belongs to a contact |
| `Task.assigned_to` | `String?` (nullable) | `String @db.Uuid` (non-nullable) | Every task must be assigned to someone |
| `Org.owner_id` | `String @db.Uuid` (non-nullable) | `String? @db.Uuid` (nullable) | Register transaction creates org before user exists — owner is set in step 3 |

The `Org.owner_id → String?` change was a **new discovery this session**: the register endpoint needs a 3-step transaction (create org → create user → update org.owner_id). If `owner_id` is non-nullable, the first step fails because there's no user yet. Making it nullable solves the circular dependency without any data integrity loss — the application always sets it before returning.

**Missing dependency also discovered:** `bcryptjs` was not in `package.json` even though auth controllers require it. Added `bcryptjs: ^2.4.3` to `dependencies` and `@types/bcryptjs: ^2.4.6` to `devDependencies`.

### P1-3: Prisma Client Generation

```bash
npm run db:generate
# → npx prisma generate --schema backend/prisma/schema.prisma
```

Result: **Prisma Client v5.22.0** generated successfully into `node_modules/@prisma/client`. The `--schema` flag is required because our schema is not in the default `prisma/` location — it lives at `backend/prisma/schema.prisma`.

### P1-4: First Migration

```bash
npm run db:migrate --name sprint0_initial
# → npx prisma migrate dev --schema backend/prisma/schema.prisma --name sprint0_initial
```

Migration file created: `backend/prisma/migrations/20260503011907_sprint0_initial/migration.sql`

Applied to Supabase (public schema, AWS us-east-1). Result: **6 tables + 10 enum types** created:

Tables: `users`, `organizations`, `contacts`, `deals`, `tasks`, `messages`

Enums: `UserRole`, `OrgPlan`, `ContactType`, `ContactStatus`, `DealStatus`, `TaskPriority`, `TaskStatus`, `MessageDirection`, `MessageChannel`, `MessageStatus`

### P1-5: CLAUDE.md Created

Created `CLAUDE.md` in the project root. Contents:
- Project directory structure
- Critical rules: `npm install --legacy-peer-deps` (why + how), `async start()` pattern (why no top-level await), Fastify v5 version lock table
- Backend dev instructions: how to start, Prisma commands, singleton rule, org-scoping rule
- Auth design summary (Sprint 1 decision)
- Response envelope format
- Architectural decisions table
- Environment variable list

---

## Phase 2 — Sprint 1 Controllers

### Architecture Conflict Resolved First

Before writing any controller, discovered a contradiction between two documents:

- **API Design.md** said: *"Auth endpoints are NOT on the Fastify API. Mobile client calls Supabase Auth directly."*
- **Session prompt** said: *"Implement POST /api/v1/auth/register and POST /api/v1/auth/login on the Fastify server."*

**Resolution:** Auth controllers live on the Fastify API using bcrypt + @fastify/jwt. Supabase is used only as the PostgreSQL host for Sprint 1. Rationale:
1. The User model has a `password_hash` field — this field is useless if Supabase Auth manages passwords
2. `@fastify/jwt` is already registered in `index.ts`
3. Phase 1 only specifies `DATABASE_URL` + `JWT_SECRET` — no `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` needed
4. Fewer moving parts for Sprint 1; Supabase OAuth/magic links can be layered in later

Logged to Decision Log. API Design.md updated to reflect Sprint 1 reality.

---

### S1-1 + S1-2: Auth Register + Login

**Files created/updated:**
- `backend/api/routes/auth.ts` (new)
- `backend/api/controllers/auth.ts` (new)
- `backend/index.ts` (updated — authRoutes import + registration)

#### Route file (`backend/api/routes/auth.ts`)

Uses `FastifyPluginAsyncZod` from `fastify-type-provider-zod`. Two Zod schemas defined inline:

```ts
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  name: z.string().min(1).max(100),
  org_name: z.string().min(1).max(200),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
```

Routes: `POST /` → register, `POST /login` → login. No `preHandler` — these are public endpoints.

Registered in `index.ts` at prefix `/api/v1/auth`. So the live endpoints are:
- `POST /api/v1/auth/` — register
- `POST /api/v1/auth/login` — login

#### Register handler

Full flow:

1. Extract `{ email, password, name, org_name }` from body (Zod-validated)
2. `generateSlug(org_name)` — lowercase + replace non-alphanumeric with `-` + 5-char random alphanumeric suffix. Example: `"Acme Corp"` → `"acme-corp-x7k2m"`
3. `db.$transaction(async (tx) => {...})` — three steps inside one atomic transaction:
   - `tx.org.create({ data: { name: org_name, slug, plan: 'starter' } })` — org created with no owner yet
   - `bcrypt.hash(password, 12)` — 12 rounds of bcrypt
   - `tx.user.create({ data: { email, password_hash, name, organization_id: org.id, role: 'owner' } })`
   - `tx.org.update({ where: { id: org.id }, data: { owner_id: user.id } })` — now we can set the owner
4. `reply.jwtSign({ sub: user.id, org_id: org.id, role: user.role }, { expiresIn: '7d' })`
5. `reply.code(201).send({ data: { user: { id, email, name, role, org_id }, token } })`
6. `catch`: if `err.code === 'P2002'` (Prisma unique constraint violation) → `409 EMAIL_ALREADY_EXISTS`

#### Login handler

1. `db.user.findUnique({ where: { email } })`
2. If no user OR `!await bcrypt.compare(password, user.password_hash)` → `401 INVALID_CREDENTIALS`
3. `reply.jwtSign({ sub: user.id, org_id: user.organization_id, role: user.role }, { expiresIn: '7d' })`
4. `reply.send({ data: { user: { id, email, name, role, org_id }, token } })`

**Important:** Invalid email and invalid password return the same error (INVALID_CREDENTIALS). This is intentional — never reveal whether an email exists.

---

### S1-3 through S1-7: Contacts Controller

All 5 handlers implemented in `backend/api/controllers/contacts.ts`. 10 stub methods (bulkAssign, bulkTag, bulkArchive, importCsv, importFromPhone, getActivity, getDeals, getTasks, getMessages, getCalendarEvents) remain as 501 for Sprint 2.

#### list (GET /api/v1/contacts)

Query params (all from Zod-validated querystring — see `backend/api/routes/contacts.ts`):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `q` | string | — | Full-text search |
| `status` | enum | — | active / inactive / archived |
| `type` | enum | — | lead / customer / partner / other |
| `assigned_to` | uuid | — | Filter by assignee |
| `tag` | string | — | JSON array contains |
| `source` | string | — | Filter by source |
| `page` | number | 1 | Pagination |
| `per_page` | number | 50 | Max 100 |
| `sort` | enum | created_at | created_at / updated_at / first_name / company |
| `order` | enum | desc | asc / desc |

The `q` search runs a Prisma OR across 5 fields, all case-insensitive:
```ts
OR: [
  { first_name: { contains: q, mode: 'insensitive' } },
  { last_name: { contains: q, mode: 'insensitive' } },
  { email: { contains: q, mode: 'insensitive' } },
  { phone: { contains: q, mode: 'insensitive' } },
  { company: { contains: q, mode: 'insensitive' } },
]
```

The `tag` filter uses Prisma's JSON `array_contains` operator (PostgreSQL `@>` containment):
```ts
tags: { array_contains: tag }
```

Count and findMany run in `Promise.all` (parallel) to minimize latency. Response: `{ data: [...], meta: { total, page, per_page } }`.

Org scoping: `where.organization_id = request.user.org_id` — always present, never optional.

#### getById (GET /api/v1/contacts/:id)

Uses `findFirst` (not `findUnique`) so org scope can be part of the WHERE clause in one query:
```ts
db.contact.findFirst({ where: { id, organization_id: request.user.org_id } })
```

Includes assignee name:
```ts
include: { assignee: { select: { id: true, name: true } } }
```

Returns `404 { error: { code: 'NOT_FOUND', message: 'Contact not found' } }` if null. This fires for both "id doesn't exist" and "id exists but belongs to another org" — intentional, prevents org enumeration.

#### create (POST /api/v1/contacts)

`organization_id` and `created_by` are injected server-side from the JWT — never trusted from request body:
```ts
data: { ...body, organization_id: request.user.org_id, created_by: request.user.sub }
```

Returns 201. The `tags` field (string[]) maps to the Prisma `Json?` column — Prisma handles the array-to-JSON conversion transparently.

#### update (PATCH /api/v1/contacts/:id)

Pre-flight `findFirst` check before update:
- If null → 404 (contact doesn't exist or belongs to another org)
- If found → `db.contact.update({ where: { id }, data: body })`

Prisma naturally skips undefined fields in the `data` object — correct PATCH semantics without needing special handling. The `status` field is intentionally NOT in the Zod UpdateContactSchema (it's derived from CreateContactSchema.partial()), so status cannot be changed via PATCH. Status changes go through the archive endpoint only.

#### archive (DELETE /api/v1/contacts/:id)

Pre-flight check, then:
```ts
db.contact.update({ where: { id }, data: { status: 'archived' } })
```

Returns 200 with the archived contact object (not 204). Soft delete — record remains in the database.

---

### S1-8 + S1-9: Deals Controller

Two handlers implemented in `backend/api/controllers/deals.ts`. 15 stub methods remain for Sprint 2.

#### list (GET /api/v1/deals)

Filters:

| Param | Notes |
|-------|-------|
| `pipeline_id` | Exact match UUID |
| `stage_id` | Exact match UUID |
| `assigned_to` | Exact match UUID |
| `status` | open / won / lost / archived |
| `contact_id` | Exact match UUID |
| `q` | Title contains (case-insensitive) |

Sort options: `created_at`, `updated_at`, `value`, `expected_close`, `title`.

Always includes contact name in list results:
```ts
include: { contact: { select: { id: true, first_name: true, last_name: true } } }
```

This is critical for the deals list UI — every deal card shows the contact name.

#### create (POST /api/v1/deals)

Important detail: `expected_close` arrives as a date string (`z.string().date()` in Zod) and must be converted to a JavaScript `Date` before writing to Prisma:
```ts
expected_close: body.expected_close ? new Date(body.expected_close) : undefined,
```

The `value` field in Zod is `z.number().nonnegative()` but the Prisma column is `Decimal?`. Prisma accepts a JavaScript number for Decimal fields — automatic conversion.

`pipeline_id` and `stage_id` are required in the Zod schema but stored as `String? @db.Uuid` in Prisma (nullable in schema because the pipeline/stages tables aren't modelled yet). Sprint 2 will add Pipeline and Stage models.

Response includes contact name (same include as list).

---

## Key Technical Decisions Made Today

### 1. Auth on Fastify (not Supabase Auth)
Already in Decision Log. Short: password_hash field exists, @fastify/jwt already registered, fewer env vars needed for Sprint 1.

### 2. Org.owner_id made nullable
Solves the register circular dependency. Org is created first (no owner), User is created second (references org), then org.owner_id is updated. All within a single transaction — no window where the org is visible to queries without an owner.

### 3. Soft delete = status → 'archived' (not deleted_at)
The contacts table has no `deleted_at` column. The established schema pattern is `status = 'archived'`. This is consistent with how deals archive (DealStatus.archived) and future contact archiving.

### 4. `findFirst` over `findUnique` for org-scoped single-record queries
`findUnique` only accepts unique fields in its where clause. To combine `id` (unique) with `organization_id` (not unique) in one atomic lookup, `findFirst` is the correct Prisma method. This is semantically identical but lets us avoid a separate org-membership check.

### 5. Promise.all for count + findMany on list endpoints
Each list endpoint fires count and findMany simultaneously. At typical page sizes (50 records), this halves the DB round-trip time for paginated responses.

---

## Problems Hit Today

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Supabase PgBouncer blocks migrations | PgBouncer doesn't support Prisma's `SET` migration commands | Add `DIRECT_URL` + `directUrl` in schema.prisma |
| Password placeholder in .env | User missed `[YOUR-PASSWORD]` | User provided `HofstraNY2026` |
| JWT_EXPIRES_IN was a number | @fastify/jwt requires zeit/ms string format | Changed to `"7d"` in .env |
| bcryptjs missing from package.json | Sprint 0 scaffold omitted it | Added to dependencies + devDependencies |
| Org.owner_id was non-nullable | Register transaction needs org before user | Made `String? @db.Uuid` (nullable) |
| Auth on Fastify vs Supabase — contradiction | API Design doc written before Sprint 1 spec | Decision: auth stays on Fastify for Sprint 1 |

---

## Files Created This Session

| File | Type | Notes |
|------|------|-------|
| `backend/api/routes/auth.ts` | New | FastifyPluginAsyncZod, RegisterSchema + LoginSchema, POST / and POST /login |
| `backend/api/controllers/auth.ts` | New | register (3-step transaction) + login (bcrypt compare) |
| `CLAUDE.md` | New | Developer rules, setup instructions, architectural decisions |

## Files Updated This Session

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Added `directUrl`, fixed 4 nullable mismatches |
| `backend/index.ts` | Added authRoutes import + registration |
| `backend/api/controllers/contacts.ts` | 5 handlers implemented (list, getById, create, update, archive) |
| `backend/api/controllers/deals.ts` | 2 handlers implemented (list, create) |
| `package.json` | Added bcryptjs + @types/bcryptjs |
| `.env` | DATABASE_URL, DIRECT_URL, JWT_SECRET, JWT_EXPIRES_IN filled |
| `brain/00 - Home.md` | Updated status table |
| `brain/04 - Architecture/API Design.md` | Auth section rewritten to reflect Fastify auth |
| `brain/05 - Decisions/Decision Log.md` | 3 new Sprint 1 decisions added |
| `brain/05 - Decisions/Sprint Log.md` | All 9 tasks logged and approved |

---

## What's Pending for Sprint 2

### Contacts controller (10 stubs remaining)
- `getActivity` — interaction history timeline
- `getDeals` — deals linked to this contact
- `getTasks` — tasks linked to this contact
- `getMessages` — SMS/in-app messages for this contact
- `getCalendarEvents` — calendar events linked to this contact
- `importCsv` — CSV file parsing + bulk create
- `importFromPhone` — import from device contacts
- `bulkAssign`, `bulkTag`, `bulkArchive` — bulk operations

### Deals controller (15 stubs remaining)
- `getById`, `update`, `archive`
- `moveStage` — change deal stage (PATCH /deals/:id/stage)
- `markWon` — set status=won, actual_close date
- `markLost` — set status=lost, lost_reason
- `listPipelines`, `createPipeline`, `getPipeline`, `updatePipeline`, `deletePipeline`
- `listStages`, `createStage`, `updateStage`, `deleteStage`

### Pipeline + Stage models
`pipeline_id` and `stage_id` are referenced by deals but the Pipeline and Stage tables are not in the Prisma schema yet. These need to be added in Sprint 2 before the deals pipeline management endpoints can be implemented.

### Other controllers (all stubs)
- `backend/api/controllers/tasks.ts` — 9 methods
- `backend/api/controllers/messages.ts` — 8 methods
- `backend/api/controllers/calendar.ts` — 13 methods
- `backend/api/controllers/analytics.ts` — 12 methods

---

## What I Learned Today

**The register transaction pattern for circular foreign key dependencies.** When A requires B and B requires A, the solution is: make one side nullable, create A first (without the FK), create B (references A), then update A with the FK. All in one transaction so the intermediate state (A with null FK) is never visible to other connections. Org.owner_id is the exact case — nullable only because the transaction requires it, not because "an org can have no owner."

**`findFirst` vs `findUnique` for scoped queries.** This trips up a lot of Prisma newcomers: `findUnique` accepts only fields in `@unique` constraints. To combine a unique field (`id`) with a non-unique field (`organization_id`) in one query, use `findFirst`. The behavior is identical — both return one record or null — but `findFirst` compiles in Prisma's type system.

**JWT_EXPIRES_IN must be a string.** `@fastify/jwt` uses `jsonwebtoken` under the hood, which uses `ms` (zeit/ms) for the `expiresIn` option. A bare number is interpreted as seconds in some versions and causes undefined behavior in others. Always use the string format: `"7d"`, `"1h"`, `"30m"`.

**PgBouncer and Prisma migrations require a direct connection.** PgBouncer (connection pooler) intercepts and transforms some SQL commands Prisma relies on during `prisma migrate`. The fix is not to avoid PgBouncer — it's the right tool for production query pooling. The fix is to always have a second `DIRECT_URL` for migration-time use only. Supabase exposes both endpoints.

---

## Mood

The groundwork paid off. Phases 1 and 2 moved fast because the schema, stubs, and route files were already in place from Sessions 1–2. The session highlights were:

1. The circular FK problem with register — a genuinely interesting design constraint with a clean solution
2. The auth architecture conflict — finding and resolving a contradiction between two docs before writing a single line of controller code is exactly the kind of pre-work that prevents expensive rewrites
3. The Prisma `findFirst` vs `findUnique` nuance — good to have it documented so it doesn't get litigated again in Sprint 2

All 9 Sprint 1 controller methods are live, org-scoped, and audited. The backend can now register a new org, authenticate, and manage contacts and deals against a real Supabase database.

---

*Previous: [[Day 2]] — Sprint 0 scaffolding complete*
*Next: [[Day 4]] — Sprint 2 planning + tasks/messages controllers*

See [[Sprint Log]] for the full task-by-task log. See [[Decision Log]] for full reasoning on today's decisions.
