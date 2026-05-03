---
tags: [feature, mvp, calendar, scheduling, appointments]
status: specced
related: ["Contact Management", "Interaction History", "Task Management", "Sales Pipeline", "Mobile Field Access", "Auto Information Capture"]
created: 2026-05-01
---

# Appointment Scheduling

## Overview

Schedule and manage meetings without back-and-forth communication. The CRM provides a built-in calendar where appointments are created, sent as invites to contacts, and synced bidirectionally with Google Calendar and Apple Calendar.

Every appointment is linked to a contact and optionally a deal. After a meeting, notes are attached directly to the contact's [[Interaction History]] — no separate note-taking app. Meeting reminders fire via push notification automatically.

For field sales teams, having an integrated schedule means the day is visible in one app: meetings, tasks, and communications all in one place.

## Why It Matters

Scheduling friction is a deal killer. The "Are you free Thursday? No, how about Friday?" email chain wastes time and creates opportunities for deals to go cold. The CRM calendar eliminates this by making meeting management frictionless and ensuring every appointment is linked to its business context.

Post-meeting notes saved directly to the contact profile (via [[Auto Information Capture]] prompt) solve the "I'll remember to write up notes later" problem that plagues most meeting follow-up workflows.

## User Stories

- As a sales rep, I want to schedule a meeting from a contact profile so the appointment is automatically linked to their history
- As a business owner, I want a push reminder 30 minutes before a meeting so I have time to review the client's history
- As a team manager, I want to see my team's calendar to avoid double-booking
- As a sales rep, I want CRM appointments to appear in my Google Calendar so I have one unified day view
- As a customer success manager, I want to add post-meeting notes and have them auto-saved to contact history
- As a field agent, I want to tap a meeting location and have it open in Maps

## Acceptance Criteria

- Calendar views: month, week, day on mobile (react-native-calendars)
- Create: title, contact link (required), start/end time, location, description, attendees, reminder setting (default 30 min)
- Invite to contact: iCal (.ics) via email (SMS fallback if no email)
- Automated reminder: push notification at configured time before meeting
- Post-meeting note prompt: when meeting end_time passes, prompt → notes auto-appended to activity_log
- Google Calendar sync: OAuth2 bidirectional sync via `googleapis`
- Apple Calendar: expo-calendar read/write access
- Team availability view for conflict avoidance

## Technical Notes

- Google OAuth: server-side flow; refresh tokens encrypted in DB; webhook for real-time change sync
- expo-calendar: device calendar read/write — adds CRM events to device calendar
- Meeting invite: `ical-generator` npm → .ics attachment in email via Nodemailer
- Post-meeting prompt: background task checks `end_time <= now AND post_meeting_prompted = false`; local notification fired; flag set
- Location: stored as `lat/lng` + text; tapped → `Linking.openURL` to Apple Maps / Google Maps

## Related Features

- [[Contact Management]] — appointments linked to contacts
- [[Interaction History]] — post-meeting notes logged here
- [[Task Management]] — meetings can have linked follow-up tasks
- [[Sales Pipeline]] — appointments can be linked to deals
- [[Mobile Field Access]] — location tagging, offline support for field reps
- [[Auto Information Capture]] — post-meeting note prompt engine

## Open Questions

1. Meeting invites via email, SMS, or custom "join link"? (MVP: email, SMS fallback)
2. Public booking link (Calendly-style) so contacts self-schedule? (Proposed: v1.5)
3. Video meeting links (Zoom, Google Meet)? (MVP: free text "Meeting URL" field)
4. Recurring meetings? (Use same RRULE approach as [[Task Management]])
5. What happens to meetings when a team member is deleted? (Transfer to org owner)
