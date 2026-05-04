---
tags: [decisions, questions, open, unresolved]
status: active
related: ["Decision Log", "MVP Scope", "Contact Management", "Sales Pipeline", "Custom Workflows", "Pricing Model"]
created: 2026-05-01
updated: 2026-05-02 (Session 3)
---

# Open Questions

Unresolved questions that are blocking design or development decisions. Each question should be answered before the relevant sprint begins.

## Product & Scope

| # | Question | Blocking | Priority | Notes |
|---|----------|----------|---------|-------|
| P1 | Should we offer a free solo tier to maximize top-of-funnel, or stick with 14-day trial only? | [[Pricing Model]] | High | Free tier risk: reduces paid conversion; benefit: brand + organic growth |
| P2 | Is sub-task support (checklist items on tasks) in MVP or v1.5? | Sprint 4 | Medium | High value for complex follow-up sequences; implementation adds 2 sprints |
| P3 | Are time-based automation triggers ("if deal in stage X for 7+ days") in MVP or v1.5? | Sprint 10 | High | Requires cron-based rule evaluator; doubles automation engine complexity |
| P4 | Is a public booking link (Calendly-style) in MVP or v1.5? | Sprint 6 | Low | Significant scope; confirmed: v1.5 |
| P5 | ~~Should we support contact merge (combining two duplicates into one)?~~ | ~~Sprint 2~~ | ~~High~~ | **RESOLVED 2026-05-02 → See Answered Questions** |
| P6 | Is email integration (Gmail/Outlook OAuth for logging email threads) MVP or v1.5? | Sprint 5 | Medium | Different from forward-to-log feature; requires OAuth for both Gmail and Outlook |

## Data Model & Architecture

| # | Question | Blocking | Priority | Notes |
|---|----------|----------|---------|-------|
| A1 | ~~Is Company a separate entity or a field on Contact for MVP?~~ | ~~Sprint 2~~ | ~~High~~ | **RESOLVED 2026-05-02 → See Answered Questions** |
| A2 | Should custom field values be stored in JSONB (current plan) or in a separate EAV table? | Sprint 10 | Medium | JSONB is simpler and faster to query; EAV is more flexible for reporting. Recommendation: JSONB for MVP |
| A3 | What is the maximum offline cache size per device? | Sprint 9 | Medium | Proposed: 2,000 most recently accessed contacts + all deals + all user's tasks |
| A4 | Should we support soft-delete (archive) only, or also hard delete for GDPR compliance from day one? | Sprint 2 | High | GDPR requires hard delete capability; implement as a separate GDPR delete endpoint |
| A5 | ~~UUID v4 (random) or UUID v7 (timestamp-ordered) for primary keys?~~ | ~~Sprint 1~~ | ~~Low~~ | **RESOLVED 2026-05-02 → See Answered Questions** |
| A6 | ~~Pipeline and Stage — separate Prisma models or just UUIDs on Deal?~~ | ~~Sprint 2~~ | ~~High~~ | **RESOLVED 2026-05-03 → See Answered Questions** |

## UX & Design

| # | Question | Blocking | Priority | Notes |
|---|----------|----------|---------|-------|
| U1 | Should dashboard widgets be drag-and-drop reorderable? | Sprint 7 | Medium | Long-press drag pattern on mobile; required for [[Reporting Dashboard]] personalization |
| U2 | Should there be a Board/List toggle on pipeline and task screens? | Sprint 3 | High | Both views of same data; different preferences for different users |
| U3 | Should tags be org-wide shared or per-user on contacts? | Sprint 2 | Medium | Org-wide shared is simpler and more useful for team collaboration |
| U4 | Should there be a "disable all hints" option immediately, or only after 30 days? | Sprint 10 | Low | Recommended: available immediately in Settings; no forced period |
| U5 | Should activity notes be editable after creation? | Sprint 2 | Medium | Proposed: editable within 10 minutes; locked after (append-only principle) |

## Business & Pricing

