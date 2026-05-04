# CRM Platform — Developer Notes for Claude Code

## Project Structure

```
crm/
├── backend/             # Fastify v5 API server (Node.js + TypeScript)
│   ├── index.ts         # Entry point — run with: npm run backend:dev
│   ├── api/
│   │   ├── routes/      # Fastify route plugins (one file per resource)
│   │   └── controllers/ # Business logic handlers (one file per resource)
│   ├── prisma/
│   │   └── schema.prisma
│   └── services/
│       └── db.ts        # Prisma singleton — import { db } from here
├── src/                 # React Native / Expo app
│   └── types/
│       └── fastify.d.ts # JWT payload type augmentation
├── (brain moved)        # Obsidian knowledge base → C:\Users\fedor\Obsidian\Brain\Projects\CRM\
├── docs/                # Feature specs, architecture docs
└── package.json
```

## Critical Rules — Read Before Touching Anything

### npm install MUST use --legacy-peer-deps

```bash
npm install --legacy-peer-deps
npm install <package> --legacy-peer-deps
```

**Why:** `@testing-library/react-native@12.x` has an unresolved peer dep conflict with `react@18`. Without this flag, npm refuses to install. Do NOT use `--force` — it modifies the lockfile aggressively.

### backend/index.ts uses async start() — never top-level await

The root `package.json` has no `"type": "module"` because Expo Metro requires CJS. Top-level `await` fails in CJS mode. All server startup code must be inside `async function start() { ... }; start();`.

### Fastify v5 stack — locked versions

```json
"fastify": "^5.0.0"
"@fastify/cors": "^11.0.0"
"@fastify/jwt": "^9.0.0"
"@fastify/multipart": "^10.0.0"
"@fastify/rate-limit": "^10.0.0"
"fastify-type-provider-zod": "^4.0.2"
```

Do NOT downgrade any of these. v9/v11 cors, v9 jwt etc. are for Fastify v5. The v4 equivalents are incompatible.

## Backend Development

### Start the server

```bash
npm run backend:dev    # tsx watch (hot reload)
```

Requires `.env` with at minimum:
- `DATABASE_URL` — Supabase PostgreSQL connection string
- `JWT_SECRET` — strong random secret for signing JWTs (NOT the Supabase JWT secret)

### Prisma

```bash
npm run db:generate    # Generate Prisma client (run after schema changes)
npm run db:migrate     # Run migrations against Supabase DB
npm run db:studio      # Open Prisma Studio GUI
```

Always run `db:generate` after any change to `backend/prisma/schema.prisma`.

### Prisma singleton

All controllers must import `db` from `backend/services/db.ts`:

```typescript
import { db } from '../../services/db';
```

**Never** instantiate `new PrismaClient()` anywhere else.

### Org scoping in Prisma queries

Prisma connects as the database superuser (bypasses RLS). Every query that touches org-specific data MUST include a `where: { organization_id: request.user.org_id }` clause. Do not rely on Supabase RLS to enforce tenant isolation for Prisma queries.

## Auth Design (Sprint 1 decision)

Auth lives on the Fastify API — not the Supabase Auth service. Pattern:

- **Register:** validate → create org → hash password (bcryptjs, 12 rounds) → create user → sign JWT
- **Login:** look up user by email → compare bcrypt hash → sign JWT
- **JWT payload:** `{ sub: user.id, org_id: org.id, role: UserRole, iat, exp }`
- **Verification:** `request.jwtVerify()` on every protected route preHandler

See `src/types/fastify.d.ts` for the JWT payload type definition.

## Response Envelope

All API responses use this shape:

```typescript
// Success (single)
{ data: { ... }, meta: {} }

// Success (list)
{ data: [...], meta: { total: number, page: number, per_page: number } }

// Error
{ error: { code: string, message: string } }
```

## Key Architectural Decisions

See `C:\Users\fedor\Obsidian\Brain\Projects\CRM\05 - Decisions\Decisions.md` for full reasoning. Short version:

| Decision | Choice |
|----------|--------|
| Auth | bcrypt + @fastify/jwt (Sprint 1); Supabase Auth SDK later |
| ORM | Prisma (not Drizzle) |
| UUID | v4 via gen_random_uuid() |
| Multi-tenancy | organization_id on every table; app-level scoping in Prisma queries |
| Soft delete | status = 'archived' (no deleted_at column) |
| Offline conflicts | Last Write Wins on updated_at |
| Company | Text field on Contact (no Company entity for MVP) |

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
DATABASE_URL=postgresql://postgres:[password]@[host]:5432/postgres
JWT_SECRET=[strong random secret — 32+ chars]
```

Optional for Sprint 1 (needed for later sprints):
```bash
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
```

## Brain / Knowledge Base

Obsidian vault is at `C:\Users\fedor\Obsidian\Brain\Projects\CRM\`. Key notes:

- `00 - Home.md` — project status dashboard
- `04 - Architecture/` — system overview, data models, API design, tech stack
- `05 - Decisions/Decisions.md` — all architectural decisions with reasoning
- `05 - Decisions/Sprints.md` — live task log for every session
- `05 - Decisions/Questions.md` — unresolved questions
