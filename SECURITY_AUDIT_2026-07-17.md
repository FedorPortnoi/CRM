# Security Audit — CRM (Fastify + Prisma + React Native)

**Date:** 2026-07-17 (completed 2026-07-18)
**Method:** Multi-agent white-box audit — one auditor per dimension, grounded in the
[Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills)
playbooks (mapped to OWASP API/Web Top 10). Every finding was **adversarially verified** against the
real code by an independent skeptic agent (default-reject). Headline findings were then
**hand-verified** by me against the source.

> ## STATUS: COMPLETE — 12/12 dimensions
> Two rounds (a session usage limit interrupted the first). 42 agents, ~2.9M tokens. The
> `dependency-supply-chain` agent failed both times, so that dimension was covered manually via
> `npm audit` + provenance analysis. **2 issues were fixed and verified during this session**
> (SSRF, PII-at-rest — see below); on the final re-run against the fixed code both correctly no
> longer appear.

---

## Result at a glance

- **30 raw findings → 21 confirmed, 4 needs-context, 5 rejected** by adversarial verification.
- The 21 confirmed collapse to **18 unique issues** (several were found by multiple dimensions).

| Severity | Count | Issues |
|---|---|---|
| 🔴 High | 5 | stale-role privilege retention · register rate-limit no-op · plaintext mobile cache · deal-transition BOLA · sync/delta full-tenant read |
| 🟠 Medium | 6 | join brute-force · password-change doesn't revoke · trustProxy spoof · DUMMY_HASH enumeration · S3 cross-tenant delete · stale-eval leak |
| 🟡 Low | 7 | register enumeration · contact-children cone gaps · import BFLA · stored phishing URL · import rate limits · PDF export DoS · deal-assign cone |
| ⚙️ Deployment-dependent | 2 | upload MIME/XSS · unsigned public download URLs (both hinge on bucket ACL) |
| 📦 Dependency | 1 | `ws` WebSocket DoS (runtime) |
| ✅ Fixed this session | 2 | Bitrix24 SSRF · contact-import plaintext PII |

**Zero SQL/ORM injection** (clean, thoroughly traced). **Zero exploitable mass-assignment** (zod strips unknown keys).

### Coverage
AuthN/JWT ✅6 · Multi-tenant AuthZ ✅4 · SQL injection ✅clean · Input/mass-assignment ✅1(+1 rejected) ·
Secrets/crypto ✅1 · SSRF/webhooks ✅(SEC-1 fixed) · File-upload/S3 ✅4 · Rate-limit/DoS ✅6 ·
CORS/headers ✅(1 rejected) · Mobile ✅2 · Dependencies ✅manual · Business-logic ✅4

---

## Remediation — all 18 issues fixed & verified (2026-07-18)

Fixed with five forked agents on **disjoint file sets** (Sol/`gpt-5.6-sol` for the two hardest bundles,
Opus for mid, Sonnet for config-level), then gated by me: **backend + frontend `tsc` exit 0**,
**63/63 backend unit tests**, the H1 auth-bypass risk **hand-verified safe**, and the attachment
upload happy-path confirmed non-regressed.

| ID | Fix | By |
|---|---|---|
| H1 | Removed redundant route-level `authenticate`; global hook is the sole auth+role source (verified every de-hooked route stays authenticated & non-public); `changeUserRole` revokes the target's sessions | Sol |
| H2 | Register/join rate-limit keyed on IP only; login keeps IP+email | Sol |
| H3 | React Query cache: `shouldDehydrateQuery` drops token-bearing/sensitive queries, `maxAge` 24h, `allowBackup=false` (JWT was already in SecureStore) | Opus |
| H4 | Deal move/won/lost now cone-checked (404 outside cone) | Sol |
| H5 | `sync/delta` subtree-filtered on all 4 entities + `since` clamp + `take:1000` | Sol |
| M1 | Shared, concurrency-safe login/join lockout | Sol |
| M2 | Password change now requires + verifies current password and revokes all sessions | Sol |
| M3 | `trustProxy` env-gated (default off) + per-code OTP attempt cap (5, atomic) | Sonnet + Sol |
| M4 | Valid module-load bcrypt `DUMMY_HASH` | Sol |
| M5/L4 | Attachment `file_url` bound to the org's own bucket key on create + delete (`deriveOrgScopedKey`) | Opus |
| M6 | Stale-eval scoped to caller's cone | Sol |
| L2 | Contact-children + `/activities` cone-gated via `getContactForUser`/subtree filter | Sol |
| L3 | `/api/v1/import/*` now owner/admin only | Sol |
| L5 | Per-route rate limits on all import endpoints | Sonnet |
| L6 | Rate limits on PDF export routes | Sonnet |
| L7 | Deal assignment cone-checked | Sol |
| NC1 | Upload MIME allowlist (excludes html/svg/js) + `Content-Disposition: attachment` | Opus |
| D1 | `ws` bumped to 8.21.1 via scoped override (runtime advisory cleared) | orchestrator |

