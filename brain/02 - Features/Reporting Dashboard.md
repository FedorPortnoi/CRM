---
tags: [feature, mvp, dashboard, reporting, metrics]
status: specced
related: ["Sales Funnel Analytics", "Task Management", "Sales Pipeline", "Contact Management", "Solo Entrepreneurs", "Small Businesses"]
created: 2026-05-01
---

# Reporting Dashboard

## Overview

The first screen every user sees when they open the app. Must answer three questions instantly: What needs my attention today? How is the business performing? What is my team doing?

The home dashboard shows active deals with pipeline value, today's tasks, recent contacts, and overdue items. Understood in under 10 seconds. Beyond the home, the reporting section provides sales performance and team activity reports for weekly reviews, board presentations, and coaching.

## Why It Matters

Morning routines drive habits. If the first thing a user sees every morning is a clear, useful view of their day, the CRM becomes a habit. If the first screen is confusing or empty, they close the app and go back to their spreadsheet.

For [[Solo Entrepreneurs]], this replaces the daily ritual of checking phone contacts + Gmail + a notes app + a todo app. For [[Small Businesses]], the team activity report replaces the daily standup or at least makes it more focused.

## User Stories

- As a business owner, I want to open the app and immediately see active deals, today's tasks, and overdue items so I can prioritize my day in under a minute
- As a sales manager, I want a weekly report showing each rep's deals won, calls made, and pipeline movement
- As a business owner, I want to export a monthly revenue report as PDF for my accountant
- As a solo entrepreneur, I want a "Tasks due today" widget so I start each day knowing exactly what to do
- As a team member, I want to see my personal performance metrics to track my own progress
- As a manager, I want a team activity heatmap to identify CRM adoption issues

## Acceptance Criteria

- Home dashboard widgets (visible without scrolling):
  - Pipeline summary: open deal count + total value
  - Tasks due today: count + top 3 list
  - Overdue tasks: count (red) — hidden when 0
  - Recent contacts: last 3 added/interacted
  - Upcoming appointments: next meeting name + time
- Widgets user-configurable (show/hide, reorder) — stored in user.preferences JSONB
- Sales performance report: date range, per-rep breakdown
- Team activity report: per-user per-day activity heatmap
- Revenue chart: 12-month bar chart
- All reports exportable as PDF + CSV
- Dashboard data cached in Redis for 5 min, invalidated on relevant mutations
- Empty states with encouraging CTAs for new accounts

## Technical Notes

- Dashboard data: single `GET /analytics/dashboard` call returning pre-aggregated metrics; Redis 5-min cache
- Widget config: `user.preferences JSONB`; rendered client-side
- Skeleton loading: react-native-skeleton-placeholder during fetch
- PDF: Puppeteer server-side with branded HTML template; S3 pre-signed URL
- Charts: Victory Native (same as [[Sales Funnel Analytics]])

## Related Features

- [[Sales Funnel Analytics]] — analytics engine reused for dashboard metrics
- [[Task Management]] — "Tasks due today" and "Overdue" widgets
- [[Sales Pipeline]] — "Pipeline summary" widget
- [[Contact Management]] — "Recent contacts" widget
- [[Appointment Scheduling]] — "Upcoming meetings" widget
- [[Built-In Learning]] — new user onboarding dashboard experience

## Open Questions

1. Should widgets be drag-and-drop reorderable on mobile? (Long-press drag pattern)
2. Should there be a web-only dashboard for larger screens (iPad)? (Post-MVP)
3. Should we support emailed weekly digest reports? (v1.5)
4. What is the right refresh interval? (Pull-to-refresh + foreground refresh — sufficient for MVP)
5. Should reps be able to see other reps' performance on the dashboard? (No — private by default; manager opt-in to share)
