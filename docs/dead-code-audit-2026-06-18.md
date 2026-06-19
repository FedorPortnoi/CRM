# CRM Dead Code Audit
*Generated 2026-06-18 — read-only analysis, no changes made*
*Coverage: 6 Codex agents + direct file analysis across all of `src/` and `backend/`*

---

## CRITICAL

### 1. MCP tools are drifting copies of controllers
All 30 tools in `backend/mcp/tools/` duplicate HTTP controller logic but have already drifted: they are missing hierarchy visibility, contact encryption/decryption, activity logs, several notifications, and safer org-scoped mutations. Calendar write tools also omit `requireMcpWrite`. The drift is silent — MCP callers get stale, less secure behavior.

Most direct copies:
- `get_contact` — MCP:80–83 vs `controllers/contacts.ts:625–628`
- `get_deal` — MCP:84–87 vs `controllers/deals.ts:290–293`
- `get_pipeline_health` — MCP:173–228 vs `controllers/deals.ts:694–753`
- `merge_contacts` — MCP:296–317 vs `controllers/contacts.ts:857–881`
- Pagination normalization copy-pasted across `mcp/contacts:35`, `deals:43`, `tasks:50`, `calendar:38`

**Fix:** Extract shared domain functions consumed by both HTTP handlers and MCP handlers. The MCP layer should call the same service functions as the controllers, not re-implement them.

---

### 2. `authenticate` preHandler copy-pasted into 15 route files
Every route file carries its own copy of the wrapper calling `request.jwtVerify()`:
`routes/auth.ts:95`, `routes/analytics.ts:28`, `routes/calendar.ts:66`, `routes/captures.ts:18`, `routes/chat.ts:6`, `routes/contacts.ts:80`, `routes/deals.ts:77`, `routes/export.ts:4`, `routes/imports.ts:6`, `routes/messages.ts:41`, `routes/notifications.ts:6`, `routes/onboarding.ts:6`, `routes/sync.ts:6`, `routes/tasks.ts:54`, `routes/workflows.ts:44`

**Fix:** Register one Fastify preHandler plugin that runs `jwtVerify()` and decorates the request. Apply per-route or per-prefix. Delete the 15 inline copies.

---

### 3. `backgroundSync.ts` invalidates wrong React Query keys
`src/utils/backgroundSync.ts:47–49` calls:
```ts
queryClient.invalidateQueries(['deals'])
queryClient.invalidateQueries(['tasks'])
queryClient.invalidateQueries(['calendar-events'])
```
The app uses `['tasks-today']` and `['tasks-all']` for tasks, and Zustand (not React Query) for deals. **Background sync silently does nothing for those entities.** The function `runSync` is also never called anywhere — so this is dead code that also contains wrong code.

**Fix:** Delete `runSync` or align query keys and wire the call from `_layout.tsx` on reconnect.

---

### 4. `REDIS_URL` validated but no Redis client exists
`backend/config/security.ts:252` validates `REDIS_URL` at startup. No Redis client, session store, or pub/sub consumer exists anywhere in the backend. The validation check runs on every boot and gives false confidence.

**Fix:** Either wire up Redis (rate limiting, session store, pub/sub) or remove the env var validation entirely.

---

## DEAD ROUTES — Backend

### Analytics — 11 routes, no frontend callers
Only `GET /api/v1/analytics/dashboard` is called. Every other analytics route is dead:

| Route | File:Line |
|---|---|
| `GET /analytics/funnel` | `routes/analytics.ts:37` |
| `GET /analytics/conversion-rates` | `:42` |
| `GET /analytics/stage-duration` | `:47` |
| `GET /analytics/lead-sources` | `:52` |
| `GET /analytics/win-loss` | `:57` |
| `GET /analytics/revenue` | `:62` |
| `GET /analytics/team-activity` | `:67` |
| `GET /analytics/rep-performance` | `:72` |
| `POST /analytics/export` | `:77` |
| `GET /analytics/export/:job_id/status` | `:82` |
| `GET /analytics/export/:job_id/download` | `:83` |