**Intentional behavior changes:** (a) members can no longer self-import contacts via `/import/*` (now
admin-only, per L3); (b) the persisted mobile cache no longer serves most cold-start reads (offline
still works via the mutation queue + `sync/delta` refetch); (c) a prod deployment behind a proxy MUST
set `TRUSTED_PROXY` so rate limits key on the real client IP (else all requests share the proxy IP).

**Follow-ups (non-blocking):** NC2 — presigned-GET download authz from a private bucket (marked with a
`SECURITY TODO` in `storage.ts`); strip the JWT from React Query keys in the `(tabs)`/`settings` query
definitions (deeper anti-pattern); the dev-tooling npm advisories (`shell-quote`, `hono`, `vite`,
`tar`, …) are not shipped — clear opportunistically, not worth `npm audit fix --force`.

## Three cross-cutting themes

The individual findings cluster around three systemic root causes — fix the root, close many findings:

1. **The manager "visibility cone" is enforced inconsistently.** Primary single-record reads
   (`getContactForUser`/`getDealForUser`/`getTaskForUser`) correctly 404 records outside a member's
   org-chart subtree, but several endpoints org-scope *only* and skip the cone: `GET /sync/delta`
   (H5), deal state-transitions (H4), `POST /deals/stale/evaluate` (M6), contact-children reads and
   `/activities` (L2), deal assignment (L7). Net effect: a low-privilege member can read/alter data
   the UI hides from them. **Root fix: route these through the same `getVisibleUserIds`/`ownerVisibilityWhere` guard the list endpoints use.**

2. **Role/session lifecycle is stale-friendly.** A redundant re-verify clobbers the DB-refreshed
   role (H1); role demotion and password change don't revoke sessions (H1/M2); a 7-day JWT means a
   demoted admin or a stolen token stays powerful for a week. **Root fix: single source of truth for
   role (drop the redundant route-level `authenticate`) + `revokeAllUserSessions` on demotion/password-change.**

3. **Rate limiting is keyed/trusted wrong.** `trustProxy: true` makes `request.ip` client-spoofable
   (M3), and the auth limiter keys on `ip:email` where email is attacker-chosen and unique (H2) —
   together they neuter brute-force, OTP, and SMS-cost protections. **Root fix: pin `trustProxy` to
   the real proxy CIDR; key identity-creating endpoints on IP alone + per-target-phone.**

---

## Already fixed & verified this session

- **[HIGH] SSRF via Bitrix24 `webhook_url`** — `bx24Get` now enforces an https + Bitrix24-portal
  allowlist, rejects private/reserved IP literals, disables redirects, and times out. (9-test guard suite green.)
- **[MEDIUM] Contact-import plaintext PII** — all four importers now `encryptField()` phone/email at rest.

---

## High

### H1 · Stale role: redundant preHandler keeps demoted admins privileged (BFLA)
`backend/api/routes/auth.ts:111` (+ `authenticate.ts:174`, `preHandlers.ts:4`) · API5:2023
The global hook re-reads the live role from the DB (`request.user.role = activeUser.role`), but every
user-management route *also* declares `preHandler: [authenticate]`, which runs **after** the global
hook and calls `request.jwtVerify()` a second time — `@fastify/jwt` reassigns `request.user` to the
**stale token role**. Controllers (`inviteUser`, `deactivateUser`, `changeUserRole`, `setUserManager`,
`getCompanyCode`, `rotateCompanyCode`, `listUsers`) then authorize on that stale role. No session is
revoked on demotion. **Exploit:** owner demotes a rogue admin → for up to 7 days the demoted user can
still invite/deactivate users, reassign managers, and read/rotate the org join code. (Deactivation is
caught by the `is_active` filter; demotion is not.) **Fix:** drop the redundant route-level
`authenticate`; call `revokeAllUserSessions` inside `changeUserRole`.

### H2 · Registration rate limiter is a no-op → unauth SMS flood / mass-org / cost DoS
`backend/api/routes/auth.ts:82` · API4:2023
The limiter key is `${request.ip}:${email}`; for register, email is attacker-chosen and unique per
account, so every attempt gets a fresh bucket and the 5/15min cap never trips. Register is
unauthenticated and sends an OTP **SMS** + creates a full org/user/pipeline. **Exploit:** loop
`POST /auth` with `a+1@…`, `a+2@…` and `phone:+<victim>` → ~100 SMS/min to a victim + unbounded org
creation. **Fix:** key register/join on `request.ip` alone; add per-target-phone SMS throttle.

