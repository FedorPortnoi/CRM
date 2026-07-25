# Diagnosis + proposed fixes — 8 reported issues (2026-07-17)

Russian-market RN/Expo + Fastify/Prisma CRM. All root-causes from read-only investigation
(4 forked agents) + on-device reproduction + DB ground-truth. Fixes NOT yet applied.

---

## 0. `?????????` garbled workflow name + tasks (screenshots #4, #8) — NOT A BUG
DB stores literal `?` chars in the `Workflow.name`, its `create_task` action `title`, and the 3
workflow-generated `Task.title` rows. This is **test-data damage**: that workflow was created via a
PowerShell script whose JSON encoder mangled the Cyrillic before it reached the API. Tasks created
through the app UI store correct Russian (e.g. "Позвонить Ивану по сделке"). The app is fine.
**Action:** data cleanup only — delete the bad workflow + its 3 `?????????` tasks in the QA DB. No code change.

---

## 1. Pipeline stage/name in English (#2, #3) — REAL, backend seed
**Root cause:** `backend/api/controllers/auth.ts`, `AuthController.register`, raw-SQL CTE (~lines 180-219):
- line ~201: pipeline name literal `'Sales Pipeline'`
- line ~209: `unnest(ARRAY['Lead','Qualified','Proposal','Closed Won'])`
Only row-creation site for Pipeline/PipelineStage. No backend market-awareness exists (`src/market/profile.ts`
is frontend-only; `Org` model has no locale column). `Pipeline.name`/`PipelineStage.name` are freeform
columns rendered verbatim (`deal/[id].tsx:285,295`, `KanbanBoard.tsx:300-301`, `kanban.tsx:73`) — no enum
key to localize at render, so the fix must be at the seed. The same file already hardcodes Russian (OTP email),
so hardcoding RU here matches convention (single-market app).
**Proposed fix:**
- `'Sales Pipeline'` → `'Воронка продаж'`
- stages → `['Лид','Квалифицирован','Предложение','Сделка закрыта']`
- **Migration for existing orgs** (they keep English rows): one-off `UPDATE` scoped to exact original seed
  values (`name='Sales Pipeline' AND is_default=true`; stages matched by original name+position) so any
  org that already renamed a stage isn't clobbered. (Also covers the live QA org.)
**Open question for Codex:** best RU wording for stages? ("Квалифицирован" vs "Квалификация"; "Сделка закрыта" vs "Закрыта — выиграна"). And is a scoped UPDATE the right migration vs. leaving existing orgs alone.

## 2. Contacts search — floating ☰ + bulk-bar overlap (#5) — SPLIT: 1 non-issue + 1 REAL bug
**The floating ☰ is NOT the app.** On-device I tapped it → it opened the Android system menu (Settings /
Show keyboard shortcuts / Show clipboard / Show on-screen keyboard / Voice). It is the **Android IME
on-screen-keyboard floating button**, which the emulator shows because a HARDWARE keyboard is attached and a
text field (search) is focused. It will not appear on a normal phone with no hardware keyboard. Confirmed the
UI dump contains only package `com.fedorportnoi.crm` and no app element renders a hamburger (agent A swept the
whole codebase: no draggable-flatlist usage, no Menu/AlignJustify/Grip icons, no FAB). **No app fix needed.**

**The REAL app bug (checkboxes + bottom action bar):**
- `isSelectionMode = selectedContactIds.length > 0` (`contacts.tsx:309`) → renders the bulk action bar
  (`908-952`) and swaps each avatar for a checkbox (`ContactCard.tsx:111-114`).
- The per-card ⋮ "more" button is wired to ENTER bulk-select, not open a menu:
  `onMenuPress={() => handleLongPressContact(item.id)}` (`contacts.tsx:586`) → pushes the id into
  `selectedContactIds` (`373-383`). So tapping what looks like a context menu selects that contact and flips
  the whole screen into multi-select = "1 selected + action bar."
- Search & selection aren't mutually exclusive: `handleToggleSearch` (`340-349`) never clears
  `selectedContactIds`, so opening search with a contact already selected shows both UIs at once.
**Proposed fix:** (1) `handleToggleSearch` clears `selectedContactIds` (mirror `handleSearchChange`/`handleSelectSegment`);
(2) `contacts.tsx:586` — make ⋮ open a per-contact context menu (reuse `ActionMenuSheet`) or go to detail, not
enter bulk-select; OR if ⋮=select is intended, change the `MoreVertical` icon (`ContactCard.tsx:206`) to a select
affordance so it doesn't read as a menu.
**Open question for Codex:** should ⋮ be a context menu or a select toggle? And is clearing selection on
search-open the right UX.

