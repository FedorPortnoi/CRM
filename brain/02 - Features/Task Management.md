---
tags: [feature, mvp, tasks, reminders, notifications]
status: specced
related: ["Contact Management", "Sales Pipeline", "Kanban Boards", "Reporting Dashboard", "Custom Workflows", "Auto Information Capture"]
created: 2026-05-01
---

# Task Management

## Overview

Tasks keep the team on track by turning intentions into accountable, visible actions with deadlines. Most deals are lost not because the product is wrong but because someone forgot to follow up. Tasks solve this with explicit, assigned, reminder-driven actions.

Every task is linked to a contact or deal, ensuring context is always visible. Automated push notification reminders mean the CRM comes to the user at the right moment — not requiring them to check constantly.

## Why It Matters

The single biggest reason deals die: the rep forgot to follow up. The second biggest: they followed up but had no record of what was said last time (fixed by [[Interaction History]]). Tasks solve problem #1.

For [[Solo Entrepreneurs]], tasks replace a mental to-do list and sticky notes. For [[Small Businesses]], the team task board lets managers see what everyone is working on without a daily standup.

## User Stories

- As a sales rep, I want to set a "Follow up on proposal" task linked to a deal with a 9am Thursday reminder so I don't forget to call back
- As a manager, I want to see all team tasks on a board sorted by due date so I can spot overdue items before the standup
- As a freelancer, I want weekly recurring check-in tasks for my top 5 clients so I maintain relationships automatically
- As a sales rep, I want a push notification 15 minutes before a task is due so I'm prepared
- As a team member, I want to mark tasks done from the notification without opening the app
- As an admin, I want to assign tasks to team members from a deal view so responsibility is clear

## Acceptance Criteria

- Task fields: title (required), description, contact (optional), deal (optional), assigned_to (required), due date, priority (low/medium/high/urgent), status, recurring flag + RRULE
- Create from: Tasks screen, contact profile, deal view, dashboard
- Push notification at reminder_at; action buttons: "Mark Done" + "Snooze 1h" (work without opening app)
- Visual task board: Pending | In Progress | Done columns
- Overdue tasks highlighted red; today's tasks highlighted amber
- Recurring: on completion, next instance auto-created from RRULE
- Team view: all org tasks, filterable by assigned_to
- Task completion logs entry in [[Interaction History]] for linked contact/deal

## Technical Notes

- RRULE stored as RFC 5545 string; parsed by `rrule.js` client-side, `rrule` npm server-side
- Reminder: Bull job scheduled at task creation with delay = reminder_at timestamp; job calls push delivery service
- Notification action "Mark Done": expo-notifications response listener → silent `POST /tasks/:id/complete` in background
- Overdue badge on bottom tab: computed at login + real-time updates via WebSocket
- Task board: separate FlatLists per status column, horizontal ScrollView; see [[Kanban Boards]] for shared component

## Related Features

- [[Contact Management]] — tasks linked to contacts
- [[Sales Pipeline]] — tasks linked to deals
- [[Kanban Boards]] — task board uses the same Kanban component
- [[Interaction History]] — task completion logged automatically
- [[Reporting Dashboard]] — "Tasks due today" widget on home screen
- [[Custom Workflows]] — automation rules can auto-create tasks on deal stage change
- [[Auto Information Capture]] — task completion auto-logged without manual entry

## Open Questions

1. Should tasks have sub-tasks (checklist items)? (Proposed: v1.5)
2. Should task templates be in MVP? (Part of [[Custom Workflows]])
3. Should task completion notify the manager? (Optional setting or always-on?)
4. What happens to tasks when an assigned team member is deactivated?
5. Should there be an "email to task" feature? (Post-MVP)