### H3 · Entire React Query cache (JWT + join code + customer DB) persisted in plaintext
`src/utils/queryClient.ts:19` · M9:2024 Insecure Data Storage
`createAsyncStoragePersister` writes every query's data to plain `AsyncStorage` (`crm-query-cache`)
with no `shouldDehydrate` filter, no maxAge, no encryption. That includes the live bearer token, the
org join code, and the whole cached contact/deal database. `allowBackup` isn't disabled. **Exploit:**
`adb backup`, a stolen/seized device, or an unencrypted iCloud/iTunes backup yields the plaintext store
→ full account + tenant data compromise. **Fix:** encrypt the persisted blob with a key held in
`expo-secure-store`, or exclude sensitive queries from dehydration; set `android:allowBackup=false`.

### H4 · Deal state-transitions bypass the visibility cone (BOLA)
`backend/api/controllers/deals.ts:201` (moveStage / markWon / markLost) · API1:2023
These load the deal with `findFirst({ where:{ id, organization_id }})` — org scope only — then mutate
it, skipping the `canSeeUser` cone that `getDealForUser`/`updateDealForUser` enforce. **Exploit:** a
member harvests deal IDs (via H5 or M6) and flips any rival team's open deal to won/lost or moves its
stage. **Fix:** apply `getAccessibleUserIds` + `canSeeUser(deal.assigned_to/created_by)` (404 otherwise).

### H5 · GET /sync/delta returns the whole tenant, no cone filter (BOLA)
`backend/api/controllers/sync.ts:20` · API1:2023
Delta-sync filters by `organization_id` + `updated_at` only — no visibility filter, no pagination.
**Exploit:** `GET /sync/delta?since=1970-01-01T00:00:00Z` returns every contact/deal (with values &
owners)/task/event in the org to any member — a full intra-tenant breach, and the seed for H4's deal
IDs. Also an unbounded-response DoS. **Fix:** add `ownerVisibilityWhere(getVisibleUserIds(...))` per
collection; clamp `since` and paginate with a row cap.

## Medium

### M1 · /auth/join lacks the account lockout that /login enforces → brute force
`backend/api/controllers/auth.ts:570` · API2:2023 — `join()` re-implements credential checking but
never increments `failed_login_count`/sets `locked_until`, so accounts never lock; only the spoofable
per-IP limit throttles. An insider with the company code can brute-force any username's password.
**Fix:** share one lockout helper between `login()` and `join()`.

### M2 · Password change doesn't revoke sessions and needs no current password
`backend/api/controllers/auth.ts:817` · API2:2023 — `changePassword` updates the hash but never calls
`revokeAllUserSessions` and never verifies the current password. A stolen 7-day token stays valid
after the victim "changes their password to lock the intruder out." **Fix:** revoke sessions on change;
require + verify current password.

### M3 · trustProxy:true → X-Forwarded-For spoofing bypasses all IP rate limits
`backend/index.ts:93` · API2/API4 — `request.ip` becomes the leftmost client-supplied XFF entry, so a
rotating `X-Forwarded-For` gives a fresh rate-limit bucket per request, defeating login/verify/global
limits (and, with no per-user OTP attempt cap, enables 6-digit OTP brute-force). **Fix:** set
`trustProxy` to the concrete proxy CIDR/hop-count; add a per-`user_id` OTP attempt counter in `verifyCode`.

### M4 · Malformed DUMMY_HASH defeats bcrypt timing protection → email enumeration
`backend/api/controllers/auth.ts:24` · CWE-208 — the dummy hash is **61 chars** (valid bcrypt = 60), so
`bcryptjs.compare` short-circuits without doing work for absent users. Login/join for a non-existent
email returns in a few ms vs ~290ms for a real one → reliable account enumeration despite identical 401
bodies. **Fix:** `DUMMY_HASH = bcrypt.hashSync('placeholder', saltRounds)` at module load.

### M5 · S3 delete key derived from client file_url → cross-tenant object deletion (BOLA)
`backend/api/controllers/attachments.ts:191` · API1:2023 — `createAttachment` stores `body.file_url`
verbatim (only an SSRF/public-host check), unbound to the presigned key issued to this org;
`deleteAttachment` string-slices that URL into an S3 key and calls `deleteFile` with no org-prefix check.
**Exploit:** create an attachment pointing at `…/uploads/<ORG_B>/…/contract.pdf`, then delete it → wipes
another tenant's object. **Fix:** store the server-issued key column and delete by that; reject keys not
under `uploads/${org_id}/`.

### M6 · POST /deals/stale/evaluate leaks all org deals + fires workflows org-wide
`backend/api/controllers/deals.ts:103` · API1:2023 — `findMany` scoped by org+status+age only, returns
full deal objects to any member and calls `evaluateWorkflows(deal_stale)` on each. `?threshold_days=0`
returns every open deal. **Fix:** scope with the cone; gate the workflow side-effect to admin/owner.