| # | Question | Blocking | Priority | Notes |
|---|----------|----------|---------|-------|
| B1 | Per-org SMS bundles vs. per-user SMS allocation — which is simpler? | [[Pricing Model]] | Medium | Per-org is simpler to explain and less punishing for teams |
| B2 | At what org size do we switch to custom/enterprise pricing? | [[Pricing Model]] | Low | Proposed: 100+ users gets a call; 200+ users gets custom contract |
| B3 | Should API access be gated to Business tier, or available to all paid plans? | [[Pricing Model]] | Medium | Business tier gating protects support costs (API users generate more tickets) |
| B4 | Should we offer startup discounts (50% off first 6 months)? | [[Pricing Model]] | Low | Helps top-of-funnel; requires verification process |
| B5 | Should we enter the Russian/CIS market directly, where Bitrix24 dominates? | Strategy | Medium | High TAM but geopolitical complexity; evaluate post-MVP |

## Answered Questions (Archive)

| # | Question | Answer | Date |
|---|----------|--------|------|
| Q1 | REST vs GraphQL? | REST for MVP | 2026-05-01 |
| Q2 | React Native vs Flutter? | React Native + Expo | 2026-05-01 |
| Q3 | Freemium vs free trial? | 14-day full-featured trial, no freemium | 2026-05-01 |
| Q4 | Drizzle vs Prisma? | Drizzle ORM | 2026-05-01 |
| Q5 | All 14 features in MVP or phased? | All 14 in MVP — they're interdependent | 2026-05-01 |
| A1 | Company entity vs text field on Contact? | **Text field on Contact for MVP; Company entity deferred to v2.** `contact.company String?` is already in the Prisma schema. A Company entity requires a new table, join logic, and management UI — unnecessary complexity at MVP scale. CSV import maps a column to the text field with zero friction. Data migration to a Company entity is feasible in v2. | 2026-05-02 |
| P5 | Support contact merge (two duplicates → one)? | **Yes — soft merge only in MVP.** Operation: transfer all related records (deals, tasks, messages) from source contact to target contact by updating `contact_id`, then archive the source (`status = 'archived'`). No schema changes required — pure service logic. Without merge, CSV import creates unresolvable duplicates. Hard delete for GDPR compliance (A4) is a separate feature. | 2026-05-02 |
| A5 | UUID v4 or UUID v7 for primary keys? | **UUID v4 via `gen_random_uuid()` — no custom extension.** `gen_random_uuid()` is built-in PostgreSQL; works on Supabase with zero setup. At MVP scale (< 50K records) B-tree fragmentation from random UUIDs is unmeasurable. Migrate to UUID v7 or ULID only if performance profiling identifies index bloat as a real bottleneck. Prisma schema already uses `@default(dbgenerated("gen_random_uuid()"))` — no change needed. | 2026-05-02 |
| M1 | Can one user belong to multiple organizations? | **No — single org per user for MVP.** `users.organization_id` remains a single FK. Multi-org adds complexity to JWT scoping, RLS policies, and a mobile org-switcher UI. The JWT payload already carries `org_id` — v2 path is: add `user_org_memberships(user_id, org_id, role)` table + login org-selection without changing token structure. Solo entrepreneurs and micro-businesses (top priority segments) are definitively single-org. | 2026-05-02 |
| M2 | Offline conflict resolution — who wins when two users sync conflicting edits? | **Last Write Wins (LWW) based on server `updated_at` timestamp.** CRM records (deals, contacts, tasks) are low-frequency edits — true simultaneous offline conflicts on the same field are rare for 1-10 person teams. React Query's optimistic update pattern handles server reconciliation: client applies change → server validates → client re-fetches if server version is newer. `updated_at` exists on all mutable entities. Activity log provides audit trail for any conflict silently resolved. v2 path: add `version` integer counter, return 409 Conflict on stale write, add conflict resolution UI to mobile app. | 2026-05-02 |
| A6 | Pipeline and Stage — separate Prisma models or just UUIDs on Deal? | **Full Prisma models (Pipeline + PipelineStage).** Added Pipeline + PipelineStage models with full relations. Reasons: type-safe joins for name includes; cascade delete support; migration path for stage history table. Migration `20260504001316_add_pipeline_stages` applied. | 2026-05-03 |

See [[Decision Log]] for full reasoning on answered questions.
