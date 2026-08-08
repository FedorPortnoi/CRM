# 4КУБ (4KUB) — Project Knowledge Base

> **This is the canonical, single-source-of-truth knowledge file for the 4КУБ CRM.** It supersedes
> the scattered `SESSION_LOG_*.md` files as the go-to reference for what the app is, how it's built,
> and its current state. Keep it updated as the app evolves.
>
> **2026-08-07: the session logs no longer live in this repo.** They were moved to the Obsidian
> vault — `Obsidian/Brain/Projects/CRM/SESSION_LOG_*.md` — which is now the single home for
> narrative history. This file stays here as the in-repo reference; the vault holds the logs.
>
> **Last updated:** 2026-07-25

---

## Current State (release status)

| | |
|---|---|
| **Current version** | **1.0.5** — iOS build **22**, Android versionCode **8** |
| **iOS (App Store)** | ✅ **Submitted for review** 2026-07-19 (build 22). Awaiting Apple (~48h). App Store Connect app id `6776447873`. |
| **Android (RuStore)** | 📦 APK built and downloaded to `C:\Users\fedor\Downloads\4kub-1.0.5-rustore-vc8.apk` (versionCode 8) — **pending manual upload to RuStore** by the owner. |
| **Previous release** | 1.0.4 (iOS build 20 / Android versionCode 7) |
| **Source branch** | `fix/dm-security-ru-i18n-ui` — pushed to `origin` 2026-07-25; **not yet merged to `main`**. |
| **Production API** | `https://4kub.ru/api/v1` (WebSocket `wss://4kub.ru`) |
| **Database** | Yandex Cloud Managed PostgreSQL (`ru-central1`) — verified 2026-07-25 |
| **Bundle id** | `com.fedorportnoi.crm` (iOS + Android) |

**What 1.0.5 is:** a security-hardening + Russian-localization release. It closes **24 security findings**
from a two-round audit (see *Security Posture*), localizes the default sales pipeline to Russian, and
polishes several UI flows. It is a complete, fully-functional build — verified end-to-end — and is
strictly more secure than the live 1.0.4. No features were removed or left unfinished.

---

## Product Overview

**4КУБ (4KUB) is a mobile-first CRM for small sales teams — contacts, deals, tasks, and meetings in one app.** It is a React Native / Expo application (iOS + Android) backed by a Fastify API, built primarily for Russian-speaking sales organizations. Each account belongs to an organization with role-based access (owner, admin, member, viewer), and the whole experience is tuned for a salesperson working from a phone: capturing leads in the field, moving deals through a pipeline, staying on top of follow-up tasks, and coordinating with teammates. Its own tagline sums it up: "Контакты, сделки, задачи и встречи — всё в одном приложении."

### Target users
Sales reps, sales managers, and owners of small-to-medium businesses who run their pipeline day-to-day from a mobile device. Owners/admins additionally get team management and a monthly revenue target ("План на месяц"); field-oriented workflows (business-card scanning, phone-book import, location permission for visit tracking) point at outside/field sales.

### Navigation
The app uses a bottom tab bar with four primary destinations:
- **Сегодня** (Today) — the dashboard/home screen
- **Контакты** (Contacts)
- **Воронка** (Pipeline) — the kanban board
- **Ещё** (More) — opens a bottom sheet

The **Ещё** sheet groups the secondary sections:
- **Задачи** (Tasks)
- **Чат** (Chat)
- **Уведомления** (Notifications)
- **Календарь** (Calendar)
- **Настройки** (Settings)

Unread chat and notification counts surface as a badge on the "Ещё" tab.

### Core features
- **Contacts / clients** — typed as lead, customer, or partner; a company text field; per-contact deals and tasks, plus an activity log and conversation history (in-app notes, logged calls).
- **Deals with a kanban pipeline** — configurable pipelines and stages, board and list views, moving deals between stages, won/lost outcomes with a loss reason, a "next action" field, and stale-deal detection (RUB values).
- **Tasks** — statuses (pending, in progress, done, cancelled), due dates, reminders, recurrence (daily/weekly/monthly/etc.), and assignee.
- **Calendar** — scheduled events, contact-linked, with a "today's schedule" view.
- **Team chat + DMs** — a shared general channel plus private direct messages between members, with unread badges.
- **Dashboard / analytics** — metric cards (open deals, tasks due today, overdue tasks), monthly revenue plan vs. actual, pipeline health, "closing this week," stale/inactive contacts, and deals with no next task.
- **Offline mode** — queued mutations and background sync so work continues without connectivity.
- **Contact imports** — from Telegram, WhatsApp (chat export), Bitrix24 (webhook), vCard (.vcf), the device phone book, and Excel/CSV.
- **Attachments** — files and photos on records, from the gallery, camera, or documents.
- **Business-card scan & captures** — camera OCR to create a contact from a business card, plus a "captures" inbox of unidentified call/email activity to match or dismiss against contacts.
- **Workflows / automation** — trigger-based rules (contact created, deal stage changed, deal won, deal stale, task completed, etc.) with conditions and actions (create task, add note, move stage).
- **Dark / light theme** — persistent user-toggled appearance.
- **RU / EN localization** — full Russian and English interface.

Additional niceties include push notifications and PDF export of contacts and deals.

## Architecture & Tech Stack

### Backend

A **Fastify v5** (`fastify ^5.0.0`) API server written in **TypeScript** and run as **CommonJS** — the root `package.json` deliberately omits `"type": "module"` because Expo's Metro bundler requires CJS, so all server startup lives inside an `async function start()` (no top-level `await`). Data access is through **Prisma 5** (`@prisma/client ^5.13.0`, `prisma ^5.13.0`) against **Yandex Cloud Managed PostgreSQL** (`*.mdb.yandexcloud.net`, `ru-central1`). Request/response validation uses **Zod** (`zod ^3.22.4`) wired into Fastify via `fastify-type-provider-zod ^4.0.2` (registered as the global validator/serializer compiler).

Registered `@fastify` plugins, at their actual `package.json` versions:

| Plugin | Version | Role |
|--------|---------|------|
| `@fastify/helmet` | `^13.0.2` | Security headers + CSP (`default-src 'self'`, `frame-ancestors 'none'`, etc.) |
| `@fastify/cors` | `^11.0.0` | CORS, origin from security config |
| `@fastify/jwt` | `^10.1.0` | JWT signing/verification |
| `@fastify/rate-limit` | `^10.0.0` | IP-based rate limiting |
| `@fastify/multipart` | `^10.0.0` | File uploads |
| `@fastify/websocket` | `^11.2.0` | Real-time WS routes (`ws` pinned to `8.21.1` via overrides) |
| `@fastify/formbody` | `^8.0.2` | URL-encoded body parsing |

All routes are mounted under the `/api/v1/*` prefix.

### Frontend

A **React Native `0.81.5`** app (**React `19.1.0`**) on the **Expo SDK 54** (`expo ~54.0.0`) managed workflow, using **expo-router `~6.0.0`** for file-based navigation. Client state is held in **Zustand `^4.5.2`**; server state and caching use **@tanstack/react-query `^5.100.9`** with offline **persistence** (`@tanstack/react-query-persist-client ^5.100.9` + `@tanstack/query-async-storage-persister ^5.100.9`, backed by AsyncStorage `2.2.0`). Localization is **i18next `^25.10.10`** / `react-i18next ^15.7.4`. Auth tokens are stored in the device keychain via **expo-secure-store `~15.0.0`**.

### Authentication

Auth is owned by the Fastify API — there is no third-party auth service. Passwords are hashed with **bcryptjs `^2.4.3`** (12 rounds); sessions are stateless **JWTs** signed by **@fastify/jwt `^10.1.0`** with payload `{ sub, org_id, role, sid }`.

A single **global `preHandler` (`enforceAuthenticatedApiRequest`)** guards every `/api/v1/*` route except an explicit public allowlist (register, login, join, email verify, the WS upgrade, and the Yandex calendar callback/webhook). On each request it:

1. Runs `request.jwtVerify()` and rejects tokens missing `sub`, `org_id`, or `sid`.
2. **Re-reads the live user from the database** (`is_active`, `organization_id`, and current `role`) — the role in the request is the DB value, not the token claim, so a demotion or deactivation takes effect immediately rather than at token expiry.
3. Validates the session id (`sid`) against the sessions store so revoked/expired sessions are rejected (audited as `auth.session_rejected`).
4. Enforces route-level authorization: admin-only paths (audits, exports, bulk contact ops, imports, pipeline/stage/workflow admin, org settings) require `owner`/`admin`; `viewer` role is restricted to read-only (GET/HEAD/OPTIONS) methods.

### Multi-tenancy

Every tenant-scoped table carries an `organization_id`. Prisma connects as the database superuser and **bypasses Postgres RLS**, so tenant isolation is enforced at the application layer: every org-scoped query must include `where: { organization_id: request.user.org_id }`. RLS is not relied upon for Prisma access.

### Manager visibility cone

Beyond org scoping, `backend/services/visibility.ts` restricts row visibility along the org chart:

- **`getVisibleUserIds(requester, scope)`** returns `null` for `owner`/`admin` (unrestricted, org scope only). For `member`/`viewer` it returns the requester plus their reports, bounded to their own branch — `scope: 'direct'` yields self + direct reports (one level), `scope: 'subtree'` walks a recursive CTE for self + all descendants. It never allows sideways or upward visibility.
- **`getAccessibleUserIds(requester)`** is the full access cone (self + entire subtree) regardless of the list-view toggle, used for single-record access checks and validating assignment targets.
- **`canSeeUser(visibleIds, userId)`** tests membership, treating `null` as unrestricted.

`ownerVisibilityWhere` translates a visible-id set into a Prisma `OR` over `assigned_to`/`created_by` so members still see records they created but that are unassigned.

### API response envelope

- Success (single): `{ data: { ... }, meta: {} }`
- Success (list): `{ data: [...], meta: { total, page, per_page } }`
- Error: `{ error: { code, message } }` — 5xx messages are collapsed to `"Internal server error"`; invalid UUIDs surface as `INVALID_ID`.

### Soft delete

Records are archived, not deleted: `status = 'archived'` (no `deleted_at` column).

### Field-level encryption at rest

Contact PII — **`email`, `phone`, and `mobile`** — is encrypted at rest with **AES-256-GCM** (`backend/services/encryption.ts`). Values are stored as `enc:v1:<iv>.<authTag>.<ciphertext>` (base64url, random 12-byte IV per value, key derived via SHA-256 of the token encryption secret). `encryptField` is applied on create/update in `contact-domain.ts` and `decryptField` on read; decryption failures fall back to the raw stored value rather than throwing, so a malformed prefix or rotated key cannot 500 the read path.

## Backend API (Fastify, prefix /api/v1)

All paths below are relative to the `/api/v1` prefix. `(admin)` marks routes gated to owner/admin by `adminRoutePolicy`; `(public)` marks routes exempt from the global JWT preHandler.

### auth — `/api/v1/auth`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth` | Register: create org + owner user, sign JWT (rate limit 5/15min) — (public) |
| POST | `/auth/login` | Login by email/password (rate limit 5/15min, keyed by ip+email) — (public) |
| POST | `/auth/join` | Join an existing org via company code (rate limit 5/15min) — (public) |
| POST | `/auth/verify` | Verify the email OTP (rate limit 10/15min) — (public) |
| POST | `/auth/verify/resend` | Resend OTP (rate limit 3/5min) — (public) |
| POST | `/auth/logout` | Revoke the current session |
| POST | `/auth/logout-all` | Revoke all of the user's sessions |
| GET | `/auth/sessions` | List the user's active sessions |
| GET | `/auth/audit` | List org audit events, filterable/paginated — (admin) |
| GET | `/auth/users` | List users in the org |
| POST | `/auth/users/invite` | Create/invite a user (first/last name + role) |
| PATCH | `/auth/users/:id/deactivate` | Deactivate a user |
| PATCH | `/auth/users/:id/role` | Change a user's role |
| PATCH | `/auth/users/:id/manager` | Set/clear a user's manager (role hierarchy) |
| GET | `/auth/company-code` | Get the org's join code |
| POST | `/auth/company-code/rotate` | Rotate the join code |
| PATCH | `/auth/me/password` | Change own password (current + new) |
| PATCH | `/auth/me/credentials` | Set own email + password (invited-user activation) |