`controllers/analytics.ts:833` — `exportReport` also **reimplements all 5 live report handlers** as a second full copy of analytics logic, so these dead routes carry dead duplicates inside them.

### Pipeline management — 8 routes, all dead
The frontend only calls `GET /deals/pipelines` (list with stages included). Everything else is dead:

| Route | File:Line |
|---|---|
| `POST /deals/pipelines` | `routes/deals.ts:127` |
| `GET /deals/pipelines/:id` | `:132` |
| `PATCH /deals/pipelines/:id` | `:133` |
| `DELETE /deals/pipelines/:id` | `:134` |
| `GET /deals/pipelines/:id/stages` | `:137` |
| `POST /deals/pipelines/:id/stages` | `:139` |
| `PATCH /deals/stages/:id` | `:144` |
| `DELETE /deals/stages/:id` | `:145` |

### Contacts — 6 dead routes

| Route | File:Line | Note |
|---|---|---|
| `DELETE /contacts/:id` | `routes/contacts.ts:112` | Path used for GET/PATCH only |
| `GET /contacts/:id/messages` | `:117` | Frontend uses `/messages/conversation/:contact_id` |
| `GET /contacts/:id/events` | `:118` | No caller |
| `POST /contacts/import` | `:124` | Frontend uses `/import-csv` |
| `POST /contacts/import/phone` | `:128` | Contacts imported individually via `POST /contacts` |
| `POST /contacts/transcribe-voice` | `:136` | No caller |
| `POST /contacts/bulk-tag` | `:143` | No caller |
| `POST /contacts/:id/merge` | `:152` | No caller |

### Messages — 4 dead routes

| Route | File:Line |
|---|---|
| `GET /messages` | `routes/messages.ts:48` |
| `POST /messages` | `:53` |
| `GET /messages/:id` | `:60` |
| `POST /messages/email` | `:62` |

### Auth — 2 dead routes (duplicated by dedicated onboarding routes)

| Route | File:Line |
|---|---|
| `GET /auth/onboarding` | `routes/auth.ts:138` |
| `PATCH /auth/onboarding` | `:141` |

### Other dead routes

| Route | File:Line | Note |
|---|---|---|
| `DELETE /deals/:id` | `routes/deals.ts:122` | Path used for GET/PATCH only |
| `GET /tasks/overdue` | `routes/tasks.ts:74` | No caller |
| `POST /tasks/:id/start` | `:88` | No caller |
| `POST /deals/stale/evaluate` | `routes/deals.ts:95` | No caller |
| `GET /workflows/:id/runs` | `routes/workflows.ts:69` | No caller |
| `POST /captures/:id/create-contact` | `routes/captures.ts:51` | Frontend creates contact then calls `/:id/match` |
| `POST /onboarding/example-data` | `routes/onboarding.ts:26` | No caller |
| `DELETE /onboarding/example-data` | `:28` | No caller |
| `POST /notifications/send` | `routes/notifications.ts:17` | No caller |

*Note: `GET /calendar/sync/yandex/callback` and `POST /calendar/webhooks/yandex` have no mobile caller but are external OAuth/webhook endpoints — do not remove without checking Yandex calendar integration status.*

---

## DEAD SCREENS — Frontend

| Screen file | Status | Evidence |
|---|---|---|
| `src/app/register.tsx` | **DEAD** | Only reachable from `VerifyOtpScreen` which is itself dead |
| `src/app/verify-otp.tsx` | **DEAD** | `userStore.register` (its only state producer) is never called; screen redirects to `/register` on direct open |
| `src/app/join-company.tsx` | **DEAD** | No `router.push`, `Link href`, or stack registration pointing here |
| `src/app/contacts/import.tsx` | **DEAD** | Registered in `_layout.tsx:156` but never navigated to from any UI |
| `src/app/contact/[id]/messages.tsx` | **DEAD** | No navigation reference in all of `src/`; backend route also dead |
| `src/app/set-password.tsx` | alive | `join-company.tsx:23`, `index.tsx:58`, `LoginScreen.tsx:58` |
| `src/app/language-select.tsx` | alive | `settings.tsx:292`, `index.tsx:38` |
| `src/app/onboarding.tsx` | alive | `_layout.tsx:59`, `join-company.tsx:25`, `index.tsx:62`, `LoginScreen.tsx:61` |
| `src/app/import/telegram.tsx` | alive | `import-hub.tsx:23` |
| `src/app/import/whatsapp.tsx` | alive | `import-hub.tsx:31` |
| `src/app/chat/new-dm.tsx` | alive | `chat.tsx:50` |
| `src/app/settings/team.tsx` | alive | `settings.tsx:245` |

