---
tags: [sprint, log, session-3, decisions]
status: active
related: ["Decision Log", "Open Questions", "API Design", "Data Models"]
created: 2026-05-02
---

# Sprint Log

Live log of every task in every session. Updated before, during, and after each task — not in batches.

---

## Session 3 — 2026-05-02

### Pre-work: Architecture conflict resolved

**Finding:** The API Design doc (`brain/04 - Architecture/API Design.md`) states auth endpoints are NOT on the Fastify API — they're called directly from the mobile client via Supabase SDK. But the session prompt explicitly asks for `POST /api/v1/auth/register` and `POST /api/v1/auth/login` on the Fastify server.

**Decision:** Auth controllers live on the Fastify API using **bcrypt + @fastify/jwt**. Supabase is used only as the PostgreSQL host for Sprint 1. No Supabase Auth SDK on the backend.

**Why:**
- Phase 1 only specifies DATABASE_URL + JWT_SECRET — no SUPABASE_URL/SERVICE_ROLE_KEY needed
- User model has `password_hash` field — designed for custom auth, useless if Supabase Auth is used
- @fastify/jwt is already registered in index.ts
- Fewer moving parts for Sprint 1; Supabase Auth can be layered in later

**Logged to Decision Log:** yes (see below)

**API Design doc:** Updated to reflect Sprint 1 auth-on-Fastify approach.

---

### Pre-work: Missing dependency found

**Finding:** `bcryptjs` is not in `package.json`. Required for password hashing in auth controllers.

**Action taken:** Added `bcryptjs` + `@types/bcryptjs` to package.json. Will install when running `npm install --legacy-peer-deps` in Phase 1.

---

### Phase 1 — Environment Setup

---

## Task P1-1 — Supabase project creation + .env setup

**Started:** Session 3 kickoff
**Goal:** User creates Supabase project; DATABASE_URL and JWT_SECRET filled in .env

**Outcome:**
- Project ID: `tiufcjxeiorvteuypaxl` (AWS us-east-1)
- DATABASE_URL: Supabase pooler (port 6543, pgbouncer=true) — for Prisma queries
- DIRECT_URL: Supabase direct (port 5432) — for Prisma migrations
- JWT_SECRET: set (base64 string)
- Additional fixes: schema.prisma updated to add `directUrl = env("DIRECT_URL")` — required for Prisma + Supabase PgBouncer. db:* scripts updated to add `--schema backend/prisma/schema.prisma` (schema is not in default location).

**Approved:** 2026-05-02

---

## Task P1-2 — Fix nullable mismatches in schema.prisma

**Started:** 2026-05-02 Session 3 pre-work
**File:** `backend/prisma/schema.prisma`
**Goal:** Fix nullability. 4 changes total.

**Codex Prompt Sent:** N/A — mechanical edit (pure type annotations, no logic)

**Audit:**
- [x] Deal.contact_id → `String @db.Uuid` (non-nullable)
- [x] Deal.contact → `Contact` (non-optional relation)
- [x] Message.contact_id → `String @db.Uuid` (non-nullable)
- [x] Message.contact → `Contact` (non-optional relation)
- [x] Task.assigned_to → `String @db.Uuid` (non-nullable)
- [x] Task.assignee → `User` (non-optional relation)
- [x] Org.owner_id → `String? @db.Uuid` (NOW NULLABLE — for register transaction)
- [x] Org.owner → `User?` (optional relation — consistent with nullable owner_id)

**Fix tasks issued:** None
**Approved:** 2026-05-02
**Notes for Session 4:** Org.owner_id nullable is intentional — set in the register transaction after both org and user are created atomically.

---

## Task P1-3 — npm run db:generate

**Started:** 2026-05-02
**File:** `node_modules/@prisma/client` (generated)
**Result:** Prisma Client v5.22.0 generated successfully.
**Approved:** 2026-05-02

---

## Task P1-4 — First migration (sprint0_initial)

