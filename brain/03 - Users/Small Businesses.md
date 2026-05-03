---
tags: [users, segment, small-business, growth]
status: active
related: ["Pricing Model", "Sales Pipeline", "Sales Funnel Analytics", "Reporting Dashboard", "Custom Workflows", "Mobile Field Access", "Medium Businesses"]
created: 2026-05-01
---

# Small Businesses

## Profile

- **Team size:** 10–100 people
- **Revenue range:** $1M–$50M/year
- **Industries:** Regional distributors, mid-size agencies, growing SaaS companies, professional services firms, franchise operations, wholesale businesses

## The Reality

At this scale, the CRM becomes infrastructure — not optional. There are multiple salespeople, multiple pipelines, a defined sales process, and a manager who needs real visibility into team performance. They likely have had a CRM before — Bitrix24, Salesforce, or HubSpot — and either found it too complex, too expensive, or both.

**Core pain:** Pipeline management at team scale. Ensuring deals are progressing, reps are following up, leads aren't falling through the cracks, and managers can identify problems before they become lost deals.

## Primary Needs

1. **Full pipeline management** — Complete visibility into all deals, all stages, all reps in real time ([[Sales Pipeline]])
2. **Team coordination** — Task assignment, shared contacts, [[Interaction History]] accessible by all
3. **Analytics and reporting** — Conversion rates, stage duration, win/loss, revenue forecasting ([[Sales Funnel Analytics]])
4. **Custom workflows** — Model the company's actual sales process ([[Custom Workflows]])
5. **Mobile field access** — Full CRM for reps on the road, even offline ([[Mobile Field Access]])

## Role-Based Usage

**Sales manager:** Reviews pipeline board weekly. Tracks team performance. Runs Monday standup from dashboard.

**Sales rep:** Daily tool — logs calls, updates deal stages, sets follow-up tasks, uses Kanban board for personal pipeline.

**Account manager:** Manages existing clients, tracks renewal deals, logs all interactions.

**Admin:** Manages contact database quality, configures pipeline stages and custom fields, runs and exports reports.

## Competitive Positioning

At 30 users: $720/month vs HubSpot Pro's $3,000/month. Same core features. Better mobile. That's the story for this segment.

## What They Need That MVP Partially Supports

- Multi-department isolation → v2
- SSO → v2
- API integrations with ERP → v2
- Advanced custom report builder → v1.5

## Design Implications

- Manager vs rep views must be first-class: manager lands on team overview; rep lands on their personal task list
- Bulk operations become important: bulk assign 50 contacts, bulk move deals, bulk export
- Search must handle 10,000+ contacts < 300ms
- Export and reporting must be board-presentation quality

## Related Notes

- [[Pricing Model]] — Business tier ($39/month) designed for this segment
- [[Sales Pipeline]] — core daily tool for this segment
- [[Sales Funnel Analytics]] — where marketing budget decisions come from
- [[Custom Workflows]] — pipeline customization is a differentiator at this scale
- [[Mobile Field Access]] — field sales teams need offline capability
- [[Medium Businesses]] — the next segment as they grow beyond 100 people