---

## DEAD FUNCTIONS & ACTIONS

### Frontend

| Symbol | File:Line | Reason |
|---|---|---|
| `useNetworkStatus` | `src/utils/network.ts:28` | Exported but never imported anywhere; file is side-effect-only imported in `_layout.tsx` |
| `captureError` | `src/utils/sentry.ts:41` | Exported, never called |
| `runSync` | `src/utils/backgroundSync.ts:76` | Exported, never called (also contains wrong query keys — see Critical §3) |
| `dequeue` | `src/utils/offlineQueue.ts:169` | Exported, never called |
| `clear` | `src/utils/offlineQueue.ts:349` | Exported, never called |
| `changeAppLanguage` | `src/i18n/index.ts:25` | Exported; callers duplicate `setStoredLanguage + initI18n` directly instead |
| `AppLanguage` type | `src/i18n/storage.ts:21` | Exported type alias, never imported |
| `register` action | `src/store/userStore.ts:31,121` | Registration moved to web; action never consumed by any screen |
| `disconnect` | `src/store/chatStore.ts:36,75` | Never called on logout or anywhere |
| `clearChannel` | `src/store/chatStore.ts:41,163` | Never called |
| `setOffline` | `src/store/syncStore.ts:16,26` | Never called; entire offline UI branch unreachable as a result |

### Backend

| Symbol | File:Line | Reason |
|---|---|---|
| `_extractVoiceFields()` | `controllers/contacts.ts:432` | Superseded by `extractSpeechFields()`, never called |
| `broadcastMessageIfAvailable()` | `controllers/messages.ts:63` | Exported, never called |
| `dmChannel()` | `controllers/chat.ts:41` | Exported, no caller anywhere in backend |
| `getMarketProfile()` | `backend/config/market.ts:51` | Never called; only `DEFAULT_MARKET_PROFILE.currency` is read by consumers |

### Unnecessarily exported (internal-only, should be private)
`email.ts:19` — `getFromEmail` · `verification.ts:6` — `generateOtp` · `storage.ts:21` — `getPublicUrl` · `storage.ts:27` — `buildKey` · `encryption.ts:4` — `ENCRYPTED_FIELD_PREFIX`

---

## DEAD STATE / FIELDS

| Symbol | File:Line | Reason |
|---|---|---|
| `connected` | `src/store/chatStore.ts:32,50` | Written, never selected/read by any component |
| `hydrated` | `src/store/taskScopeStore.ts:11,25` | Written, never read |
| `snapshot` | `src/store/dealsStore.ts:165` | Captured for optimistic rollback, never used for actual rollback |
| `dismissed_tooltips` | `src/store/onboardingStore.ts:6` | Backend state modeled, never read |
| `example_data_loaded` | `src/store/onboardingStore.ts:7` | Backend state modeled, never read |
| Offline UI branch | `src/components/SyncStatusBar.tsx:12,24` | Reachable only when `setOffline` is called, which never happens |
| Android call-log branch | `src/utils/callCapture.ts:120–138` | Does no real work; `lastCheck` voided only to suppress lint |

---

## DUPLICATE PATTERNS

### Backend