**Started:** 2026-05-02
**Migration:** `backend/prisma/migrations/20260503011907_sprint0_initial/migration.sql`
**Result:** All 6 tables (users, organizations, contacts, deals, tasks, messages) + 10 enum types created in Supabase (public schema, AWS us-east-1).
**Command used:** `npx prisma migrate dev --schema backend/prisma/schema.prisma --name sprint0_initial`
**Approved:** 2026-05-02
**Notes for Session 4:** Prisma migrations live at `backend/prisma/migrations/`. directUrl is set to DIRECT_URL for migration compatibility with Supabase PgBouncer.

---

## Task P1-5 — Create CLAUDE.md

**Started:** 2026-05-02 Session 3 pre-work
**File:** `CLAUDE.md` in project root

**Codex Prompt Sent:** N/A — reference/config document, not business logic

**Audit:** Contains: --legacy-peer-deps warning, async start() explanation, Fastify v5 version lock table, Prisma singleton rule, org-scoping rule, auth design, response envelope, env var list, brain index.

**Fix tasks issued:** None
**Approved:** 2026-05-02

---

### Phase 2 — Sprint 1 Controllers

---

## Task S1-1 — Auth route file + auth register controller

**Started:** 2026-05-02
**Files:** `backend/api/routes/auth.ts` (new), `backend/api/controllers/auth.ts` (new), `backend/index.ts` (updated)
**Goal:** POST /api/v1/auth/register — create org + user atomically (bcrypt hash), return JWT

**Audit:**
- [x] `backend/api/routes/auth.ts` — FastifyPluginAsyncZod, RegisterSchema + LoginSchema inline, POST / and POST /login, no JWT preHandler
- [x] `backend/api/controllers/auth.ts` — register: transaction (org → user → org.owner_id update), bcrypt 12 rounds, slug generated, envelope { data: { user, token } }, P2002 → 409
- [x] `backend/index.ts` — authRoutes imported and registered before contactsRoutes at /api/v1/auth

**Approved:** 2026-05-02

---

## Task S1-2 — Auth login controller

**Started:** 2026-05-02
**File:** `backend/api/controllers/auth.ts` (implemented with S1-1)
**Goal:** POST /api/v1/auth/login — validate email + bcrypt, return JWT

**Audit:**
- [x] findUnique by email, bcrypt.compare, 401 on mismatch
- [x] JWT payload: { sub, org_id, role }, expiresIn from env
- [x] Envelope { data: { user, token } }

**Approved:** 2026-05-02

---

## Task S1-3 — Contacts list

**Started:** 2026-05-02
**File:** `backend/api/controllers/contacts.ts`
**Goal:** GET /api/v1/contacts — paginated, org-scoped, filterable

**Audit:**
- [x] where.organization_id = request.user.org_id on every query
- [x] Filters: q (OR across first_name/last_name/email/phone/company, insensitive), status, type, assigned_to, tag (JSON array_contains)
- [x] Pagination: skip=(page-1)*per_page, take=per_page; count+findMany in parallel
- [x] Response: { data: [...], meta: { total, page, per_page } }

**Approved:** 2026-05-02

---

## Task S1-4 — Contact get by ID

**Started:** 2026-05-02
**File:** `backend/api/controllers/contacts.ts`
**Goal:** GET /api/v1/contacts/:id — org-scoped, 404 if not found, include assignee name

**Audit:**
- [x] findFirst with { id, organization_id } — org-scoped
- [x] include: { assignee: { select: { id, name } } }
- [x] 404 NOT_FOUND if null

**Approved:** 2026-05-02

---

## Task S1-5 — Contact create

**Started:** 2026-05-02
**File:** `backend/api/controllers/contacts.ts`
**Goal:** POST /api/v1/contacts — create with org_id + created_by from JWT, return 201

**Audit:**
- [x] organization_id: request.user.org_id, created_by: request.user.sub injected server-side
- [x] Body spread from Zod-validated request.body
- [x] Response 201 { data: contact }

**Approved:** 2026-05-02

---

## Task S1-6 — Contact update

**Started:** 2026-05-02
**File:** `backend/api/controllers/contacts.ts`
**Goal:** PATCH /api/v1/contacts/:id — partial update, 404 if not org-owned

