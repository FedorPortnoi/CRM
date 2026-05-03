# Feature 09: Mobile Field Access

## Overview

Mobile Field Access is not a single feature — it is the foundational design constraint that shapes the entire product. Every screen, interaction, and data flow is designed for a person holding a phone in the field: a real estate agent at a property showing, a B2B sales rep at a client's office, a consultant on a factory floor. These users cannot rely on a laptop, a stable WiFi connection, or a large screen.

The critical capability is **offline-first operation**: the app works fully even with no internet. A field rep can update a deal, add a contact, complete a task, and write meeting notes while underground, on a plane, or in a rural area. Everything syncs automatically when connectivity returns — no user action needed.

Location tagging for field visits adds geographic context to meetings and contacts. Push notifications ensure that while reps are mobile, they never miss an important update or reminder from the rest of the team.

## User Stories

- **As a field sales rep**, I want to add a new contact and create a follow-up task while I'm meeting with a client in a basement with no signal so that I don't lose any information.
- **As a field agent**, I want the app to sync all my offline changes automatically when I get back in my car and reconnect so that I don't have to manually trigger anything.
- **As a manager**, I want to tag a meeting location so that I have a geographic record of field visits for my client portfolio.
- **As a sales rep**, I want to receive a push notification that a client replied to my message while I was in a meeting so that I see it immediately after I finish.
- **As a field team manager**, I want my reps to be able to pull up any contact's full profile and history on their phone, even in areas with poor signal, so that they're always prepared.
- **As a field agent**, I want the app to be fast and easy to use with one hand while I'm walking so that I can look up information without stopping.

## Acceptance Criteria

- **Offline operation:** The following work offline: view contacts (all previously loaded), view deals and pipeline, view tasks (all), add a new contact, update existing contact fields, create tasks, complete tasks, write notes
- **Sync on reconnect:** All offline mutations sync automatically within 30 seconds of network restoration; no user action required
- **Sync status indicator:** Persistent status bar shows "Offline" (red), "Syncing..." (amber), "All synced" (green); sync progress shown for large batches
- **Conflict resolution:** If a contact was edited offline by the user AND by a colleague while offline, server timestamp wins; user sees a non-blocking notification "3 of your offline changes were overridden by a teammate"
- **Location tagging:** When creating or editing a calendar event / field visit note, user can optionally add current GPS location (expo-location); stored as `lat/lng`; displayed as "Open in Maps" link
- **Push notifications:** Delivered reliably even when app is in background or killed state via FCM/APNS
- **Touch-optimized UI:** All interactive elements are minimum 44×44 points (Apple HIG standard); primary actions accessible with one thumb; no hover-dependent UI
- **Performance:** Contact list of 5,000 entries scrolls at 60fps; contact search returns results in < 300ms; screen transitions complete in < 300ms

## Edge Cases

- Very long offline period (3+ days with many changes): sync may take 10–30 seconds; show a progress indicator with number of items being synced
- Conflict where user deleted a contact offline but colleague edited it: server state (edited) wins; user is notified that "Contact [Name] was restored — it was edited by [colleague] while you were offline"
- Location permission denied by user: gracefully degrade — location tagging fields simply not shown; app functions normally
- App killed mid-sync: sync resumes on next app open; offline queue is persisted to SQLite (not in-memory) so it survives process death
- Field rep with 2GB offline data limit reached: notify user that some older contact data has been evicted from local cache; they must reconnect to load it
- Push notification tapped while app is closed: deep link to the relevant contact/deal/task (universal link / custom URI scheme)

## Open Questions

1. What is the maximum offline data size the app should cache? (Proposed: most recently accessed 2,000 contacts + all deals + all tasks assigned to user)
2. Should location tracking be continuous (GPS breadcrumb trail for field visits) or point-in-time? Point-in-time for MVP — continuous tracking raises privacy concerns.
3. Should there be an explicit "Go Offline" mode the user enables, or is offline always automatic? Always automatic — no user decision needed.
4. Should offline edits be visible to colleagues before sync (e.g., via another field rep's device)? No — offline changes are local until synced.
5. How do we handle a contact that is deleted on the server while the user has it cached offline? Server returns 410 Gone on next sync; client removes from local cache.

## Technical Notes

- Offline storage: SQLite via expo-sqlite for structured contact/deal/task data; MMKV for metadata and cache index
- Offline mutation queue: array of operations stored in MMKV; each operation has: type (create/update/delete), entity, payload, client_timestamp, retry_count
- Sync engine: background task using expo-task-manager + expo-background-fetch; runs every 15 minutes in background even when app is closed (iOS limitations apply — max 30s of background work)
- Connectivity detection: expo-network `NetInfo` API; switch between online/offline mode automatically
- Delta sync endpoint: `GET /sync/delta?since={last_sync_timestamp}` returns all changes the client missed; efficient for reconnection after long offline periods
- Location: `expo-location` with `Accuracy.Balanced` (not GPS-level accuracy — saves battery); one-time read on field visit record creation, not continuous
- Touch target sizes: enforced via ESLint custom rule checking that all Pressable/Touchable components have `minHeight: 44` and `minWidth: 44`
