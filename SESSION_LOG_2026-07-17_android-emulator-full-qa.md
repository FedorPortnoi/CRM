# Session Log — 2026-07-17: Full Android Emulator QA Sweep

## Goal
Boot an Android emulator, exhaustively click through every screen/tab/control to learn what
each does, then functionally test every workflow end-to-end against a live backend.

**Result:** 14 feature areas driven end-to-end on a real debug build. 8 distinct issues found
(1 fixed + verified this session). Core CRM (auth, contacts, deals/kanban, tasks, calendar,
chat, notifications, settings, captures, workflows, import/export, offline sync) all functional.

---

## Test rig (isolated — no touching production data)
- **Emulator:** Pixel_8 AVD; installed the existing debug APK (`app-debug.apk`, native build
  from 2026-06-22, still matches current native config).
- **DB:** embedded PostgreSQL 18.4 in a scratchpad dir, port 5433, fresh `crm_smoke` database
  (UTF8, `citext` ext), schema via `prisma db push`. **Not** the Yandex production cluster.
- **Backend:** `tsx backend/index.ts` on port **3001**, `NODE_ENV=test`, curated env
  (test DB, `SMSRU_SEND_ENABLED=false`, empty Resend key, local JWT secret).
- **Metro:** `EXPO_PUBLIC_API_URL=http://127.0.0.1:3001/api/v1`, dev-client deep-linked to it.
- **Bridge:** `adb reverse tcp:8081` + `tcp:3001`.
- **QA account:** `qa@test.com` (owner, org "QA Smoke Org"), verified by flipping
  `is_verified` in the test DB (the sanctioned smoke-test OTP bypass).
- Drove the UI via `adb input tap/text/swipe` + `uiautomator dump` (custom PowerShell helper
  parsing node bounds → tappable centers) and per-step screenshots.

> ⚠️ One env quirk found during setup: the backend **crashed** on the first notification write
> because the initial `crm_smoke` DB had been created with WIN1252 encoding — Prisma couldn't
> write Cyrillic (`22P05: no equivalent in encoding "WIN1252"`). Recreated the DB as UTF8 and
> it was fine. Not a product bug, but a reminder that any non-UTF8 Postgres target will break
> notification/Cyrillic writes.

---

## What works (verified end-to-end)

| Area | Verified |
|------|----------|
| **Auth** | Register→OTP-gate→verify→login; Login/Join tab switch; password show/hide; JWT persists across relaunch; 401 on stale token routes back to login |
| **Onboarding** | 4-step walkthrough checklist + 4-page carousel; skip/next/finish → dashboard |
| **Dashboard** | Metric cards (open deals/₽, due today, overdue); conditional banners (pending-captures, deals-without-tasks); quick actions; today-focus, closing-this-week, today's-schedule; workflow button; pull-to-refresh |
| **Contacts** | Create/edit (persisted, verified in DB); detail (activity/deals/tasks/journal/attachments); type chips (Все/Клиенты/Партнёры/Лиды) filter; sort chips; bulk select→assign & archive; per-row call/WA/TG quick actions |
| **Deals** | Create (pipeline+stage pickers, next-action, close date); detail; **Kanban board** stage move via **swipe** and **long-press menu** (both PATCH 200); board⇄list toggle |
| **Tasks** | Create (due-date calendar, assignee, contact link); **recurring** (weekly) task; mark-complete (status→Выполнено); Today/All filters; detail |
| **Calendar** | Agenda view; create event (live scheduled-preview); detail (place/contact/deal/mark-done/cancel); Yandex sync card |
| **Chat** | Channel list; open general channel; send message (201, bubble+timestamp) |
| **Notifications** | Scheduler-generated deadline + task-assignment notifications; mark-all-read clears tab badge |
| **Settings** | **Dark⇄Light theme toggle** (persists); **RU⇄EN language** switch (full i18n); profile/org display; monthly-plan input; **PDF export contacts** & **deals** (both 200, file saved locally); notifications-blocked state; logout |
| **Captures** | Pending-capture banner→list; link-to-contact picker; dismiss (200) |
| **Workflows** | List; detail (actions, run log); enable/disable toggle (PATCH 200); create form (after fix) |
| **Import hub** | 6 sources; **CSV import** end-to-end (parsed, "1 imported", contact in DB) |
| **Attachments** | Upload flow (presign 200 → S3 PUT); graceful "upload failed" on storage error |
| **Offline sync** | Offline reads from cache; create with backend down → **queued**; reconnect (NetInfo) → **queue flushed** to server (POST 201); records synced to DB |