| Pattern | Locations |
|---|---|
| `contactBelongsToOrg()` Prisma query | `controllers/calendar.ts:80`, `deals.ts:84`, `messages.ts:54`, `tasks.ts:58` |
| `userBelongsToOrg()` Prisma query | `controllers/contacts.ts:212`, `deals.ts:111`, `tasks.ts:50` |
| `dealBelongsToOrg()` Prisma query | `controllers/calendar.ts:88`, `tasks.ts:67` |
| Paginated `findMany + count` in `Promise.all` | `activities`, `attachments`, `contacts`, `deals`, `tasks`, `messages`, `calendar`, `notifications` (8 controllers) |
| `updateMany` → check count → `findFirst` conditional | `contacts:673`, `tasks:343/405/476/521`, `calendar:534/584/630/673`, `deals:791` |
| Analytics visibility/assignee ternary | `analytics.ts:132`, `:217`, `:421`, `:458` |
| Analytics report calculations duplicated inside `exportReport` | funnel, revenue, team activity, win/loss, lead sources — all implemented twice |
| Password-strength schema verbatim copy | `routes/auth.ts:8–12`, `:48–52`, `:56–60` |
| Header extraction | `services/audit.ts:47`, `services/sessions.ts:27` |
| SHA-256 string hashing | `services/sessions.ts:31`, `services/verification.ts:10` |
| Auth/session validation | `api/authenticate.ts:123`, `mcp/validation.ts:28` |
| Viewer write restriction | `api/authenticate.ts:196`, `mcp/validation.ts:118` |
| Session revocation updates (differ only by selector) | `services/sessions.ts:116`, `:133` |
| Bitrix24 pagination + success/failure loop | `services/importBitrix24.ts:63`, `:118` |
| Push-token lookup, send, clear-invalid | `services/notificationEngine.ts:261`, `services/scheduler.ts:41` |
| Contact-ID resolution in workflow actions | `services/workflows.ts:273`, `:296` |
| URL parsing + private-host rejection | `config/security.ts:157`, `:197` |
| Sequential per-contact import with counters and swallowed errors | `controllers/imports.ts:38–56`, `:106–125`, `:143–162` |
| Two separate onboarding APIs (drifted state formats) | `controllers/auth.ts:485–514`, `controllers/onboarding.ts:31–96` |
| Contact import row transformation near-identical | `controllers/contacts.ts:922`, `:943` |

### Frontend

| Pattern | Locations |
|---|---|
| `SecureStore.getItemAsync('crm_auth_token')` token lookup | `chatStore`, `dealsStore`, `pipelinesStore`, `userStore`, `backgroundSync`, `offlineQueue` (6 files) — should go through shared API util |
| WebSocket connection logic | `src/store/chatStore.ts`, `src/utils/websocket.ts` |
| Create mutation flow (validate → sendOrQueue → success route → error parse → finally) | `contact/new.tsx:87`, `deal/new.tsx:110`, `task/new.tsx:175`, `calendar/new.tsx:134` |
| Edit PATCH/send-or-queue/error flow | `contact/edit/[id].tsx:132`, `deal/edit/[id].tsx:253`, `task/edit/[id].tsx:287`, `calendar/edit/[id].tsx:322` |
| Contact lookup debounce/fetch/reset | `deal/new.tsx:84`, `task/new.tsx:91`, `deal/edit/[id].tsx:214`, `task/edit/[id].tsx:258`, `calendar/edit/[id].tsx:268` |
| Audit-log fetch pattern | `contact/[id].tsx:145`, `deal/[id].tsx:143`, `task/[id].tsx:180` |
| Onboarding completion logic | `userStore.ts`, `onboardingStore.ts`, `app/onboarding.tsx`, `components/OnboardingWalkthrough.tsx` |
| Date/day calculations | `screens/KanbanBoard.tsx`, `(tabs)/tasks.tsx`, `(tabs)/index.tsx`, `(tabs)/notifications.tsx`, `chat/[channel].tsx` |
| Bottom-sheet/modal structure | `components/CreateSheet.tsx`, `components/MoreSheet.tsx` |
| **Import screens** | `import/vcard.tsx` and `import/whatsapp.tsx` share ~80% structure (Phase type, state shape, `pickFile`, `toggle`, `doImport`, loading/done/error renders, full StyleSheet). All 4 import screens have identical `container/center/btn/btnText/error/doneEmoji/doneTitle` style blocks. `vcard` and `whatsapp` are merge candidates (parameterize parser + file type MIME). |

