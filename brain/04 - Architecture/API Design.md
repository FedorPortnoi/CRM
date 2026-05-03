---
tags: [architecture, api, rest, backend]
status: active
related: ["System Overview", "Data Models", "Tech Stack", "Mobile Field Access"]
created: 2026-05-01
updated: 2026-05-02
---

# API Design

## Conventions

- Base URL: `https://api.yourcrm.com/api/v1`
- All endpoints require `Authorization: Bearer <supabase_jwt>` (validated by Fastify plugin)
- Consistent response envelope: `{ data, meta, error }`
- HTTP status codes used semantically (200/201/204/400/401/403/404/422/429/500)
- URI versioning: `/api/v1`, `/api/v2` — breaking changes require new version
- All timestamps in ISO 8601 UTC
- **Framework:** Fastify (replaced Express — see [[Tech Stack]])

## Response Format

```json
// Success (single)
{ "data": { ... }, "meta": {} }

// Success (list)
{ "data": [...], "meta": { "total": 150, "page": 1, "per_page": 50 } }

// Error
{ "error": { "code": "CONTACT_NOT_FOUND", "message": "...", "details": {} } }
```

## Authentication Flow (Sprint 1 — bcrypt + @fastify/jwt)

> **Updated 2026-05-02:** Auth endpoints live on the Fastify API, not the Supabase Auth service. See [[Decision Log]] for full rationale. Supabase Auth (OAuth, magic links) can be added in a later sprint.

Auth is implemented directly on the Fastify API using **bcryptjs** (password hashing) and **@fastify/jwt** (token signing and verification).

### Register — `POST /api/v1/auth/`

1. Validate body: `{ email, password (min 8), name, org_name }`
2. Generate org slug from `org_name` (lowercase + alphanumeric + 5-char random suffix)
3. `db.$transaction`:
   - Create `Org` with slug, plan=starter, owner_id=null (nullable intentionally)
   - `bcrypt.hash(password, 12)` — 12 rounds
   - Create `User` with email, password_hash, name, organization_id, role=owner
   - Update `Org.owner_id = user.id`
4. `reply.jwtSign({ sub: user.id, org_id: org.id, role: user.role }, { expiresIn: '7d' })`
5. Return `201 { data: { user: { id, email, name, role, org_id }, token } }`
6. On Prisma P2002 (email conflict): `409 EMAIL_ALREADY_EXISTS`

### Login — `POST /api/v1/auth/login`

1. Validate body: `{ email, password }`
2. `db.user.findUnique({ where: { email } })`
3. If no user OR `bcrypt.compare` fails: `401 INVALID_CREDENTIALS` (same error for both — never reveal email existence)
4. `reply.jwtSign({ sub: user.id, org_id: user.organization_id, role: user.role }, { expiresIn: '7d' })`
5. Return `200 { data: { user: { id, email, name, role, org_id }, token } }`

### JWT Payload

```ts
// Defined in src/types/fastify.d.ts — augments @fastify/jwt
{
  sub: string;      // user.id (UUID)
  org_id: string;   // user.organization_id (UUID)
  role: 'owner' | 'admin' | 'member' | 'viewer';
  iat: number;
  exp: number;
}
```

### Protected Routes

All non-auth routes use a `preHandler`:
```ts
const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
  await request.jwtVerify();  // throws 401 if token missing/invalid/expired
};
```

After verification, `request.user` contains the full JWT payload — `request.user.org_id` and `request.user.sub` are used in every controller for org scoping.

### Mobile Client Token Storage

Tokens are stored in `expo-secure-store` (Keychain on iOS, Keystore on Android). React Query handles token attachment (Authorization header) and refresh logic on the client side.

## Zod Validation

Every route handler has a Zod schema for the request body and query params. The same schema files are imported by both the Fastify API and the React Native app (shared TypeScript monorepo):

```ts
// shared/schemas/contact.ts — used by BOTH mobile and backend
export const CreateContactSchema = z.object({
  first_name: z.string().min(1).max(100),
  phone: z.string().optional(),
  // ...
});
```