**Audit:**
- [x] findFirst check with { id, organization_id } before update
- [x] update only provided fields (Prisma skips undefined)
- [x] 404 NOT_FOUND if not owned

**Approved:** 2026-05-02

---

## Task S1-7 — Contact soft delete

**Started:** 2026-05-02
**File:** `backend/api/controllers/contacts.ts`
**Note:** Soft delete = status → 'archived'. Schema has no deleted_at column.
**Goal:** DELETE /api/v1/contacts/:id → set status='archived', return updated contact

**Audit:**
- [x] findFirst check with { id, organization_id } before update
- [x] update: { status: 'archived' }
- [x] 404 NOT_FOUND if not owned
- [x] Returns 200 with archived contact data

**Approved:** 2026-05-02

---

## Task S1-8 — Deals list

**Started:** 2026-05-02
**File:** `backend/api/controllers/deals.ts`
**Goal:** GET /api/v1/deals — paginated, org-scoped, include contact name

**Audit:**
- [x] where.organization_id = request.user.org_id
- [x] Filters: pipeline_id, stage_id, assigned_to, status, contact_id, q (title contains, insensitive)
- [x] include: { contact: { select: { id, first_name, last_name } } } — contact name included
- [x] Pagination + orderBy [sort]: order; count+findMany in parallel
- [x] Response: { data: [...], meta: { total, page, per_page } }

**Approved:** 2026-05-02

---

## Task S1-9 — Deal create

**Started:** 2026-05-02
**File:** `backend/api/controllers/deals.ts`
**Goal:** POST /api/v1/deals — create with org_id + created_by from JWT

**Audit:**
- [x] organization_id: request.user.org_id, created_by: request.user.sub injected server-side
- [x] expected_close: string → new Date() conversion
- [x] include contact name in response
- [x] Response 201 { data: deal }

**Approved:** 2026-05-02

---

## Session 3 — Handoff to Session 4

**Sprint 1 status:** All planned tasks complete (S1-1 through S1-9).

**Files written this session:**
- `backend/api/routes/auth.ts` — new
- `backend/api/controllers/auth.ts` — new (register + login)
- `backend/index.ts` — updated (authRoutes added)
- `backend/api/controllers/contacts.ts` — list, create, getById, update, archive implemented
- `backend/api/controllers/deals.ts` — list, create implemented

**Stub methods remaining (Sprint 2+):**
- Contacts: getActivity, getDeals, getTasks, getMessages, getCalendarEvents, importCsv, importFromPhone, bulkAssign, bulkTag, bulkArchive
- Deals: getById, update, archive, moveStage, markWon, markLost, listPipelines, createPipeline, getPipeline, updatePipeline, deletePipeline, listStages, createStage, updateStage, deleteStage

**Next session priorities:**
1. `npm install --legacy-peer-deps` — install bcryptjs if not already done
2. `npm run backend:dev` — smoke test the server starts without TypeScript errors
3. Manual API test: POST /api/v1/auth/register, POST /api/v1/auth/login
4. Sprint 2 planning — tasks, messages, and remaining deal/contact endpoints

---

## Session 4 — 2026-05-03

---

## Task S2-1 — Tasks controller

**Started:** 2026-05-03
**File:** `backend/api/controllers/tasks.ts` (new)
**Goal:** Implement full tasks controller — GET / (list+filter), POST / (create), GET /today, GET /overdue, GET /:id, PATCH /:id, DELETE /:id (soft delete), POST /:id/complete (toggle), POST /:id/start

**Codex Prompt:** 5-block format (CONTEXT / TASK / CONSTRAINTS / OUTPUT / VALIDATION). 9 handlers typed with FastifyRequest generics, Prisma singleton, org scoping, soft delete via status='cancelled', UTC date range for dueToday.

