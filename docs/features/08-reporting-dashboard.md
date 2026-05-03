# Feature 08: Basic Reporting & Dashboard

## Overview

The Reporting Dashboard is the first screen every user sees when they open the app. It must answer three questions instantly: What needs my attention today? How is the business performing? What is my team doing? It is the command center — a visual summary that replaces the morning ritual of opening five spreadsheets and asking colleagues for status updates.

The home dashboard shows key metrics at a glance: active deals with their total pipeline value, tasks due today, recent contacts added, and any overdue items screaming for attention. It is designed to be understood in under 10 seconds, not studied for 10 minutes.

Beyond the home dashboard, the reporting section provides sales performance reports and team activity summaries that business owners and managers use for weekly reviews, board presentations, and team coaching. All reports can be exported as PDF or CSV.

## User Stories

- **As a business owner**, I want to open the app every morning and immediately see how many active deals I have, what tasks are due today, and if anything is overdue so that I can prioritize my day in under a minute.
- **As a sales manager**, I want a weekly sales performance report showing each rep's deals won, calls made, and pipeline movement so that I can run an informed team review.
- **As a business owner**, I want to export a monthly revenue report as PDF to share with my accountant.
- **As a solo entrepreneur**, I want a dashboard widget showing my follow-up tasks for today so that I start each day knowing exactly what to do.
- **As a team member**, I want to see my personal performance metrics so that I can track my own progress against last month.
- **As a manager**, I want to see a team activity heatmap showing who is most active in the CRM so that I can identify adoption issues early.

## Acceptance Criteria

- Home dashboard widgets (all visible without scrolling on a standard mobile screen):
  - Pipeline summary: total open deals count + total value
  - Tasks due today: count + list of top 3 (tap to expand)
  - Overdue tasks: count (highlighted red); 0 = no widget shown
  - Recent contacts: last 3 contacts added or interacted with
  - Upcoming appointments: next appointment with time and contact name
- Dashboard widgets are user-configurable (show/hide, reorder) — settings in user profile
- Sales performance report: date range selector, per-rep breakdown (deals created, deals won, value won, calls made, tasks completed)
- Team activity report: activity log summary per user per day — heatmap-style grid view
- Revenue chart: monthly bar chart for past 12 months (reuses analytics engine from Feature 07)
- All reports export as PDF (formatted, with logo) and CSV (raw data)
- Dashboard data refreshes on app foreground (pull-to-refresh also available)
- Empty states: when a widget has no data, show an encouraging message with a CTA (e.g., "No tasks today — add your first contact!")

## Edge Cases

- Dashboard load with slow connection: show skeleton screens while data loads; never show blank white screen
- User with no deals, no tasks, no contacts (new account): full empty state onboarding dashboard with guided next steps ("Start by adding your first contact")
- Org with 10,000+ contacts and deals: dashboard aggregates are pre-computed (materialized views / Redis cache); dashboard must load in under 2 seconds even at scale
- Multiple currencies in pipeline: show total in org's default currency with "(mixed currencies)" disclaimer
- Team activity report for org with 200 users: paginate; show top 20 by activity, allow search/filter by name
- Export of very large report (12 months, 50 reps): run as background job; notify user with push when PDF is ready; don't block UI

## Open Questions

1. Should dashboard widgets be draggable/reorderable on mobile? (Yes, but this is a UI challenge — use a long-press drag pattern)
2. Should there be a web-only dashboard for larger screens (iPad, browser)? Post-MVP — focus on mobile for MVP.
3. Should we support email-scheduled reports (e.g., weekly summary emailed every Monday)? Good CRM feature — v1.5.
4. Should the dashboard show competitor activity (deals lost to specific competitors)? Only if loss reasons support that level of detail.
5. What is the right refresh interval for dashboard data? Pull-to-refresh + foreground refresh is sufficient for MVP.

## Technical Notes

- Dashboard data: single `GET /analytics/dashboard` call returning pre-aggregated metrics; cached in Redis for 5 minutes, invalidated on relevant mutations (deal closed, task completed, etc.)
- Widget configuration: stored in `user.preferences JSONB` column; applied client-side to determine which widgets to render
- Skeleton loading: each widget has a skeleton placeholder (react-native-skeleton-placeholder) shown during data fetch
- PDF report generation: Puppeteer-based server-side rendering using branded HTML template; stored in S3 with 24-hour pre-signed URL
- CSV export: streamed from DB using cursor-based pagination; no memory overflow for large datasets
- Charts on mobile: Victory Native — renders native SVG paths, no WebView overhead
