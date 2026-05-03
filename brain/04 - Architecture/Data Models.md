---
tags: [architecture, data, database, schema]
status: active
related: ["System Overview", "API Design", "Contact Management", "Sales Pipeline", "Task Management"]
created: 2026-05-01
updated: 2026-05-02
---

> **Sprint 0 note (2026-05-02):** Prisma schema is live at `backend/prisma/schema.prisma`. The 6 core models (User, Org, Contact, Deal, Task, Message) are defined with 10 enums. Company is a **text field on Contact** (not a separate entity) for MVP. All PKs use UUID v4 via `gen_random_uuid()`. Three nullable mismatches vs. the reference SQL need fixing before the first migration — see [[Day 2]] for details.

# Data Models

## Core Entity Hierarchy

```
Organization (tenant)
  └── Users (members)
  └── Contacts (CRM data)
       └── Deals (sales opportunities)
       └── Tasks (follow-up actions)
       └── Messages (SMS/in-app)
       └── Calendar Events (meetings)
       └── Activity Log (append-only history)
       └── Attachments (files)
  └── Pipelines
       └── Pipeline Stages
            └── Deals
```

Full SQL schema in `backend/db/schema/`.

## Key Entities

### Organization
Top-level tenant. All other entities belong here. Plan determines feature access. See [[Pricing Model]].

### Contact
The heart of the CRM. Feeds [[Contact Management]], [[Interaction History]], [[Call & Messaging]], [[Appointment Scheduling]]. Contains: name, company, phone (encrypted), email (encrypted), tags, custom_fields JSONB, assigned_to, type, status, fts (full-text search vector).

### Deal
A sales opportunity tracking through pipeline stages. Central to [[Sales Pipeline]] and [[Sales Funnel Analytics]]. Key fields: value, currency, stage_id, probability, expected_close, status (open/won/lost), lost_reason, source.

### Pipeline + Pipeline Stage
Customizable via [[Custom Workflows]]. Position uses Lexorank (float) for drag-and-drop ordering without full re-indexing.

### Task
Powers [[Task Management]]. Linked to contact OR deal (or both). Recurring via RRULE string. Reminder fires via Bull job. Status: pending → in_progress → done.

### Activity Log
Append-only. Powers [[Interaction History]]. Every CRM action writes here. Types: call, message, meeting, note, task_created/completed, deal_created/stage_changed/won/lost, contact_created/updated, email, file_uploaded. No UPDATEs or DELETEs allowed (PostgreSQL RULE).

### Message
Powers [[Call & Messaging]]. Channels: sms (Twilio), in_app (WebSocket), email. Direction: inbound/outbound. Twilio SID for idempotency.

### Calendar Event
Powers [[Appointment Scheduling]]. Syncs with Google Calendar (google_event_id for deduplication). Post-meeting notes via `post_meeting_prompted` flag.

## Critical Design Choices

**Custom fields:** `custom_fields JSONB` on contacts and deals allows [[Custom Workflows]] without schema migrations. GIN-indexed for key-based filtering.

**Encryption:** Phone and email fields encrypted at the application layer before write. Decrypted on read. Keys in environment variables.

**Soft deletes:** Status = 'archived' (not `deleted_at`). Contacts and deals are never hard-deleted except for GDPR requests.

**UUIDs everywhere:** All PKs are UUID (gen_random_uuid()). UUID v7 ordering considered for future — maintains sort order with embedded timestamp.

**Row-Level Security:** All tables have RLS enabled. Policies use `current_setting('app.organization_id')` set per-request by the API middleware.

## Related Notes

- [[System Overview]] — where these models fit in the architecture
- [[API Design]] — how these models are exposed as REST resources
- [[Contact Management]] — contact entity in depth
- [[Sales Pipeline]] — pipeline, stage, deal entities
- [[Task Management]] — task entity and recurring task logic
- [[Custom Workflows]] — custom field definitions and automation rules
