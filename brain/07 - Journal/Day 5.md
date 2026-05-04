---
tags: [journal, day-5, sprint-2, calendar, analytics, deals, pipeline]
status: complete
related: ["Sprint Log", "Decision Log", "Open Questions", "API Design", "Data Models"]
created: 2026-05-03
---

# Day 5 — May 3, 2026

## What Happened Today

The heaviest coding session so far. Took Sprint 2 from tasks+messages to a nearly complete backend. Six major deliverables shipped.

---

## Schema Work (Two Migrations)

### CalendarEvent + UserCalendarSync

Added `CalendarEvent` model (23 fields including Google sync fields: `google_event_id`, `google_calendar_id`, `post_meeting_prompted`) and `UserCalendarSync` model (stores Google OAuth tokens per user, unique on `[user_id, provider]`). Also added the `CalendarEventStatus` enum.

Migration: `20260504000401_add_calendar_events`

### Pipeline + PipelineStage

Resolved Open Question A6 by adding full Prisma models for Pipeline and PipelineStage. This converted the raw `String? @db.Uuid` FK fields on Deal (`pipeline_id`, `stage_id`) into proper Prisma relations with type-safe joins.

Migration: `20260504001316_add_pipeline_stages`

---

## Calendar Controller (13 handlers)

**Core CRUD (8 handlers):**
- `list` — paginated, filtered by date range/contact/deal/status; attendee_id filter uses JSON array_contains
- `create` — injects org_id + created_by; maps `attendees` array to `attendee_ids` JSON field; status always 'scheduled'
- `getById` — includes contact (id, first_name, last_name) + deal (id, title)
- `update` — 422 guard on cancelled events; handles partial date string → Date conversion
- `cancel` — soft delete via status='cancelled'; 422 if already cancelled
- `addPostMeetingNotes` — 422 if event still 'scheduled' (hasn't happened yet); sets post_meeting_prompted=true
- `markCompleted` — toggle: completed↔scheduled; sets/clears completed_at
- `getAvailability` — UTC day range; queries by created_by IN user_ids; returns busy_slots

**Google OAuth (5 stubs):**
- `googleOAuthStart`, `googleOAuthCallback` — 501 with clear "set GOOGLE_CLIENT_ID/SECRET" message
- `googleDisconnect` — fully implemented: deletes UserCalendarSync record (hard delete is correct for OAuth disconnect)
- `syncStatus` — returns { connected, google_calendar_id, expires_at, webhook_expiry }
- `googleWebhook` — logs channel/resource headers; always 200

---

## Analytics Controller (funnel + revenue)

**funnel:**
Uses Prisma `groupBy([stage_id, status])` with `_count` and `_sum.value`. Reshapes into per-stage `{ open, won, lost, total, total_value, conversion_rate }`. Summary includes `overall_conversion_rate`.

**revenue:**
Fetches won deals with `actual_close` in range, groups by period in JavaScript via a `Map<string, { count, revenue }>`. Returns `periods[]` + summary `{ total_revenue, total_deals, avg_deal_value }`.

Key decision: application-layer grouping instead of `db.$queryRaw DATE_TRUNC` — portable, testable, sufficient at MVP data volumes. See Decision Log.

---

## Deals Controller (all 17 handlers)

Sprint 1 had only `list` and `create`. Today added all 15 stubs as real implementations:

**Deal CRUD (6 new handlers):**
- `getById` — includes contact + pipeline + stage in one query
- `update` — partial; no status guard (allow fixing won/lost deal data)
- `archive` — 422 if already archived; status='archived'
- `moveStage` — 422 if not open; validates target stage belongs to deal's pipeline
- `markWon` — 422 if already won; sets status + actual_close (defaults to now())
- `markLost` — 422 if already lost; sets status + lost_reason + actual_close

**Pipeline management (9 new handlers):**
- `listPipelines` — ordered by is_default desc; includes stages + deal count per pipeline
- `createPipeline` — if is_default=true, unsets prior default (updateMany) first
- `getPipeline` — includes stages + deal count
- `updatePipeline` — updates is_default with same deconfliction logic
- `deletePipeline` — 409 PIPELINE_HAS_OPEN_DEALS if open deals exist (with count in message)
- `listStages` — verifies pipeline belongs to org; ordered by position; includes deal count
- `createStage` — verifies pipeline org; 201
- `updateStage` — verifies stage → pipeline → org chain
- `deleteStage` — 409 STAGE_HAS_OPEN_DEALS if open deals; hard delete

---

## Default Pipeline Seeding

Added to `register` transaction in `auth.ts`. Every new org gets:
- Pipeline: "Sales Pipeline" (is_default=true)
- Stages: Lead (0), Qualified (1), Proposal (2), Closed Won (3, is_won_stage=true)

Inside the transaction = atomic: no window where org exists without a pipeline.

---

## Verification

`npm run backend:dev` → Server listening at http://127.0.0.1:3000. Zero TypeScript errors, zero startup errors.

---

## Key Decisions Made Today

1. **Pipeline/Stage = full Prisma models** — type safety + joins outweigh bare UUID approach
2. **Pipeline/Stage deletion = hard delete** — config objects, not CRM data; 409 guard prevents unsafe deletion
3. **Default pipeline in register transaction** — atomicity, not after-the-fact
4. **Revenue uses app-layer grouping** — portable over db.$queryRaw DATE_TRUNC
5. **Google OAuth = functional stubs** — model in place, credentials not yet configured

All logged to Decision Log.

---

## Stub count remaining

| Controller | Stubs left |
|-----------|-----------|
| analytics | dashboard, conversionRates, stageDuration, leadSources, winLoss, teamActivity, repPerformance, exportReport, exportStatus, exportDownload (10) |
| contacts | getActivity, getDeals, getTasks, getMessages, importCsv, importFromPhone, bulkAssign, bulkTag, bulkArchive (9) |
| calendar | googleOAuthStart, googleOAuthCallback (Google credentials needed) (2) |
| messages | twilioInboundWebhook HMAC validation (upgrade from stub, not new) |

---

## What's Next (Session 6)

1. Smoke test all new endpoints (register → verify pipeline seeded, deals pipeline CRUD, analytics)
2. Contact sub-routes: GET /contacts/:id/deals, /tasks, /messages, /activity
3. Remaining analytics: leadSources, winLoss, teamActivity, repPerformance (all pure Deal/Message queries)

---

*Previous: [[Day 4]] — Sprint 2 start: tasks + messages controllers*
*Next: [[Day 6]] — Sprint 2 wrap-up: contact sub-routes + remaining analytics*