### contacts — `/api/v1/contacts`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/contacts` | List/filter/search contacts (paginated, subtree scope) |
| POST | `/contacts` | Create a contact |
| GET | `/contacts/:id` | Get one contact |
| PATCH | `/contacts/:id` | Update a contact |
| DELETE | `/contacts/:id` | Archive a contact (soft delete) |
| GET | `/contacts/:id/activity` | Contact activity timeline |
| GET | `/contacts/:id/deals` | Deals for a contact |
| GET | `/contacts/:id/tasks` | Tasks for a contact |
| POST | `/contacts/import-csv` | Bulk CSV import (1–500 rows) — (admin) |
| POST | `/contacts/business-card/scan` | OCR/parse a business card, optionally create contact |
| POST | `/contacts/bulk-assign` | Reassign many contacts to a user — (admin) |
| POST | `/contacts/bulk-archive` | Archive many contacts — (admin) |

### deals — `/api/v1/deals`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/deals` | List/filter/search deals (paginated, subtree scope) |
| POST | `/deals` | Create a deal |
| POST | `/deals/stale/evaluate` | Scan for stale deals past a day threshold |
| GET | `/deals/:id` | Get one deal |
| PATCH | `/deals/:id` | Update a deal |
| PATCH | `/deals/:id/stage` | Move a deal to another stage |
| POST | `/deals/:id/won` | Mark a deal won |
| POST | `/deals/:id/lost` | Mark a deal lost (reason + close date) |
| GET | `/deals/pipelines` | List pipelines with their stages |

### tasks — `/api/v1/tasks`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/tasks` | List/filter/search tasks (paginated, subtree scope) |
| POST | `/tasks` | Create a task (supports RRULE recurrence) |
| GET | `/tasks/assignees` | List assignable users |
| GET | `/tasks/today` | Tasks due today |
| POST | `/tasks/suggest-contact` | Suggest a contact from a task title |
| GET | `/tasks/:id` | Get one task |
| PATCH | `/tasks/:id` | Update a task |
| POST | `/tasks/:id/complete` | Complete a task (spawns next recurrence) |
| DELETE | `/tasks/:id` | Cancel a task |

### messages — `/api/v1/messages`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/messages/conversation/:contact_id` | Conversation thread with a contact |
| POST | `/messages/in-app` | Send an in-app message |
| POST | `/messages/call` | Log a phone call (direction/duration/notes) |
| POST | `/messages/:id/read` | Mark a message read |

### calendar — `/api/v1/calendar`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/calendar` | List events (date range, contact/deal/attendee filters) |
| POST | `/calendar` | Create an event (validates start < end) |
| GET | `/calendar/availability` | Free-slot lookup across users for a date |
| GET | `/calendar/:id` | Get one event |
| PATCH | `/calendar/:id` | Update an event |
| DELETE | `/calendar/:id` | Cancel an event |
| POST | `/calendar/:id/notes` | Add post-meeting notes |
| POST | `/calendar/:id/complete` | Mark an event completed |
| GET | `/calendar/sync/yandex/auth` | Start Yandex Calendar OAuth |
| GET | `/calendar/sync/yandex/callback` | Yandex OAuth redirect handler — (public) |
| DELETE | `/calendar/sync/yandex` | Disconnect Yandex sync |
| GET | `/calendar/sync/status` | Yandex sync status |
| POST | `/calendar/webhooks/yandex` | Yandex CalDAV poll webhook (rate limit 20/min) — (public) |

### analytics — `/api/v1/analytics`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/analytics/dashboard` | Dashboard metrics/KPIs |

### notifications — `/api/v1/notifications`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/notifications/register` | Register a device push token |
| GET | `/notifications` | List notifications (paginated) |
| PATCH | `/notifications/:id/read` | Mark one notification read |
| PATCH | `/notifications/read-all` | Mark all notifications read |
| GET | `/notifications/unread-count` | Unread notification count |

### workflows — `/api/v1/workflows`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/workflows` | List automation workflows |
| POST | `/workflows` | Create a workflow (trigger + conditions + actions) — (admin) |
| GET | `/workflows/:id` | Get one workflow |
| PATCH | `/workflows/:id` | Update a workflow — (admin) |
| DELETE | `/workflows/:id` | Archive a workflow — (admin) |

### sync — `/api/v1/sync`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/sync/delta` | Records changed since a timestamp (offline delta sync) |

### captures — `/api/v1/captures`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/captures` | Create a capture (call/email event with raw data) |
| GET | `/captures` | List captures (by status) |
| POST | `/captures/:id/match` | Match a capture to a contact |
| POST | `/captures/:id/dismiss` | Dismiss a capture |

### onboarding — `/api/v1/onboarding`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/onboarding` | Get onboarding state (completed steps, dismissed tooltips) |
| PATCH | `/onboarding` | Update onboarding state |

### org — `/api/v1/org`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/org` | Get org settings |
| PATCH | `/org/settings` | Update org settings (e.g. monthly revenue target) — (admin) |

### activities — `/api/v1`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/activities` | List the org/user activity feed |

### attachments — `/api/v1`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/attachments/upload-url` | Get a pre-signed upload URL |
| GET | `/attachments` | List attachments |
| POST | `/attachments` | Create an attachment record |
| DELETE | `/attachments/:id` | Delete an attachment |

### chat — `/api/v1/chat` (team chat)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/chat/channels` | List chat channels |
| GET | `/chat/messages` | List messages in a channel (before/limit paging) |
| POST | `/chat/messages` | Send a message to a channel |
| POST | `/chat/read` | Mark a channel read |

### imports — `/api/v1/import` (admin, per-route rate limits)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/import/telegram/send-code` | Send Telegram login code (rate limit 3/10min) — (admin) |
| POST | `/import/telegram/verify` | Verify Telegram code + import contacts (rate limit 5/10min) — (admin) |
| POST | `/import/bitrix24` | Import from a Bitrix24 webhook URL (rate limit 5/hour) — (admin) |
| POST | `/import/vcard` | Import vCard contacts (rate limit 10/hour) — (admin) |
| POST | `/import/whatsapp` | Import WhatsApp contacts (rate limit 10/hour) — (admin) |

### export — `/api/v1/export` (admin, rate limit 5/hour each)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/export/contacts/pdf` | Export contacts as PDF — (admin) |
| GET | `/export/deals/pdf` | Export deals as PDF — (admin) |

### ws — `/api/v1`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/ws` | WebSocket connection; token via `Authorization: Bearer` or `?token`, then session-validated in-handler — (public to the JWT preHandler) |

