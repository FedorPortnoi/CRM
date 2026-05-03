# Feature 06: Appointment & Meeting Scheduling

## Overview

Appointment Scheduling eliminates the back-and-forth of coordinating meetings with customers. Instead of "Are you free Thursday? No, how about Friday? What time?" the CRM provides a built-in calendar where appointments are created, sent as invites to contacts, and synced bidirectionally with Google Calendar and Apple Calendar.

Every appointment is linked to a contact (and optionally a deal), so meeting context is always preserved. After a meeting, notes are attached directly to the contact's history — no separate note-taking app needed. Meeting reminders fire automatically via push notification to ensure no one shows up unprepared or, worse, misses the meeting entirely.

For field sales teams, having an integrated schedule means the day is visible in one app: meetings, tasks, and communications all in one place. Switching between Calendar, Notes, and CRM is eliminated.

## User Stories

- **As a sales rep**, I want to schedule a meeting with a client from their contact profile so that the appointment is automatically linked to their history.
- **As a business owner**, I want to receive a push notification 30 minutes before a meeting so that I have time to review the client's history before the call.
- **As a team manager**, I want to see my team's calendar to avoid double-booking when assigning client meetings.
- **As a sales rep**, I want my CRM appointments to appear in my Google Calendar so that I have one unified view of my day.
- **As a customer success manager**, I want to add meeting notes directly after an appointment and have them saved to the contact's history automatically.
- **As a field agent**, I want to set the meeting location and have it open in Maps when I tap it so that I can navigate without leaving the app.

## Acceptance Criteria

- Calendar view: month, week, and day views on mobile (react-native-calendars)
- Create appointment: title (required), contact link (required), start/end time (required), location (optional), description (optional), attendees (from team), reminder setting (default 30 min)
- Send invite to contact: generates an iCal (.ics) file, sends via email or SMS to contact
- Automated reminder: push notification to all attendee users at configured interval before meeting
- Post-meeting note prompt: when a meeting's end time passes, prompt user to add meeting notes; notes auto-appended to contact activity history with type=meeting
- Google Calendar sync: OAuth2 authorization → bidirectional sync (CRM events appear in Google Calendar, Google Calendar events appear in CRM with contact matching attempted)
- Apple Calendar sync: EventKit integration via expo-calendar → read device calendar events into CRM
- Team availability view: show all team members' schedules for a given day to avoid conflicts
- Meeting linked to deal: when creating from a deal view, deal is pre-linked
- All appointments create an activity_log entry (meeting created, meeting completed, meeting cancelled)

## Edge Cases

- Meeting with no Google Calendar sync: appointment exists only in CRM; user sees it only in CRM calendar
- Two users accept the same time slot from Google Calendar and CRM creates duplicate events: detected by Google event ID; second webhook is a no-op (idempotent)
- Contact has no email (can't send iCal): offer SMS with meeting details as plain text fallback
- Meeting reminder fires when phone is on Do Not Disturb: iOS/Android handle this — high-priority notifications can bypass DND; make this configurable per user preference
- Meeting cancelled after notes were added: notes remain in history as "(Meeting cancelled) + notes"; they're part of the history
- Appointment at midnight spanning two days: display correctly in both the day it starts and the day it ends on day view
- Google Calendar token expires: detect 401 from Google API → prompt user to re-authorize; queue missed sync events for retry

## Open Questions

1. Should meeting invites to contacts be sent via email, SMS, or a custom "join link"? For MVP: email only (SMS as fallback if no email).
2. Should there be a public-facing booking link (like Calendly) so contacts can self-schedule? High value but significant scope — defer to v2.
3. Should we support video meeting links (Zoom, Google Meet) embedded in appointments? Yes — as a free text "Meeting URL" field for MVP; deep integration in v2.
4. What happens to meetings when a team member is deleted? Transfer to org owner.
5. Should recurring meetings be supported? (Weekly 1:1 with a client) — Yes, using same RRULE approach as tasks.

## Technical Notes

- Google Calendar OAuth: server-side OAuth2 flow; refresh tokens stored encrypted in DB; `googleapis` npm package
- Calendar sync: webhook from Google Calendar API notifies backend of changes; backend fetches delta and upserts into calendar_events table
- expo-calendar: used for Apple Calendar read access (no OAuth required on iOS — user grants permission); write access for adding CRM events to device calendar
- Meeting invite (.ics): generated server-side using `ical-generator` npm package; attached to email sent via Nodemailer
- Post-meeting prompt: mobile tracks current time; when current time > event end_time, show local notification/modal once; flag `post_meeting_prompted = true` in MMKV to avoid repeat prompts
- Team availability: `GET /calendar/availability?date=2026-05-01&user_ids[]=...` returns busy time blocks per user (fetched from calendar_events table + Google Calendar free/busy API)