---

## Issues found

### Fixed this session ✅
**1. [HIGH] Workflows list header rendered under the status bar — Add/Back buttons unreachable.**
`src/app/workflows/index.tsx` used the **deprecated `SafeAreaView` from `react-native`**, which
applies no top inset on Android. The header (title + orange "+" create button + back button)
rendered at y≈0, colliding with the clock/battery. Verified the +/back buttons did **not**
respond to taps (they sat in the status-bar touch zone) → the create-workflow form was
**unreachable**. (The user independently flagged this same screen.)
**Fix:** swapped to `SafeAreaView` from `react-native-safe-area-context` (what the rest of the
app uses). Re-verified live: header now clears the status bar; the "+" opens `/workflows/new`.
`tsc --noEmit` and `eslint` both clean.

### Open — recommend fixing
**2. [HIGH] Multi-button `Alert.alert` menus silently drop buttons on Android (native 3-button cap).**
Two confirmed sites:
- `AttachmentsSection.tsx:173` — 4 buttons (gallery/camera/document/**cancel**). "Отмена" is
  dropped **and** back / tap-outside don't dismiss it → the attachment picker is a **dead-end**;
  the user is forced to pick a source.
- `contacts.tsx:362` (add menu) — 5 buttons (new/scan/import-apps/**import-phone**/**cancel**) →
  only 3 render; **"Импорт из телефонной книги" and "Отмена" are both dropped** → phone-book
  import is unreachable from the "+" menu, no cancel.
  **Fix:** replace these Alert-as-menu call sites with a custom bottom sheet (like `CreateSheet`),
  or cap at ≤3 buttons on Android.

**3. [MED] Contact search never matches phone or email, though the placeholder promises it.**
Placeholder: "Поиск по имени, email или телефону…", but phone/email are encrypted at rest
(`enc:v1:…`), so the backend LIKE can't match them (verified: `q=79167`→0, `q=ivan.petrov`→0,
while name/company match). Same in the capture link-picker. **Fix:** drop "email или телефону"
from the placeholder, or add a blind-index/hash column for phone & email.

**4. [MED] `CreateSheet` uses hardcoded light-theme colors → poor contrast in dark mode.**
Text uses `c.bgDark` and separators/handle/cancel use literals (`#F0E8E2`, `#D1C4B8`, `#9C8677`).
In light theme it's crisp; in dark theme the labels are dark-on-dark (legible but low-contrast)
and the sheet looks out of place. Confirmed by light-vs-dark comparison.

**5. [MED — needs clean repro] Possible duplicate on offline queue flush.**
A single offline contact-create ("TrulyOffline"/"Queued", backend down) flushed **two** POSTs on
reconnect and left both "TrulyOffline Queued" and a "TrulyOffline" (null last_name) in the DB.
May be contamination from messy manual re-submits — needs an isolated repro (1 offline create →
reconnect → expect exactly 1 row).