### Auth model
- **Global JWT preHandler.** A single `preHandler` hook (`enforceAuthenticatedApiRequest`) runs on every `/api/v1/*` request. It calls `request.jwtVerify()`, confirms the token carries `sub`/`org_id`/`sid`, re-checks the user is still active in the org (DB lookup), and validates the session is not revoked/expired. Individual route files also attach a per-route `authenticate` preHandler, but it short-circuits once the global hook has populated `request.user`.
- **Public allowlist.** Only these are exempt from JWT verification: `POST /auth`, `POST /auth/login`, `POST /auth/join`, `POST /auth/verify`, `POST /auth/verify/resend`; `GET /ws`; `GET /calendar/sync/yandex/callback` (OAuth redirect); and `POST /calendar/webhooks/yandex` (CalDAV poll webhook). Everything else requires a valid token.
- **adminRoutePolicy (owner/admin only).** After authentication, `adminRoutePolicy` gates sensitive paths to `owner`/`admin` roles (403 + audit-log `denied` otherwise): audit read (`GET /auth/audit`), all exports (`/export/*` and analytics export), all imports (`/import/*`), bulk/CSV contact operations (`/contacts/import-csv`, `/contacts/bulk-assign`, `/contacts/bulk-archive`, and `.../merge`), pipeline/stage administration (mutating `/deals/pipelines*`, `/deals/stages*`), workflow administration (mutating `/workflows*`), example-data clearing (`DELETE /onboarding/example-data`), and org settings (`PATCH /org/settings`).
- **Viewer role.** Users with role `viewer` are read-only — any non-`GET`/`HEAD`/`OPTIONS` request is rejected with 403.
- **Rate limits.** A global limiter applies (default 100/min, configurable), with tighter per-route limits on auth (register/login/join 5/15min, verify 10/15min, resend 3/5min, keyed by IP and, for login, IP+email), imports (3–10 per 10min/hour), exports (5/hour), and the Yandex webhook (20/min).

## Data Model (Prisma / PostgreSQL)

The schema (`backend/prisma/schema.prisma`, Prisma 5.13 on Yandex Cloud Managed PostgreSQL) defines 22 models. All primary keys are UUID v4 (`gen_random_uuid()`). **Multi-tenancy:** every tenant-scoped table carries an `organization_id` (FK to `Org`); `PendingCapture` uses `org_id`. App-level query scoping enforces isolation (Prisma bypasses RLS as superuser).

### Identity & Tenancy

- **Org** (`@@map("organizations")`) — the tenant root. Fields: `name`, unique `slug`, `plan` (`starter`/`growth`/`business`), `owner_id`, `settings`/`plan_features` (JSON), `stalled_threshold_days` (default 30), `decay_factor` (default 0.5), `join_code` (+ `join_code_expires_at`). Owns users, contacts, deals, tasks, messages, calendar events, pipelines, workflows, captures, sessions, audit/activity logs, attachments, chat, notifications.
- **User** — belongs to one Org (`UserOrg`). Auth: `email` (unique, citext), `username` (unique per org via `@@unique([organization_id, username])`), `password_hash`, verification/lock fields (`is_verified`, `phone_verified`, `email_verified`, `failed_login_count`, `locked_until`, `must_change_password`, `must_change_email`). Profile: `name`, `role`, `avatar_url`, `phone`, `push_token`, `onboarding_state`/`preferences` (JSON), `last_seen_at`. **Roles** (`UserRole`): `owner`, `admin`, `member`, `viewer`. **Manager hierarchy:** self-relation `manager_id` → `manager` / `reports` (indexed), plus `invited_by` → `inviter` / `invitees`. Also relates to `ownedOrgs` (`OrgOwner`).
- **AuthSession** — persisted login sessions. `user_id`, `organization_id`, unique `token_hash`, `user_agent`, `ip_address`, `revoked_at`/`revoked_reason`, `last_seen_at`, `expires_at`.
- **VerificationCode** — email/phone verification. `user_id` (cascade delete), `code_hash`, `channel`, `expires_at`, `used_at`.
- **AuditEvent** — security/audit trail. Nullable `organization_id`/`user_id`, `action`, `outcome` (default `success`), `target_type`/`target_id`, `ip_address`, `user_agent`, `metadata` (JSON).

### CRM Core

- **Contact** — `first_name`, `last_name`, `company` (text field; no Company entity), **`email` / `phone` / `mobile` (encrypted at rest, application-level)**, `address`/`tags`/`custom_fields` (JSON), `source`, `notes`, `avatar_url`, `assigned_to` (assignee), `created_by`, `type` (`ContactType`: lead/customer/partner/other), `status` (`ContactStatus`: active/inactive/archived), `is_example_data`. Owns deals, tasks, messages, calendar events, pending captures.
- **Deal** — `title`, `contact_id`, `pipeline_id`, `stage_id`, `value` (Decimal) + `currency` (default `RUB`), `expected_close`/`actual_close`, `probability`, `status` (`DealStatus`: open/won/lost/archived), `lost_reason`, `next_action`(+`_due`), `stage_entered_at`, `source`, `assigned_to`, `created_by`, `custom_fields`, `is_example_data`.
- **Pipeline → PipelineStage → Deal** structure:
  - **Pipeline** — `name`, `description`, `is_default`, `created_by`; has many `stages` and `deals`.
  - **PipelineStage** — `pipeline_id`, `name`, `position` (ordering Int), `color`, `is_won_stage`, `is_lost_stage`; referenced by Deals via `stage_id`.
- **Task** — `title`, `description`, optional `contact_id`/`deal_id`, required `assigned_to` (assignee) + `created_by`/`completed_by`, `due_date`, `priority` (`TaskPriority`: low/medium/high/urgent), `status` (`TaskStatus`: pending/in_progress/done/cancelled), `is_recurring`+`recurrence_rule`, `reminder_at`, `completed_at`, `is_example_data`.
- **Message** — contact communication log. `contact_id`, optional `user_id`, `direction` (`MessageDirection`: inbound/outbound), `channel` (`MessageChannel`: in_app/email/call), `body`, `status` (`MessageStatus`: pending/sent/delivered/read/failed), `error_message`, `twilio_sid`, `read_at`/`delivered_at`.
- **CalendarEvent** — `title`, `description`, optional `contact_id`/`deal_id`, `created_by`, `attendee_ids` (JSON), `start_time`/`end_time`, `location`, `meeting_url`, `reminder_minutes` (default 30), `status` (`CalendarEventStatus`: scheduled/completed/cancelled), `notes`, `completed_at`, `post_meeting_prompted`, external sync ids (`ext_event_uid`/`ext_calendar_uid`), `is_example_data`.
- **UserCalendarSync** — per-user external calendar credentials (`@@unique([user_id, provider])`). `provider`, `access_token`, `refresh_token`, `expires_at`, `ext_calendar_uid`, Yandex fields (`yandex_username`, `yandex_calendar_slug`).

