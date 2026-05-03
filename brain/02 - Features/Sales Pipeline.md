---
tags: [feature, mvp, pipeline, deals, kanban]
status: specced
related: ["Contact Management", "Kanban Boards", "Sales Funnel Analytics", "Task Management", "Custom Workflows", "Interaction History"]
created: 2026-05-01
---

# Sales Pipeline

## Overview

Full visibility into every deal from first contact to closed sale. Replaces the chaos of spreadsheets, sticky notes, and "I'll remember to follow up" with a visual, real-time view of all active opportunities.

Uses a Kanban-style board (see [[Kanban Boards]]) where each column is a stage (Lead → Qualified → Proposal → Closed Won) and each card is a deal. Sales reps drag deals between stages as they progress. Business owners see the total pipeline value and forecast revenue at a glance.

Organizations can create multiple pipelines for different product lines, service types, or sales teams. Fully customizable stages — see [[Custom Workflows]].

## Why It Matters

Most SMBs run their sales pipeline in their head or in a spreadsheet. Both fail at team scale: the spreadsheet gets out of date, no one trusts it, and deals fall through. A visual, shared pipeline with a single source of truth gives every team member situational awareness and every manager forecasting power.

The drag-and-drop metaphor makes pipeline updates so fast (2 seconds vs 30) that reps actually do them.

## User Stories

- As a sales rep, I want to drag a deal from "Proposal Sent" to "Contract Signed" so the team sees progress without a status meeting
- As a business owner, I want to see total value of deals per stage so I can forecast next month's revenue
- As a manager, I want to create a pipeline with stages specific to our process so the CRM reflects reality
- As a sales rep, I want to link a deal to a contact so I can see full history and tasks from the deal view
- As an analyst, I want to filter the pipeline by team member for our weekly review
- As a business owner, I want to mark deals won or lost (with reason for lost) to track win rate

## Acceptance Criteria

- Kanban board with customizable stages (see [[Kanban Boards]] for board UX)
- Deal cards show: title, contact name, value, expected close, days in current stage, assigned rep
- Drag-and-drop between stages on mobile (native touch, 60fps via Reanimated)
- Multiple pipelines per org (up to 10 for MVP)
- Revenue forecasting: `value × probability / 100` per stage summed
- Deal history: every stage change logged in [[Interaction History]]
- Won/Lost are special terminal stages — prompt for close date and lost reason
- All deal events feed [[Sales Funnel Analytics]]

## Technical Notes

- Stage positions use Lexorank (float) to avoid re-indexing all rows on reorder
- Stage change: `PATCH /deals/:id/stage` → updates stage_id + writes deal_stage_history + logs to activity_log + triggers push if changed by a colleague
- `deal_stage_history` table enables "avg time in stage" analytics in [[Sales Funnel Analytics]]
- Kanban board rendering: see [[Kanban Boards]] for component architecture

## Related Features

- [[Kanban Boards]] — the visual UI for this feature
- [[Contact Management]] — deals linked to contacts
- [[Sales Funnel Analytics]] — analytics derived from pipeline data
- [[Task Management]] — tasks linked to deals
- [[Interaction History]] — every deal change logged
- [[Custom Workflows]] — pipeline stages and automation rules
- [[Reporting Dashboard]] — pipeline summary on home dashboard

## Open Questions

1. Should pipeline stage order be drag-and-drop rearrangeable, or a static list edit?
2. Should deal probability be manually set, AI-predicted, or both?
3. Should we support deal splitting for complex B2B? (Proposed: defer to v2)
4. Do time-based automation triggers belong in MVP? (e.g., "if deal in stage 7+ days, create task")
5. Maximum number of stages per pipeline? (Proposed: 20)
