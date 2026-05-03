---
tags: [feature, mvp, contacts, database]
status: specced
related: ["Sales Pipeline", "Interaction History", "Task Management", "Smart Data Entry", "Auto Information Capture", "Custom Workflows"]
created: 2026-05-01
---

# Contact Management

## Overview

The foundation of the entire CRM. Every customer, lead, and partner lives here. Without a reliable, searchable, centrally accessible contact database, no other feature has context — tasks have no owner, deals have no buyer, messages have no recipient.

This feature must feel like a supercharged address book: fast to search, easy to add, and rich with information. Unlike enterprise CRMs that demand 20 fields before saving, a contact here can be created with just a name and phone number. Additional information fills in gradually over time.

Every contact has a full [[Interaction History]], linked tasks, linked deals, and communication history — the contact profile is the single source of truth for everything known about a person.

## Why It Matters

Lost leads = lost revenue. Most SMBs lose 15–30% of potential customers because someone forgot to follow up. A centralized contact database with full history ensures no lead slips through. Team members who leave or are unavailable no longer take their client knowledge with them — it lives in the CRM.

For [[Solo Entrepreneurs]], this replaces a chaotic personal phone + Gmail + spreadsheet. For [[Micro-Businesses]], it becomes the shared source of truth no one has to maintain separately.

## User Stories

- As a freelancer, I want to import my phone contacts so I don't manually re-enter hundreds of names
- As a sales rep, I want to search for a contact by company name while on a call so I can pull up their history in under 3 seconds
- As a business owner, I want to assign contacts to specific team members so responsibility is clear
- As a field sales agent, I want to add a contact by photographing a business card at a trade show so I capture leads without typing
- As a team manager, I want to filter contacts by tag (e.g., "VIP") so I can segment and prioritize outreach
- As an admin, I want to bulk-import a CSV of 500 contacts so we can migrate from our old system

## Acceptance Criteria

- Create a contact with only a name and phone number (no other required fields)
- Profile supports: name, company, phone (multiple), email, address, tags, notes, assigned user, type, source, custom fields
- Full-text search returns results in < 300ms for orgs with up to 10,000 contacts
- Filter by: status, type, assigned_to, tag, date range, source
- Import from: phone contacts (expo-contacts), CSV, vCard
- Business card OCR: photo → Google Vision → pre-filled form → user confirms
- Duplicate detection warns on create/import if phone or email matches an existing contact
- Soft delete only — contacts are never permanently deleted except for GDPR requests

## Technical Notes

- Full-text search via PostgreSQL `tsvector` generated column on (first_name, last_name, company, notes)
- Phone/email encrypted at rest with AES-256-GCM
- CSV import as Bull background job with WebSocket progress reporting
- Business card: expo-camera → compress to ≤500KB → backend → Google Vision API → heuristic parser → pre-fill response
- `custom_fields JSONB` with GIN index for key-based filtering
- See [[Smart Data Entry]] for the full business card + voice note entry design
- See [[Auto Information Capture]] for automatic call/message logging to contact history

## Related Features

- [[Sales Pipeline]] — contacts are linked to deals
- [[Interaction History]] — every touchpoint logged here
- [[Task Management]] — tasks linked to contacts
- [[Call & Messaging]] — one-tap call and SMS from contact profile
- [[Appointment Scheduling]] — meetings linked to contacts
- [[Smart Data Entry]] — OCR and voice input for new contacts
- [[Auto Information Capture]] — calls/messages auto-logged
- [[Custom Workflows]] — custom fields defined here

## Open Questions

1. Do we need a separate Company entity, or is company a field on contacts for MVP?
2. Should duplicate detection also check company name, or only phone/email?
3. Do we support contact merge (combining two duplicates into one)?
4. Should tags be org-wide shared, or per-user?
5. What is the maximum number of custom fields per contact? (Proposed: 50)
