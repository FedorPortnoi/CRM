# Tech Stack

## Decision Criteria

Every technology was evaluated against:
1. Works well on mobile (including offline)?
2. Shippable by a small team without a DevOps specialist?
3. Production-proven at our scale (up to ~500 orgs)?

---

## Mobile (Primary Client)

| Technology | Purpose |
|-----------|---------|
| **React Native** | Cross-platform iOS + Android from one codebase |
| **Expo + Expo Router** | Managed workflow + file-based navigation (replaces React Navigation) |
| **Expo EAS Build** | Cloud builds — no local Xcode/Android Studio needed |
| **Expo EAS Update** | OTA JS updates without App Store review for hotfixes |
| **React Query** | Server state management, caching, background refetch, offline sync |
| **Zustand** | Local/UI state management — lightweight, no boilerplate |
| **Expo Push Notifications** | Cross-platform push delivery — wraps FCM (Android) + APNS (iOS) in one API |
| **expo-location** | GPS location tagging for field visits |
| **expo-contacts** | Phone address book import for Smart Data Entry |
| **expo-camera + expo-av** | Business card OCR + voice notes for Smart Data Entry |
| **Reanimated 3 + GestureHandler** | 60fps drag-and-drop for Kanban Boards |

### Key Mobile Decisions

**Expo Router (file-based navigation) over React Navigation:** Expo Router's file-system convention removes manual route registration and aligns with the TypeScript-first setup. Deep linking and typed routes come for free.

**React Query over RTK Query / custom offline queue:** React Query handles server state (fetching, caching, background refetch, optimistic updates) and has first-class offline support via `networkMode: 'offlineFirst'`. Eliminates the need for a separate offline mutation queue.

**Zustand over Redux Toolkit:** Redux Toolkit is over-engineered for the amount of local state this app actually needs. Zustand is ~1KB, requires no boilerplate, and handles auth tokens, UI state, and user preferences with simple stores.

---

## Backend (API Server)

| Technology | Purpose |
|-----------|---------|
| **Node.js + TypeScript** | Same language as frontend — shared types and Zod schemas |
| **Fastify** | REST API framework — faster than Express, built-in schema validation hooks, WebSocket-compatible |
| **Zod** | Runtime validation + TypeScript schema inference; schemas shared between mobile client and backend |
| **Prisma ORM** | Type-safe DB queries + migrations; strong Supabase PostgreSQL integration |
| **SMS.ru HTTP API** | Outbound SMS for Call & Messaging in the Russian market |

### Key Backend Decisions

**Fastify over Express:** Fastify is 2–3x faster than Express in benchmarks, has built-in JSON schema validation hooks, and is fully compatible with WebSockets via `@fastify/websocket`. Required for persistent server hosting on Yandex Cloud.

**Prisma over Drizzle ORM:** Prisma's Supabase integration is mature, its migration system (`prisma migrate`) is more ergonomic than Drizzle's, and its generated client provides excellent autocomplete and type safety.

**Shared Zod schemas:** The same Zod schema definitions are imported by both the Fastify API (for request validation) and the React Native app (for response parsing and form validation). One source of truth, zero frontend/backend contract bugs.

---

## Database / Real-Time / Auth

| Technology | Purpose |
|-----------|---------|
| **Supabase (hosted PostgreSQL)** | Primary data store — managed Postgres with built-in connection pooling (pgBouncer), backups, and dashboard |
| **@fastify/websocket** | WebSocket support for real-time features (planned, not yet live) |
| **bcrypt + @fastify/jwt (custom auth)** | JWT issuance, password hashing, and refresh token management; handles session lifecycle |

### Database: Supabase (Current) → Yandex Managed PostgreSQL (Planned)

Supabase is used as the current PostgreSQL host. It provides managed Postgres with built-in connection pooling (pgBouncer), backups, and a web dashboard.

