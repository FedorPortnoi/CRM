---
tags: [home, dashboard, index]
status: active
related: ["Vision & Philosophy", "MVP Scope", "Decision Log"]
created: 2026-05-01
---

# Mobile CRM Platform — Knowledge Brain

> **Simple. Visual. Powerful.**
> A mobile-first CRM for 1–500 person businesses.

---

## Quick Status

| Area | Status | Notes |
|------|--------|-------|
| PDF Spec | ✅ Complete | 14 features defined |
| Project Scaffold | ✅ Created | Folders + files created |
| Obsidian Brain | ✅ Active | This vault |
| Architecture Docs | ✅ Drafted | See [[System Overview]] |
| Feature Specs | ✅ Drafted | All 14 features documented |
| Backend Schema | ✅ Drafted | 5 schema files |
| Sprint 0 — Backend Scaffold | ✅ Complete | Fastify v5 server, 6 route plugins, 6 controller stubs, Prisma schema, db singleton |
| Phase 1 — Environment | ✅ Complete | Supabase project live, .env filled, migration applied, Prisma Client generated |
| Sprint 1 — Core Controllers | ✅ Complete | Auth (register + login), Contacts (CRUD + archive), Deals (list + create) |
| Sprint 2 — Tasks Controller | ✅ Complete | Tasks controller: list, create, getById, update, complete, start, cancel, dueToday, overdue |
| Sprint 2 — Messages Controller | ✅ Complete | Messages controller: list, getConversation, sendSms, sendInApp, logCall, markRead + Twilio stubs |
| Sprint 2 — Calendar Controller | ✅ Complete | Calendar controller: 8 full handlers + 5 Google sync stubs; CalendarEvent + UserCalendarSync schema |
| Sprint 2 — Analytics (funnel + revenue) | ✅ Complete | funnel: groupBy stage+status; revenue: application-layer time grouping |
| Sprint 2 — Deals controller (full) | ✅ Complete | All 17 handlers: getById, update, archive, moveStage, markWon, markLost + full pipeline/stage CRUD |
| Sprint 2 — Pipeline + Stage schema | ✅ Complete | Pipeline + PipelineStage models; migration applied; default pipeline seeded on register |
| Sprint 2 — Smoke Tests | ✅ Complete | 41 Playwright API tests across 9 suites, all green; commit 39c2209 |
| MVP Development | 🔄 In Progress | Sprint 2 wrapping up — contact sub-routes + remaining analytics next |

---

## 01 — Product

| Note | Description |
|------|-------------|
| [[Vision & Philosophy]] | Why this product exists and what it stands for |
| [[MVP Scope]] | What is and is not in the MVP |
| [[Competitive Landscape]] | Bitrix24, Salesforce, HubSpot — how we win |
| [[Pricing Model]] | Tiered pricing strategy and revenue projections |

---

## 02 — Features (14 MVP Features)

| # | Feature | Status |
|---|---------|--------|
| 1 | [[Contact Management]] | 📋 Specced |
| 2 | [[Sales Pipeline]] | 📋 Specced |
| 3 | [[Task Management]] | 📋 Specced |
| 4 | [[Call & Messaging]] | 📋 Specced |
| 5 | [[Interaction History]] | 📋 Specced |
| 6 | [[Appointment Scheduling]] | 📋 Specced |
| 7 | [[Sales Funnel Analytics]] | 📋 Specced |
| 8 | [[Reporting Dashboard]] | 📋 Specced |
| 9 | [[Mobile Field Access]] | 📋 Specced |
| 10 | [[Kanban Boards]] | 📋 Specced |
| 11 | [[Smart Data Entry]] | 📋 Specced |
| 12 | [[Auto Information Capture]] | 📋 Specced |
| 13 | [[Custom Workflows]] | 📋 Specced |
| 14 | [[Built-In Learning]] | 📋 Specced |

---

## 03 — Users

| Segment | Size | Note |
|---------|------|------|
| [[Solo Entrepreneurs]] | 1 person | Highest priority for MVP launch |
| [[Micro-Businesses]] | 2–10 people | Core growth segment |
| [[Small Businesses]] | 10–100 people | Revenue driver |
| [[Medium Businesses]] | 100–500 people | Future enterprise expansion |

---

## 04 — Architecture

| Note | Topic |
|------|-------|
| [[System Overview]] | Full architecture diagram and component responsibilities |
| [[Data Models]] | All database entities and relationships |
| [[API Design]] | REST API conventions, endpoints, auth |
| [[Tech Stack]] | Technology choices and rationale |

---

## 05 — Decisions & Questions

| Note | Topic |
|------|-------|
| [[Decision Log]] | All architectural and product decisions made |
| [[Open Questions]] | Unresolved questions blocking design or development |

---

## 06 — Competitors

| Competitor | Note |
|-----------|------|
| [[Bitrix24]] | Our primary displacement target |
| [[Salesforce]] | Aspirational competitor, not direct MVP competition |
| [[HubSpot]] | Direct comparison for mid-market positioning |

---

## 07 — Journal

| Date | Note |
|------|------|
| 2026-05-01 | [[Day 1]] — Project initiated, spec read, scaffold created |
| 2026-05-02 | [[Day 2]] — Sprint 0 complete: Fastify v5 server live, 6 controller stubs, Prisma schema, 5 open questions resolved |
| 2026-05-02 | [[Day 3]] — Phase 1 + Sprint 1 complete: Supabase live, migration applied, auth + contacts + deals controllers written |
| 2026-05-03 | [[Day 4]] — Sprint 2 start: tasks controller (9 handlers) implemented, audited, and committed |
| 2026-05-03 | [[Day 5]] — Sprint 2 bulk: calendar (13), analytics (funnel+revenue), deals (17), pipeline schema + migration, register seed |
| 2026-05-04 | [[Day 6]] — Sprint 2 smoke tests: 41 Playwright API tests, 9 suites, all green; 8 route mismatches found and fixed |

---

## Key Decisions Made

- **Tech stack:** React Native + Expo + TypeScript + Node.js + PostgreSQL + Redis
- **Architecture:** REST API (not GraphQL) + offline-first mobile
- **Pricing:** Per-seat, 3 tiers ($14 / $24 / $39 per user/month annually)
- **Competitors:** Bitrix24 is primary displacement; we win on mobile + simplicity
- **MVP scope:** All 14 features are MVP; phased by sprint (see [[MVP Scope]])

---

## Next Session Priorities

- [ ] Implement contact sub-routes: GET /contacts/:id/deals, /tasks, /messages, /activity
- [ ] Implement remaining analytics: leadSources, winLoss, teamActivity, repPerformance
- [ ] Add smoke tests for new handlers (extend existing suites)

*Last updated: 2026-05-04*
