# System Overview

## Architecture Philosophy

The Mobile CRM Platform is **mobile-first and API-driven**. The iOS/Android app is the primary client — not a wrapper around a web app. All UI state, caching, and offline data management live on-device. The backend serves as the source of truth for persistence, cross-device sync, server-side automation, and push notification dispatch.

The core principle: **the app must work without an internet connection.** A salesperson in a basement or a field rep in a rural area cannot lose access to their CRM. Everything syncs in the background when connectivity returns.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Mobile Clients                         │
│           iOS (React Native + Expo)                      │
│           Android (React Native + Expo)                  │
│                                                          │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  Local DB  │  │  MMKV Cache  │  │  Sync Engine    │  │
│  │  (SQLite)  │  │  (KV Store)  │  │  (background)   │  │
│  └────────────┘  └──────────────┘  └─────────────────┘  │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTPS / REST + WebSocket
                           ▼
┌──────────────────────────────────────────────────────────┐
│               API Gateway (Fastify + TypeScript)          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  JWT Auth  │  Rate Limit  │  Zod Validation  │  CORS│ │
│  └─────────────────────────────────────────────────────┘ │
│                  ↓ Route Dispatch                         │
│  /contacts  /deals  /tasks  /messages  /calendar  /analytics │
└────────────┬──────────────────────────┬──────────────────┘
             │                          │
┌────────────▼──────┐       ┌───────────▼──────────────────┐
│  Business Logic   │       │  Real-Time & Push             │
│  Service Layer    │       │  WebSocket (@fastify/websocket, planned)        │
│  (contacts,       │       │  FCM → Android                │
│   deals, tasks,   │       │  APNS → iOS                   │
│   pipeline, etc.) │       │  Expo Push (dev)              │
└────────────┬──────┘       └──────────────────────────────┘
             │
┌────────────▼──────────────────────────────────────────────┐
│                    PostgreSQL (Primary DB)                  │
│  organizations │ users │ contacts │ deals │ tasks          │
│  messages │ calendar_events │ activity_log │ pipelines      │
│  (multi-tenancy enforced at application layer via organization_id in every Prisma query) │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│                       Redis                                 │
│   Session cache  │  Push queues  │  Rate limit counters    │
│   Background job queue (Bull)                               │
└────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│                  Third-Party Integrations                   │
│  SMS.ru (SMS)  │  Yandex CalDAV  │  Apple Calendar      │
│  Yandex Object Storage (file storage)  │  Yandex Vision (OCR)            │
└────────────────────────────────────────────────────────────┘
```

## Key Architectural Decisions

### 1. Offline-First Mobile Client
The app stores a local copy of all data the user has accessed using SQLite (via expo-sqlite) for structured data and MMKV for key-value cache. Mutations are queued locally and replayed against the server when online. Conflicts use a last-write-wins strategy with server timestamp as authority.

### 2. Multi-Tenant Data Model
Every database table has an `organization_id` column. Multi-tenancy is enforced at the application layer — every Prisma query includes an `organization_id` filter derived from the verified JWT. The API never issues cross-tenant queries; `organization_id` is never accepted from the request body.

### 3. REST over GraphQL (MVP)
REST is simpler to build, cache, debug, and version. GraphQL can be evaluated for v2 once access patterns are well understood. All endpoints follow `GET/POST/PATCH/DELETE` conventions with consistent response envelopes.

### 4. Stateless API with JWT + Refresh Tokens
The API is fully stateless. Access tokens expire in 7 days. Refresh tokens are long-lived (30 days) and stored in the database for revocation. On mobile, tokens are stored in `expo-secure-store` (Keychain/Keystore), never in AsyncStorage.

### 5. Background Sync Engine
A dedicated sync service on the client reconciles local mutations with the server. It uses exponential backoff on failure. Sync state is visible to the user (connectivity indicator). The server exposes a `GET /sync/delta?since={timestamp}` endpoint returning only changes since the last sync.

## Component Responsibilities

| Component | Technology | Responsibility |
|-----------|-----------|----------------|
| Mobile App | React Native + Expo | UI, local cache, offline ops, push receipt |
| API Gateway | Fastify + TypeScript | Auth, validation, routing, rate limiting |
| Business Services | Node.js services | CRM logic, automation rules, notifications |
| PostgreSQL | PostgreSQL 16 (Supabase, migrating to Yandex Managed PostgreSQL for FZ-242) | Primary data store, audit logs |
| Redis | Redis 7 | Caching, job queues, rate limit counters |
| Push Delivery | FCM + APNS + Expo | Cross-platform push notifications |
| SMS | SMS.ru | Outbound SMS from contact profiles |
| Calendar Sync | Yandex CalDAV | Appointment sync via CalDAV |
| File Storage | Yandex Object Storage | Attachments, business card photos |

## Security Boundaries

- All API endpoints require a valid JWT except `/api/v1/auth/*`
- Organization isolation enforced at application layer via `organization_id` in every Prisma query, derived from the verified JWT
- Phone numbers and emails are encrypted at rest (AES-256-GCM)
- TLS 1.3 required for all communication — no HTTP in production
- API keys for integrations stored server-side only, never shipped to mobile client
- File uploads validated for type and size before storage in Yandex Object Storage; pre-signed URLs for download

## Scalability Path

MVP targets single-server deployment (1 API server, 1 DB, 1 Redis). When load requires it:
- API: horizontally scale behind a load balancer (stateless design supports this from day one)
- DB: read replicas for analytics queries; connection pooling via PgBouncer
- Jobs: Bull queue workers scale independently from API workers
- Real-time: migrate from @fastify/websocket to a managed WS service (Ably, Pusher) at scale
