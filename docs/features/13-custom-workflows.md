# Feature 13: Customizable Workflows & Stages

## Overview

Customizable Workflows ensure that the CRM adapts to the business, not the other way around. Every business has its own sales process, its own terminology for deal stages, its own set of fields it needs to track on contacts, and its own rules for what should happen when something changes. A CRM that forces everyone into the same fixed workflow will be fought, workaround-ed, and eventually abandoned.

This feature covers three layers of customization: (1) **structural customization** — stages, custom fields, multiple pipelines; (2) **template customization** — reusable deal and contact templates for quick creation; and (3) **automation rules** — "when X happens, do Y" logic that removes manual follow-up steps.

A real estate agency needs a pipeline with stages like "Property Visit Scheduled → Offer Made → Offer Accepted → Contracts Signed → Closed." A marketing agency needs "Brief Received → Strategy Presented → Proposal Sent → Retainer Signed." Neither fits the generic "Lead → Qualified → Proposal → Closed" default — and neither should have to.

## User Stories

- **As a business owner**, I want to rename and reorder my pipeline stages to match exactly how my sales process works so that the CRM reflects reality and not a generic template.
- **As an admin**, I want to add custom fields to contact profiles (e.g., "Industry", "Budget", "Contract Renewal Date") so that I can track information that is specific to my business.
- **As a manager**, I want to create a rule that automatically creates a follow-up task when a deal is moved to "Proposal Sent" so that reps never forget to follow up.
- **As a sales rep**, I want to use a "New Enterprise Deal" template that pre-fills 8 custom fields with their default values so that creating complex deals takes seconds, not minutes.
- **As an admin**, I want to create separate pipelines for our product sales team and our services team with different stages so that each team works in a process that fits their reality.
- **As a business owner**, I want to define which fields are visible on contact cards in the list view so that the most important information is always visible without opening the full profile.

## Acceptance Criteria

- Pipeline stage CRUD: create, rename, reorder (drag), color-code, delete (if empty), mark as won/lost stage
- Multiple pipelines: create up to 10 pipelines per org; each with independent stages
- Custom fields on contacts and deals: field types: text, number, date, dropdown (single-select), multi-select, checkbox, URL, email, phone
- Custom field management: define field name, type, description, default value; mark as required; set visibility (always shown / shown when filled)
- Deal/contact templates: save current field values as a named template; apply template on new record creation to pre-fill fields
- Automation rules (MVP scope — trigger + action pairs):
  - Trigger: deal moves to stage X → Action: create task assigned to deal owner
  - Trigger: deal moves to stage X → Action: send notification to team member
  - Trigger: contact created with tag X → Action: create task
  - Trigger: deal marked as won → Action: create task "Send onboarding materials"
  - Trigger: deal marked as lost → Action: create task "Schedule win-back call in 90 days"
- Maximum 20 automation rules per org for MVP (prevent complexity explosion)
- Automation rule creation UI: visual "If → Then" builder (no code required)

## Edge Cases

- Delete a custom field that has data: warn user that data will be lost; require confirmation; soft-delete field (data remains in JSONB but field is hidden and excluded from exports)
- Custom required field added after 1,000 contacts already exist: existing contacts are not retroactively invalid; field shows as "required" only on new record creation; a "Missing required field" filter helps user backfill
- Automation rule loop (Rule A triggers Rule B which triggers Rule A): detect cycles at rule creation time; reject rule if it would create a cycle; max automation chain depth = 3
- Pipeline deleted while automation rule references it: rule is disabled and flagged "pipeline deleted — rule inactive"
- Template used across team: templates are org-wide (not per-user) unless marked as personal; admin can restrict template creation to admins only
- Custom dropdown field with 100+ options: show searchable dropdown in form, not a flat list

## Open Questions

1. Should automation rules support time-based triggers (e.g., "if deal has been in stage X for 7 days, create a task")? Very valuable but requires a cron-based rule evaluator. Include in MVP if feasible, otherwise v1.5.
2. Should there be a marketplace of workflow templates for common industries (Real Estate, Agency, SaaS, etc.)? Post-MVP — good growth lever.
3. Should custom fields be orderable in the profile view (user drags fields into preferred order)? Yes — store order in `custom_field_definitions.position`.
4. Maximum number of custom fields per entity: 50 proposed. Is this sufficient for medium businesses?
5. Should automation rules support "send email" as an action? Requires email integration — post-MVP.

## Technical Notes

- Custom field definitions stored in `custom_field_definitions` table: (id, organization_id, entity_type, name, type, options JSONB, required, default_value, position, is_archived)
- Custom field values stored in entity `custom_fields JSONB` column; queried with `jsonb_extract_path`; GIN-indexed for filter queries
- Automation rules stored in `automation_rules` table: (id, organization_id, trigger_event, trigger_conditions JSONB, action_type, action_payload JSONB, is_active)
- Rule execution: event-driven; when a trigger event fires (e.g., deal stage change), a Bull job is enqueued to evaluate all matching rules for the org; rules executed asynchronously to not block the user-facing API response
- Cycle detection: at rule creation, build a directed graph of trigger→action chains; use DFS to detect cycles before saving
- Templates: stored in `record_templates` table: (id, organization_id, entity_type, name, field_values JSONB, created_by); applied by merging template values into the new record form client-side