## 3. Chat tab "+" opens generic create sheet (#6) — REAL
`src/components/NavHeader.tsx`: shows the "+" (→ `CreateSheet` = task/contact/deal) for any `TAB_PATHS` route,
and `/chat` is included (line ~13,31,36-45). `CreateSheet` has no chat option. The chat screen already has a
bottom bar "Общий чат" / "Написать лично" (`chat.tsx:127-136`), so the "+" is wrong AND redundant.
**Proposed fix:** in `NavHeader`, special-case `/chat`: render a spacer (no "+"), OR repoint the "+" onPress to
`router.push('/chat/new-dm')`. Leaning toward: no "+" on chat (bottom bar already covers both actions).
**Open question for Codex:** suppress vs repurpose the chat "+".

## 4. DM "Личное сообщение" empty (#7) — PARTIAL bug (missing empty-state)
`src/app/chat/new-dm.tsx` lists **org teammates** (`GET /api/v1/auth/users`), not contacts, keyed by user IDs
(`dm:<uid>:<uid>`). Fetch + endpoint verified correct. QA org has only the owner → filtered out
(`new-dm.tsx:32`) → empty. It's legitimately empty, but the `FlatList` (lines 65-71) has NO `ListEmptyComponent`,
so the user sees a blank body with no explanation = the reported symptom.
**Proposed fix:** add `ListEmptyComponent` (e.g. "Нет коллег для переписки. Пригласите участников в организацию.")
with new i18n keys; also guard `res.ok`/default `data=[]` at `new-dm.tsx:29-33` (currently can throw).
**Clarification (design):** DMs target teammates, not CRM contacts, by design (contacts have no chat identity).
Messaging contacts would be a separate feature.
**Open question for Codex:** confirm the empty-state approach; is "message a contact" worth flagging as a feature gap.

## 5. Workflow detail — middle button text clips (#8) — REAL
`src/app/workflows/[id].tsx:446-448`: 3 bottom buttons share equal `flex:1`; middle label
`t('workflows.edit')` = "Редактировать автоматизацию" (~27 chars) can't fit ~100dp → wraps/clips. Left
("Pause"/"Enable") + right ("Удалить") are short.
**Proposed fix:** bottom button (line 370) → `t('common.edit')` = "Редактировать" (shorter). Leave header edit
(line 254) as-is (has room).

## 6. Workflow detail — English strings "Pause"/"Enable" + action labels (#8) — REAL i18n
`[id].tsx:355-357` literal `'Pause' : 'Enable'`; `getActionLabel` (91-99) literal "Create task: ", "Add note: ",
"Move to stage: ". No existing keys.
**Proposed fix:** add `workflows.pause/resume` + `workflows.actionCreateTask/actionAddNote/actionMoveStage`
(interpolated) to ru.ts + en.ts; wire `t()` in the two spots.

## 7. Workflow detail — light/cream background in dark theme (#8) — REAL theming
`[id].tsx` never adopted `useTheme()` — all hardcoded hex. During theming rollout (commit 21b488a) it got a
superficial hex find/replace: `outerContainer`/`container` bg became `rgba(204,120,92,0.08)` (an 8%-opacity
skeleton tint, not an opaque dark bg). `bottomBar` (#1A1A18, correct) uses flat `padding:16` with no
`insets.bottom`, so on devices with a bottom inset it stops short and exposes the translucent wash =
light seam behind the buttons.
**Proposed fix:** convert screen to `useTheme()`/`makeStyles(colors)` (mirror `deal/[id].tsx`); make
outer/container opaque `colors.bg`; add `useSafeAreaInsets` bottom padding to `bottomBar`.

---

## Fix batching (proposed)
- **A. i18n / RU content** (low risk): pipeline seed RU names (#1) + existing-org UPDATE; workflow strings (#5,#6).
- **B. Chat UX** (#3 NavHeader + #4 empty-state) — small, `NavHeader.tsx` + `new-dm.tsx` + locales.
- **C. Contacts search ☰** (#2) — pending root cause.
- **D. Workflow theming** (#7) — the largest change (full theme conversion of `[id].tsx`).
- **E. Data cleanup** (#0) — delete bad workflow + ??? tasks.

Questions for Codex are inline above (marked "Open question for Codex").
