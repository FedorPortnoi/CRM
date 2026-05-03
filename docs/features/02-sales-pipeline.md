# Feature 02: Sales Pipeline & Deal Tracking

## Overview

The Sales Pipeline gives the team full visibility into every deal from first contact to closed sale. It replaces the chaos of spreadsheets, sticky notes, and "I'll remember to follow up" with a visual, real-time view of all active opportunities and exactly where each one stands.

The pipeline uses a Kanban-style board where each column is a stage (e.g., Lead → Qualified → Proposal → Closed Won) and each card is a deal. Sales reps drag deals between stages as they progress. Business owners see the total pipeline value and can forecast revenue at a glance.

Organizations can create multiple pipelines for different product lines, service types, or sales teams. A software company might have separate pipelines for new business, renewals, and partnerships — each with different stages and logic.

## User Stories

- **As a sales rep**, I want to drag a deal from "Proposal Sent" to "Contract Signed" so that the team can see the deal has progressed without needing a status meeting.
- **As a business owner**, I want to see the total value of all deals in each stage so that I can forecast next month's revenue.
- **As a manager**, I want to create a custom pipeline with stages specific to our service delivery process so that the CRM reflects how we actually work.
- **As a sales rep**, I want to link a deal to a specific contact so that I can see their full history and all related tasks from the deal view.
- **As an analyst**, I want to filter the pipeline by team member so that I can review each rep's active opportunities in our weekly review.
- **As a business owner**, I want to mark deals as won or lost (with a reason for lost) so that I can track win rate and learn from patterns.

## Acceptance Criteria

- Each pipeline has customizable stages with name, position, color, and won/lost designation
- Deals display: title, contact name, value, expected close date, probability, assigned rep, days in current stage
- Drag-and-drop between stages works on mobile (touch-native Reanimated + GestureHandler)
- Multiple pipelines supported per organization (at least 10)
- Deal creation requires: title + contact link (minimum); all other fields optional
- Revenue forecasting: sum of `deal.value * deal.probability / 100` per stage and total
- Deal history: every stage change, field update, and status change logged in activity_log
- Filter pipeline view by: assigned_to, expected close date range, deal value range
- "Won" and "Lost" are special terminal stages — when a deal is moved there, ask for a close date and (for Lost) a reason
- Archiving a pipeline is only allowed if no open deals exist in it

## Edge Cases

- Deal with no value set: show as "$—" in forecasting; exclude from revenue totals
- Pipeline with no stages: cannot create deals in it; warn user and prompt to add stages first
- Stage deletion when deals exist in it: block deletion, require moving deals first OR provide bulk-move option
- Two reps simultaneously moving the same deal to different stages: last-write-wins with server timestamp; the losing rep sees a "Deal was moved by [name]" notification
- Offline deal stage move: queued locally, replayed on sync; if conflict, server state wins and user is notified
- Deal linked to archived contact: deal remains accessible; contact shown as "(Archived)" with link to restore

## Open Questions

1. Should pipeline stage order be drag-and-drop rearrangeable in settings, or fixed edit-in-list?
2. Do we support automations (e.g., "When a deal moves to Proposal, create a task for the rep")? This is feature 13 (Custom Workflows) — how tightly coupled should it be at MVP?
3. Should deal probability be manually set, AI-predicted, or both?
4. Do we need deal splitting (one deal → multiple sub-deals for complex B2B)? Defer to v2.
5. What is the maximum number of stages per pipeline? (Proposed: 20)

## Technical Notes

- Kanban board rendered with `react-native-draggable-flatlist` for vertical lists per column; columns in horizontal ScrollView
- Stage positions use floating-point ordering (Lexorank) to avoid re-indexing all rows on reorder
- Pipeline board data fetched as: `GET /deals?pipeline_id=X&status=open` + stage metadata in a single joined query
- Revenue forecasting computed server-side in the analytics endpoint, not client-side, to ensure consistency
- Deal stage change: `PATCH /deals/:id/stage` updates `stage_id` + appends to `activity_log` + triggers push notification to deal owner if changed by another user
- Stage-duration tracking: `deal_stage_history` table (deal_id, stage_id, entered_at, exited_at) — enables "avg time in stage" analytics
