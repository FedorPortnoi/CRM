---
tags: [feature, mvp, workflows, automation, customization]
status: specced
related: ["Sales Pipeline", "Contact Management", "Task Management", "Reporting Dashboard", "Small Businesses", "Medium Businesses", "Decision Log"]
created: 2026-05-01
---

# Custom Workflows

## Overview

The system adapts to the business, not the other way around. Every business has its own sales process, terminology for deal stages, fields to track, and rules for what should happen when something changes. A CRM that forces everyone into fixed workflows will be fought, workaround-ed, and abandoned.

Three layers of customization:
1. **Structural:** Pipeline stages, custom fields on contacts/deals, multiple pipelines
2. **Templates:** Reusable deal and contact templates for quick creation
3. **Automation rules:** "When X happens, do Y" logic that removes manual follow-up steps

## Why It Matters

Every industry has a different sales process. Real estate: "Property Visit → Offer Made → Offer Accepted → Contracts Signed → Closed." Marketing agency: "Brief Received → Strategy Presented → Proposal Sent → Retainer Signed." Neither fits the generic default. Forcing either into "Lead → Qualified → Proposal → Closed" reduces adoption and forces people to use workarounds.

Custom fields and automation rules are the features that take the CRM from a contact database to a true business process tool. They're also what [[Medium Businesses]] need to consider us seriously.

## User Stories

- As a business owner, I want to rename and reorder pipeline stages to match exactly how my sales process works
- As an admin, I want to add custom fields to contact profiles (e.g., "Industry", "Budget") for business-specific data
- As a manager, I want a rule that automatically creates a follow-up task when a deal moves to "Proposal Sent"
- As a sales rep, I want to use a "New Enterprise Deal" template that pre-fills 8 custom fields
- As an admin, I want separate pipelines for our product team and services team with different stages
- As a business owner, I want to define which fields are visible on contact cards in the list view

## Acceptance Criteria

- Pipeline stage CRUD: create, rename, reorder (drag), color-code, delete (if empty), mark as won/lost
- Multiple pipelines: up to 10 per org for MVP
- Custom fields: types: text, number, date, dropdown, multi-select, checkbox, URL, email, phone
- Custom field management: name, type, description, default value, required flag, position
- Record templates: save field values as named template; apply on creation to pre-fill
- Automation rules (MVP trigger+action pairs):
  - Deal moves to stage X → create task assigned to deal owner
  - Deal moves to stage X → send notification to team member
  - Contact created with tag X → create task
  - Deal marked won/lost → create task
- Max 20 automation rules per org for MVP
- Visual "If → Then" automation builder (no code required)

## Technical Notes

- Custom fields: `custom_field_definitions` table; values in `custom_fields JSONB` on entities
- Automation rules: `automation_rules` table; event-driven execution via Bull job queue
- Cycle detection: DFS on trigger→action graph at rule creation time; max chain depth 3
- Templates: `record_templates` table; applied by merging field values into form client-side
- See [[Data Models]] for schema details on custom_field_definitions and automation_rules

## Related Features

- [[Sales Pipeline]] — pipeline stages are the primary customization surface
- [[Contact Management]] — custom fields defined for contacts
- [[Task Management]] — automation rules can auto-create tasks
- [[Reporting Dashboard]] — custom fields can be used in filters
- [[Decision Log]] — decisions made about automation scope for MVP

## Open Questions

1. Should automation rules support time-based triggers ("if deal in stage 7+ days, create task")? (Include in MVP if feasible; v1.5 otherwise — requires cron evaluator)
2. Should there be a marketplace of workflow templates for common industries? (Post-MVP)
3. Should custom fields be orderable by user drag? (Yes — store in position column)
4. Maximum custom fields per entity: 50 proposed — sufficient?
5. Should automation rules support "send email" action? (Requires email integration — post-MVP)