**Audit:**
- [x] Zero `any` — all handlers typed with FastifyRequest<{...}> generics; TaskPriority + TaskStatus from @prisma/client
- [x] TasksController named export with exactly 9 keys: list, create, getById, update, complete, startProgress, cancel, dueToday, overdue
- [x] Every Prisma findFirst/findMany/count includes organization_id: request.user.org_id
- [x] No new PrismaClient() — only import { db } from '../../services/db'
- [x] cancel: status='cancelled', no db.task.delete call
- [x] complete: cancelled→422, done↔pending toggle with completed_at/completed_by set/cleared
- [x] startProgress: 422 INVALID_STATUS_TRANSITION if status≠pending
- [x] dueToday: setUTCHours(0,0,0,0) + setUTCDate(+1) UTC midnight range
- [x] list: findMany + count via Promise.all in parallel
- [x] All responses use { data, meta } or { error: { code, message } } envelope
- [x] No request.jwtVerify() calls; every early reply.send() followed by return

**Defect found (audit):** due_before + due_after in list handler used sequential spread — second spread overwrote due_date key, silently dropping the `lt` constraint when both params present. Fixed to single nested due_date object.

**Fix dispatched:** Codex sandbox blocked write; fix applied directly.
**Approved:** 2026-05-03

---

## Task S2-2 — Messages controller

**Started:** 2026-05-03
**File:** `backend/api/controllers/messages.ts` (new)
**Goal:** Implement full messages controller — append-only interaction log scoped to contacts. GET / (list), GET /conversation/:contact_id, POST /sms, POST /in-app, POST /call, POST /:id/read, POST /webhooks/twilio/inbound (stub), POST /webhooks/twilio/status (stub)

**Codex Prompt:** 5-block format. 8 handlers, MessageDirection/MessageChannel/MessageStatus enums, contact ownership verified before every create, Twilio stubs with try/catch always returning 200. Key design decisions: no `call` enum value → channel: in_app for calls; occurred_at maps to created_at.

**Audit:**
- [x] Zero `any` — all handlers typed with FastifyRequest<{...}> generics
- [x] MessagesController named export with exactly 8 keys: list, getConversation, sendSms, sendInApp, logCall, markRead, twilioInboundWebhook, twilioStatusWebhook
- [x] Every non-webhook Prisma query includes organization_id: request.user.org_id
- [x] No db.message.delete anywhere — append-only enforced
- [x] markRead only updates status + read_at; never body
- [x] twilioStatusWebhook only updates status/delivered_at/error_message; never body
- [x] logCall uses channel: MessageChannel.in_app; occurred_at maps to created_at
- [x] list runs findMany + count via Promise.all
- [x] Contact ownership verified in sendSms, sendInApp, logCall, getConversation
- [x] Twilio handlers wrapped in try/catch; always return 200

**Defect found (audit):** logCall body empty string when notes: '' (empty, not undefined) and no duration_seconds — `??` does not fall back on empty strings. Fixed: `(durationPrefix + (notes?.trim() ?? '')).trim() || 'Call logged'`

**Fix dispatched:** Applied directly (Codex sandbox read-only).
**Approved:** 2026-05-03

---

## Session 4 — Handoff to Session 5

**Sprint 2 status:** Tasks controller (S2-1) + Messages controller (S2-2) complete.

**Files written this session:**
- `backend/api/controllers/tasks.ts` — new (9 handlers)
- `backend/api/controllers/messages.ts` — new (8 handlers: list, getConversation, sendSms, sendInApp, logCall, markRead, twilioInboundWebhook, twilioStatusWebhook)
- `.gitignore` — new
- `brain/00 - Home.md` — updated
- `brain/05 - Decisions/Sprint Log.md` — Session 4 logged
- `brain/07 - Journal/Day 4.md` — new + updated

**Stub methods remaining (Sprint 2+):**
- Deals: getById, update, archive, moveStage, markWon, markLost
- Contacts: getActivity, getDeals, getTasks, getMessages, importCsv, etc.

**Next session priorities:**
1. `npm run backend:dev` — verify tasks + messages controllers compile, no TS errors
2. Manual API test: POST /api/v1/messages/sms, GET /api/v1/messages/conversation/:id, POST /api/v1/messages/call
3. Sprint 2 continuation — deals remaining endpoints (getById, update, archive, moveStage, markWon, markLost)

---