### Automation

- **Workflow** — `name`, `description`, `trigger` (`WorkflowTrigger`: contact_created / deal_stage_changed / task_completed / deal_won / deal_created / task_created / deal_stale), `conditions` (JSON), `actions` (JSON, required), `status` (`WorkflowStatus`: active/paused/archived), `created_by`; has many `runs`.
- **WorkflowRun** — execution record. `workflow_id`, `organization_id`, `trigger_record_id`, `status` (`WorkflowRunStatus`: success/failed), `error_message`.

### Capture / Import

- **PendingCapture** — inbound call/email awaiting contact matching. `org_id`, `type` (`PendingCaptureType`: call/email), `raw_data` (JSON), `phone_number`, `status` (`PendingCaptureStatus`: pending/matched/dismissed), optional `contact_id`.

### Collaboration & Cross-cutting

- **ChatMessage** — internal team chat. `sender_id`, `channel`, `body`.
- **ChatReadReceipt** — per-user unread tracking (`@@unique([user_id, channel])`). `channel`, `last_read_at`.
- **Notification** — in-app notifications. `recipient_id`, `event_type`, `role`, `title`, `body`, `entity_type`/`entity_id`, `data` (JSON), `is_read`/`read_at`.
- **NotificationSent** — dedup ledger for delivered notifications (`@@unique([event_type, entity_id, recipient_id])`); standalone, no org FK.
- **ActivityLog** — generic entity change feed. `user_id`, `entity_type`/`entity_id`, `action`, `changes` (JSON).
- **Attachment** — polymorphic file attachments. `entity_type`/`entity_id`, `filename`, `file_url`, `size`, `mime_type`, `uploaded_by`.

## Integrations & External Services

### Yandex Calendar (OAuth + CalDAV two-way sync)
`backend/services/yandex-calendar.ts` connects a user's Yandex account for bidirectional calendar sync. The OAuth flow builds a consent URL against `https://oauth.yandex.ru/authorize`, exchanges the code at `https://oauth.yandex.ru/token`, and reads the username from `https://login.yandex.ru/info`; the `state` parameter is an HMAC-SHA256-signed, 5-minute-expiry blob keyed on `JWT_SECRET`. Access/refresh tokens are stored encrypted (AES-256-GCM via the field-encryption helper) and auto-refreshed ~60s before expiry. Outbound event writes/deletes go to `https://caldav.yandex.ru/calendars/<username>/<slug>/<uid>.ics` (PUT/DELETE with an `OAuth <token>` header), and inbound changes arrive via a push webhook authenticated by a shared secret sent in the `x-yandex-webhook-secret` header or a `Bearer` token, compared in constant time. Config: `YANDEX_CLIENT_ID` and `YANDEX_CLIENT_SECRET` (both required together, gate whether the feature is "configured"); `YANDEX_REDIRECT_URI` (https, required in production, else derived from the request host); `YANDEX_CALENDAR_SUCCESS_URL` (optional post-connect redirect, allows `https:` or the `crm:` app deep-link scheme); `YANDEX_WEBHOOK_SECRET` (min 32 chars, required in production — a missing config returns 503); and `TOKEN_ENCRYPTION_KEY` for token-at-rest encryption (falls back to `JWT_SECRET` outside production).

### Contact imports (Bitrix24, Telegram, vCard, WhatsApp)
Four import sources feed `db.contact`, all encrypting phone/email at rest via `encryptField`. Bitrix24 (`backend/services/importBitrix24.ts` + `bitrix-paginator.ts`) pulls contacts and deals from a user-supplied inbound-webhook URL by calling `crm.contact.list`/`crm.deal.list`; every request is SSRF-guarded by `assertAllowedBitrixWebhookUrl` (config/security.ts), which permits only `https` URLs whose host matches `*.bitrix24.(ru|com|by|kz|eu|de)` and rejects private/reserved IP literals, and the fetch itself uses `redirect: 'error'` with a 10s abort timeout plus safety caps (1000 contacts, 500 deals). Telegram (`backend/services/importTelegram.ts`) uses MTProto through the `telegram` (GramJS) client: it sends a login code, signs in with the SMS/app code, saves a `StringSession`, and pulls the user's contacts via `contacts.GetContacts`; needs `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. vCard and WhatsApp imports are parsed client-side and bulk-created server-side in `backend/api/controllers/imports.ts` (sources `vcard`/`whatsapp`), requiring no external service or credentials.

### Transactional email (Resend)
`backend/services/email.ts` sends plain-text transactional email via the Resend SDK (`client.emails.send`). It is a no-op returning `SERVICE_NOT_CONFIGURED` when unconfigured. Config: `RESEND_API_KEY` (required to enable sending) and `RESEND_FROM_EMAIL` (the From address, defaulting to `CRM <onboarding@resend.dev>`).

### Push notifications (Expo push, with FCM v1 fallback)
`backend/services/push.ts` delivers device push notifications. It inspects the stored device token: Expo tokens go through `expo-server-sdk`'s `sendPushNotificationsAsync`, while non-Expo (raw FCM) tokens are sent directly to the Firebase Cloud Messaging v1 API (`https://fcm.googleapis.com/v1/projects/<id>/messages:send`) using a Google service-account access token from `google-auth-library`. `DeviceNotRegistered`/unregistered responses cause the user's `push_token` to be cleared. Config: `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_PATH` (path to the Firebase service-account JSON, default `firebase-service-account.json` resolved from cwd) — these are only needed for the raw-FCM path; Expo delivery needs no server credentials.

