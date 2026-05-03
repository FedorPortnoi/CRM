---
tags: [feature, mvp, analytics, funnel, reporting]
status: specced
related: ["Sales Pipeline", "Reporting Dashboard", "Contact Management", "Custom Workflows", "Small Businesses", "Medium Businesses"]
created: 2026-05-01
---

# Sales Funnel Analytics

## Overview

Answers the questions every business owner has but can't answer: Where are my leads coming from? Where are they dropping off? Why am I winning or losing deals? How long does a typical sale take?

Full funnel visualization from first contact to closed deal with conversion rates at every stage. If 100 leads enter the pipeline and only 10 close, this feature shows exactly which stage loses the most — that's where the business needs to focus.

All analytics data comes from the [[Sales Pipeline]] data + [[Interaction History]] activity log. [[Data Models]] detail the `deal_stage_history` table that powers stage duration metrics.

## Why It Matters

Data-driven sales teams outperform intuition-driven teams by 20–40% in most studies. But most SMBs don't have access to real analytics — they're guessing. This feature gives a 5-person company the same analytical capability that enterprise teams have, without requiring a data analyst.

For [[Small Businesses]] and [[Medium Businesses]], the win/loss analysis and lead source breakdown directly inform where to spend marketing budget. "Our trade show leads close at 35% vs. our website leads at 12%" is the kind of insight that changes budget allocations.

## User Stories

- As a business owner, I want to see a visual funnel showing deal conversion per stage so I can identify where I'm losing opportunities
- As a sales manager, I want to see which lead sources produce the highest-value deals so I can focus marketing budget
- As a sales rep, I want to see how long my deals have been in each stage vs team average so I know which need attention
- As a business owner, I want monthly revenue from closed deals for the past 12 months to spot trends
- As a manager, I want a breakdown of lost deals by reason to identify systemic problems
- As an analyst, I want to export a custom date range report as CSV

## Acceptance Criteria

- Funnel visualization: chart showing deal count + value per stage, conversion rate between adjacent stages
- Date range filter, pipeline filter
- Conversion rate: `deals_that_exited_stage_as_won / deals_that_entered_stage × 100`
- Average stage duration from `deal_stage_history` table
- Lead source breakdown: pie/bar chart by deal.source
- Win/loss analysis: win rate + loss reasons breakdown
- Revenue report: monthly/quarterly bar chart
- Team performance: per-rep metrics (deals created, won, value, avg size, win rate)
- All reports exportable as CSV or PDF
- Analytics recalculate within 15 minutes of deal change (batch, not real-time)

## Technical Notes

- `deal_stage_history`: (deal_id, stage_id, entered_at, exited_at) — populated by trigger on deal stage change
- Analytics queries run on read replica or dedicated connection pool
- Materialized views: `mv_monthly_revenue`, `mv_stage_conversion`, `mv_lead_sources` — refreshed every 15 min via cron
- Chart rendering: Victory Native (SVG charts, no WebView)
- PDF export: Puppeteer headless render → S3 pre-signed URL with 1-hour expiry
- CSV: streaming PostgreSQL cursor via `pg-query-stream`

## Related Features

- [[Sales Pipeline]] — source data for all analytics
- [[Reporting Dashboard]] — summary of analytics on home screen
- [[Contact Management]] — lead source tracked on contacts
- [[Custom Workflows]] — pipeline customization affects which stages appear in funnel
- [[Data Models]] — `deal_stage_history` table design

## Open Questions

1. Should analytics be real-time (expensive) or batch-computed every 15 min? (Proposed: batch — acceptable latency)
2. Should reps see only their own analytics, or can they see the team? (Proposed: reps see own, managers see team)
3. Do we need forecasting (predicted next month's revenue)? (v1.5 — needs historical data)
4. Should there be a custom report builder? (Proposed: v1.5 — predefined reports for MVP)
5. Should deal targets/quotas be set per rep and tracked? (Post-MVP — significant feature)
