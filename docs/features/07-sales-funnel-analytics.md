# Feature 07: Sales Funnel & End-to-End Lead Analytics

## Overview

Sales Funnel Analytics answers the questions every business owner has but often can't answer: Where are my leads coming from? Where are they dropping off? Why am I winning or losing deals? How long does a typical sale take? These insights are what turn a reactive sales team into a data-driven one.

The full funnel visualization shows the journey from first contact to closed deal, with conversion rates at every stage. If 100 leads enter the pipeline and only 10 close, the funnel shows exactly which stage loses the most — and that is where the business needs to focus. Average time per stage reveals bottlenecks: if deals sit in "Proposal Sent" for an average of 3 weeks, that is a process problem, not a product problem.

Lead source tracking connects marketing effort to revenue: was this month's best deal from a referral, a trade show, the website, or a cold outreach campaign? Win/loss analysis surfaces patterns in what closes and what doesn't.

## User Stories

- **As a business owner**, I want to see a visual funnel showing how many deals are in each stage and what percentage convert so that I can identify where I'm losing opportunities.
- **As a sales manager**, I want to see which lead sources produce the highest-value closed deals so that I can focus marketing budget accordingly.
- **As a sales rep**, I want to see how long my deals have been sitting in each stage compared to the team average so that I know which deals need immediate attention.
- **As a business owner**, I want to see monthly revenue from closed deals for the past 12 months so that I can spot trends and set realistic targets.
- **As a manager**, I want to see a breakdown of deals lost by reason so that I can identify systemic problems (price, timing, competitor, feature gaps).
- **As an analyst**, I want to export a custom date range revenue report as CSV so that I can import it into our accounting software.

## Acceptance Criteria

- Full funnel visualization: bar/funnel chart showing deal count and total value per stage, with conversion rate between adjacent stages
- Date range filter: today, this week, this month, this quarter, this year, custom range — applies to all analytics views
- Pipeline filter: view analytics for one specific pipeline or all pipelines combined
- Conversion rate: `deals_that_exited_stage_as_won / deals_that_entered_stage * 100` for each stage
- Average stage duration: mean of `(exited_at - entered_at)` for deals that passed through each stage (in days)
- Lead source breakdown: pie/bar chart grouping deals by `deal.source` field; includes count and total value
- Win/loss analysis: win rate = `won / (won + lost)`; loss reasons broken down by frequency
- Revenue report: monthly/quarterly bar chart of closed deal values; filterable by pipeline, assigned rep
- Team performance: per-rep metrics — deals created, deals won, total value won, avg deal size, win rate
- Export: all reports exportable as CSV or PDF; PDF includes chart images (server-rendered)
- Real-time: analytics recalculate within 5 minutes of any deal change (not real-time streaming — acceptable latency for analytics)

## Edge Cases

- Organization with zero closed deals: show empty state with helpful message ("Close your first deal to see analytics") — no division by zero errors
- Pipeline with custom "Won" stages (multiple): all stages flagged `is_won_stage = true` counted as wins
- Deal moved backward through stages (e.g., from Proposal back to Qualified): stage history records this; duration counts time in each visit separately; funnel shows net forward flow
- Deals with no source set: grouped under "Unknown" in lead source chart
- Revenue with multiple currencies: for MVP, display in org's default currency; flag a warning if mixed currencies exist (full multi-currency conversion is post-MVP)
- Very large orgs (500 users, 50,000 deals): analytics queries must use pre-aggregated materialized views or run as async jobs returning cached results — not blocking real-time queries

## Open Questions

1. Should we support custom report builder (choose metrics, dimensions, chart type) for MVP? No — predefined reports only; custom builder is v2.
2. Should analytics data be real-time or batch-computed? Batch (every 15 min) is sufficient for MVP and avoids expensive live aggregations.
3. Should reps be able to see their own analytics only, or can they see the team? Role-based: reps see own stats, managers see team.
4. Do we need forecasting (predicted revenue for next month)? Nice-to-have for v1.5; requires enough historical data to be useful.
5. Should deal targets/quotas be set per rep and tracked against actuals? Sales quota management is a significant feature — post-MVP.

## Technical Notes

- Stage duration data: queried from `deal_stage_history` table (deal_id, stage_id, entered_at, exited_at); populated via triggers on deal stage changes
- Conversion rate: computed from stage history, not from current deal stage — captures all deals that ever passed through a stage
- Analytics queries run as read-only against a PostgreSQL read replica (or the same DB with separate connection pool for analytics in MVP)
- Materialized views: `mv_monthly_revenue`, `mv_stage_conversion`, `mv_lead_sources` — refreshed every 15 minutes via cron job
- Chart rendering on mobile: Victory Native or React Native Chart Kit — charts rendered natively, not WebView
- PDF export: server-side via Puppeteer rendering a headless HTML report page; stored temporarily in S3 with 1-hour pre-signed download URL
- CSV export: streaming response from PostgreSQL `COPY TO` equivalent using `pg-query-stream` to avoid memory overflow for large datasets
