# Feature 01: Contact Management & Customer Database

## Overview

Contact Management is the foundation of the entire CRM. Every customer, lead, prospect, and partner lives here. Without a reliable, searchable, centrally accessible contact database, no other feature has context — tasks have no owner, deals have no buyer, messages have no recipient.

The contact database must feel like a supercharged address book: fast to search, easy to add, and rich with information without being intimidating. Unlike enterprise CRMs that demand 20 fields before you can save a contact, this system allows a contact to be created with just a name and a phone number, with additional information filled in gradually over time.

Every contact has a full activity history, linked tasks, linked deals, and communication history. The contact profile is the single source of truth for everything known about a person or business.

## User Stories

- **As a freelancer**, I want to import my phone contacts into the CRM so that I don't have to manually re-enter hundreds of names and numbers I already have.
- **As a sales rep**, I want to search for a contact by company name while I'm on a call so that I can pull up their history in under 3 seconds.
- **As a business owner**, I want to assign contacts to specific team members so that each salesperson is responsible for their own relationships.
- **As a field sales agent**, I want to add a new contact by photographing a business card so that I capture leads at events without manual typing.
- **As a team manager**, I want to filter contacts by tag (e.g., "VIP", "Follow-up") so that I can segment and prioritize outreach.
- **As an admin**, I want to import a CSV of 500 contacts from our old system so that we can migrate without data loss.

## Acceptance Criteria

- A contact can be created with only a name and phone number (no other required fields)
- Contact profiles support: first/last name, company, phone (multiple), email, address, tags, notes, assigned user, contact type (lead/customer/partner), source, custom fields (JSONB)
- Full-text search across name, company, email, phone returns results in < 300ms for orgs with up to 10,000 contacts
- Filter by: status (active/inactive/archived), type, assigned_to, tag, created date range, source
- Import from: phone address book (expo-contacts), CSV file, vCard
- Business card OCR: camera capture → Google Vision API → pre-filled form (user confirms before saving)
- Assign contacts to team members; contact appears in assignee's "My Contacts" view
- Bulk operations: bulk assign, bulk tag, bulk archive
- Duplicate detection: warn if phone or email already exists in org on create/import
- Soft delete (archive) only — contacts are never permanently deleted except on GDPR request
- All contact CRUD actions create an entry in the activity_log table

## Edge Cases

- Importing CSV with missing headers: show column mapping UI, allow user to map columns manually
- Duplicate phone numbers on import: show a conflict resolution UI (skip, overwrite, create anyway)
- Contact with no phone and no email: allowed, but show a warning that messaging won't be possible
- Team member is deactivated while they have assigned contacts: contacts remain assigned, show "(Deactivated)" label; manager can bulk reassign
- Contact belongs to a company that is itself a contact: support company-contact linking (parent contact relationship)
- Search with Unicode/non-ASCII names (Cyrillic, Arabic, CJK): handled by PostgreSQL full-text search with unaccent extension

## Open Questions

1. Do we need a "company" entity separate from contacts, or is company just a field on contacts for MVP? (Recommendation: field for MVP, entity for v2)
2. What is the maximum number of custom fields an org can define on contacts? (Proposed limit: 50)
3. Should duplicate detection also run on company name, or only phone/email?
4. Do we support contact merge (combining two duplicates into one)? Critical for import workflows.
5. Should tags be org-wide shared, or per-user?

## Technical Notes

- Full-text search: PostgreSQL `tsvector` column updated via trigger on contact insert/update
- Phone and email stored encrypted (AES-256-GCM, key in env) — decrypted only in API response
- CSV import runs as a background job (Bull queue) with progress reporting to client via WebSocket
- Business card OCR: mobile sends image to backend, backend calls Google Vision API `documentTextDetection`, parses name/phone/email/company with regex + heuristics, returns structured pre-fill data
- `custom_fields` JSONB indexed with a GIN index for `jsonb_path_ops` to support key-based filtering
- Contact list on mobile: virtualized FlatList with 50-item pages, prefetch next page when 80% scrolled