Fastify uses these schemas in route definitions; React Native uses them for form validation and response parsing. One source of truth, zero contract bugs.

## Key Endpoint Groups

| Group | Prefix | Status | Note |
|-------|--------|--------|------|
| Auth | `/api/v1/auth` | ✅ Sprint 1 | register, login |
| Contacts | `/api/v1/contacts` | ✅ Sprint 1 (CRUD) | list, getById, create, update, archive; bulk ops Sprint 2 |
| Deals | `/api/v1/deals` | 🔄 Sprint 1 partial | list + create done; pipeline mgmt Sprint 2 |
| Tasks | `/api/v1/tasks` | 🔲 Sprint 2 | All stubs |
| Messages | `/api/v1/messages` | 🔲 Sprint 2 | All stubs |
| Calendar | `/api/v1/calendar` | 🔲 Sprint 3 | All stubs |
| Analytics | `/api/v1/analytics` | 🔲 Sprint 4 | All stubs |
| Webhooks | `/api/v1/webhooks/twilio` | 🔲 Sprint 2 | Twilio SMS + status callbacks |

## Sprint 1 — Implemented Endpoints

All endpoints below are live and tested against Supabase (as of 2026-05-02):

### Auth

| Method | Path | Handler | Auth Required |
|--------|------|---------|---------------|
| POST | `/api/v1/auth/` | register | No |
| POST | `/api/v1/auth/login` | login | No |

### Contacts

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/api/v1/contacts` | list | Paginated, filterable (q, status, type, assigned_to, tag, source) |
| POST | `/api/v1/contacts` | create | org_id + created_by from JWT |
| GET | `/api/v1/contacts/:id` | getById | Includes assignee name; 404 if not found/not owned |
| PATCH | `/api/v1/contacts/:id` | update | Partial; status not updatable here |
| DELETE | `/api/v1/contacts/:id` | archive | Soft delete (status → archived); returns 200 |

### Deals

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/api/v1/deals` | list | Paginated, filterable; includes contact name |
| POST | `/api/v1/deals` | create | expected_close: string→Date; includes contact name in response |

## Offline Sync Design

React Query handles offline sync — no custom delta sync endpoint is needed for the core use case:

- React Query `networkMode: 'offlineFirst'` serves cached data when offline
- Mutations queued by React Query when offline; replayed automatically on reconnect
- Supabase Realtime re-subscribes on reconnect and pushes down any missed changes
- For conflicts: Prisma writes use `updatedAt` timestamps; last-write-wins with server time

See [[Mobile Field Access]] for the full offline behavior design.

## Real-Time Subscriptions (Supabase Realtime)

The mobile client subscribes directly to Supabase Realtime channels — this does NOT go through the Fastify API:

```ts
supabase
  .channel('deals')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, handler)
  .subscribe()
```

Handles: live Kanban board updates, inbound message delivery, team presence. See [[System Overview]] for the full real-time data flow.

## Rate Limits

- Default: 100 req/min per user (Fastify rate limit plugin — in-memory for MVP; Redis-backed if needed)
- Bulk import: 10 req/min per org
- SMS send: 60/hour per org (Twilio also enforces upstream)
- Analytics: 30 req/min (queries are expensive)

## Security

- JWT validated by Supabase Auth JWKS; `user_id` and `organization_id` extracted from verified claims
- RLS on all Supabase tables enforces org isolation at the DB layer — even a compromised Fastify API cannot read another org's data if using the anon/user key
- Fastify uses the **service role key** for admin operations (bypasses RLS only when necessary)
- Twilio webhooks validated via HMAC signature (`X-Twilio-Signature` header) before processing
- Phone/email fields encrypted at application layer before write

## Related Notes

- [[System Overview]] — where the API fits in the architecture; Supabase Realtime data flow
- [[Data Models]] — what the API exposes; RLS policies
- [[Tech Stack]] — Fastify, Zod, Prisma, Supabase Auth decisions
- [[Mobile Field Access]] — React Query offline sync behavior