**Authentication** is handled entirely by the backend: bcrypt for password hashing and `@fastify/jwt` for JWT issuance and refresh token management. The Supabase Auth SDK is not used.

**Planned migration:** Supabase PostgreSQL will be migrated to Yandex Managed PostgreSQL for FZ-242 (Russian data residency) compliance.

**Multi-tenancy** is enforced at the application layer — every Prisma query includes an `organization_id` filter derived from the verified JWT. Row-Level Security (RLS) is not used.

**Real-time:** `@fastify/websocket` is planned for live deal board updates and team presence (not yet live).

---

## Notifications / Messaging

| Technology | Purpose |
|-----------|---------|
| **Expo Push Notifications** | Native push to iOS (APNS) and Android (FCM) via a single Expo API — no separate FCM/APNS credentials needed during development |
| **SMS.ru** | Outbound SMS for Call & Messaging; send operations stay server-side behind the Fastify API |

---

## Hosting & Infrastructure

| Component | Technology | Monthly Cost (MVP) |
|-----------|-----------|-------------------|
| **API Server** | Yandex Cloud (Node.js/Fastify) | ~$5/month |
| **Database + Auth + Real-time** | Supabase free tier | $0 |
| **Mobile Builds + OTA** | Expo EAS | Free tier for MVP |
| **CI/CD** | GitHub Actions | Free for private repos |
| **Error tracking** | Sentry | Free tier |

**Estimated infrastructure cost before revenue: ~$5/month.**

### Why Railway for the API (not Vercel or Render)

**Vercel is explicitly ruled out:** Vercel's serverless model cannot hold persistent WebSocket connections. The Fastify API must handle inbound webhooks reliably — serverless cold starts make this impossible. **Vercel = eliminated for the backend.**

**AWS/GCP ruled out:** Overkill for MVP. The operational overhead (VPC, IAM, ECS/EKS, RDS, ElastiCache) requires DevOps expertise we don't have or need at this stage. Revisit when monthly revenue exceeds ~$50K.

**Railway chosen:** Persistent Node.js process on Yandex Cloud (required for WebSocket compatibility and webhook reliability), log tailing built in.

---

## What Was Ruled Out (and Why)

| Rejected | Why |
|---------|-----|
| **Vercel (hosting)** | Serverless — cannot hold WebSocket connections; incompatible with webhook reliability |
| **AWS / GCP (hosting)** | Overkill for MVP; requires DevOps expertise; revisit at scale (~$50K MRR) |
| **Firebase** | Firestore is document-based and poorly suited for relational CRM data (contacts → deals → pipeline stages → tasks). PostgreSQL's relational model is the right fit; multi-tenancy is enforced at the application layer via organization_id in every Prisma query. |
| **Express** | Replaced by Fastify — 2–3x faster, better schema validation hooks, WebSocket-compatible |
| **Drizzle ORM** | Replaced by Prisma — better Supabase integration, more ergonomic migrations |
| **Socket.io** | Replaced by @fastify/websocket — eliminates a separate WebSocket server entirely |
| **Redis (standalone)** | No longer needed — Supabase replaces the session cache, pub/sub, and real-time use cases |
| **Redux Toolkit** | Replaced by Zustand — simpler, less boilerplate for the amount of local state needed |
| **React Navigation** | Replaced by Expo Router — file-based navigation, typed routes, deep linking for free |
| **GraphQL** | Overkill for MVP; REST + @fastify/websocket covers all use cases |
| **NestJS** | Decorator/DI complexity unnecessary at MVP scale |
| **Self-managed PostgreSQL** | Replaced by Supabase — eliminates ops burden of managing DB, backups, connections |

---

## Related Files

- `docs/architecture/system-overview.md` — how these technologies fit together as a system
- `docs/architecture/api-design.md` — Fastify + Zod + Supabase Auth design
- `docs/architecture/data-models.md` — PostgreSQL schema; multi-tenancy via organization_id
