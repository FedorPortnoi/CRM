---
tags: [architecture, system, overview, technical]
status: draft
related: ["Tech Stack", "Data Models", "API Design", "Mobile Field Access", "Auto Information Capture"]
created: 2026-05-01
updated: 2026-05-01
---

# System Overview

## Architecture Philosophy

Mobile-first, API-driven, offline-capable. The mobile app (iOS + Android via React Native + Expo) is the primary client — not a wrapper around a web app. See [[Tech Stack]] for technology decisions.

## Key Constraints

1. **Offline-first:** The app must work fully with no internet. See [[Mobile Field Access]].
2. **Multi-tenant:** Every DB row is scoped to `organization_id` via Supabase PostgreSQL Row-Level Security.
3. **Managed auth:** Supabase Auth issues and validates JWTs; tokens stored in device Keychain via expo-secure-store.
4. **REST + Real-time:** Fastify REST API for mutations + queries; Supabase Realtime WebSocket for live updates.

## Component Map

```
Mobile App (React Native + Expo Router)
    │
    ├── HTTPS (REST)
    │       ↓
    │   Fastify API (Railway)
    │   Zod validation + Prisma ORM
    │       ↓
    │   Supabase PostgreSQL
    │   (RLS enforces org isolation)
    │
    ├── WebSocket (Realtime)
    │       ↓
    │   Supabase Realtime
    │   (live deal updates, team presence,
    │    inbound message delivery)
    │
    ├── Supabase Auth
    │   (JWT, OAuth, magic links, session management)
    │
    └── Expo Push Notifications
        (APNS on iOS, FCM on Android — via Expo)

    Twilio → Fastify webhook endpoint → Supabase DB → Supabase Realtime → Mobile
```

Full architecture diagram in `docs/architecture/system-overview.md`.

## Multi-Tenancy Model

- All tables have `organization_id UUID NOT NULL`
- Supabase RLS policies enforce isolation using `auth.uid()` from Supabase Auth JWT
- `organization_id` resolved server-side from the authenticated user record — never trusted from client
- Supabase's built-in connection pooler (pgBouncer) manages PostgreSQL connections

## Offline Sync Strategy

- React Query's `networkMode: 'offlineFirst'` handles client-side cache and background refetch
- Mutations queued locally by React Query when offline; replayed automatically on reconnect
- Supabase Realtime subscriptions re-establish automatically on reconnect
- Conflict resolution: server timestamp wins; React Query invalidates stale cache on reconnect

## Real-Time Data Flow

Supabase Realtime replaces the previous Socket.io setup:

- **Live deal board:** When a teammate moves a deal to a new stage, all connected clients see the Kanban card move in real time via Supabase Realtime channel subscription on the `deals` table
- **Team presence:** Who is currently active in the app — useful for collaborative editing awareness
- **Inbound messages:** Twilio webhook → Fastify → Supabase DB insert → Supabase Realtime fires → mobile client receives and displays without polling

## Security Boundaries

- Supabase Auth validates JWTs on every request; RLS enforces org isolation at the DB layer
- Phone/email fields encrypted at application layer before write (AES-256-GCM)
- TLS 1.3 only in production
- Twilio webhooks validated via HMAC signature on the Fastify endpoint before processing
- Supabase service role key kept server-side only (Fastify); mobile client uses anon key + RLS

## Related Notes

- [[Data Models]] — all database entities; RLS policy patterns
- [[API Design]] — Fastify + Zod + Supabase Auth design
- [[Tech Stack]] — full technology choices and rationale
- [[Mobile Field Access]] — React Query offline mode + Expo for field capability
- [[Auto Information Capture]] — automatic logging architecture
