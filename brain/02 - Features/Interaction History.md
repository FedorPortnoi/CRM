---
tags: [feature, mvp, history, timeline, activity]
status: specced
related: ["Contact Management", "Call & Messaging", "Auto Information Capture", "Task Management", "Appointment Scheduling", "Sales Pipeline"]
created: 2026-05-01
---

# Interaction History

## Overview

A complete chronological timeline of every touchpoint with every customer — calls, messages, meetings, notes, task completions, deal changes, and files. The institutional memory of the customer relationship.

With full interaction history, any team member can pick up a relationship exactly where another left off. Before a call, a rep reads the last 3 interactions in 30 seconds. Before a meeting, a manager reviews every promise ever made. No context is lost when a rep leaves or is unavailable.

The history is largely automatic — calls, messages, and meetings are captured via [[Auto Information Capture]] without manual entry. Manual notes can be added at any time.

## Why It Matters

Knowledge handoff is one of the most expensive problems in sales. When a rep leaves a company, their institutional knowledge about client relationships often leaves with them. Interaction history solves this structurally — all relationship context lives in the CRM, not in someone's head.

For [[Small Businesses]] and [[Medium Businesses]], shared history enables team members to seamlessly take over accounts, handle inbound calls for each other, and present a unified front to clients.

## User Stories

- As a sales rep taking over a client from a colleague, I want the full interaction history so I can understand the relationship without asking the previous rep
- As a manager, I want to see all interactions a specific rep had with a client this month for quality review
- As a field agent, I want to add a quick note after a meeting before I drive to my next appointment
- As a customer success manager, I want to filter contact history to show only calls
- As a business owner, I want to attach a signed contract to a contact's history so the document is always in context
- As a sales rep, I want to see the deal moved from "Proposal" to "Won" in the history for a complete record

## Acceptance Criteria

- Timeline on every contact profile, newest-first (toggle to oldest-first)
- Auto-logged types: call, outbound/inbound SMS, in-app message, meeting, task created/completed, deal created/stage changed/won/lost, file attached
- Manually created: note (free text), file attachment
- Filter by type: calls, messages, meetings, notes, tasks, deals, files
- Filter by date range: today, week, month, custom
- Shared history: all team members with contact access see full history
- Attachments: up to 10MB, types: PDF, DOCX, XLSX, PNG, JPG; stored in S3
- History is append-only and immutable (no edits or deletes, except GDPR wipe)
- Export: PDF or CSV of contact's full history

## Technical Notes

- `activity_log` table: append-only; PostgreSQL RULE blocks UPDATE and DELETE
- Timeline query: `SELECT * FROM activity_log WHERE organization_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 50 OFFSET $3`
- Source ID unique constraint prevents duplicate auto-logged entries (idempotency)
- File upload: mobile → `POST /attachments` (multipart) → S3 → attachment record + activity_log entry
- PDF export: `pdfkit` or Puppeteer server-side; Bull background job

## Related Features

- [[Contact Management]] — history displayed on contact profile
- [[Call & Messaging]] — calls and messages auto-logged here
- [[Auto Information Capture]] — the engine that populates history automatically
- [[Task Management]] — task completion logged here
- [[Appointment Scheduling]] — meeting notes saved here post-meeting
- [[Sales Pipeline]] — deal stage changes logged here
- [[Smart Data Entry]] — manually adding notes as part of data entry

## Open Questions

1. Should activity notes be editable after creation? (Proposed: edit within 10 min, then locked)
2. Should history entries be individually shareable via link?
3. Do we need email thread tracking? (Requires email integration — post-MVP)
4. Should history be filterable by team member (show only actions by a specific rep)?
5. Maximum file attachment size: 10MB — is this enough for large presentations/contracts?
