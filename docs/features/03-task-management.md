# Feature 03: Task Management & Reminders

## Overview

Task Management keeps the team on track by turning intentions into accountable, visible actions with deadlines. In a typical SMB sales process, most deals are lost not because the product is wrong but because someone forgot to follow up. Tasks solve that problem by making follow-ups explicit, assigned, and reminder-driven.

Every task is linked to a contact or deal, ensuring context is never lost. When a rep opens a task, they see who the task is about, the full history of interactions with that person, and all other tasks in the pipeline. The task board gives managers a real-time view of what everyone is working on and what is falling behind.

Automated push notification reminders mean team members don't need to check the CRM constantly — the CRM comes to them at the right moment.

## User Stories

- **As a sales rep**, I want to set a "Follow up on proposal" task linked to a deal with a reminder for Thursday 9am so that I don't forget to call back when I said I would.
- **As a manager**, I want to see all tasks assigned to my team on a board sorted by due date so that I can spot what's overdue before the morning standup.
- **As a freelancer**, I want recurring weekly check-in tasks for my top 5 clients to be created automatically so that I maintain relationships without manual setup each week.
- **As a sales rep**, I want to receive a push notification 15 minutes before a task is due so that I'm prepared and not caught off-guard.
- **As an admin**, I want to assign tasks to specific team members from a deal view so that responsibility is clear and visible.
- **As a team member**, I want to mark tasks as done from the notification so that I don't have to open the app for routine completions.

## Acceptance Criteria

- Task fields: title (required), description, linked contact (optional), linked deal (optional), assigned_to (required, defaults to creator), due date, priority (low/medium/high/urgent), status (pending/in_progress/done/cancelled), is_recurring, recurrence_rule
- Tasks can be created from: the Tasks screen, a contact profile, a deal view, or the dashboard
- Push notification reminder fires at `reminder_at` timestamp (configurable per task; default 30 min before due date)
- Notification action buttons: "Mark Done" and "Snooze 1h" — operable without opening the app
- Visual task board with columns: Pending | In Progress | Done (Kanban for tasks)
- List view alternative: sorted by due date, grouped by today / tomorrow / this week / overdue
- Recurring tasks: support iCal RRULE (daily, weekly, monthly, custom) — on completion, next instance auto-created
- Team view: manager sees all tasks across the org, filterable by assigned_to
- Overdue tasks highlighted in red; tasks due today highlighted in amber
- Completing a task logs an activity_log entry for the linked contact/deal

## Edge Cases

- Task assigned to user who is then deactivated: task remains visible in team view, assignee shown as "(Deactivated)" — manager must reassign
- Recurring task deleted mid-series: only future instances are cancelled; past instances remain as completed records
- Task with no due date: no reminder sent; task appears in "Undated" section of list view; valid use case
- Task linked to archived contact: task remains accessible; link shown with "(Archived)" label
- Multiple tasks due at the same time for the same user: all notifications fire; user sees them in notification tray grouped by app
- Offline task completion: queued locally, synced on reconnection; no duplication risk (idempotent `complete` mutation)

## Open Questions

1. Should tasks have sub-tasks (checklist items)? Useful for complex follow-up sequences. Propose for v1.5.
2. Should task templates be supported at MVP? (e.g., "New Lead Onboarding" = 5 pre-defined tasks) Relates to Feature 13 (Custom Workflows).
3. What is the maximum number of tasks visible on the board before pagination? (Proposed: 200 per column max)
4. Should task completion send a notification to the manager? Optional setting or always-on?
5. Should there be an "email to task" feature (forward an email, it creates a task)? Post-MVP.

## Technical Notes

- Recurring tasks: recurrence_rule stored as RRULE string (RFC 5545); `rrule.js` library used client-side for display, Node `rrule` library server-side for instance generation
- Reminder notifications: Bull job scheduled at task creation with `reminder_at` as the delay; job pushes via FCM/APNS
- Notification action buttons ("Mark Done"): handled by `expo-notifications` notification response listener; sends `POST /tasks/:id/complete` silently in background
- Task board on mobile: separate FlatLists per status column in horizontal scroll; drag-and-drop between columns changes status
- Overdue badge count: computed at login + updated via WebSocket event when tasks change; displayed on bottom tab icon