---

## COMPLEXITY

| File | Issue | Suggested fix |
|---|---|---|
| `controllers/contacts.ts` | **1,178-line controller** mixing CRUD, visibility, encryption, CSV import, OCR, speech recognition, bulk ops, timeline construction | Split into contact CRUD, import, recognition, and bulk-operation services |
| `controllers/analytics.ts:833` | `exportReport` reimplements all 5 live report handlers — full second copy of analytics logic | Extract report-data functions; let HTTP handlers choose JSON/CSV/PDF serialization from shared logic |
| `controllers/calendar.ts` | 990-line file mixes CRUD with full Yandex OAuth / token refresh / CalDAV / webhook implementation | Extract `CalendarSyncService` |
| `controllers/analytics.ts:690` | `conversionRates` runs one deal query per pipeline (N+1) | Fetch all matching deals once, group by `pipeline_id` in memory |
| `controllers/auth.ts:752` | Manager-cycle detection: one query per hierarchy level (N+1) | Recursive SQL CTE or load full org edge set once |
| `controllers/auth.ts:177` | Registration uses a large raw-SQL CTE for org, owner, pipeline, stages | Replace with Prisma interactive transaction unless latency measurements justify the CTE |
| `services/scheduler.ts:152` | 5 near-identical candidate query → N+1 context/user query blocks | Use a notification-spec table with batched/joined queries |
| `services/notificationEngine.ts:268` | Re-fetches each recipient even though `UserSnap` already loads `push_token` at :322 | Carry the token through or bulk-load recipients |
| `services/importBitrix24.ts:46` | Mixes API pagination, field mapping, persistence, counters, placeholder creation in one function | Extract a reusable paginator; use batch transactions |
| `services/storage.ts:6` | Constructs new `S3Client` on every storage operation | Cache one module-level client |
| `services/visibility.ts:69` | Wrapper-only function around `getVisibleUserIds(requester, 'subtree')` | Inline the call at the two callsites or delete wrapper |
| `services/workflows.ts:166` | Unnecessary `return await` conditional; lines 273–300 duplicate contact-ID resolution | Extract one contact-ID helper |
| `api/authenticate.ts:21` | Route paths hard-coded separately from route registration | Use route metadata / preHandler policies |
| `backend/index.ts:196` | SIGTERM and SIGINT shutdown handlers duplicated | Consolidate into one handler |
| `src/components/AttachmentsSection.tsx` | Manual `useState/useEffect/fetch` server state — React Query already used everywhere else | Migrate to React Query query + mutations |
| `src/store/chatStore.ts` | WebSocket not disconnected on logout; duplicates `useOrgWebSocket` | Consolidate connection management; call `disconnect` on logout |
| `src/store/notificationStore.ts` | Bypasses shared `API_URL`; falls back to `localhost` | Use shared API client |
| `src/screens/LoginScreen.tsx` | Hardcoded Russian strings bypass i18n; forgot-password `Pressable` has no `onPress` | Wire i18n keys; implement or remove forgot-password button |
| `src/screens/RegisterScreen.tsx` | Wraps a web-link-only screen in `KeyboardAvoidingView` — no inputs exist | Remove `KeyboardAvoidingView` wrapper |
| `src/components/ContactCard.tsx` | Hardcoded Russian pluralization in `getRuDealsLabel` | Move to i18n pluralization |
| `src/i18n/index.ts` | `_layout.tsx` forces `initI18n('ru')` before stored language is loaded; callers bypass `changeAppLanguage` | Consolidate into one language-initialization path |

---

## DEAD IMPORTS

### Frontend — `React` default import unused (JSX transform handles it)
Remove from all of:
`src/app/contact/[id].tsx`, `contact/edit/[id].tsx`, `contact/scan-card.tsx`, `contact/import-csv.tsx`, `contact/[id]/messages.tsx`, `contacts/import.tsx`, `deal/[id].tsx`, `deal/edit/[id].tsx`, `task/[id].tsx`, `task/edit/[id].tsx`, `calendar/CalendarScreen.tsx`, `calendar/[id].tsx`, `calendar/edit/[id].tsx`, `calendar/new.tsx`, `import/telegram.tsx`, `import/vcard.tsx`, `import/whatsapp.tsx`, `import/bitrix24.tsx`

