# Plan Review Log: RU fixes (7 issues) — Codex adversarial review
Started 2026-07-17 session. MAX_ROUNDS=3. PLAN_FILE=PLAN_ru_fixes.md. Codex = read-only critic (gpt-5.6-sol).

## Round 1 — Codex → VERDICT: REVISE
Codex verified each root cause against code and largely confirmed them, but found material gaps.
Highest-value catch (I verified all of these in code myself):

- **CRITICAL / new — DM confidentiality (broken access control).** `backend/api/controllers/chat.ts`
  `getMessages`(:132) & `sendMessage`(:166) read `channel` from the request with NO participant check —
  any org user can read/write any `dm:<a>:<b>` channel (user IDs are exposed via `/auth/users`).
  `sendMessage`→`broadcastToOrg`(:190 → `wsRooms.ts:22`) pushes EVERY message incl. DMs to ALL org sockets;
  `pushChatNotification`(:17) push-notifies the DM body to EVERY active org user. Routes only have
  `authenticate`. DMs are effectively public within an org. Release-blocking for the DM feature.
  My agent B only checked the fetch/endpoint, not authz — cross-model review caught it.
- **My "no backend market-awareness" was wrong** — `backend/config/market.ts` exists (currently just
  `DEFAULT_CURRENCY='RUB'`; a natural home for RU pipeline defaults, though it doesn't hold them today).
- **Pipeline RU wording** — Codex's is better: pipeline "Воронка продаж"; stages "Новый лид", "Квалификация",
  "Предложение", "Сделка выиграна". ("Квалифицирован" incomplete; "Сделка закрыта" loses the "won" sense.)
- **Migration correctness** — update STAGES before the pipeline (renaming parent first can break the lookup);
  match by full seed fingerprint (name+position+won/lost); `updated_at=NOW()` (Prisma `@updatedAt` doesn't run
  for raw SQL); existing smoke tests assert the English values (`08-pipelines.spec.ts:23`, `12-screens.spec.ts:630`)
  and would fail; NOT low-risk (tenant data → backup + before/after counts + deploy ordering).
- **Contacts** — "overlap" imprecise (list already reserves the bulk-bar space, `contacts.tsx:872`); real defect is
  misleading ⋮ semantics + surprise mode switch (LOW severity). Make ⋮ an explicit select affordance (not a context
  menu — scope creep); mode transitions must be bidirectional + a complete reset, not a lone `setSelectedContactIds([])`.
- **Chat "+"** — suppress on /chat with a fixed-width spacer (a bare empty leftBtn is narrower than the icon).
- **DM empty-state** — role-gate any "invite" CTA (only owners/admins can invite, `auth.ts:488`); do NOT default a
  failed fetch to `[]` (misreports errors as "no teammates"); `email` is optional for members; theme the screen.
- **Workflow button** — `common.edit` ("Редактировать") still borderline on narrow screens; add `workflows.editShort`
  ("Изменить") or a pencil icon.
- **Workflow i18n** — incomplete: `0d` for missing deadline = false info; raw `archived` (:271), `Workflow not found`
  (:232), "Move to stage" shows a UUID; new/edit screens also show raw action types → scope or complete.
- **Workflow theming** — must also convert `SkeletonBox`, `getStatusColor`, inline run/button colors, `errorContainer`,
  separators, `RefreshControl`, both roots + footer; keep roots opaque `colors.bg`; don't blindly mirror `deal/[id].tsx`
  (its own root is also translucent); scope to workflow-DETAIL (index/new/edit stay fixed-dark).
- **Test-data cleanup unsafe as written** — workflow API archives (not hard-delete), runs restrict deletion, tasks have
  no workflow_id proving provenance → archive the workflow + cancel the 3 EXACT task IDs (not title/`?` matching).
  Also: my "good RU task was created via UI" note was wrong — it was seeded via API (adb can't type Cyrillic).

**Claude's decision (arbiter):** accept essentially all of it. The DM authz bug is the headline. Not looping to
another round — the critique is comprehensive and I agree with it; consultation goal met. Full critique text is in
the Codex job result (thread 019f729f-76a8-7ab3-9f03-4f3c76854f44).