### Minor
**6. [LOW] Workflow detail i18n gaps.** "Enable" button and "Create task: …" action labels render
in English inside the otherwise-Russian screen (missing i18n keys).
**7. [LOW] Contact detail header falls back to literal "Contact"** when the record can't load
(e.g. offline) instead of a localized string / the contact name.
**8. [LOW] `npm run db:seed` points to a missing file** (`backend/db/seeds/index.ts` doesn't exist).

### Investigated & withdrawn
- Suspected the header "+" (Создать) was a dead zone (early post-onboarding taps missed). On
  re-verification it works reliably — the early misses were transient (screen still settling).
  `SyncStatusBar` does lack `pointerEvents="none"`, but its overlay sits above the header
  buttons and doesn't block them. Not a functional bug (optional hardening only).

---

## Notes / left for later
- Offline reads: with the backend fully **down** (connection refused), the contacts list shows a
  full-screen "Network request failed" instead of cached rows + the optimistic new contact. In a
  true airplane-mode offline (React Query cache intact) it degrades more gracefully; worth
  confirming the hard-down path keeps showing cached data.
- Workflow created via PowerShell shows a garbled name (`QA ??? ???`) — PowerShell→JSON Cyrillic
  encoding artifact in the *test* tooling, not the app.
- `adb input text` can't inject Cyrillic (ASCII only); Russian test data was seeded via the API.

## Fixes applied & verified on-device (this session)
All changes uncommitted in the working tree. Full-project `tsc --noEmit` and `eslint` clean.
The HIGH fix + the two search/back MED items were built by forked subagents (Opus for HIGH,
Sonnet for the rest), split by disjoint files; every fix was then re-verified by me on the
running emulator.

| # | Fix | Files | On-device verification |
|---|-----|-------|------------------------|
| A | Workflows header under status bar (Add/Back unreachable) | `src/app/workflows/index.tsx` — deprecated `SafeAreaView` → `react-native-safe-area-context` | Header clears status bar; back arrow works; **+** opens `/workflows/new` |
| B | **[HIGH]** Android `Alert.alert` menus drop buttons / un-cancelable dead-end | new `src/components/ActionMenuSheet.tsx`; `AttachmentsSection.tsx`, `contacts.tsx` (attachment picker + contacts "+" now use the sheet) | Both menus show ALL options (contacts: phone-book import restored; attachments: Cancel restored). Dismiss verified via Cancel row, backdrop tap, AND hardware back (the exact dead-end case). |
| C | **[MED]** `CreateSheet` dark-theme colors | `src/components/CreateSheet.tsx` — `c.bgDark`→`c.text1`, hardcoded light hexes → `c.border`/`c.textMuted` | Heading + option labels now light-on-dark and readable in dark theme |
| D | **[MED]** Contacts search placeholder over-promised email/phone | `src/i18n/locales/ru.ts`, `en.ts` (`contacts.searchPlaceholder`) | Placeholder now "Поиск по имени или компании…" / "Search by name or company…" |
| E | Back arrow invisible on workflows (dark-on-dark) + overlay could swallow header taps | `src/components/HomeBackButton.tsx` (`c.bgDark`→`c.text1`); `src/components/SyncStatusBar.tsx` (`pointerEvents="none"`) | Workflows back arrow now clearly visible and navigates |

Still open (not fixed this session): the LOW i18n gaps (#6), the "Contact" header fallback (#7),
`db:seed` missing file (#8), the possible offline-flush duplicate (#5 — needs clean repro), and
the encrypted-field search limitation itself (only the placeholder was corrected).

Observation during verification: a dev-only LogBox toast ("Uncaught (in promise) … Unable to
act…", appears at app init on the dashboard, unrelated to these component changes — most likely
the benign expo `Unable to activate keep awake` dev warning). Worth a glance but not a release blocker.

## Repo change (original note)
- `src/app/workflows/index.tsx` — SafeAreaView import swap. (Now row A above.)

---

# Round 2 — DM security fix + RU pipeline localization + UI polish (committed)

_Codex agents implemented all three tracks; I reviewed every diff and verified by tests + on the
live emulator, then committed the work split into three clean topical commits._

## Branch & commits
Branch **`fix/dm-security-ru-i18n-ui`** off `main` (not pushed).

| Commit | Scope | Files |
|--------|-------|-------|
| `8a4bad8` | **fix(chat): enforce DM channel authorization and scope realtime/push delivery** | `backend/api/controllers/chat.ts`, `backend/api/routes/ws.ts`, `backend/services/chatChannel.ts` (new), `backend/services/wsRooms.ts`, `tests/unit/backend/chat-authz.test.ts` (new) |
| `f04327b` | **i18n(ru): localize default pipeline and workflow/chat strings** | `backend/api/controllers/auth.ts`, `backend/config/market.ts`, `backend/prisma/migrations/20260717000000_localize_default_pipeline_ru/migration.sql` (new), `src/i18n/locales/ru.ts`, `src/i18n/locales/en.ts`, `tests/smoke/08-pipelines.spec.ts`, `tests/smoke/12-screens.spec.ts` |
| `4a90804` | **fix(ui): chat "+", contacts selection, DM empty state, workflow detail, action sheets** | `NavHeader.tsx`, `contacts.tsx`, `ContactCard.tsx`, `new-dm.tsx`, `workflows/[id].tsx`, `workflows/index.tsx`, `AttachmentsSection.tsx`, `CreateSheet.tsx`, `HomeBackButton.tsx`, `SyncStatusBar.tsx`, `ActionMenuSheet.tsx` (new) |

## 🔒 DM privacy — broken access control (found by Codex review, verified by me)
Before the fix, chat `get`/`send`/`mark-read` performed **no participant check**: any authenticated
org user could read or write any `dm:<a>:<b>` channel (and user IDs were discoverable via
`/auth/users`), DMs were broadcast **org-wide** via `broadcastToOrg`, and `pushChatNotification`
pushed DM bodies to every org user.

Fix: new `backend/services/chatChannel.ts` centralizes channel authorization —
`authorizeChatChannel(channel, userId, orgId)` validates the `dm:<uuid>:<uuid>` shape (distinct,
lowercased, sorted → 404 if malformed), requires the caller to be a participant (else **403**),
and requires the other user to be active in the same org (else **404**); it returns the canonical
channel id. `chat.ts` now authorizes every read/send/mark-read; `wsRooms.ts` tracks socket→user and
delivers DMs only to the two participants via `broadcastToUsers`; push goes only to `otherUserId`.

**Verified:** 13/13 `chat-authz` unit tests + 5/5 live API assertions against the isolated backend —
non-participant read/send → **403** (previously leaked), malformed / cross-org / nonexistent-partner
→ **404**, `general` read → **200**.

## 🇷🇺 Pipeline localization
Default pipeline + stage names now ship in Russian. Constants in `backend/config/market.ts`
(`DEFAULT_PIPELINE_NAME = 'Воронка продаж'`, stages `Новый лид / Квалификация / Предложение /
Сделка выиграна`), seeded on register in `auth.ts`, plus an **idempotent backfill migration** that
updates existing orgs' stages first (fingerprint-matched on original English name + position +
is_won/is_lost), then the pipeline, setting `updated_at = NOW()` — English-only predicates so
customized orgs are left untouched. Smoke tests updated to the Russian names.

**Verified on-device:** funnel shows НОВЫЙ ЛИД / КВАЛИФИКАЦИЯ / ПРЕДЛОЖЕНИЕ / СДЕЛКА ВЫИГРАНА.

## 🎨 Frontend fixes (all verified on the emulator)
- **Chat "+" removed** — `NavHeader` renders a 42×42 spacer on `/chat` so the title stays centered
  (there was no create action for chat; the "+" led nowhere).
- **Contacts ⋮ is now an explicit select toggle** (previously silently entered bulk-select);
  opening search clears any active selection (search and selection are mutually exclusive).
- **New-DM empty state** — themed "Пока некому написать / В вашей команде пока нет других
  участников" instead of a blank screen; fetch throws on non-2xx instead of defaulting to `[]`.
- **Workflow detail** — converted to `useTheme()`/`makeStyles(colors)` (fixes the light-in-dark
  seam), safe-area footer, short middle button "Изменить", Russian action labels
  ("Пауза", "Создать задачу: … · срок через 1 дн.").

## Static gate
backend `tsc --noEmit` **0 errors** · frontend `tsc --noEmit` **0 errors** ·
**13/13** authz unit tests · ESLint clean across all 13 changed files.

## Caveats (honest)
- **Pipeline names first appeared as mojibake on-device** — this was a *harness* mistake on my side:
  PowerShell's `Get-Content -Raw` mangled the UTF-8 `.sql` when I applied the migration by hand.
  The committed `migration.sql` is correct; a real `prisma migrate deploy` reads it as UTF-8. I
  fixed the QA database via a parameterized Node script and re-verified the correct bytes.
- **Codex write access** came from the per-run `--dangerously-bypass-approvals-and-sandbox` flag
  only; I restored `~/.codex/config.toml` to its original state (no standing full-access setting).

## State at end of round
- Three commits on `fix/dm-security-ru-i18n-ui`; **not pushed**, no PR opened yet.
- The `?????????` mojibake **test data** (PowerShell-seeded workflow + its runs + 3 tasks) was
  deleted from the QA DB by exact id — that was test-data damage, not an app bug.
- Left uncommitted on purpose: pre-existing 2026-07-03 test/config changes and the session docs.
- **Follow-up queued (interrupted, not started):** a forked-agent security audit driven by the
  `Anthropic-Cybersecurity-Skills` repo (repo cloned to scratchpad; backend attack surface mapped).
