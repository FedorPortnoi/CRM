---
tags: [journal, day-6, sprint-2, smoke-tests, playwright]
status: complete
related: ["Sprint Log", "Decision Log", "Open Questions", "API Design"]
created: 2026-05-04
---

# Day 6 — May 4, 2026

## What Happened Today

Sprint 2 smoke testing session. No new feature code — pure verification of everything built in Sprint 2.

---

## Playwright Setup

Installed `@playwright/test` as a dev dependency. Created:

- `playwright.config.ts` — baseURL: localhost:3000, timeout: 10s, workers: 1, globalSetup pointing to helpers
- `tests/smoke/helpers/global-setup.ts` — registers a fresh `smoke-${Date.now()}@test.com` user per run, saves JWT + userId to `.auth.json`
- `tests/smoke/helpers/auth.ts` — `getAuth()` helper reads `.auth.json` for shared JWT

No browser downloads needed — API testing only via Playwright's `APIRequestContext`.

---

## 9 Smoke Suites — 41 Tests Total

| Suite | Tests | Notes |
|-------|-------|-------|
| 00-health | 1 | GET /health → 200 |
| 01-auth | 3 | register token, login, wrong password 401 |
| 02-contacts | 5 | list, create, getById, update, archive (status=archived) |
| 03-deals | 6 | list, create, getById, update, markWon, markLost |
| 04-tasks | 7 | list, create, getById, complete (status=done), cancel, today, overdue |
| 05-messages | 4 | list, in-app send, log-call, conversation thread |
| 06-calendar | 7 | list, create, update, cancel (DELETE), availability, sync/status, Google OAuth 501 |
| 07-analytics | 2 | funnel, revenue (period=month) |
| 08-pipelines | 6 | default pipeline seeded, 4 stages in order, create, update, add stage, delete |

**Final result: 41 passed (56.5s)**

---

## Bugs Found and Fixed

### 1. Global setup URL wrong
- **Bug:** global-setup used `POST /api/v1/auth/register` — doesn't exist
- **Fix:** Route is `POST /api/v1/auth/` (prefix-only), body uses `name` not `first_name/last_name`

### 2. Global `Content-Type: application/json` broke DELETE requests
- **Bug:** `extraHTTPHeaders: { 'Content-Type': 'application/json' }` in playwright.config sent the header on all requests including DELETEs with no body, causing Fastify to try JSON-parse an empty body → 400
- **Fix:** Removed from global config; Playwright auto-sets Content-Type only when `data:` is provided

### 3. Deals create missing required fields
- **Bug:** `CreateDealSchema` requires `pipeline_id` and `stage_id` (both UUIDs, not optional) — test was sending only `title` and `contact_id`
- **Fix:** `beforeAll` fetches default pipeline + first stage, uses those IDs in all deal creates

### 4. markWon/markLost wrong method
- **Bug:** Tests used `PATCH /:id/won` — routes are `POST /:id/won` and `POST /:id/lost`
- **Fix:** Changed to `request.post()`. Also `markWon` body must be `{}` (not missing) since `WonSchema` has a body schema even though all fields are optional

### 5. Wrong field names in test assertions
- `lost_reason` → `reason` (per `LostReasonSchema`)
- `body.data.type` → `body.data.channel` (Message model uses `channel` enum, not `type`)
- `body.data.status === 'completed'` → `'done'` (per TaskStatus enum)

### 6. Task route names wrong
- `POST /tasks/:id/complete` not `PATCH`
- `GET /tasks/today` not `GET /tasks/due-today`

### 7. Calendar field names wrong
- `start_at`/`end_at` → `start_time`/`end_time` (per `CreateEventSchema`)
- Cancel is `DELETE /:id` not `PATCH /:id/cancel`
- Google OAuth start is `GET /sync/google/auth` not `GET /sync/google`

### 8. AvailabilitySchema user_ids as string
- **Bug:** Fastify's querystring parser sends a single `?user_ids=uuid` as a string, but `AvailabilitySchema` expects `z.array(...)` — Zod rejects string with `Expected array, received string`
- **Fix:** Added `z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(...))` to `user_ids` in `calendar.ts` routes; also `z.coerce.number()` for `duration_minutes`

---

## Key Decision Made Today

**AvailabilitySchema preprocess for user_ids** — Fastify querystring parser doesn't wrap single values in arrays. `z.preprocess` in `fastify-type-provider-zod@4` runs before Zod type validation, so the string→array coercion works. Logged to Decision Log.

---

## Commit

`39c2209` — Sprint 2 smoke tests: 41 tests across 9 suites, all green

---

## What's Next (Session 7)

- Contact sub-routes: GET /contacts/:id/deals, /tasks, /messages, /activity
- Remaining analytics: leadSources, winLoss, teamActivity, repPerformance

---

*Previous: [[Day 5]] — Sprint 2 bulk: calendar, analytics, deals, pipeline*
*Next: [[Day 7]] — Sprint 2 wrap-up: contact sub-routes + remaining analytics*
