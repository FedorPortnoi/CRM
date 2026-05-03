---
tags: [journal, day-2, sprint-0, backend]
status: complete
related: ["Decision Log", "Open Questions", "Tech Stack", "API Design", "Data Models"]
created: 2026-05-02
---

# Day 2 — May 2, 2026

## What Happened Today

Sprint 0 (backend scaffolding) completed in full. The server boots, routes are registered, the Prisma schema is in place, and all 5 blocking open questions from Day 1 are resolved.

### Files Created

| File | Purpose |
|------|---------|
| `backend/index.ts` | Fastify v5 entry point — CORS, JWT, Zod type provider, 6 route plugins, GET /health, graceful shutdown |
| `src/types/fastify.d.ts` | Module augmentation for `@fastify/jwt` — defines JWT payload shape (`sub`, `org_id`, `role`) |
| `backend/api/controllers/contacts.ts` | 15-method stub controller (list, create, getById, update, archive, bulk ops, phone import) |
| `backend/api/controllers/deals.ts` | 17-method stub controller (CRUD + pipeline/stage management + won/lost) |
| `backend/api/controllers/tasks.ts` | 9-method stub controller (CRUD + dueToday, overdue, complete, startProgress) |
| `backend/api/controllers/messages.ts` | 8-method stub controller (SMS, in-app, call log, Twilio webhooks) |
| `backend/api/controllers/calendar.ts` | 13-method stub controller (events + Google Calendar OAuth + Google webhook) |
| `backend/api/controllers/analytics.ts` | 12-method stub controller (funnel, revenue, team activity, export pipeline) |
| `backend/prisma/schema.prisma` | Prisma schema — 6 models (User, Org, Contact, Deal, Task, Message), 10 enums, UUID v4 PKs |
| `backend/services/db.ts` | Prisma client global singleton — hot-reload safe, production guard |

### Files Modified

| File | Change |
|------|--------|
| `package.json` | Upgraded Fastify from v4 → v5; aligned all `@fastify/*` plugins to v5 ecosystem versions |
| `brain/00 - Home.md` | Added Sprint 0 completion to status table |
| `brain/05 - Decisions/Decision Log.md` | Documented 3 Sprint 0 architectural decisions |
| `brain/05 - Decisions/Open Questions.md` | Resolved and archived 5 open questions |

## Key Decisions Made

### Architectural (Sprint 0)

- **Fastify v5** — Session 1 scaffold had `fastify@^4` but all ecosystem plugins (`fastify-type-provider-zod@4.x`, `@fastify/cors@11.x`, `@fastify/jwt@9.x`) require v5. Aligned everything to v5. This is the correct long-term direction; v4 is past active support.
- **`async start()` wrapper instead of top-level await** — Root `package.json` cannot have `"type": "module"` because Expo Metro requires CJS. Top-level `await` fails in CJS mode. Wrapping in `async start(); start()` costs nothing and requires no config changes.
- **`npm install --legacy-peer-deps`** — `@testing-library/react-native@12.x` has a peer dep conflict with `react@18`. Pre-existing scaffold issue. All installs must use this flag. Documented in Decision Log.

### Product (Open Questions resolved)

- **Company = text field** on Contact for MVP. No Company entity until v2. Simplifies CSV import, contact forms, and the data model. See [[Open Questions]] A1.
- **Contact merge = yes, soft merge only**. Archive the source contact; transfer all FKs (deals, tasks, messages) to the target. No schema changes required — pure service logic. Critical for CSV import usability. See [[Open Questions]] P5.
- **UUID v4** via `gen_random_uuid()` for all primary keys. No Postgres extension needed. Performance difference vs UUID v7 is immeasurable at MVP scale. See [[Open Questions]] A5.
- **Single org per user** for MVP. `users.organization_id` is a single FK. Multi-org support deferred to v2 (add `user_org_memberships` table). JWT already carries `org_id` — no token redesign needed for v2. See [[Open Questions]] M1.
- **Last Write Wins (LWW)** for offline conflict resolution, based on `updated_at` server timestamp. CRM data is low-frequency edits; true conflicts are rare for small teams. React Query handles reconciliation. v2 adds a `version` counter and 409 Conflict response. See [[Open Questions]] M2.

## What I Learned Today

**Package version alignment matters from day one.** The Session 1 scaffold had a latent peer dependency trap — `fastify@4` with plugins that required `fastify@5`. It only surfaced when we first ran `npm install`. Starting every session with a validation step (can the server start?) catches these before they compound.

**CJS/ESM matters for monorepos.** Expo Metro requires CommonJS at the root. Top-level `await` is ESM-only. The `async start()` wrapper is a single-file fix, but the underlying tension (mobile = CJS, backend = ideally ESM) will resurface when we add ESM-only backend libraries. Plan: if needed, add a `backend/package.json` with `"type": "module"` to scope ESM to the backend only — Metro won't traverse into it.

**Prisma relation naming is non-negotiable when there are multiple FKs to the same model.** User appears on Contact as both `assigned_to` and `created_by`. Without named relations (`"ContactAssignedTo"`, `"ContactCreatedBy"`), Prisma throws an ambiguity error. Every future model that has dual FKs to the same table needs this pattern.

## Blockers for Session 3

1. **Supabase project does not exist yet.** `DATABASE_URL` is empty in `.env.example`. Without it, `prisma migrate` fails.
2. **Prisma client not generated yet.** `npm run db:generate` has not been run. No controller can import `db` until it is.
3. **3 nullable mismatches in schema.prisma** need to be fixed before the first migration:
   - `Deal.contact_id` — should be non-nullable
   - `Message.contact_id` — should be non-nullable
   - `Task.assigned_to` — should be non-nullable

## What's Next

- [ ] **Create Supabase project** — get `DATABASE_URL` and `JWT_SECRET`, fill `.env`
- [ ] **Fix 3 nullable mismatches** in `schema.prisma` before `prisma migrate`
- [ ] **Run `npm run db:generate`** — generate the Prisma client
- [ ] **Run first migration** — `npm run db:migrate` or `prisma db push`
- [ ] **Sprint 1 — auth controllers** — register, login, refresh token, logout
- [ ] **Sprint 1 — contacts CRUD** — implement `ContactsController.list` and `ContactsController.create` first
- [ ] **Add CLAUDE.md** to project root with dev setup instructions (including `--legacy-peer-deps` note)

## Mood

Solid. The scaffolding is real now — you can run `npm run backend:dev` and get a live Fastify server with all 6 route groups mounted. The stubs are placeholders, not promises; every 501 is a Sprint 1 ticket waiting to happen. The open questions being resolved is the more important milestone — design ambiguity is a silent sprint killer, and we've cleared the five that were most likely to cause backtracking.

---

*Previous: [[Day 1]] — Project initiated, spec read, scaffold created*

See [[Decision Log]] for full reasoning on all decisions. See [[Open Questions]] for remaining unresolved items.
