---
tags: [feature, mvp, mobile, offline, field-sales]
status: specced
related: ["Contact Management", "Sales Pipeline", "Task Management", "Appointment Scheduling", "Tech Stack", "System Overview"]
created: 2026-05-01
---

# Mobile Field Access

## Overview

Mobile Field Access is not a single feature — it is the foundational design constraint shaping the entire product. Every screen, interaction, and data flow is designed for a person holding a phone in the field: a real estate agent at a showing, a B2B sales rep at a client's office, a field technician in a building with no signal.

The critical capability is **offline-first operation**: the app works fully with no internet. Everything syncs automatically when connectivity returns. No user action needed.

This is what separates us from every competitor in the market. [[Bitrix24]], [[Salesforce]], [[HubSpot]], Pipedrive — none of them work offline.

## Why It Matters

Field sales is a $multi-trillion market. Reps driving between clients, visiting sites, attending events — they operate intermittently connected. Every time a rep can't access their CRM at the critical moment of a client interaction, data is lost and deals suffer. Offline-first is not a nice-to-have for this segment — it is a prerequisite.

## User Stories

- As a field sales rep, I want to add a contact and create a follow-up task while in a basement with no signal so I don't lose information
- As a field agent, I want offline changes to sync automatically when I reconnect so I don't manually trigger anything
- As a manager, I want to tag a meeting location so I have a geographic record of field visits
- As a sales rep, I want a push notification when a client replied to my message while I was in a meeting
- As a field agent, I want to pull up any contact's full profile on my phone even in areas with poor signal
- As a field rep, I want the app to be fast and usable with one hand while walking

## Acceptance Criteria

- **Works offline:** view contacts, view deals + pipeline, view tasks, add contact, update contact, create task, complete task, write notes
- **Auto-sync on reconnect:** within 30 seconds of reconnection, no user action required
- **Sync status indicator:** "Offline" (red) / "Syncing..." (amber) / "All synced" (green)
- **Conflict resolution:** server timestamp wins; non-blocking notification for overridden changes
- **Location tagging:** GPS capture on field visit/meeting creation; "Open in Maps" link
- **Touch-optimized:** all interactive elements ≥ 44×44 points; one-thumb accessible
- **Performance:** 5,000 contacts scrolls at 60fps; search returns in < 300ms

## Technical Notes

- Offline storage: SQLite (expo-sqlite) for contacts/deals/tasks; MMKV for KV metadata
- Mutation queue: array in MMKV, each item: {type, entity, payload, client_timestamp, retry_count}
- Sync engine: expo-background-fetch background task; runs every 15 min even when app closed
- Delta sync: `GET /sync/delta?since={last_sync_at}` — returns all org changes since timestamp
- Location: expo-location with `Accuracy.Balanced` (not GPS-precision; saves battery)
- Connectivity: expo-network `NetInfo` API for online/offline mode switching
- See [[Tech Stack]] for full component list (expo-sqlite, MMKV, expo-background-fetch)

## Related Features

- [[Contact Management]] — contacts cached locally for offline access
- [[Sales Pipeline]] — pipeline board works offline
- [[Task Management]] — tasks accessible and completable offline
- [[Appointment Scheduling]] — calendar events accessible offline; location tagging
- [[Tech Stack]] — technologies enabling offline capability
- [[System Overview]] — sync architecture overview

## Open Questions

1. Maximum offline cache size? (Proposed: most recent 2,000 contacts + all deals + all user's tasks)
2. Point-in-time vs continuous location tracking? (Point-in-time for MVP — continuous raises privacy concerns)
3. Should offline edits be visible to colleagues before sync? (No — local until synced)
4. What happens when a contact is deleted on server while user has it cached offline? (Server returns 410 Gone on sync; client removes from cache)
5. Should there be an explicit "Go Offline" toggle? (No — always automatic)