### Object storage (Yandex Object Storage, S3-compatible)
`backend/services/storage.ts` stores attachments in an S3-compatible bucket (Yandex Object Storage) via `@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post`. Uploads use a browser-direct presigned POST (5-minute expiry) constrained by a `content-length-range` condition and a strict server-side MIME allowlist (`ALLOWED_UPLOAD_MIME_TYPES` — images/video/office docs; `image/svg+xml` and `text/html` are deliberately excluded to prevent stored XSS), and every object is forced to `Content-Disposition: attachment`. Object keys are org-scoped as `uploads/<orgId>/<entityType>/<uuid>-<sanitizedName><ext>`; `deriveOrgScopedKey` validates that any stored `file_url` points at this app's own endpoint/bucket and the caller's org prefix before allowing deletes or accepting the URL, blocking cross-tenant/external references. Config: `S3_ENDPOINT` (default `https://storage.yandexcloud.net`), `S3_REGION` (default `ru-central1`), `S3_BUCKET` (default `crm-uploads-users`), `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. (Note: `getPublicUrl` currently returns unsigned public-read URLs, flagged in-code as a security TODO to move to short-TTL presigned GETs.)

## Build, Release & Configuration

### EAS build profiles (`eas.json`)

The app ships through five EAS build profiles, all keyed off `APP_ENV`:

| Profile | Target | Distribution | Artifact | Key env |
|---|---|---|---|---|
| `development` | Local dev with `expo-dev-client` | internal | Android APK, iOS simulator build | `APP_ENV=development` |
| `preview` | Internal staging / QA | internal | Android APK, iOS device build (`simulator: false`) | `APP_ENV=staging` |
| `production` | App Store + Google Play | store | iOS `.ipa` (`resourceClass: m-medium`) + Google Play **app-bundle** (`.aab`) | `APP_ENV=production`, `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_WS_URL` |
| `rustore` | RuStore (Russia) | internal | Android **APK** | `APP_ENV=production`, `MARKET_CODE=RU` |
| `huawei` | Huawei AppGallery (Russia) | internal | Android **APK** | `APP_ENV=production`, `MARKET_CODE=RU` |

- `production` has `autoIncrement: true` (iOS buildNumber / Android versionCode bump automatically); `appVersionSource` is `local`.
- Both `rustore` and `huawei` build sideloadable APKs (RuStore and AppGallery do not accept `.aab`), carry production API URLs, and set `MARKET_CODE=RU` to force the Russian market pipeline (see below). They are distinct profiles only because each store needs its own signed APK upload.
- Submit config (`submit.production`): iOS via `appleId: thiofedor@gmail.com`, `ascAppId: 6776447873`, `appleTeamId: C924RZ5S3J`; Android via `google-play-service-account.json` to the `production` track.

### App identity (`app.json`)

- **Name / display name:** `name: "4KUB"`; user-facing display name is **4КУБ** (Cyrillic) — set via iOS `CFBundleDisplayName` and the Android `./plugins/withAndroidDisplayName` config plugin.
- **Slug:** `crm` · **Owner:** `flada` · **Scheme:** `crm` · **Version:** `1.0.5` (iOS `buildNumber` 22, Android `versionCode` 8).
- **Bundle / package:** iOS `bundleIdentifier` and Android `package` are both `com.fedorportnoi.crm`.
- **Apple:** App Store Connect app id `6776447873`, Apple Team `C924RZ5S3J`, `ITSAppUsesNonExemptEncryption: false`.
- **EAS project id:** `63759f24-3860-43b6-ac4f-cec8180d63c3`.
- Ships Firebase (`google-services.json`) for FCM push; requests location, contacts, camera, photo-library, and POST_NOTIFICATIONS permissions.

### Target markets

Russia-focused distribution across three stores from a single codebase: **Apple App Store** (production `.ipa`), **RuStore** (`rustore` APK), and **Huawei AppGallery** (`huawei` APK). Google Play is wired up in submit config but the RU store APKs are the primary distribution channels.

### Production API

All production profiles point the app at the same backend:

- REST: `https://4kub.ru/api/v1` (`EXPO_PUBLIC_API_URL`)
- WebSocket: `wss://4kub.ru` (`EXPO_PUBLIC_WS_URL`)

### Backend environment variables

`backend/config/env.ts` loads a local `.env` (skippable via `CRM_SKIP_LOCAL_ENV=true`) without overwriting already-set vars. `backend/config/security.ts` (`validateProductionConfig`) hard-validates the security-critical vars at boot when `NODE_ENV=production`.

**Core / required (enforced in production):**
- `DATABASE_URL` — Yandex Cloud Managed PostgreSQL connection string; must be `postgresql:`/`postgres:`, non-private host, and carry a non-weak password.
- `JWT_SECRET` — JWT signing secret, min 32 chars, rejected if weak.
- `TOKEN_ENCRYPTION_KEY` — encrypts stored OAuth tokens; min 32 chars, required in production, and **must differ from `JWT_SECRET`** (falls back to `JWT_SECRET` only in non-prod).
- `YANDEX_WEBHOOK_SECRET` — validates inbound Yandex calendar webhooks; min 32 chars, required in production.
- `CORS_ORIGINS` (or `CRM_CORS_ORIGINS` / `ALLOWED_ORIGINS`) — allowlist, required in production.
- `TRUSTED_PROXY` — reverse-proxy IP/CIDR (or hop count) fed to Fastify `trustProxy`; unset ⇒ `false` (only set behind a known proxy so client IPs / rate limiting stay accurate).

**Storage (Yandex Object Storage, S3-compatible — `backend/services/storage.ts`):**
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — bucket credentials.
- `S3_ENDPOINT` (default `https://storage.yandexcloud.net`), `S3_REGION` (default `ru-central1`), `S3_BUCKET` (default `crm-uploads-users`).
- `MAX_UPLOAD_SIZE_MB` (default 10).

**Yandex calendar OAuth + Vision:**
- `YANDEX_CLIENT_ID` + `YANDEX_CLIENT_SECRET` (must be set together), `YANDEX_REDIRECT_URI` (https, required in prod when Yandex is configured), `YANDEX_CALENDAR_SUCCESS_URL` (https or `crm:` deep link), plus `YANDEX_WEBHOOK_SECRET` above.
- `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` — Yandex Vision OCR for business-card / contact recognition.

