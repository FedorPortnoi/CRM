---
tags: [feature, mvp, auto-capture, automation, logging]
status: specced
related: ["Call & Messaging", "Interaction History", "Smart Data Entry", "Task Management", "Appointment Scheduling", "Contact Management"]
created: 2026-05-01
---

# Auto Information Capture

## Overview

The system should record everything it can observe, without asking the user to do it manually. Every time a salesperson has to stop and manually log "I called Sarah at 2pm for 8 minutes about the contract" is friction that either gets skipped or creates data entry debt. Skipped = data lost. Debt = never done.

This feature ensures calls are logged when they happen, messages are saved when sent, meeting notes are prompted when meetings end, and email content is extracted when integrated. The user's job is to have the conversation — the CRM's job is to remember it.

The companion to [[Smart Data Entry]] (which handles user-initiated entry) and [[Interaction History]] (which displays the captured data).

## Why It Matters

CRM adoption collapses when logging feels like an obligation. When salespeople realize the CRM is capturing things *for* them — not demanding things *from* them — adoption rates rise dramatically. The first time a rep's manager says "I see you called the client this morning — what did they say?" and the call is already in the system, the rep becomes a CRM believer.

## User Stories

- As a sales rep, I want every call I make from the CRM to auto-log to contact history so I never manually enter "Called [Name] on [date]" again
- As a team member, I want outbound SMS to automatically save to contact history
- As a manager, I want inbound SMS replies to auto-appear in the CRM so reps don't need to check their personal phone
- As a customer success manager, I want post-meeting note prompts so context is captured while fresh
- As a business owner using email, I want the CRM to scan incoming emails from known contacts and log them
- As a rep, I want the system to extract key email details automatically so I don't retype information that exists

## Acceptance Criteria

- **Call auto-log:** Calls initiated via CRM → logged automatically with contact_id, user_id, direction, start_time, estimated duration, type=call
- **Inbound call identification:** Phone number matches CRM contact → in-app notification identifies contact; inbound call logged
- **Outbound SMS auto-log:** Every Twilio SMS saved to messages table and activity_log automatically
- **Inbound SMS auto-log:** Every Twilio webhook for inbound SMS saved automatically; no user action needed
- **Post-meeting prompt:** When event end_time passes → local notification "Meeting with [Contact] ended — add notes?" with "Add notes" + "Skip" actions
- **Email forward-to-log:** User forwards email to `log@{org_slug}.crm.app` → matched by From/To against contacts → logged
- **No duplicate logging:** Each auto-captured event logged exactly once; source_id + unique constraint enforces idempotency

## Technical Notes

- Call auto-log: `Linking.openURL('tel:...')` → MMKV stores `{call_start, contact_id}`; AppState 'active' event on return → compute duration → create activity_log entry
- Post-meeting prompt: expo-task-manager background task polls `calendar_events WHERE end_time <= now AND post_meeting_prompted = false`; fires local notification; sets flag
- Twilio webhook idempotency: unique constraint on `(organization_id, source_id)` where source_id = Twilio MessageSid; duplicate webhooks are no-ops
- Email forward: inbound SMTP / SendGrid Inbound Parse webhook → `mailparser` → match sender against contacts.email → create activity_log entry with type=email

## Related Features

- [[Call & Messaging]] — the communication layer that generates call and message events to capture
- [[Interaction History]] — where all captured data appears in the timeline
- [[Smart Data Entry]] — the user-initiated complement (OCR, voice, CSV)
- [[Task Management]] — task completion is also an auto-captured event
- [[Appointment Scheduling]] — post-meeting prompt engine lives here

## Open Questions

1. Should auto-capture require user confirmation before saving, or save silently? (Silent — friction defeats the purpose)
2. Should there be a "disable auto-capture" toggle? (Yes — in user preferences)
3. Inbound call detection: call log permission (Android) or Twilio push-to-identify? (Twilio for MVP — privacy-safe)
4. Should we attempt to extract action items from email content automatically? (Post-MVP AI feature)
5. Should auto-captured call logs include call recordings? (Privacy/legal concern — never without explicit consent and legal review)
