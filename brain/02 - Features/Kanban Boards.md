---
tags: [feature, mvp, kanban, visual, drag-and-drop]
status: specced
related: ["Sales Pipeline", "Task Management", "Mobile Field Access", "Tech Stack", "Built-In Learning"]
created: 2026-05-01
---

# Kanban Boards

## Overview

Kanban Boards make complex workflows simple and visual. Columns are stages; cards are deals or tasks; the board is a snapshot of right now. The Trello-inspired design is a deliberate philosophical choice — hundreds of millions of people understand this metaphor without instruction.

Two board types exist: **Sales Pipeline Board** (deals through pipeline stages) and **Task Board** (tasks through pending → in progress → done). Both share the same underlying board component but display different data. The [[Sales Pipeline]] and [[Task Management]] features depend on this UI.

## Why It Matters

Visual information is processed 60,000x faster than text. A sales manager who looks at the pipeline board for 5 seconds knows more than a manager who reads a status report for 5 minutes. The board is the CRM's most compelling feature for new user demos — it immediately makes the value proposition tangible.

The zero-training-required goal (see [[Built-In Learning]]) is only achievable if the core interaction model is inherently intuitive. Drag and drop is one of the most universally understood UI metaphors.

## User Stories

- As a sales manager, I want to look at the pipeline board every morning and immediately see which deals are in which stage
- As a sales rep, I want to drag a deal from "Proposal Sent" to "Contract Signed" on my phone with my thumb in 2 seconds
- As a team member, I want color-coded cards so I can instantly distinguish priority levels without reading each card
- As a manager, I want to filter the task board by team member for our weekly review
- As a team member, I want to add due dates and notes directly to a task card without opening a separate form
- As a new team member, I want to understand the board immediately without training

## Acceptance Criteria

- Pipeline board: columns = pipeline stages; cards = deals; drag changes stage (triggers [[Sales Pipeline]] stage update)
- Task board: columns = Pending, In Progress, Done; drag changes task status
- Card shows: title, linked contact, value (deals), due date, assigned user avatar, priority color border
- Color coding: card left-border: grey=low, blue=medium, orange=high, red=urgent
- Drag-and-drop: 60fps on mobile; card snaps on release; server update fires in background (optimistic update)
- Column headers: name + card count + total value (pipeline) or count (tasks)
- Filter: by assigned_to, priority, due date; text search by title
- Tap card → bottom sheet with full details (no nav away from board)
- Offline: local state updates immediately; server sync queued for reconnection

## Technical Notes

- Drag-and-drop: `react-native-draggable-flatlist` for within-column reordering; custom cross-column DnD via `react-native-gesture-handler` + `react-native-reanimated`
- Column layout: horizontal ScrollView wrapping one FlatList per column
- Optimistic update: on drop, Redux dispatch local state change immediately; async API call; rollback action on failure + error toast
- Card memoization: `React.memo` on card components to prevent re-renders of unaffected cards during drag
- Column virtualization: `initialNumToRender=10`, `windowSize=5` to bound memory usage for large boards
- Column width: fixed 220dp; shows 1.3 columns at default zoom (hints scrollability)

## Related Features

- [[Sales Pipeline]] — pipeline board is the primary UI for this feature
- [[Task Management]] — task board shares the kanban component
- [[Mobile Field Access]] — board works offline with local optimistic updates
- [[Tech Stack]] — Reanimated 3 + GestureHandler for 60fps drag on mobile
- [[Built-In Learning]] — kanban drag hint shown on first board visit

## Open Questions

1. Should the board support swimlanes (rows by assigned rep)? (Post-MVP — complex mobile UX)
2. Should cards be manually reorderable within a column? (Default: sorted by created_at; manual reorder as setting)
3. Should there be a Board/List toggle? (Yes — both views of same data)
4. Should we support multiple task boards (one per project)? (MVP: one per org; v2: multiple)
5. Should columns be horizontally collapsible? (v1.5 — power user feature)