### Other unused imports
- `src/app/contact/[id].tsx:2` — `Modal`, `TextInput` imported from `react-native`, never used
- `backend/api/controllers/imports.ts:3` — `TgContact` imported, never referenced
- `routes/messages.ts:32` — `MessageFilterSchema` exported but only consumed in the same file

---

## DEAD CONFIG / ENV VARS

| Var / field | Location | Status |
|---|---|---|
| `REDIS_URL` | `backend/config/security.ts:252` | Validated at startup; no Redis client exists anywhere in the backend |
| `EXPO_PUBLIC_API_URL` | `backend/config/security.ts:256` | Validated; never consumed by any backend service or controller |
| `YANDEX_DB_SSL_CA` | `backend/services/db.ts:13` | Read; triggers a log warning only — not wired into Prisma or database TLS config, operationally inert |
| All fields in `DEFAULT_MARKET_PROFILE` except `currency` | `backend/config/market.ts` | `getMarketProfile()` never called; only `.currency` is read by any consumer |

---

## DEAD I18N KEYS

The following keys exist in **both** `src/i18n/locales/en.ts` and `ru.ts` but are never referenced via `t('key')` anywhere in `src/`:

**`auth.*`** — `login`, `register`, `name`, `orgName`, `loginButton`, `registerButton`, `noAccount`, `hasAccount`, `logout`, `welcomeBack`, `getStarted`, `alreadyHaveAccount`, `needAccount`, `fieldRequired`, `emailInvalid`, `passwordRequirements`, `newHereCreate`, `joinCompany`, `signUpOnWebsite`, `createAccountTitle`, `createAccountSubtext`, `createAccountButton`, `phone`, `phoneInvalid`

**`tabs.*`** — `dashboard`, `messages`, `deals`

**`contacts.*`** — `save`, `edit`, `delete`, `merge`, `mobile`, `tags`, `assignedTo`, `type`, `messages`, `telegram`, `maxMessenger`

**`deals.*`** — `title`, `value`, `status`, `closeDate`, `probability`, `noDeals`

**`tasks.*`** — `title`, `complete`, `start`, `cancel`, `description`, `priority`, `status`, `recurrenceCustom`

**`calendar.*`** — `eventTitle`, `startTime`, `endTime`, `sync`, `edit`, `start`, `end`, `location`, `today`

**`dashboard.*`** — `title`, `todayTasks`, `pipelineHealth`, `recentActivity`, `recentContacts`, `score`, `revenue`, `pipeline`, `upcomingEvents`, `monthlyPlanNotSet`

**`captures.*`** — `phone`, `type`, `pendingReview`, `searchContact`

**`messages.*`** — `title`, `send`, `sendSms`, `call`, `noMessages`, `typeMessage`

**`messaging.*`** — `title`, `sms`, `inApp`, `call`, `message`, `send`, `conversation`

**`settings.*`** — `english`, `russian`, `notificationsComingSoon`, `sync`

**`common.*`** — `menu`, `delete`, `search`, `error`, `yes`, `no`, `confirm`, `update`, `empty`, `selectLanguage`

**`errors.*`** — `notFound`, `failedToLoadContacts`

**`workflows.*`** — `actions`, `actions_plural`, `step`, `stepOf`

### Inverse — keys referenced in code but missing from both locale files
These produce blank strings at runtime: `auth.joinTitle`, `auth.joinSubtitle`, `auth.tempPassword`, `errors.unknown`

---

## Summary

| Category | Count |
|---|---|
| Dead backend routes | 35+ |
| Dead frontend screens | 5 confirmed |
| Dead exported functions / actions | 14+ |
| Dead state fields / store actions | 8 |
| Dead i18n keys | ~60+ |
| Missing i18n keys (blank at runtime) | 4 |
| Major duplicate patterns | 30+ |
| Complexity hotspots | 20 |
| Dead imports | 20+ files |
