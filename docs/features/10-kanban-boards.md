# Feature 10: Visual Kanban Boards (Trello-Inspired)

## Overview

Kanban Boards make complex workflows simple and visual. Instead of reading a list of deals or tasks and mentally tracking their status, a user can look at the board and immediately understand the state of the entire business. Columns are stages; cards are deals or tasks; the board is a snapshot of right now.

The Trello-inspired design is a deliberate philosophical choice: Trello has been used by hundreds of millions of people who had never heard of "Kanban" before. The drag-and-drop metaphor is intuitive without any instruction. Users who have never used a CRM understand the board immediately because they understand organizing things into columns and moving cards between them.

Two types of boards exist in the CRM: the **Sales Pipeline Board** (deals moving through pipeline stages) and the **Task Board** (tasks moving through pending → in progress → done). Both share the same underlying board component but display different data.

## User Stories

- **As a sales manager**, I want to look at the pipeline board every morning and immediately see which deals are in which stage without reading a list or opening any detail views.
- **As a sales rep**, I want to drag a deal card from "Proposal Sent" to "Contract Signed" on my phone with my thumb so that updating the pipeline takes 2 seconds, not 30.
- **As a team member**, I want to see color-coded cards so that I can instantly distinguish high-priority items from low-priority ones without reading each card's details.
- **As a manager**, I want to filter the task board by team member so that in our weekly review, I can show just one rep's tasks on screen.
- **As a team member**, I want to add a due date and notes directly to a task card without opening a separate form so that quick updates are fast.
- **As a new team member**, I want to understand the board immediately without training so that I'm productive on my first day.

## Acceptance Criteria

- Pipeline board: columns = pipeline stages; cards = deals; drag-and-drop moves deal to new stage (same interaction as pipeline feature)
- Task board: columns = Pending, In Progress, Done; cards = tasks; drag-and-drop changes task status
- Card displays: title, linked contact name, value (deals only), due date, assigned user avatar, priority color indicator
- Color coding: card left-border color indicates priority (low=grey, medium=blue, high=orange, urgent=red)
- Drag-and-drop: native feel on iOS and Android; 60fps during drag; card snaps to new position on release; server update fires in background after drop
- Column headers: show stage name + card count + total value (pipeline) or count (tasks)
- Filter bar: filter cards by assigned_to, priority, due date (tasks), search by title
- Tap card to open detail sheet (bottom sheet) — shows full details without navigating away from board
- Add card button (+) in each column creates a new deal/task pre-assigned to that stage/status
- Scroll: vertical scroll within each column; horizontal scroll across columns
- Board works offline: local state updates immediately; background sync queued

## Edge Cases

- Too many cards in one column (50+): virtualized list within each column; performance must hold at 100+ cards
- Card with a very long title: truncate at 2 lines with ellipsis on card; full title in detail sheet
- Slow network: drag-and-drop updates local state immediately (optimistic update); if server call fails, card snaps back and user sees an error toast
- Horizontal columns overflowing screen: all platforms support horizontal scroll; minimum column width 200dp; pipeline with 10+ stages is scrollable
- Board filter applied: filtered-out cards are hidden; column counts update to reflect filtered count vs total (e.g., "Proposal — 3 of 8")
- Empty column: shows an empty state card with "No deals here" and a "+" button; column still visible so users understand stage exists

## Open Questions

1. Should the board support swimlanes (rows grouping cards by assigned rep, for example)? Useful for manager view; complex to implement on mobile. Post-MVP.
2. Should cards be rearrangeable within a column (manually ordered), or always sorted by a rule (date, value)? Default: sorted by created_at; manual reorder as opt-in setting.
3. Should there be a "Board" and "List" toggle on the same screen? Yes — useful for different preferences. Both views show same data.
4. Should we support multiple task boards (one per project/department)? For MVP, one task board per org. Multiple boards in v2.
5. Should board columns be horizontally collapsible to show more columns on screen at once? Nice UX feature for power users — v1.5.

## Technical Notes

- Drag-and-drop: `react-native-draggable-flatlist` for within-column card reordering; custom cross-column drag logic using `react-native-gesture-handler` + `react-native-reanimated` for the inter-column drop zones
- Column layout: `ScrollView` (horizontal) wrapping multiple `FlatList` instances (one per column); each FlatList has its own scroll context
- Optimistic update: on drag release, local state updates immediately (Redux store); API call fires async; on failure, dispatch a rollback action + show toast
- Card rendering: memoized card components with `React.memo` to avoid re-renders of unaffected cards during drag
- Column width: fixed at 220dp; calculated to show 1.3 columns at default zoom (hints at horizontal scrollability)
- Board virtualization: each column FlatList uses `initialNumToRender=10`, `windowSize=5` to keep memory usage bounded for large boards
