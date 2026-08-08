# API Design

> **Status.** This file began life as the Sprint-0 design spec and described the API as
> planned, not as built. It has been reconciled against the code (`backend/api/routes/`,
> `backend/index.ts`, `backend/api/authenticate.ts`), and every route below was checked to
> exist. What was planned and never built is not deleted — it is recorded under
> [Known Gaps](#known-gaps). It is still a summary, not an exhaustive reference: see
> [Not specified here](#not-specified-here).

## Conventions

**Base URL:** `https://4kub.ru/api/v1`

All endpoints:
- Return JSON with a consistent envelope: `{ data, meta, error }`
- Require `Authorization: Bearer <access_token>` — the exception is **not** the whole
  `/auth/*` prefix. Only ten auth routes are public (`POST /auth`, `/auth/login`,
  `/auth/join`, `/auth/verify`, `/auth/verify/resend`, `/auth/forgot-password`,
  `/auth/reset-password`, `/auth/invites/open`,
  `/auth/invites/lookup`, `/auth/invites/accept`), plus a handful outside it: `GET /ws`,
  the Yandex Calendar OAuth callback and webhook, the amoCRM callback and webhook, the
  open-tracking pixel, the consent unsubscribe pair, and the expo-updates manifest and
  assets. Every other `/auth/*` route — including `GET /auth/audit`, `GET /auth/users`
  and `GET /auth/company-code` — requires a token like anything else.
  **`isPublicApiRoute()` in `backend/api/authenticate.ts` is the authority; this list is a
  summary of it.** Do not widen the check to a `/api/v1/auth` prefix match to agree with
  any list, including this one.
- Accept `Content-Type: application/json`
- Return HTTP status codes semantically (200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500)

### Response Envelope

```json
// Success (single)
{ "data": { "id": "...", ... }, "meta": {} }

// Success (list)
{ "data": [...], "meta": { "total": 150, "page": 1, "per_page": 50, "pages": 3 } }

// Error
{ "error": { "code": "CONTACT_NOT_FOUND", "message": "Contact not found", "details": {} } }
```

### Pagination
Most list endpoints support `?page=1&per_page=50&sort=created_at&order=desc`: contacts,
deals, tasks, calendar, sequences, webhooks, notifications, email templates, assistant
history, auth (audit, invites) and the public API. The remaining route files accept no
paging parameters at all — assume none unless the route's schema says otherwise.
`per_page` is capped at 100.

### Filtering
Contacts support: `?q=&phone=&status=&type=&assigned_to=&scope=&tag=&source=&last_contacted_before=`
Deals support: `?q=&pipeline_id=&stage_id=&assigned_to=&scope=&status=&contact_id=`
Note deals have **no** `tag` filter. `scope` is `direct` | `subtree` and selects whether
the manager hierarchy below the caller is included.

### Versioning
URI versioning (`/api/v1`). Breaking changes increment the version. Non-breaking additions are backwards-compatible within a version.

---

## Authentication Endpoints

Prefix `/api/v1/auth`. `(public)` marks the ten routes that need no bearer token —
the same ten listed under Conventions, and the same ten in `isPublicApiRoute()`.

```
POST   /auth                          Create organization + owner account (public)
POST   /auth/login                    Authenticate, get an access token (public)
POST   /auth/join                     Join an existing org with its company code (public)
POST   /auth/verify                   Confirm an email with the emailed OTP (public)
POST   /auth/verify/resend            Re-send the verification OTP (public)
POST   /auth/forgot-password          Mail a password-reset code (public)
POST   /auth/reset-password           Set a new password with that code (public)
POST   /auth/logout                   Revoke the current session
POST   /auth/logout-all               Revoke every session for this user
GET    /auth/sessions                 List this user's active sessions

PATCH  /auth/me/password              Change own password (needs the current one)
PATCH  /auth/me/credentials           Set own email + password on first sign-in
PATCH  /auth/me/timezone              Set the timezone reminders are interpreted in

GET    /auth/audit                    Org audit log (owner/admin — audit.read)
GET    /auth/users                    List org members
POST   /auth/users/invite             Create a member account with a temp password
PATCH  /auth/users/:id/deactivate     Deactivate a member
PATCH  /auth/users/:id/role           Change a member's role
PATCH  /auth/users/:id/manager        Reassign a member's manager

POST   /auth/invites                  Mint an invite link (team.manage)
GET    /auth/invites                  List outstanding invites
DELETE /auth/invites/:id              Revoke an invite
POST   /auth/invites/open             Open an invite link by token (public)
POST   /auth/invites/lookup           Look up an invite by claim code (public)
POST   /auth/invites/accept           Redeem an invite into an account (public)

GET    /auth/company-code             Read the org's join code
POST   /auth/company-code/rotate      Rotate the join code
```

There is no `POST /auth/register` — registration is a POST to the root of the prefix.
There are no refresh tokens; see [Known Gaps](#known-gaps). Password recovery DOES now
exist — the two routes above — but read the Known Gaps entry before assuming it reaches
everybody: it is keyed on `User.email`, and invited members whose address is still NULL
have no self-service path.

---

## Contacts

```
GET    /contacts               List contacts (paginated, filterable, searchable)
POST   /contacts               Create contact
GET    /contacts/:id           Get contact by ID
PATCH  /contacts/:id           Update contact fields
DELETE /contacts/:id           Archive contact (soft delete)

GET    /contacts/:id/activity  Get full activity log for contact
GET    /contacts/:id/deals     Get all deals for contact
GET    /contacts/:id/tasks     Get all tasks for contact

GET    /contacts/nearby        Contacts near a coordinate, nearest first
POST   /contacts/import-csv    Bulk import from a CSV payload
POST   /contacts/business-card/scan  Extract a contact from a business-card image
POST   /contacts/bulk-assign   Assign multiple contacts to a team member
POST   /contacts/bulk-archive  Archive multiple contacts
```

---

## Deals / Sales Pipeline

Pipelines and stages are **nested under the deals prefix** — `/api/v1/deals/pipelines`,
`/api/v1/deals/stages/:id` — not mounted at the top level.

```
GET    /deals                  List deals (filterable by stage, pipeline, status)
POST   /deals                  Create deal
GET    /deals/:id              Get deal by ID
PATCH  /deals/:id              Update deal
PATCH  /deals/:id/stage        Move deal to a different stage
POST   /deals/:id/won          Mark deal as won
POST   /deals/:id/lost         Mark deal as lost (with reason)
POST   /deals/stale/evaluate   Re-evaluate which open deals have gone stale

GET    /deals/pipelines        List all pipelines for organization
POST   /deals/pipelines        Create pipeline
PATCH  /deals/pipelines/:id    Update pipeline
DELETE /deals/pipelines/:id    Delete pipeline (must not have active deals)

GET    /deals/stages/library   Stage library for the org's pipelines
POST   /deals/stages           Create stage
POST   /deals/stages/reorder   Reorder stages within a pipeline
PATCH  /deals/stages/:id       Update stage (name, position, color, is_archived)
DELETE /deals/stages/:id       Delete stage (must be empty)
```

`is_archived` belongs to **Stage**, not to Deal. There is no route that archives a deal;
see [Known Gaps](#known-gaps).

---

## Tasks

```
GET    /tasks                  List tasks (filter by assignee, status, due date)
POST   /tasks                  Create task
GET    /tasks/:id              Get task
PATCH  /tasks/:id              Update task
POST   /tasks/:id/complete     Mark task as completed
DELETE /tasks/:id              Cancel task

GET    /tasks/today            Tasks due today for current user
GET    /tasks/assignees        Users this caller may assign a task to
POST   /tasks/suggest-contact  Suggest the contact a free-text task refers to

GET    /tasks/:id/reminders                 List reminders on a task (tasks.read)
POST   /tasks/:id/reminders                 Add a reminder (tasks.write)
PATCH  /tasks/:id/reminders/:reminderId     Update a reminder (tasks.write)
DELETE /tasks/:id/reminders/:reminderId     Delete a reminder (tasks.write)
```

---

## Messages

```
POST   /messages/in-app                    Send in-app message to contact
POST   /messages/call                      Log a phone call against a contact
GET    /messages/conversation/:contact_id  Conversation history with a contact
POST   /messages/:id/read                  Mark message as read

WebSocket: wss://4kub.ru/api/v1/ws
  Obtain a single-use ticket first: GET /api/v1/ws/ticket (authenticated), then
  connect with ?ticket=<t>. This keeps the JWT out of the socket URL.
  The only payload the server emits today is { type: 'chat:message', message: {...} }.
```

---

## Calendar / Appointments

```
GET    /calendar               List events (filterable by date range, attendee)
POST   /calendar               Create appointment
GET    /calendar/:id           Get event
PATCH  /calendar/:id           Update event
DELETE /calendar/:id           Cancel event
POST   /calendar/:id/complete  Mark an appointment as completed
POST   /calendar/:id/notes     Attach notes to an appointment

GET    /calendar/availability  Get team availability for a date range
GET    /calendar/sync/yandex/auth      Initiate Yandex Calendar OAuth flow
GET    /calendar/sync/yandex/callback  Complete Yandex Calendar OAuth callback (public)
DELETE /calendar/sync/yandex           Disconnect Yandex Calendar
GET    /calendar/sync/status           Check sync health
POST   /calendar/webhooks/yandex       Yandex push notification sink (public)
```

There is no `/calendar/events` segment, and no `POST /calendar/sync/yandex` —
Yandex changes arrive via the webhook above rather than a client-triggered sync.

---

## Analytics

```
GET    /analytics/dashboard    Home dashboard aggregate metrics (revenue.view)
```

The reports live under their own prefix, `/api/v1/reports`, not under `/analytics`:

```
GET    /reports/funnel          Full funnel conversion data (by pipeline, date range)
GET    /reports/win-loss        Win/loss breakdown with reasons
GET    /reports/revenue         Revenue report (monthly, quarterly, custom range)
GET    /reports/reps            Per-representative performance
GET    /reports/pipeline-health Pipeline health summary
```

Both prefixes are gated on `revenue.view` in `authenticate.ts`.

---

## Sync (Offline Support)

```
GET    /sync/delta?since={iso_timestamp}
       Returns all changes (creates, updates, deletes) since the given timestamp
       Response includes: contacts[], deals[], tasks[], messages[], events[]
```

Sync is **read-only**. The planned `POST /sync/push` was never built; see
[Known Gaps](#known-gaps).

---

## Users & Organization

Member administration is not a top-level resource — it lives under `/auth`
(see [Authentication Endpoints](#authentication-endpoints)):

```
GET    /auth/users                  List org members
POST   /auth/users/invite           Invite a new team member
PATCH  /auth/users/:id/deactivate   Deactivate user
PATCH  /auth/users/:id/role         Change a user's role
PATCH  /auth/users/:id/manager      Reassign a user's manager

GET    /org                         Get org settings
PATCH  /org/settings                Update org settings (org.manage)
```

---

## Files / Attachments

Upload is two steps and the bytes never pass through this API — every body it accepts is
JSON.

```
POST   /attachments/upload-url  Mint a presigned POST policy for one file
POST   /attachments             Record the uploaded file's metadata (JSON)
GET    /attachments             List attachments
DELETE /attachments/:id         Delete attachment
```

Step one returns `{ uploadUrl, fields, fileUrl, key }`. The client then posts those `fields`
plus the file as `multipart/form-data` **to `uploadUrl`, which is object storage, not this
API**; step two records the result. The policy pins `Content-Type`, bounds the length, and
forces `Content-Disposition: attachment` so a stored file can never render inline.

Object storage speaks the S3 protocol against Yandex Object Storage — `services/storage.ts`
defaults `S3_ENDPOINT` to `https://storage.yandexcloud.net` and `S3_REGION` to `ru-central1`.
Whether that bucket still resolves is a separate question: the project record has the Yandex
Cloud account deleted on 2026-08-03. These routes exist and behave as described; the
infrastructure behind them is not this document's claim to make.

---

## Known Gaps

Capabilities that earlier revisions of this document described as shipped, and which do
not exist. They are listed rather than deleted so that a reader learns the capability is
**absent**, not merely undocumented. None of these is a queued task; each is a recorded
deferral, and picking one up is a product decision, not a cleanup.

### Password recovery — PARTIAL. Reset-by-email shipped; two populations still stranded

`POST /auth/forgot-password` and `POST /auth/reset-password` now exist and are public.
Earlier revisions of this document listed them as if they had shipped for two years while
neither did; this entry stays so a reader learns what the shipped version does and does
not cover, rather than assuming "recovery exists" means "everyone can recover".

How it works: forgot-password mails a six-digit code on the `password_reset` channel of
the existing `VerificationCode` model (no new model, no migration), and always answers
`202 {sent:true}` whatever the address resolves to. reset-password verifies the code,
sets the new password through the same `PasswordSchema` every other setter uses, clears
`failed_login_count` / `locked_until`, revokes every session, and returns no token —
the user signs in normally afterwards. A successful reset also sets `is_verified`,
because a code delivered to the address on file is the same proof `POST /auth/verify`
accepts; without that, a post-cutover unverified account would finish a perfect reset and
still be refused by `/auth/login`.

**Still no path back for:**

1. **Invited members whose `User.email` is NULL.** `POST /auth/users/invite` creates
   username-only accounts (`must_change_email: true`) and `User.email` is nullable, so
   `findUnique({ where: { email } })` can never match them. They sign in via `/auth/join`
   with the company code and their username, and if they forget that password there is
   still nothing. The complement is admin-initiated reset — a new authenticated route
   gated on `team.manage`, reusing the `must_change_password` flag already on `User` —
   which has not been built. That is a product decision, not a queued task.
2. **An organisation whose owner account is abandoned.** Only the owner may deactivate or
   reparent an admin (see `team.manage_admins`), and there is no owner-transfer endpoint:
   `ASSIGNABLE_ROLE_VALUES` deliberately excludes `owner`, the owner cannot self-deactivate,
   and no admin can deactivate the owner. Such an org permanently loses the ability to
   remove a departed admin from the team screen.

Also worth stating plainly: this makes the mail provider load-bearing for account
recovery, not just for onboarding OTPs. On a box with no `RESEND_API_KEY` the endpoint
still answers `202` — it cannot say otherwise without becoming an enumeration oracle —
and records `outcome: 'failure'`, `reason: 'delivery_failed'` in the audit log instead.
That audit row is the only signal that recovery is dead; check it before telling a user
to "try the reset link again".

### The rest

- **`POST /sync/push`** — offline mutations are not accepted server-side at all.
  `GET /sync/delta` is the whole sync surface and it is read-only.
- **Refresh tokens** — `POST /auth/login` returns an access token only, and there is no
  `POST /auth/refresh`. Every `refresh_token` in the repo belongs to amoCRM or Yandex
  Calendar OAuth, not to app sessions.
- **`GET /auth/me` / `PATCH /auth/me`** — no generic profile route. The only `/me` routes
  are the three narrow ones listed above (`password`, `credentials`, `timezone`).
- **Billing** — no `GET /organization/billing`; there is no billing in the product.
- **Archiving a deal** — no `DELETE /deals/:id` and no other route that sets a deal's
  status to `archived`. `DealStatus.archived` exists in the schema and is filterable on
  `GET /deals?status=archived`, but only the amoCRM sync worker ever writes it.
- **`GET /tasks/overdue`** — overdue tasks are derived client-side from `GET /tasks`.
- **Analytics `conversion-rates`, `stage-duration`, `lead-sources`, `team-activity`** —
  none exists under `/analytics` or `/reports`.
- **`POST /contacts/bulk-tag`** — no bulk tag mutation.
- **`GET /contacts/:id/messages` and `GET /contacts/:id/events`** — use
  `GET /messages/conversation/:contact_id` and `GET /calendar` respectively.
- **`GET /deals/pipelines/:id`** and **`GET /deals/pipelines/:id/stages`** — read the list
  and the stage library instead.
- **`GET /auth/users/:id`** — no single-member read; only the list.
- **`GET /attachments/:id`** — no single-attachment read; only the list.
- **`GET /messages`** — no org-wide message list; messages are read per conversation.

---

## Not specified here

This document covers the surfaces above and nothing else. `backend/api/routes/` registers
200 routes; the sections above account for almost exactly half of them. The other ~100 sit
under prefixes this file never mentions: `/api/v1/sequences`, `/api/v1/consent`,
`/api/v1/webhooks`, `/public/v1` and `/api/v1/api-keys`, `/api/v1/amocrm` and
`/api/v1/integrations/amocrm`, `/api/v1/import`, `/api/v1/captures`, `/api/v1/chat`,
`/api/v1/assistant`, `/api/v1/ai`, `/api/v1/email-templates`, `/api/v1/tracking`,
`/api/v1/updates`, `/api/v1/export`, `/api/v1/notifications`, `/api/v1/onboarding`,
`/api/v1/activities` and `/api/v1/workflows`.

`backend/api/routes/` and the registration list in `backend/index.ts` are authoritative
for what exists; `backend/api/authenticate.ts` is authoritative for what it takes to reach
it. Treat this file as a summary that can go stale, never as the contract.

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |
| `SESSION_REVOKED` | 401 | Valid JWT, but the session was revoked or expired |
| `FORBIDDEN` | 403 | Valid JWT but wrong org/role/capability |
| `NOT_FOUND` | 404 | Resource does not exist in this org |
| `CONFLICT` | 409 | Duplicate email, slug, etc. |
| `VALIDATION_ERROR` | 422 | Request body failed Zod schema |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

The shape is `{ error: { code, message } }` everywhere, but the codes above are the
generic ones. Most handlers send a per-domain code instead — `DEAL_NOT_FOUND`,
`DEAL_NOT_OPEN`, `DEAL_ALREADY_IN_STAGE`, `STAGE_NOT_FOUND`, `EMAIL_TAKEN`,
`EMAIL_ALREADY_EXISTS`, `INVALID_ROLE`, `FILE_TOO_LARGE`, `INVALID_FILE_URL`,
`SERVICE_NOT_CONFIGURED` — so match on the HTTP status first and the code second.

---

## Rate Limits

- Default: **100 requests / 60 s keyed by client IP** (not per user). Both numbers are
  overridable via `RATE_LIMIT_MAX_REQUESTS` and `RATE_LIMIT_WINDOW_MS`
  (`backend/index.ts`).
- Auth: register / login / join 5 per 15 min — login is additionally keyed by IP+email;
  `verify` 10 per 15 min; `verify/resend` 3 per 5 min; `invites/open` and `invites/lookup`
  20 per 15 min; `invites/accept` 10 per 15 min.
- Import endpoints (`/api/v1/import/*`): 3–20 requests per 10 minutes to 1 hour depending
  on the route, keyed by IP.
- Export (PDF and CSV): 5 per hour.
- Analytics and reports: **no override** — they fall under the global limit.
