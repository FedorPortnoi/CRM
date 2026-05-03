# Feature 12: Automatic Information Capture

## Overview

Automatic Information Capture is the principle that the system should record everything it can observe, without asking the user to do it manually. Every time a salesperson has to stop and manually log "I called Sarah at 2pm for 8 minutes and talked about the contract" is friction that either gets skipped or creates data entry debt. Skipped means data is lost. Debt means it never gets done.

This feature ensures that calls are logged when they happen, messages are saved when they are sent, meeting notes are created when a meeting ends, and email content is extracted when email integration is enabled. The user's job is to have the conversation — the app's job is to remember it.

This is the feature that transforms a CRM from a data entry tool into a relationship intelligence platform. When salespeople realize the CRM is capturing things for them — not demanding things from them — adoption rates rise dramatically.

## User Stories

- **As a sales rep**, I want every call I make from the app to be automatically logged to the contact's history so that I never have to manually enter "Called [Name] on [date]" again.
- **As a team member**, I want outbound SMS messages I send through the CRM to be automatically saved to the contact's history so that the conversation is always in context.
- **As a manager**, I want inbound SMS replies from clients to automatically appear in the CRM so that reps can see customer responses without checking their personal phone.
- **As a customer success manager**, I want meeting notes to be auto-created when a calendar appointment ends so that I'm prompted to fill in details while they're fresh, not hours later.
- **As a business owner who uses email**, I want the CRM to scan incoming emails from known contacts and log them to the contact's history so that email conversations are part of the relationship record.
- **As a rep**, I want the system to extract the key details from an email (subject, sender, date) automatically so that I don't have to retype information that already exists.

## Acceptance Criteria

- **Call auto-log:** When user initiates a call via the CRM (tap "Call" on contact profile), a call activity is logged automatically with: contact_id, user_id, direction (outbound), start_time (when app goes to background), estimated duration (when app returns to foreground), auto-note prompt shown
- **Inbound call detection:** When device receives a call, if the caller's number matches a CRM contact, show an in-app notification identifying the contact; log the inbound call (user must not decline automatic logging — it's always on)
- **Outbound SMS auto-log:** Every SMS sent via the CRM is automatically saved to messages table and activity_log with type=message
- **Inbound SMS auto-log:** Every Twilio webhook for an inbound SMS is automatically saved to messages table and activity_log; no user action needed
- **In-app message auto-log:** All in-app messages (sent and received) automatically logged
- **Post-meeting auto-prompt:** When a calendar event's end_time passes, app shows a local notification: "Meeting with [Contact] ended — add notes?" with quick-action "Add notes" (opens note form) and "Skip"
- **Email integration (if configured):** Forward-to-CRM email address: user can forward any email to `log@{org_slug}.crm.app` to add it to a contact's history (matched by From/To address against contacts database)
- **No duplicate logging:** Each call, message, and event is logged exactly once, even if the app crashes and restarts; idempotency enforced via unique constraint on (entity_type, external_id)

## Edge Cases

- Call auto-log when user makes a call NOT from the CRM (switches to dialer directly): not captured — we only know about calls initiated via the CRM `tel://` deep link; we cannot intercept arbitrary calls (OS limitation on iOS; Android could use call log permission but this is privacy-sensitive — defer to v2 opt-in)
- App is killed during a call: start_time is saved before the call starts; on app restart, compare current time with start_time to estimate duration; show post-call note prompt even if duration is inaccurate
- Inbound SMS from unknown number (not in contacts): saved to a "Unknown" inbox; user can match to existing contact or create new contact from it
- Meeting auto-prompt fires while user is in another meeting: notification queued; user sees it when they check notifications; not dismissed silently
- Email forwarding to wrong org: emails are matched by sender's email against users table; if sender is not an org member, email is rejected with an autoresponse explaining the error
- Email with no matching contact (From/To not in CRM): email is saved as an "unmatched email" in a review queue; user can manually link to a contact

## Open Questions

1. Should inbound call detection require the user to grant call log permission (Android) or use push-to-identify via Twilio? Push-to-identify (Twilio Lookup) is privacy-safe; call log permission is invasive. Use Twilio for MVP.
2. Should auto-captured call logs require user confirmation before saving, or save silently? Save silently — any friction defeats the purpose.
3. Should there be a "disable auto-capture" toggle for privacy-conscious users? Yes — global setting in user preferences; disabled = user must manually log everything.
4. Should meeting auto-notes include AI-generated summaries (if notes are taken)? Post-MVP AI feature — v2.
5. Email parsing: should we attempt to extract action items from email content automatically? Intriguing but complex — post-MVP.

## Technical Notes

- Call auto-log trigger: `Linking.openURL('tel:...')` fires → record `call_start` in MMKV with timestamp and contact_id; `AppState` listener fires `active` event when user returns → compute `call_end - call_start` = estimated duration → create activity_log entry
- Inbound call identification: requires call log permission on Android (READ_CALL_LOG) or Twilio Voice SDK notification → use Twilio Lookup to identify caller → WebSocket push to app with contact info
- Post-meeting prompt: `expo-task-manager` background task runs every 5 minutes; checks `calendar_events` where `end_time <= now AND post_meeting_prompted = false AND status = scheduled`; triggers local notification; marks as prompted
- Email forward parsing: inbound email via dedicated Nodemailer-compatible SMTP listener or SendGrid Inbound Parse webhook; `mailparser` npm package to extract headers, body, attachments; match sender against contacts via email field
- Idempotency: every auto-captured event has a `source_id` (e.g., Twilio MessageSid, Google Calendar event ID); unique constraint on `(organization_id, source_id)` prevents duplicate inserts