**YandexGPT (`backend/services/yandex-gpt.ts`) — the only model provider in the backend:**
- `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` (the same pair as Vision; both required, otherwise `isYandexGptConfigured()` is false and every AI feature degrades quietly).
- `YANDEX_GPT_MODEL` (default `yandexgpt/latest`), `YANDEX_GPT_TIMEOUT_MS` (default 30000).
- Every model call in the backend goes through the `createCompletion` seam in this file, and it has exactly two consumers: `backend/services/assistant.ts` and `contact-ai.ts`. The provider is domestic, so ФЗ-152 ст. 12 (cross-border transfer) does not apply today; what applies is the ч. 5 ст. 5 minimisation duty. The planned Wave A swap to OpenAI via `workers/openai-proxy/` repoints this one file, and ст. 12 begins to apply at that moment.
- The tasks `suggest-contact` endpoint used to be the third consumer and no longer calls a model at all. `resolveSuggestedContact` (`backend/api/controllers/tasks.ts`) now matches the task title against a local Prisma read with `matchContactByName` (`backend/services/contact-name-match.ts`), so up to 300 customers' full names stopped going into a prompt and that route has no provider seam left for Wave A to repoint. It still checks `isYandexGptConfigured()` — that is the switch operators already use to keep the AI surfaces off, not a model call.

**Email (Resend — `backend/services/email.ts`):**
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (default `CRM <onboarding@resend.dev>`).

**Push notifications (`backend/services/push.ts`):**
- Expo push via `expo-server-sdk` for Expo tokens; `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_PATH` (default `firebase-service-account.json`) for raw FCM tokens.

**Other:** `JWT_EXPIRES_IN` (default `7d`), `PORT` (default 3000), `ENABLE_MCP`, `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` (Telegram import), `APP_VERSION` / `APP_VERSION_CODE`.

### Market configuration (`backend/config/market.ts`)

`MARKET_CODE=RU` (set on the `rustore`, `huawei`, and production builds) drives the Russian default pipeline for new organizations:

- Default currency: `RUB`.
- Default pipeline name: **Воронка продаж**.
- Default stages: **Новый лид → Квалификация → Предложение → Сделка выиграна**.

Currency codes are normalized via `normalizeCurrencyCode` (trim + uppercase).

---

## Security Posture

The app underwent a **two-round white-box security audit** (2026-07-17/19) using the
[Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) playbooks
as methodology, with every finding **adversarially verified** against the real code. Full report:
**`SECURITY_AUDIT_2026-07-17.md`**.

**Outcome: 24 issues found and fixed**, all verified (backend + frontend `tsc` 0 errors, 63 backend
unit tests, live API smoke, and an on-device emulator pass).

**Round 1 (18 fixes):** Bitrix24 `webhook_url` SSRF (now https + host-allowlist + reserved-IP block +
timeout); contact-import PII stored in plaintext (now AES-256-GCM); stale-role privilege retention
(removed the redundant route-level `authenticate`, revoke sessions on role change); register/join
rate-limit re-keyed to IP only; `/auth/join` account lockout; password change requires + verifies the
current password and revokes sessions; per-code OTP attempt cap; valid module-load bcrypt `DUMMY_HASH`;
`adminRoutePolicy` gates `/api/v1/import/*`; the manager **visibility cone** applied to `sync/delta`,
deal move/won/lost, stale-eval, contact-children reads, `/activities`, and deal assignment; attachment
`file_url` bound to the org's own bucket key + upload MIME allowlist + `Content-Disposition`; `trustProxy`
env-gated; per-route rate limits on `/import/*` and `/export`; `ws` bumped to 8.21.1; mobile React Query
cache no longer persists the JWT/PII (`shouldDehydrateQuery` filter + `allowBackup=false`).

**Round 2 re-audit (6 more fixes)** — caught endpoints the first pass missed: visibility cone extended
to **messages, attachments, calendar, and deal→contact links**; `authenticate()` made **idempotent**
so the fresh DB role survives on *all* routes (completing the stale-role fix); `decryptField` made
**fail-safe** (a crafted `enc:v1:` PII value can no longer 500 the contacts list).

### Key security controls in place
- Global JWT preHandler that re-reads the **live DB role** every request (demotion/deactivation is instant).
- **Visibility cone** enforced on every org-scoped read/write; owner/admin unrestricted.
- App-level tenant isolation (`organization_id` on every query; Prisma bypasses RLS).
- Field-level **AES-256-GCM** encryption of Contact email/phone/mobile (fail-safe on read).
- Org-scoped S3 object keys + server-side MIME allowlist; SSRF-guarded outbound imports.
- Env-gated `trustProxy`; per-route rate limits on auth/import/export; DM channel authorization.

### Deferred security backlog (target 1.0.6 — NOT blocking 1.0.5)
1. **S3 attachment URLs (HIGH if the bucket is public-read).** Attachments are served as unsigned,
   permanent, public object URLs with no server-side download authz. This is **pre-existing** (also in
   1.0.4) and its impact depends on the Yandex bucket ACL. Fix: keep the bucket private + add an
   authenticated `GET /attachments/:id/download` that returns a short-TTL presigned URL (also touches
   the mobile client). Marked `// SECURITY TODO` in `backend/services/storage.ts`.
2. **OTP hashing** — codes are unsalted single-pass SHA-256 (exploitable only with DB-read access).
   Move to a salted/HMAC KDF with a server-side pepper.
3. **JWT in the WebSocket URL** — `wss://host/ws?token=<JWT>` puts the bearer token in the URL query
   string. Switch to a short-lived, single-use WS ticket.
4. **`undici`** — a vulnerable transitive via `expo-server-sdk` on the push path (low runtime relevance).
   Monitor / bump when an override is clean.

---

## Testing & QA

- **Unit / integration:** Vitest — `tests/unit/backend/` (63 tests: auth, security, chat-authz, SSRF
  guard, calendar-webhook, etc.) and `tests/unit/utils/`. Run: `npx vitest run tests/unit/backend/`.
