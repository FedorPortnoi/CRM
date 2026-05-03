# Feature 05: Customer Interaction History

## Overview

Customer Interaction History provides a complete chronological timeline of every touchpoint with every customer — calls, messages, meetings, notes, task completions, deal changes, and file attachments. It is the institutional memory of the customer relationship, and it solves one of the most painful problems in sales: the knowledge handoff when a rep leaves or a team member is unavailable.

With full interaction history, any team member can pick up a relationship exactly where another left off. Before calling a client, a rep can read the last 3 calls in 60 seconds. Before a meeting, a manager can review every promise and commitment that was made. No context is ever lost.

The history is largely automatic — calls, messages, and meetings are captured without manual entry. Manual notes can be added at any time. Every action in the CRM that relates to a contact is logged here.

## User Stories

- **As a sales rep taking over a client from a colleague**, I want to read the full history of every interaction so that I can understand the relationship without needing to ask the previous rep.
- **As a manager**, I want to see all interactions a specific rep has had with a client in the past 30 days so that I can review their engagement quality.
- **As a field sales agent**, I want to add a quick note immediately after a meeting so that I can capture key points before I drive to the next appointment.
- **As a business owner**, I want to filter a contact's history to show only calls so that I can review what was discussed without wading through unrelated messages.
- **As a customer success manager**, I want to attach a signed contract to the contact's history so that the document is always accessible in context.
- **As a sales rep**, I want to see that a deal moved from "Proposal" to "Won" in the history so that I have a complete record of the deal's journey.

## Acceptance Criteria

- Activity timeline displayed on every contact profile, sorted newest-first by default (toggle to oldest-first)
- Auto-logged event types: call (with duration and notes), outbound SMS, inbound SMS, in-app message, meeting/appointment, task created, task completed, deal created, deal stage changed, deal won, deal lost, contact field updated, file attached
- Manually created types: note (free text), file attachment
- Filter history by type (one or multiple): calls, messages, meetings, notes, tasks, deals, files
- Filter by date range: today, this week, this month, custom range
- Shared history: all team members can read the full history for any contact they have access to
- File attachments: upload from device, linked to contact history; stored in S3; max 10MB per file; supported types: PDF, DOCX, XLSX, PNG, JPG
- History items show: type icon, user who performed action, timestamp (relative for recent, absolute for older), description
- History is append-only and immutable — entries cannot be edited or deleted (except as part of a GDPR wipe)
- Export: download contact's full history as PDF or CSV

## Edge Cases

- Contact with 3 years of history (thousands of entries): paginate at 50 per page; client-side lazy loading; performance must stay below 500ms for first page load
- Note added by a deactivated user: note remains visible, shows user name + "(Deactivated)"
- File attachment where S3 upload fails mid-stream: activity_log entry is not created until S3 confirms success; use a two-phase write pattern
- Multiple automated events in the same second (e.g., deal created + stage logged + task auto-created): all entries appear; sort is stable by `id` (UUID v7 with embedded timestamp) when timestamps are equal
- Team member viewing a contact they are not assigned to: if org settings allow cross-team visibility, they see full history; if restricted, they only see their own interactions
- History for a contact who is later merged into another contact: merged contact's history must be transferred to the surviving record

## Open Questions

1. Should activity notes be editable after creation, or truly append-only? (Recommend: allow edit for 10 minutes after creation, then lock)
2. Should history entries be individually shareable (e.g., copy link to specific note)? Useful for internal handoff.
3. Do we need email thread tracking (linking inbound/outbound emails to contact history)? Requires email integration — post-MVP.
4. Should the timeline be filterable by team member (show only actions by a specific rep)? Yes — needed for manager review workflows.
5. Maximum file attachment size: 10MB currently proposed. Is this enough for large contracts/presentations?

## Technical Notes

- `activity_log` table is append-only with no UPDATE or DELETE permissions granted to API user (enforced via PostgreSQL row-level privilege)
- Timeline query: `SELECT * FROM activity_log WHERE organization_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 50 OFFSET $3` — simple, fast with index on (organization_id, contact_id, created_at DESC)
- File upload flow: mobile → `POST /attachments` (multipart) → backend validates type/size → uploads to S3 → records attachment in DB → appends to activity_log → returns attachment metadata to client
- Pre-signed S3 download URLs: generated on-demand in API response, 1-hour expiry
- PDF export: server-side PDF generation using `pdfkit` or `puppeteer`; runs as Bull job to avoid blocking the API