## Low
- **L1 · Register 409 → email enumeration** (`auth.ts:272`) — duplicate email returns 409 vs 201; probe which emails are customers. *(The login not-verified 403 half was rejected — needs a correct password.)*
- **L2 · Contact-children & /activities ignore the cone** (`contacts.ts` getDeals/getTasks/getActivity, `deals.ts:103`) — read out-of-cone deal values/history via a contact_id.
- **L3 · Bulk importers not owner/admin-gated** (`routes/imports.ts:39`) — `/import/vcard|whatsapp|bitrix24` bypass the owner/admin rule applied to `/contacts/import-csv`.
- **L4 · createAttachment stores arbitrary file_url** (`attachments.ts:35`) — stored phishing/malware link + fabricated metadata on shared entities (teammate taps → `Linking.openURL`).
- **L5 · /import/* have no per-route rate limit** (`routes/imports.ts:15`) — Telegram `send-code` SMS spam; 5000 serial inserts/request.
- **L6 · PDF export has no cost bound** (`export.ts:51`) — synchronous full-org pdfkit render blocks the event loop; repeat = CPU DoS.
- **L7 · Deal assignment not cone-checked** (`deal-domain.ts:205`) — `assigned_to` validated only by `userBelongsToOrg` (tasks use `canSeeUser`); assign/dump deals onto out-of-cone users.

## Deployment-dependent (hinge on the S3 bucket ACL)
- **NC1 · No upload MIME allowlist / no Content-Disposition** (`storage.ts:48`) — `mime_type` is
  `z.string().min(1)`; an uploaded `text/html` with `<script>` renders inline **if the bucket is
  public-read** → stored XSS. **Fix:** server-side MIME allowlist + `Content-Disposition: attachment` + `nosniff`.
- **NC2 · Attachments served via unsigned, non-expiring public URLs** (`storage.ts:19`) — no presigned
  GET, no download authz; **if an operator makes the bucket public-read** to "make downloads work,"
  every document is world-readable by URL. **Fix:** private bucket + short-TTL presigned GET or an
  authenticated org-scoped proxy route.

## Dependency (manual — `npm audit` + provenance)
`npm audit` reports 1 critical / 5 high, but provenance shows almost all are build/test/CLI tooling or a
wrong-framework transitive. **The one runtime-real issue: `ws` (HIGH)** via `@fastify/websocket` →
WebSocket memory-exhaustion DoS on the chat server. **Fix:** bump `@fastify/websocket`/`ws`. The
"critical" `shell-quote` (react-native/Metro), `hono`, `vite`/`esbuild` (vitest), `tar`/`js-yaml`
(expo CLI) are **not shipped**; `npm audit fix` clears the easy transitives.

## Adversarially rejected (checked, dismissed — for transparency)
- OTP no per-user attempt limit — folded into M3 remediation (per-IP + OTP expiry; add per-user counter).
- Mass-assignment via body spread — **non-exploitable**: `fastify-type-provider-zod` strips unknown keys.
- `GET /activities` unbounded `take` — verifier rejected (bounded in practice); low-value.
- CORS reflects any Origin when `NODE_ENV!=='production'` — no prod exploit (guarded by env).
- `notificationStore` cleartext `http://localhost` fallback — `EXPO_PUBLIC_*` is inlined at build; eas.json sets real URLs.

---

## Prioritized remediation roadmap
**P0 (this week):** H1 (drop redundant `authenticate` + revoke-on-demote) · H4 + H5 + M6 (apply the
cone to sync/delta, deal transitions, stale-eval) · H2 (re-key register limiter) · H3 (encrypt/limit
the mobile cache, `allowBackup=false`).
**P1:** M3 (`trustProxy` CIDR + OTP counter) · M2 (revoke on password change) · M5 (bind delete to
issued key) · M1 (join lockout) · M4 (fix DUMMY_HASH) · `ws` bump.
**P2:** the Low cluster (cone on contact-children/assignment, import BFLA + rate limits, PDF cost bound,
attachment URL binding) · NC1/NC2 (confirm bucket is private + presigned GET + MIME allowlist).

## Verification notes
Headline findings hand-verified against source: `sync.ts:20` (org-only, no cone/pagination) ·
`routes/auth.ts:110-125` (route-level `authenticate` on every user-mgmt route) · `authenticate.ts:174`
(DB-role refresh) · `routes/auth.ts:82-86` (`ip:email` key) · `auth.ts:24` (61-char DUMMY_HASH) ·
`deals.ts:201` (org-only `findFirst`). Every spot-check matched the agent findings exactly.

To re-run after fixes: `Workflow({scriptPath: "…/crm-security-audit-wf_e8fc65af-f09.js", resumeFromRunId: "wf_e8fc65af-f09"})`.
