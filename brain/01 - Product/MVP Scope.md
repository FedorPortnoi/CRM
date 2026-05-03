---
tags: [product, mvp, scope, planning]
status: active
related: ["Vision & Philosophy", "Decision Log", "Open Questions", "Roadmap"]
created: 2026-05-01
---

# MVP Scope

## What Is In the MVP

All 14 features below are in the MVP (v1.0). They are a single, cohesive product — not modular. Each feature depends on and amplifies the others.

| # | Feature | Core Value |
|---|---------|-----------|
| 1 | [[Contact Management]] | The foundation — every relationship lives here |
| 2 | [[Sales Pipeline]] | Visual deal tracking from first contact to close |
| 3 | [[Task Management]] | Follow-ups with automated reminders |
| 4 | [[Call & Messaging]] | Communication from inside the CRM |
| 5 | [[Interaction History]] | Complete relationship memory — automatic |
| 6 | [[Appointment Scheduling]] | Calendar + meeting management |
| 7 | [[Sales Funnel Analytics]] | Where leads come from, where they drop off |
| 8 | [[Reporting Dashboard]] | The daily command center |
| 9 | [[Mobile Field Access]] | Offline-first, always-on mobile capability |
| 10 | [[Kanban Boards]] | Visual boards for pipeline and tasks |
| 11 | [[Smart Data Entry]] | Business card OCR, voice notes, flexible input |
| 12 | [[Auto Information Capture]] | Calls and messages logged automatically |
| 13 | [[Custom Workflows]] | Customizable stages, fields, and automation rules |
| 14 | [[Built-In Learning]] | Contextual help, tutorials, onboarding |

## What Is NOT In the MVP

These were explicitly excluded to keep the MVP focused and shippable in 5–6 months:

| Feature | Why Excluded | Target Version |
|---------|-------------|---------------|
| Company entities (separate from contacts) | Scope creep; field on contact works for MVP | v2 |
| Multi-department data isolation | Not needed at solo/micro/small scale | v2 |
| SSO (SAML, Google Workspace) | No IT departments in target segment | v2 |
| API access / webhooks | Not needed for direct users | v1.5/v2 |
| VoIP calling (in-app telephony) | High complexity; native dialer is sufficient | v2 |
| WhatsApp integration | Different platform; SMS sufficient | v2 |
| Email marketing campaigns | Wrong product category | Never |
| Advanced report builder | Predefined reports sufficient for MVP | v1.5 |
| Booking link (self-scheduling for contacts) | Significant scope; good v1.5 feature | v1.5 |
| Deal sub-tasks / complex projects | Out of scope for sales CRM | Post-v2 |
| Kanban swimlanes | Good for managers; complex mobile UX | v1.5 |
| On-premise / self-hosted | Wrong market for MVP | Post-v2 |
| Invoice generation | ERP territory | Never |
| AI features | High value but deferred | v2 |

## MVP Sprint Plan

| Sprint | Focus |
|--------|-------|
| 1 | Auth, org setup, user management |
| 2 | [[Contact Management]] |
| 3 | [[Sales Pipeline]] + [[Kanban Boards]] |
| 4 | [[Task Management]] |
| 5 | [[Call & Messaging]] + [[Auto Information Capture]] |
| 6 | [[Appointment Scheduling]] |
| 7 | [[Sales Funnel Analytics]] + [[Reporting Dashboard]] |
| 8 | [[Smart Data Entry]] (OCR, voice) |
| 9 | [[Mobile Field Access]] (offline sync) |
| 10 | [[Custom Workflows]] + [[Built-In Learning]] |
| Beta | 20 pilot companies |
| Launch | App Store + Play Store |

## Scope Decision Log

See [[Decision Log]] for the reasoning behind each major inclusion/exclusion decision.

## Open Questions About MVP Scope

See [[Open Questions]] for unresolved debates, particularly around:
- Whether sub-tasks are MVP
- Whether time-based automation triggers are MVP
- Whether email integration is MVP or v1.5