- **Smoke / e2e:** Playwright — `tests/smoke/` (auth, pipelines, screens…).
- **Static gate:** `npx tsc --noEmit -p backend/tsconfig.json` (backend) and `npx tsc --noEmit` (frontend).
- **Isolated on-device QA rig** (never point at production — not `4kub.ru`, not the Yandex prod cluster):
  - Embedded PostgreSQL 18.4 on **:5433**, db `crm_smoke` — **must be UTF8 + citext** (WIN1252 crashes on
    Cyrillic writes; `adb input text` can't type Cyrillic, so seed Russian data via the API).
  - Backend on **:3001** with `NODE_ENV=test CRM_SKIP_LOCAL_ENV=true` and
    `DATABASE_URL=postgresql://postgres:crm_qa_password@127.0.0.1:5433/crm_smoke`.
  - Metro on **:8081** with `EXPO_PUBLIC_API_URL=http://127.0.0.1:3001/api/v1`; `adb reverse tcp:8081` + `tcp:3001`.
  - Pixel_8 AVD + the dev-client APK. QA account: **qa@test.com / QaTest123!** (verify via a DB flip of `is_verified`).

---

## Follow-up Backlog

- **Merge `fix/dm-security-ru-i18n-ui` to `main`** — the branch is on `origin` as of 2026-07-25, but
  `main` still sits at the pre-1.0.5 commit.
- Upload the RuStore APK; after Apple approval, release the iOS version (manual release recommended).
- The **security deferred items** above (S3 download authz is the top one for 1.0.6).
- Smaller known items from QA: `npm run db:seed` points to a missing file; confirm the offline-flush
  duplicate-on-reconnect case with a clean repro; encrypted email/phone are not searchable (a blind
  index / searchable hash would restore search).

---

## Version History

- **1.0.5** (iOS 22 / Android vc 8) — 2026-07: security-hardening release (24 audit fixes) + Russian
  pipeline localization ("Воронка продаж": Новый лид / Квалификация / Предложение / Сделка выиграна) +
  UI polish (chat header, contacts selection, DM empty state, workflow detail theming). **iOS in review;
  Android APK for RuStore.**
- **1.0.4** (iOS 20 / vc 7) — prior store release.
- Earlier 1.0.x: dark/light theme system, tasks localization + auto-contact, role hierarchy, splash fix.

---

## Developer Quick Reference

> This section absorbed the old `CLAUDE.md`, which was deleted on 2026-07-25. There is no separate
> conventions file — repo rules live here.

### Hard constraints (read before writing code)

1. **Russian providers only.** No US services anywhere in the stack — not Supabase, Resend, Stripe,
   Twilio, or a US-hosted data path. FZ-242 requires personal data of Russian citizens to sit on
   servers in Russia, and the product is Russia-first by positioning. Reach for the Russian
   equivalent (Yandex Cloud, Yandex Object Storage, Yandex Calendar/Vision/SpeechKit,
   RuStore Push, YooMoney/SBP) before wiring anything new. **SMS is out of the product
   entirely** — no SMS provider, no SMS channel, no SMS OTP. Do not reintroduce one.
2. **Market/provider changes go through a boundary, never into feature code.** Backend defaults live
   in `backend/config/market.ts`, mobile display defaults in `src/market/profile.ts`; provider logic
   belongs in a named adapter. No hardcoded `$`, `USD`, `en-US`, or US phone formats in screens or
   controllers. Customer-specific process variation belongs in pipelines, stages, workflows, and
   `custom_fields`. See `docs/architecture/adaptability.md`.
3. **Org scoping is the golden rule.** Every org-scoped Prisma query must include
   `where: { organization_id: request.user.org_id }`. Prisma connects as superuser and bypasses RLS,
   so this is the *only* thing standing between tenants.
4. **Respect the visibility cone.** Org scoping alone is not enough on `member`/`viewer` reads — go
   through `backend/services/visibility.ts` (`getVisibleUserIds` / `getAccessibleUserIds`). Two
   security audits found endpoints that skipped it.

### Repo layout

```
crm/
├── backend/             # Fastify v5 API (CommonJS TypeScript)
│   ├── index.ts         # entry point — npm run backend:dev
│   ├── api/routes/      # one Fastify route plugin per resource
│   ├── api/controllers/ # one handler module per resource
│   ├── config/          # env, security, market profile
│   ├── prisma/          # schema.prisma + migrations
│   └── services/db.ts   # the Prisma singleton
├── src/                 # React Native / Expo app (expo-router in src/app)
├── tests/               # unit (vitest) + smoke (playwright)
├── docs/                # architecture, feature specs, store listings, privacy policies
└── scripts/             # release tooling (rustore-publish.js)
```

Deeper design history lives in the Obsidian vault at
`C:\Users\fedor\Obsidian\Brain\Projects\CRM\` — note that it was last verified 2026-05-31 and this
file supersedes it wherever they disagree.

### Commands and build rules

- **Install:** `npm install --legacy-peer-deps` (MANDATORY — `@testing-library/react-native` has an
  unresolved `react@19` peer conflict; do **not** use `--force`).
- **After a fresh install, run `npm run db:generate` before anything else.** Without the generated
  client both typechecks fail with misleading errors (`Module '@prisma/client' has no exported member
  'WorkflowTrigger'`, `Prisma has no exported member 'OrgWhereInput'`) and one unit test fails.
- **Backend dev server:** `npm run backend:dev` (tsx watch). Requires `.env` with `DATABASE_URL`,
  `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` (must differ from `JWT_SECRET` in prod).
- **Prisma:** `npm run db:generate` (after any schema change), `db:migrate`, `db:studio`. Import the
  singleton `import { db } from 'backend/services/db.ts'` — never `new PrismaClient()` elsewhere.
- **Backend startup:** all init lives in `async function start()` — no top-level `await`. The root
  `package.json` deliberately omits `"type": "module"` because Expo's Metro bundler requires CJS.
- **Do not downgrade the Fastify v5 plugin set** (`@fastify/cors ^11`, `@fastify/jwt ^10`,
  `@fastify/multipart ^10`, `@fastify/rate-limit ^10`, `fastify-type-provider-zod ^4`). The v4-era
  equivalents are incompatible with Fastify v5.
- **Before closing any session that touched `src/` or `backend/`:** `npx tsc --noEmit`,
  `npx tsc --noEmit -p backend/tsconfig.json`, and `npx vitest run tests/unit`. The 2026-06-18
  dead-code audit skipped this and left the suite broken for two weeks.
- **Builds:** `eas build -p ios --profile production` (App Store), `eas build -p android --profile rustore`
  (RuStore APK). iOS submit: `eas submit -p ios --profile production` (uses the stored ASC API key).
- **Knowledge base:** deeper design docs live in the Obsidian vault at
  `C:\Users\fedor\Obsidian\Brain\Projects\CRM\` (decisions, sprints, architecture).