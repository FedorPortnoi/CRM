# 002 - Operator Names in the Model-Facing Analytics Surface

## Status

**Partially Accepted — option (b) implemented for the cross-border case on 2026-07-30; whether it
should also apply under the domestic provider is still open and still the owner's call. See the
2026-07-30 revision at the foot of this file.**

The rest of this section describes the state before that change and is kept as written, because the
options and the legal reasoning below are what the decision was made against.

**Proposed — open, and now narrowed to one tool.**

When this record was written, `get_rep_performance` was one of several places where an operator's
real name reached the language model. Since then `b6f22bf` closed the others structurally, at the
MCP boundary. `get_rep_performance` is what is left, and it is left deliberately: unlike every other
case it cannot be fixed by deleting a field, because the name *is* what the feature returns. The
choice is a product decision, so this document lays out the options and recommends one rather than
making it.

Nothing in this record has been implemented. `b6f22bf` did not choose an option below; it fenced off
everything *except* this tool, and made the exemption explicit at the registration site so the open
question is greppable from the code (`backend/mcp/tools/analytics.ts:511-525`).

`001-russia-first-market-profile.md` is a settled decision and uses `Decision / Why / Consequences`.
This one is pending, so it adds `Status`, `Options`, `Recommendation` and `Gate` around that spine.
Future pending records should follow this shape; settled ones can stay with the 001 shape.

The legal reading below is an engineering summary written to make the trade-off legible. It is not
legal advice and should be confirmed with counsel before it is relied on.

---

## Context — what the tool does today

`get_rep_performance` is one of six analytics tools registered in
`backend/mcp/tools/analytics.ts`. It answers "how is each sales rep doing" over a date range.

Registration and handler: `backend/mcp/tools/analytics.ts:447-526` — the handler body runs to
`:510`, and `:511-525` is the model-facing declaration described in the next section.

The metrics come from three `groupBy` aggregations over `Deal`, keyed on `assigned_to`
(`analytics.ts:476-480`). Those return uuids and numbers — no names. The name is fetched
separately, in one extra query:

```ts
// backend/mcp/tools/analytics.ts:485-488
const users = await db.user.findMany({
  where: { id: { in: userIds }, organization_id: orgId },
  select: { id: true, name: true },
});
```

and joined onto each row on the way out:

```ts
// backend/mcp/tools/analytics.ts:490
const userMap = new Map<string, string>(users.map((u) => [u.id, u.name]));

// backend/mcp/tools/analytics.ts:506
return [{ user_id: uid, name: userMap.get(uid) ?? 'Unknown', deals_total, deals_won,
          deals_lost, total_value, win_rate }];
```

`User.name` is a plain, non-nullable column (`backend/prisma/schema.prisma:165,171`) — it is not
one of the encrypted columns, so no decryption step is involved. In this product it holds an
operator's ФИО.

### The tool now declares its exemption rather than relying on its shape

Every MCP tool result is projected through `projectModelFacing()`
(`backend/mcp/model-projection.ts:274-276`) on its way out of `registerTool`
(`backend/mcp/server.ts:168-184`). That projection strips operator names by structure: an object
found under a User-relation key, or one carrying a User-only marker column, loses its name-shaped
keys. Neither rule reaches `{ user_id, name, win_rate }` — a flat row with no user-ish container key
and no User marker column — so `get_rep_performance` would have kept working whether or not anyone
had thought about it.

That silence was the problem, so the tool now says so out loud. Its registration passes
`{ operatorNames: 'allowed' }` (`analytics.ts:525`), typed as `ToolModelFacingOptions`
(`backend/mcp/server.ts:41-54`), with a comment pointing here. Three properties of that flag matter
for this decision:

1. **It is default-deny.** A tool that says nothing gets the projection. Relaxing it is a visible
   edit at a registration site, not an accident of the result shape.
2. **It is the only one.** A test asserts that exactly one `operatorNames: 'allowed'` declaration
   exists in `backend/mcp/tools/` and that it sits on `get_rep_performance`
   (`tests/unit/backend/mcp-operator-name-projection.test.ts`). A second one cannot be added quietly.
3. **It exempts the whole result, not just the `name` key.** `registerTool` stores the raw handler
   when the flag is set (`server.ts:175-178`). Today that makes no practical difference, because the
   rows are flat and carry nothing else a projection would touch. It would matter if this tool ever
   grew a nested user object, and whoever changes its shape should know that the projection is not
   standing behind it.

Nothing about the tool's behaviour changed in `b6f22bf`. The flag documents the status quo; it does
not create it.

### What reaches the model, exactly

One row per rep, each carrying `user_id`, `name`, `deals_total`, `deals_won`, `deals_lost`,
`total_value`, `win_rate`. The row set is bounded by the caller's visibility cone
(`analytics.ts:465,473,483,499` via `getAccessibleUserIds` / `canSeeUser` in
`backend/services/visibility.ts:69-80`): an owner or admin sees every rep in the organisation, a
member sees only themselves and their reports. So the composition is "every name inside the caller's
cone", not "every name in the database" — but for an owner asking the obvious question, those are
the same set.

The path from the tool to the provider:

1. `backend/services/assistant.ts:746` — `serializeToolResult(outcome.result)`.
2. `backend/services/assistant.ts:402-408` — that function calls `redactToolResult` and stringifies.
3. `backend/services/assistant.ts:394-396` — `redactToolResult` walks the object and masks a key when
   `REDACTED_KEYS.has(key)` **or** `keyLooksLikePii(key)` (`assistant.ts:379`).

Neither test matches `name`:

- `REDACTED_KEYS` (`assistant.ts:284-292`) is an exact-match set: `email`, `phone`, `mobile`,
  `email_bidx`, `phone_bidx`, `mobile_bidx`, `unsubscribe_token`.
- `PII_KEY_FRAGMENTS` (`assistant.ts:351`, used by `keyLooksLikePii` at `:353-356`) is
  `['email', 'phone', 'mobile', 'telephone', 'e_mail', 'tel_']`.

So the row passes through unchanged, and the same serialized string is both sent to the provider
and persisted into `AssistantMessage.content` as plain text (`assistant.ts:265-267`).

**Adding `name` to the redaction set is still not available as a fix**, and `b6f22bf` confirmed it
by building the projection somewhere else instead. `keyLooksLikePii` matches on *substring*, so a
`name` fragment would mask `pipeline_name`, `stage_name`, `from_stage_name`, `to_stage_name`,
`first_name` and `last_name` as well — including the legitimate business labels this very file
returns from `get_pipeline_health` (`analytics.ts:256,258,267`) and the ones `get_deals` selects
(`backend/mcp/tools/deals.ts:257-258`). An exact-match entry for the bare key `name` would still eat
`pipeline: { name }` and `stage: { name }` from those same tools. The redactor also sits *inside* the
assistant, so the stdio MCP transport bypasses it entirely. Both are why the projection went in at
the boundary and why the decision for this tool has to be made at the tool.

### The same numbers already have a non-model path

Worth knowing before weighing the options: the named leaderboard is **not** exclusive to the
assistant. There is a second, independent implementation that never touches a model —
`getRepPerformance` in `backend/services/reporting.ts:462`, selecting
`{ id: true, name: true, role: true }` at `:523`, exposed as `GET /api/v1/reports/reps`
(`backend/api/routes/reporting.ts:32-35` → `backend/api/controllers/reporting.ts:19-21`) and
rendered by the app's Reports screen at `src/app/reports/index.tsx:283` (`{rep.name ?? UNSET_VALUE}`).

That path is fine as it stands — it is a server rendering an operator's own organisation's data to
an authorised operator, with no third-party processor in the middle. `reporting.ts` is also not
reachable from `backend/mcp/`: nothing in the MCP directory imports it, so this implementation is
not an alternative door into the model. It matters here only because it bounds the scope of every
option below: whatever is decided about the MCP tool, the product keeps a named rep leaderboard.

### There is a per-tool result declaration, but still no per-tool availability gate

These are two different mechanisms and the difference decides how expensive option (a) is.

What now exists is a declaration about a tool's **result** — `ToolModelFacingOptions` at
`backend/mcp/server.ts:41-54`, consumed by `registerTool` at `:175-178`. It shapes what comes back;
it does not decide whether the model is offered the tool at all.

What still does not exist is a gate on **availability**. `buildToolDefinitions`
(`backend/services/assistant.ts:565-578`) offers the model everything `listMcpTools()` returns, and
`listMcpTools` (`backend/mcp/server.ts:228-235`) returns the whole registry, populated by
unconditional module imports in `loadMcpTools` (`backend/mcp/server.ts:191-203`). The same registry
also backs the stdio MCP transport (`startMcp`, `backend/mcp/server.ts:205-209`). So "just turn this
tool off for the model" is still not a config flag that exists — but it is now a smaller feature than
it was when this record was written, because `registerTool` already takes an options bag and that is
the natural place to hang it. It would still need to distinguish the two transports if the tool
should stay available over stdio.

---

## Why this is different from the cases already fixed

Five instances of the same underlying issue have now been looked at. Four are closed. This one is
not, and the reason is worth stating precisely, because it is the whole basis of the decision.

| | `ea2572f` — assistant system prompt | `c456e0f` — contact-ai summary | `cb88ba9` — `merge_contacts` | `b6f22bf` — `get_contact` / `get_task` / `get_overdue_tasks` | **this one — `get_rep_performance`** |
|---|---|---|---|---|---|
| What carried the name | org name + operator ФИО in the system prompt | «Ответственный менеджер: ФИО» in the summary prompt | `include: { assignee: { select: { name } } }` | the same shared `include`, read by the app *and* by three MCP tools | `select: { name: true }`, returned as `name` per rep |
| What the name was for | nothing — the model answers in the second person | nothing — the prompt asks about the *relationship* | nothing — no consumer read it | the **app** reads it; the model does not | **the answer itself** |
| Fix | replaced with a one-way handle | deleted | deleted | cut at the MCP boundary, plus deleted at source where only the model read it | *not obvious — hence this record* |

In the first three closed cases the name was **passenger data**: it rode along in a payload that was
about something else, and removing it cost nothing because nothing downstream read it. `c456e0f`
could delete the field outright; `cb88ba9` could drop the whole `include` because
`Contact.assigned_to` already carried the uuid the model chains on; `ea2572f` could substitute an
opaque handle because the system prompt's identities are things the model *refers to*, never things
it *reports*.

`b6f22bf` is the interesting middle case and is described in its own section below: the name was
passenger data *for the model* and payload *for the app*, from the same query, so it could not be
deleted and could not be kept.

Here the name is the **payload** on every path. A user asking «кто лучший менеджер в этом месяце» is
asking for a name. A row of `{user_id: "…", win_rate: 62}` does not answer that question, and an
answer reading «лучший результат у USER-1a2b3c» is worse than no answer — it is a technical token
surfaced inside user-facing Russian prose. That is precisely the trap `c456e0f` avoided by deleting
rather than substituting: a handle only works where something downstream turns it back into meaning,
and in `contact-ai.ts` nothing did.

The difference here — and it is the crux of option (b) below — is that in the assistant there *is*
something downstream. The response is composed by the backend before the user sees it, so unlike
`contact-ai.ts` there is a place to put a substitution pass. Whether that pass is trustworthy is
the question option (b) has to answer honestly.

---

## The shared-service reads — closed at the boundary, not at the source

An earlier draft of this record deferred these to "their own record". `b6f22bf` settled them, and
they belong here rather than in a separate document, because the mechanism it chose is the same
mechanism that now surrounds `get_rep_performance` and defines what that tool is an exception *to*.

### What it was

`assignee: { select: { id: true, name: true } }` in two shared domain functions, each feeding both a
human surface and a model surface from one query:

- `getContactForUser` (`backend/services/contact-domain.ts:204`, include at `:223`) — behind
  `GET /contacts/:id` for the app (`backend/api/controllers/contacts.ts:355` →
  `src/app/contact/[id].tsx`, which types `assignee: Assignee | null`), behind
  `GET /v1/contacts/:id` for external API-key integrators
  (`backend/api/controllers/public-api.ts:209`), and behind MCP `get_contact`
  (`backend/mcp/tools/contacts.ts:64`).
- `getTaskForUser` (`backend/services/task-domain.ts:172`, include at `:197-200`) — behind
  `GET /tasks/:id` (`src/app/task/[id].tsx` renders `task.assignee.name`;
  `src/app/task/edit/[id].tsx` seeds its assignee picker from `assignee.id` + `assignee.name`),
  behind `GET /v1/tasks/:id` (`public-api.ts:384`), and behind MCP `get_task`
  (`backend/mcp/tools/tasks.ts:88`).

A third, `getOverdueTasksForUser` (`backend/services/task-domain.ts:513`), had the same include but
only one caller in the repository — MCP `get_overdue_tasks` (`backend/mcp/tools/tasks.ts:222`). No
REST route, no public-API route, no app screen.

### Why deleting the select was not available for the first two

`c456e0f` and `cb88ba9` could delete, because nothing else read the field. Here something does. The
same include is the app's data. Deleting it fixes the prompt and breaks two screens and a
third-party API response.

Adding the name to `redactToolResult` was not available either, for the substring reason set out
above, and because that function lives inside the assistant while the stdio transport is equally
model-facing.

### What was done instead

The cut was made where the two audiences diverge — the MCP boundary. `projectModelFacing()`
(`backend/mcp/model-projection.ts`) is applied by `registerTool` (`backend/mcp/server.ts:175-178`),
which is the only way into the tool registry and therefore covers both model transports from one
place: the stdio `CallToolRequestSchema` handler and the in-process `invokeMcpTool` the assistant
uses. REST controllers never pass through it, so the app and the public API keep their names.

It decides structurally rather than textually — it does not ask whether a string looks like a name,
it asks whether the object holding it is a user:

- **Container key.** An object reached under a User-relation key loses every name-shaped key.
  `USER_RELATION_KEYS` (`model-projection.ts:119-134`) is the set of User-typed fields in
  `backend/prisma/schema.prisma`, and a test re-derives that set from the schema file and fails when
  a new relation appears, so the list cannot silently rot.
- **Row shape.** An object carrying a User-only column — `username`, `password_hash`, `push_token`,
  … (`model-projection.ts:196-204`) — is a user row wherever it sits.

Ids always survive: `assignee.id`, `assigned_to` and `user_id` are uuids, the model chains tool calls
on them, and stripping them would break the agent loop for no minimisation gain. The name is deleted
rather than masked, because the id beside it already states that an operator is attached.

`getOverdueTasksForUser` was additionally fixed at source — the assignee include is gone
(`task-domain.ts:528-530` now selects only the contact). Its only consumer is the model, so the ФИО
had no reason to leave Postgres at all; that is the `c456e0f` / `cb88ba9` move, available there
precisely because nothing renders those rows to a human. The projection still backstops it.

### What is still load-bearing, and what has to stay true

The two shared includes remain in the source. That is deliberate and it is not a residual defect —
the app and the public API are entitled to the name — but it does mean the minimisation for the
model path is enforced by a seam rather than by absence. Three things have to keep holding:

1. **The projection stays the only door into the registry.** `tools[]` is module-private and
   `registerTool` is the only way in, which is why the wrap sits there rather than at the two
   dispatch sites. A future tool cannot opt out by forgetting something.
2. **The projection runs where the model reads and nowhere the app reads.** An earlier draft of this
   item stated the rule as «nothing outside `backend/mcp/` imports `model-projection`, and a test
   asserts this». Both halves are now false. `backend/services/assistant.ts:26` imports the module
   directly — deliberately, and the reason is written at the import (`:7-25`) — and the guard in
   `tests/unit/backend/task-contact-assignee-name-app-path.test.ts:222-251` carries an `ALLOWED`
   allowlist (`:220`) holding exactly that one path, so it still passes.

   The invariant that survived is narrower, and it is the one that was load-bearing all along: a
   function the **app** reads from must not run the projection. Inside `assistant.ts` the split is
   by function, not by module. `historyToAiMessages()` (`:512-559`) projects — through
   `parseStoredToolCalls` (`:487`) and `redactStoredToolContent` (`:438`) — and its one consumer is
   the prompt (`:663`). `getAssistantConversation()` (`:889`), which backs the transcript the app
   renders, returns its rows untouched. `tests/unit/backend/assistant-history-operator-name.test.ts`
   pins both directions independently: `:291` asserts a replayed ФИО does not reach the provider,
   `:301-323` asserts the same ФИО is still in the conversation the app reads.

   What must keep holding is that the allowlist stays at one entry. A REST controller or a shared
   service that starts running the projection takes the name away from the app, which is the
   over-correction the guard exists to catch.
3. **Both directions stay pinned.** `tests/unit/backend/mcp-operator-name-projection.test.ts`
   asserts the model cannot get the name; `tests/unit/backend/task-contact-assignee-name-app-path.test.ts`
   asserts the app still can, and that the domain functions still ask Postgres for it. They fail
   independently, which is the point: an over-correction that deletes the include is caught by the
   second file, and a regression that removes the projection is caught by the first.

Recorded as a decision, not as an open item: **no further work is required on these three paths
before Wave A**, provided the three conditions above still hold when the gate below is checked.

---

## Legal position

Stated narrowly, in the order the duties actually apply.

**Whose data.** An operator's ФИО. Under the repository's own privacy policy
(`docs/privacy_policy.md §4.2.1`) ФИО is the first listed category of personal data processed for
app users, and `§4.2.2` records that for user data the Operator acts as an **independent
controller** (самостоятельный оператор) — not as a processor acting on a client organisation's
instruction, which is the basis `§3.2` uses for *customer* data. So this is a category where the
Operator carries the duties directly and cannot point at a client's instruction.

**Today the provider is domestic.** `backend/services/yandex-gpt.ts` is the only model client in the
backend, and its endpoint is `https://llm.api.cloud.yandex.net/foundationModels/v1/completion`
(`yandex-gpt.ts:18-19`) — Yandex Cloud, a Russian legal entity, infrastructure in Russia. Its
`createCompletion` seam has exactly two consumers — `backend/services/assistant.ts:28` and
`backend/services/contact-ai.ts:87` — and no other provider SDK, hostname or API-key environment
variable appears anywhere under `backend/`.

It had three until `608f924`, which removed the third: the tasks `suggest-contact` endpoint used to
put up to 300 customers' full names (`SUGGEST_CONTACT_LIMIT`, `tasks.ts:254`) into a prompt on every
call, and now matches the task title against a local Prisma read with no provider in the path at all
(`resolveSuggestedContact`, `backend/api/controllers/tasks.ts:277-301`, calling `matchContactByName`
from `backend/services/contact-name-match.ts`). That file still imports `isYandexGptConfigured`
(`tasks.ts:4`) — it is the switch operators already use to keep the AI surfaces off, and the comment
at `:281-285` says so — but no longer imports `createCompletion`, which
`tests/unit/backend/tasks-suggest-contact.test.ts:293-295` pins. Worth naming here because it is the
same question this record is about, answered the (d) way on a route where the client-side cost that
makes (d) expensive for `get_rep_performance` did not exist.

**Therefore ст. 12 does not apply today.** Трансграничная передача is defined in п. 11 ст. 3 ФЗ-152
as transfer to a foreign state / foreign person. A transfer to a domestic processor is not one, and
`docs/privacy_policy.md §8.8` already says exactly that about Yandex Cloud. **This is not a
cross-border transfer today and should not be described as one.** More than one note in this
codebase has got that wrong; the correction is deliberate and it is not a softening — see the next
paragraph for the duty that does bite.

**What does apply today** is the minimisation duty of **ч. 5 ст. 5 ФЗ-152** — the composition of
processed data must be adequate and not excessive for the stated purpose — together with the
requirement of a lawful basis and purpose (ч. 1, 2 ст. 5; ст. 6) and the processor-instruction
requirements of ч. 3 ст. 6 for engaging a processor at all. Two concrete observations:

- Minimisation is a genuine question, not a formality. The names are sent so the model can put them
  back in a sentence. If they can be reinserted after the model instead of before it, the transfer
  of names to the processor is by definition not necessary — and a duty to avoid excess bites
  hardest exactly where the excess is avoidable. `b6f22bf` is now the in-repository demonstration
  that the excess *was* avoidable on every other model-facing path.
- The policy's processor register (`docs/privacy_policy.md §14.2`) and cross-border table (`§8.7`)
  list Yandex Cloud, Resend, FCM, Expo and Sentry. **Neither table mentions a language model
  provider of any kind** — not YandexGPT, not OpenAI. The register is behind the code regardless of
  which option is chosen below.

**ст. 12 begins to apply at Wave A, with no change to this file.** Wave A repoints
`backend/services/yandex-gpt.ts` at OpenAI through `workers/openai-proxy/`
(`workers/openai-proxy/README.md`). `analytics.ts` calls no provider directly — it returns data, and
`assistant.ts` sends it — so the moment that seam moves, every name in this payload becomes a
transfer to a US recipient. The US is not on the Roskomnadzor adequacy list, so the ч. 4 ст. 12
route applies: notification of intent, receipt of the recipient's assurances, and the 30-day
waiting period, all as `docs/privacy_policy.md §8.5-8.6` already sets out for the existing US
recipients. That filing is still outstanding.

Two secondary points about Wave A, both neutral facts rather than objections:

- The proxy runs on Cloudflare, so the request transits a second foreign entity before OpenAI. Both
  belong in the transfer description, not just OpenAI.
- ФЗ-242 / ч. 5 ст. 18 localisation is a separate duty from ст. 12 and is unaffected by any option
  here: it constrains where the *database* lives, and the database stays in Russia. Sending a copy
  abroad afterwards is governed by ст. 12, as `§8.1` notes.

**The product is deployed; this surface is not yet.** An earlier draft of this record said «nothing
is deployed — there is no production database and no live service». That was wrong, and the
repository contradicts it in three places: the `production`, `rustore` and `huawei` EAS profiles all
point the app at `https://4kub.ru/api/v1` and `wss://4kub.ru` (`eas.json`);
`validateProductionConfig` (`backend/config/security.ts:423-435`) refuses to boot under
`NODE_ENV=production` without a remote `DATABASE_URL` — `postgresql:`/`postgres:`, password present,
private and local hosts rejected (`:404-412`) — alongside `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`YANDEX_WEBHOOK_SECRET` and a CORS allowlist; and `PROJECT_KNOWLEDGE.md` names that database as
Yandex Cloud Managed PostgreSQL (`ru-central1`) and records 1.0.4 live in the App Store with 1.0.5
submitted. There is a production database — this record's author has queried it.

Whether there is a live *service* was left open on 2026-07-28 with two candidate readings —
a released app pointing at a dead backend, or aspirational release claims. **Measurement on
2026-07-29 settled it, and neither reading was right. There is a live service.**

The 2026-07-28 text above is retained deliberately, because one of its own premises was
false: `111.88.149.122` is **not** «an address outside every Yandex Cloud range this
project uses». RIPE RDAP returns `RU-YANDEXCLOUD-20090612`, Yandex.Cloud LLC,
`111.88.144.0/20`. It was this project's own VM — its *ephemeral* one-to-one NAT address,
released back to the pool when the instance was stopped. The account now holds
`51.250.26.203`, reserved static since 2026-07-28 20:38 UTC, while DNS at reg.ru still
pointed `4kub.ru` at the address the project had lost. The refused TCP was a stale A
record, nothing more.

Behind that record the service was running the whole time: `pm2 crm-backend` online, nginx
with `sites-enabled/4kub.ru`, a valid Let's Encrypt certificate for the domain, and the
backend on `:3000`. Verified end-to-end on 2026-07-29 with `curl --resolve` against the
current address — `https://4kub.ru/version` → 200 with a valid chain, and
`POST /api/v1/auth/login` → 200. The App Store listing is real and live (`ascAppId
6776447873`, v1.1.3, 2026-07-19).

**So the ФЗ-152 questions are live, not theoretical.** A shipped application and a running
production backend both exist. What does *not* exist is this surface: see below.

One caution carries forward. Deployed code lagged `origin/main` by 38 commits until
2026-07-29 — the box was serving pre-security-audit code from 20 June. Do not assume the
running service matches the tree; check `git rev-parse HEAD` on the VM before reasoning
from source about what production does.

What is true is narrower, and it is about this surface rather than about the system: the assistant
and its MCP tool layer landed in `d0e0fef` on 2026-07-25, six days after 1.0.5 went to Apple, so
neither the live 1.0.4 nor the submitted 1.0.5 ships the chat screen that reaches them, and
day-to-day development runs against a local PostgreSQL with test data. Whether the production
backend has been redeployed since is not something this repository records.

None of the reasoning above rests on either fact. **ст. 12 does not apply today because the
processor is domestic**, not because the service is idle, and the ч. 5 ст. 5 minimisation duty
attaches to the composition of processed data whether or not anyone has typed into the chat yet. The
correction cuts against comfort rather than for it: this is worth settling before the surface
reaches the live service, and the live service is already standing there waiting for it.

---

## Options

### (a) Drop the tool from the model-facing set

Remove `get_rep_performance` from what the assistant is offered — either by unregistering it or by
adding a model-facing allowlist.

- **Effect.** No operator name ever reaches the model from this path. Permanent, and survives Wave A
  untouched.
- **Product cost.** «Кто лучший менеджер» becomes unanswerable in chat. Real but bounded: the
  Reports screen (`src/app/reports/index.tsx`) still shows the named leaderboard, so the capability
  moves rather than disappears. The honest framing is a *conversational* regression, not a feature
  deletion — the brief that prompted this record described it as breaking the feature, which
  overstates it.
- **Engineering cost.** Smaller than when this record was first written, because `registerTool` now
  takes a `ToolModelFacingOptions` bag (`backend/mcp/server.ts:41-54`) and an availability flag is a
  natural second field on it. Still a small feature rather than a config change: `listMcpTools`
  returns the whole registry today, and unregistering the tool outright would also remove it from
  the stdio MCP transport, which may not be intended. The flag form is the cleaner one and is useful
  independently — it is the mechanism any future "this tool is not for the model" decision needs.
- **Ancillary.** `tests/unit/backend/mcp-analytics-cone.test.ts:384-399` exercises the tool and pins
  `name: 'Outsider'` at `:390`; that test needs updating under this option and under (d). Under
  every option that stops the tool emitting names, the `{ operatorNames: 'allowed' }` declaration at
  `analytics.ts:525` should be deleted so the tool falls back to the default-deny projection, and
  the one-declaration test then asserts that no exemption exists at all.

### (b) Return handles from the tool, substitute names back server-side

The tool emits `USER-<hex>` handles in place of names, using the existing
`identityHandle('user', id)` (`backend/services/assistant.ts:185-187`). The model composes prose
referring to handles. Before the answer is returned, a server-side pass rewrites each handle back
to the real name from a table built for that request.

**Is re-substitution actually tractable? Mostly yes — and this is where the earlier framing needs
correcting.**

This was initially filed alongside the reversible token vault that was rejected on 2026-07-27, and
the two are not the same problem. The vault was an **inbound** matcher: it held `Иванов` and had to
recognise `Иванова`, `Иванову`, `Ивановым` in free user input. Russian inflection made it
unreliable, and — decisively — its failure mode was **fail-open**: a missed match meant an
unmasked name went out. The comment at `assistant.ts:161-166` records that reasoning, and it
remains correct for that direction.

Handle→name substitution runs the other way:

- The token is **server-generated and machine-shaped**, not a human name. `USER-[0-9a-f]{12}` is
  matched by a strict case-insensitive regex; there is no morphology to defeat.
- It **fails closed**. If the model mangles a handle, splits it, or invents one that is not in the
  table, the substitution simply does not fire and the user sees a raw token. That is an ugly
  answer, never a leaked name. The vault's failure produced the opposite.
- **No streaming complication.** `yandex-gpt.ts:432` sends `stream: false`, so the pass runs once
  over a complete string with no chunk-boundary risk. If streaming is ever added, this cost returns.
- The table is **small and rebuildable** — the reps in the current cone — and `identityHandle` is
  deterministic, so a handle stays stable across turns and conversations.

The genuine costs, none of which are safety costs:

1. **Russian declension.** The model will write «у USER-1a2b3c лучший результат» or «результат
   USER-1a2b3c». Substituting a nominative ФИО yields grammatically wrong prose («результат Иван
   Иванов» instead of «Иванова»). Fixable only with a morphology library or by constraining the
   model to a fixed frame; otherwise accept slightly stilted output.
2. **Prompt rules conflict.** Rule 6 (`assistant.ts:220`) currently instructs the model *not* to
   show `ORG-…` / `USER-…` handles. Under this option it must show them for this tool's output and
   hide them elsewhere — a more delicate instruction, and instructions are not guarantees.
3. **Persistence.** `AssistantMessage.content` stores the turn. A decision is needed on whether the
   stored copy holds handles (substitute at render, requiring the pass on every history read) or
   names (simpler, but the stored copy then differs from what the provider saw).
4. **Attribution errors.** A model can attach the wrong handle to the wrong number. It can do that
   with names too, so this is not a regression — but a substituted handle *looks* authoritative.

- **Effect.** The name never enters the prompt. Same legal property as (a) and (d) — under ч. 5
  ст. 5 today and under ст. 12 after Wave A, names are simply not in the transferred composition.
- **Engineering cost.** Moderate, and entirely backend. No client change, no app-store release.
- **Interaction with the projection.** Once the tool emits handles instead of names, the
  `{ operatorNames: 'allowed' }` declaration should be removed so the tool rejoins default-deny.
  Handles are opaque strings under a `name` key, and the projection's rules do not touch them, so
  nothing breaks — but the tool would no longer be an exception to anything, which is the point.

### (c) Accept the exposure and cover it in the Roskomnadzor filing

Leave the tool as it is, add the model provider to `docs/privacy_policy.md §8.7` and `§14.2`, and
name operator ФИО in the composition of transferred data in the ч. 3/4 ст. 12 notification.

- **Effect.** Legally coherent — this is what the filing mechanism is for, and the policy already
  documents this exact route for four US recipients.
- **Cost.** It converts a solvable engineering question into a permanent disclosure obligation over
  a category the Operator controls directly. It also sits awkwardly with `§8.12`, which commits the
  Operator to assessing adequacy and non-excess before each cross-border transfer and to
  pseudonymising *where technically possible* — and options (a), (b) and (d) are all existence
  proofs that it is technically possible here, as is `b6f22bf` on the adjacent paths. Choosing (c)
  means asserting that a named conversational leaderboard is worth a transfer that the Operator's
  own policy says should be avoided when avoidable. That is a defensible commercial judgement, but
  it should be made knowingly.
- **Note.** The register work in (c) is required under *every* option, because no model provider is
  listed today. What is optional is the part that names operator ФИО in the transferred composition.

### (d) Ids to the model, names resolved on the client

The tool returns `user_id` + metrics only. The model refers to reps by ordinal («первый по
выручке») or by id, and the app renders a small structured leaderboard alongside the prose,
resolving ids to names locally from data it already holds.

- **Effect.** Strongest and most durable: names never leave Postgres on this path at all, matching
  the structural approach `c456e0f`, `cb88ba9` and (for `get_overdue_tasks`) `b6f22bf` took. No
  substitution pass to trust, no prompt rule to balance.
- **Cost.** The largest, and it lands on the slowest surface. `AssistantToolCall`
  (`src/utils/assistantTools.ts:18-24`) carries `round`, `name`, `arguments`, `ok`, `error` and
  deliberately **no result payload**, so the assistant response contract would have to start
  carrying structured tool results to the client, plus a new render component and i18n. That is a
  mobile app release through the stores, not a backend deploy.
- Also produces stiffer prose: a model told to avoid names writes more awkwardly than one given a
  substitution frame.

### (e) Considered and rejected: mask inside `redactToolResult`

Covered above — `keyLooksLikePii` is a substring test, so any `name` rule would mask
`pipeline_name`, `stage_name` and `first_name`/`last_name` across every other tool, and the redactor
sits inside the assistant where the stdio transport does not reach it. `b6f22bf` faced the same
question for the shared-service reads and answered it by building `projectModelFacing` at the MCP
boundary instead. Recorded here so it is not re-proposed.

### (f) Considered and rejected: let the projection catch it by shape

Now that `projectModelFacing` exists, the tempting move is to widen it until
`{ user_id, name, win_rate }` is caught too — for instance by treating any object with a `user_id`
key as a user row. Rejected, and it should stay rejected:

- It would silently delete the answer to «кто лучший менеджер» rather than deciding anything. The
  product question in this record would still be open; it would just have an undocumented default.
- The rule is not safely generalisable. `user_id` appears next to unrelated labels in other results,
  and a shape-based rule wide enough to catch this row is wide enough to catch rows where `name` is
  a pipeline, a stage or a company.
- The projection's value is that its two rules are narrow and structural. Widening it to cover a
  case it was explicitly documented as *not* covering (`model-projection.ts:94-103`) trades that for
  a heuristic.

The declaration at `analytics.ts:525` exists precisely so this stays a decision rather than a
tuning exercise.

---

## Recommendation

**Recommended: option (b) — return handles from `get_rep_performance` and substitute names back
server-side before the answer reaches the user — scoped to this one tool, with option (a) held as
the fallback if Wave A arrives before (b) is built.**

The reasoning, in the order it decided the question:

1. **(c) should not be the standing answer, and that is the load-bearing judgement here.** Every
   other option removes the names from the transfer entirely, which means the transfer under (c) is
   avoidable by construction. `docs/privacy_policy.md §8.12` commits the Operator to pseudonymising
   before cross-border transfer *where technically possible*, and options (a), (b) and (d) are three
   separate proofs that it is technically possible in this case — with `b6f22bf` a fourth, already
   shipped on the adjacent paths. Choosing (c) would mean filing for a transfer of operator ФИО — a
   category where `§4.2.2` makes the Operator an independent controller — in order to preserve a
   phrasing convenience in one chat answer. That trade is available, and it is the owner's to make,
   but it is a poor one on the merits.

2. **(b) buys the same legal property as (a) and (d) without giving up the feature.** After (b), the
   composition sent to the provider contains uuids, numbers and opaque handles. Under ч. 5 ст. 5
   today that is a clean minimisation story; after Wave A repoints the seam at OpenAI, it is the
   difference between filing "operator ФИО crosses the border" and filing "identifiers and
   aggregates cross the border." And the user still gets «Лучший результат у <ФИО>», which is what
   they asked for. Nothing about the answer degrades except its grammar.

3. **The objection that killed the token vault does not transfer, and I want to be explicit that
   this corrects the framing I was given.** The vault failed because inbound matching against
   inflected Russian surnames fails open — it holds `Иванов`, the user types `Иванова`, and an
   unmasked name gets through. Handle→name substitution runs the opposite direction over a
   server-generated `USER-[0-9a-f]{12}` token: a strict regex, no morphology, and a failure mode of
   showing an ugly token rather than leaking a name. `yandex-gpt.ts:432` sets `stream: false`, so
   the pass is one rewrite over a finished string. This is a materially easier problem than the one
   that was rejected, and it should not inherit that rejection by association.

4. **(d) is strictly better and should still not be chosen first.** It is the right end state — the
   name never leaves the database, which is the same structural move `c456e0f` and `cb88ba9` made
   and that `b6f22bf` repeated for `get_overdue_tasks`, and structural beats procedural every time.
   But its cost lands on the client: the assistant response contract does not carry tool result
   payloads today (`src/utils/assistantTools.ts:18-24`), so it needs a contract change, a new
   component, i18n, and an app-store release cycle. (b) is backend-only and can ship in an
   afternoon. If the client is being changed for other reasons anyway, promote (d) — and note that
   (b) is a strict subset of the work, not wasted effort, since both require the tool to stop
   emitting names.

5. **(a) is the correct emergency answer, not the correct answer.** If Wave A is ready before (b) is
   built, dropping the tool from the model-facing set is the right call for that window: it is
   cheap, it is certain, and the Reports screen means the product keeps a named leaderboard
   regardless. It is listed as the gate's fallback below for exactly that reason. As a permanent
   choice it gives up a capability that (b) shows is retainable.

6. **Do the register work regardless.** `docs/privacy_policy.md §14.2` and `§8.7` list no language
   model provider at all, while `backend/services/assistant.ts` has been sending CRM data to one.
   That gap is independent of this decision and is not fixed by any option above, nor by `b6f22bf`.
   It should be closed on its own schedule, not bundled into this choice.

**What this recommendation still does not decide.** Whether the *contact's* own name should reach
the model at all is untouched here; `backend/services/contact-ai.ts` sends it deliberately and that
is a separate, already-made decision. The projection at the MCP boundary leaves `first_name` /
`last_name` alone wherever they are not inside a user container, for the same reason.

---

## Gate — what must be true before Wave A ships

Wave A repoints `backend/services/yandex-gpt.ts` at OpenAI through `workers/openai-proxy/`. From
that moment `get_rep_performance` output crosses the border with **no change to
`backend/mcp/tools/analytics.ts`**. All of the following must hold before that repoint lands:

1. **This record is resolved** — an option is chosen, `Status` is updated to Accepted, and the
   chosen option is either implemented or explicitly deferred with (a) applied in the interim.
2. **No operator ФИО is in the model-facing composition**, unless (c) was chosen knowingly and the
   filing in item 5 names that category explicitly.
3. **The MCP boundary projection is still in place and still the only door.** Specifically:
   `registerTool` still wraps every handler in `projectModelFacing`
   (`backend/mcp/server.ts:175-178`); `tests/unit/backend/mcp-operator-name-projection.test.ts`,
   `tests/unit/backend/task-contact-assignee-name-app-path.test.ts` and
   `tests/unit/backend/assistant-history-operator-name.test.ts` all pass; the `ALLOWED` allowlist in
   the second of those files still holds exactly one entry, `backend/services/assistant.ts` (see the
   shared-service section — a second entry means the projection has reached a surface the app reads);
   and the count of `operatorNames: 'allowed'` declarations under `backend/mcp/tools/` is still
   exactly one — zero if an option above removed it. This item covers the paths `b6f22bf` closed and
   is the reason they need no further work; it fails loudly if that stops being true.
4. **A regression test pins whatever is chosen for this tool.** In the shape of
   `tests/unit/backend/mcp-merge-contacts-pii.test.ts` and the two files in item 3 — a distinctive
   fixture ФИО, absent from the rest of the repository, asserted absent from the serialized tool
   result. `tests/unit/backend/mcp-analytics-cone.test.ts:390` currently pins the *presence* of the
   name and will need updating in the same change.
5. **The Roskomnadzor notification of intent (ч. 3, 4 ст. 12 ФЗ-152) is filed and the 30-day period
   under ч. 4 ст. 12 has elapsed**, with the model provider and the Cloudflare transit hop both
   described, and the composition of transferred data stated accurately for whichever option was
   chosen.
6. **`docs/privacy_policy.md` is updated** — the model provider added to the `§14.2` processor
   register and to the `§8.7` cross-border table, with the `§8.12` adequacy-and-non-excess
   assessment recorded for this transfer.
7. **The masking condition attached to the Wave A exception is met** — names masked before they
   cross — and this tool is confirmed to be inside the set that condition covers, not an
   unexamined exception to it. The `{ operatorNames: 'allowed' }` declaration is the one place that
   exception is currently visible, so checking this item starts by grepping for it.

Items 5 and 6 are required for Wave A irrespective of this decision; items 1, 2, 3, 4 and 7 are what
this record adds.

---

## Consequences of leaving this open

Recorded so that "no decision yet" is a visible state rather than an invisible one:

- Today the composition goes to a domestic processor, so nothing is urgent — this is a ч. 5 ст. 5
  minimisation question, not a ст. 12 one.
- It is now the **only** model-facing path in the repository that carries an operator ФИО. Before
  `b6f22bf` it was one of several and could be read as part of a pattern; it is now a single
  documented exception, which is a better place to be but also removes any excuse for forgetting it.
- The transition is silent. No code in `analytics.ts` changes when the provider does, so there is no
  diff to review at the moment the legal character of the composition changes. That is exactly why
  the gate above is written as a precondition on Wave A rather than as a task on this file.
- Names continue to be persisted in `AssistantMessage.content` as plain text in the meantime.

---

## Related

- `docs/decisions/001-russia-first-market-profile.md` — the Russia-first constraint this sits under.
- `ea2572f` — org name and operator ФИО removed from the assistant system prompt, replaced by
  one-way `ORG-…` / `USER-…` handles. Introduced `identityHandle`, which option (b) would reuse.
- `c456e0f` — «Ответственный менеджер: ФИО» removed from the contact summary prompt. Deleted rather
  than masked, because that output is prose rendered straight to the operator with no substitution
  point on the way out. The presence of a substitution point in the assistant is what makes (b)
  viable here and not there.
- `cb88ba9` — `merge_contacts` stopped returning the assignee ФИО; the `include` was dropped
  entirely since `Contact.assigned_to` already carries the uuid.
- `b6f22bf` — `projectModelFacing` added at the MCP boundary, covering `get_contact`, `get_task` and
  every tool written after it by default; `getOverdueTasksForUser` additionally stopped selecting
  the assignee at source. Introduced `ToolModelFacingOptions`, which is what makes this tool's
  exemption explicit. See the shared-service section above.
- `backend/mcp/model-projection.ts` — the projection's own header states what it deliberately does
  not cover and points back here.
- `backend/services/assistant.ts:142-171` — why masking is by one-way handle and not a reversible
  vault. Correct for the inbound direction; see option (b) for why the outbound direction differs.
  Note that the header of that block (`:144-145`) lists ст. 12 among the duties in play; it predates
  the correction in the Legal position section above and should be read as naming the duty that
  arrives at Wave A, not as a claim about the domestic path today.
- `docs/privacy_policy.md` — `§4.2.1` (ФИО as user personal data), `§4.2.2` and `§3.2` (independent
  controller vs. processor), `§8.5-8.6` (the ч. 4 ст. 12 route for US recipients), `§8.8` (domestic
  transfer is not cross-border), `§8.12` (minimisation and pseudonymisation before transfer),
  `§14.2` (processor register).

---

## Revision note

**2026-07-28 — corrected against the tree after `b6f22bf`.** This record was written before the MCP
boundary projection existed and described paths that have since changed. Documentation only; no
source file was touched in this pass.

What changed and why:

1. **`get_tasks` removed from the list of tools exposing an assignee ФИО.** The previous
   Recommendation section named `get_tasks` alongside `get_task` and `get_overdue_tasks` behind
   `backend/services/task-domain.ts`. That was wrong. `listTasksForUser` (`task-domain.ts:110`,
   query at `:153-161`) is a bare `findMany` with `where` / `skip` / `take` / `orderBy` and no
   `include` at all; the file's only two `include` blocks are at `:197` and `:528`, belonging to
   `getTaskForUser` and `getOverdueTasksForUser`. The MCP handler
   (`backend/mcp/tools/tasks.ts:36-73`) returns that result unchanged. An over-report rather than a
   concealment, but it would have sent a reader looking for something that was never there.
   `listContactsForUser` (`contact-domain.ts:171-179`) is clean for the same reason — it includes
   only `_count`.
2. **The three shared-service paths folded in as a decided section** rather than deferred to "their
   own record". `b6f22bf` closed them, and the mechanism it chose is what `get_rep_performance` is
   now an exception to, so splitting the two across documents would have made both harder to read.
   The section states what remains load-bearing — the two shared includes stay, because the app and
   the public API read them — and the three conditions that must keep holding, which is also
   gate item 3.
3. **The tool's `{ operatorNames: 'allowed' }` declaration described**, including the property that
   it exempts the whole result rather than the `name` key alone.
4. **Options updated.** (a)'s engineering cost lowered, because `registerTool` now takes an options
   bag. (b) and (a) both note that the declaration should be deleted once the tool stops emitting
   names. (e) records that the alternative it rejected has since been built elsewhere. (f) added:
   widening the projection to catch this row by shape, rejected.
5. **The comparison table gained a `b6f22bf` column**, since "passenger for the model, payload for
   the app" is a fourth category the original three did not cover.
6. **Gate renumbered from six items to seven**, with the projection's continued presence added as
   item 3 — the reason the closed paths need no further work, written so that it fails loudly if it
   stops being true.
7. **File:line references re-resolved against the current tree.** `contact-domain.ts:211` → `:223`;
   `task-domain.ts:187,504` → `:197-200` and the note that `:513` no longer selects an assignee;
   `analytics.ts:447-511` → `:447-526`; `server.ts:147-159/161-165/184-192` →
   `:191-203/:205-209/:228-235`; `assistant.ts:488-499` → `:487-499`, `:334-336` → `:333-336`,
   `:142-146` → `:141-146`, `:126-152` → `:122-151`; `controllers/reporting.ts:20` → `:19-21`.
   *(Read this item as a record of what that pass did, not as a statement about the tree today. The
   targets were right at `b6f22bf`; `984cd1a` moved every `assistant.ts` number in the list two days
   later. The second pass below carries the current ones.)*
8. **Legal framing preserved unchanged in substance.** The domestic path is not a cross-border
   transfer; ч. 5 ст. 5 minimisation applies today; ст. 12 begins at Wave A. Two additions only: the
   "only model client" claim is now backed by the named consumers of the `createCompletion` seam,
   and a note in Related flags that a source comment predating this correction lists ст. 12 in a way
   a reader could misread.

**2026-07-28 (second pass) — corrected against the tree after `984cd1a` and `608f924`.** Three
factual claims in this record had gone false in the two days since the pass above, and one file's
line references had all moved. This repository is public and this record is written to carry legal
weight, so a stale claim in it is a claim on the record. Documentation only; no source file was
touched in this pass either.

1. **The «nothing outside `backend/mcp/` imports `model-projection`» invariant withdrawn and
   replaced.** It was false on both halves: `backend/services/assistant.ts:26` imports the module,
   and the test that was cited as asserting the rule now carries an `ALLOWED` allowlist naming
   exactly that file, so it passes rather than failing. The rule was never the point; the point was
   that a function the app reads from must not run the projection, and that still holds inside
   `assistant.ts` by function — `historyToAiMessages()` projects and feeds only the prompt,
   `getAssistantConversation()` does not project and feeds the transcript the app renders. The
   load-bearing section states it that way now, and gate item 3 has gained the allowlist-stays-at-one
   condition it needs to be checkable.
2. **`createCompletion` has two consumers, not three.** `608f924` took the tasks `suggest-contact`
   endpoint off the seam entirely — it now matches a task title against a local Prisma read via
   `matchContactByName`, with no provider in the path. The Legal position section named
   `backend/api/controllers/tasks.ts:4` as a consumer; that import is now `isYandexGptConfigured`
   alone. The «only model client in the backend» conclusion is unaffected and was re-verified by
   three independent searches (the identifier, the module path, and dynamic-import forms).
3. **«Nothing is deployed» withdrawn.** `PROJECT_KNOWLEDGE.md`, `eas.json` and
   `backend/config/security.ts` all say otherwise: production profiles point at `https://4kub.ru/api/v1`
   and `wss://4kub.ru`, a remote PostgreSQL is hard-validated at boot in production, and 1.0.4 is
   live with 1.0.5 submitted. The sentence is replaced by the narrower thing that is true — this
   *surface* has not shipped — with an explicit note that the ст. 12 conclusion never rested on the
   sentence in the first place. It rests on the processor being domestic, which is unchanged and
   re-verified above. The legal reasoning is not adjusted in either direction by this correction;
   only its stated urgency is, and that moves up rather than down.
4. **Every `backend/services/assistant.ts` reference re-resolved.** `984cd1a` inserted about 20 lines
   above the tool catalogue and about 78 below it, so every one of them was off:
   `:668` → `:746`; `:487-499` → `:565-578`; `:382-388` → `:402-408`; `:374-376` → `:394-396`;
   `:359` → `:379`; `:333-336` → `:353-356`; `:331` → `:351`; `:264-272` → `:284-292`;
   `:245-247` → `:265-267`; `:200` → `:220`; `:165-167` → `:185-187`; `:141-146` → `:161-166`;
   `:122-151` → `:142-171`; `:124-125` → `:144-145`; and the `createCompletion` import `:8` → `:28`.
   Re-checked this pass and found **unchanged**: every reference into `analytics.ts`, `server.ts`,
   `model-projection.ts`, `contact-domain.ts`, `task-domain.ts`, `reporting.ts`, `visibility.ts`,
   `yandex-gpt.ts`, `schema.prisma`, `public-api.ts`, `controllers/contacts.ts`, `tools/contacts.ts`,
   `tools/tasks.ts`, `tools/deals.ts`, `src/utils/assistantTools.ts`, `src/app/reports/index.tsx`,
   the `mcp-analytics-cone.test.ts:390` fixture, and every `docs/privacy_policy.md` section cited.
5. **Confirmed correct and deliberately not changed: the contact's own `first_name` / `last_name` are
   NOT masked before reaching the model.** `backend/mcp/model-projection.ts:105-107` preserves them
   on purpose and strips only operator (`User.name`) fields; `redactToolResult` does not touch them
   either. This record already said so in two places — the closing note of the Recommendation and the
   substring argument in (e) — and both were accurate, so they stand as written.

### Revision, 2026-07-29 — the live-service question, settled by measurement

6. **«There is no live service» withdrawn, and one of its premises was false.** The 2026-07-28 text
   asserted that `111.88.149.122` is «an address outside every Yandex Cloud range this project uses».
   RIPE RDAP returns `RU-YANDEXCLOUD-20090612`, Yandex.Cloud LLC, `111.88.144.0/20` — it was this
   project's own VM, on the ephemeral NAT address it lost when the instance was stopped. The refused
   TCP measured that day was a stale reg.ru A record, not a dead backend. Verified 2026-07-29 against
   the current address `51.250.26.203`: `https://4kub.ru/version` → 200 with a valid certificate,
   `POST /api/v1/auth/login` → 200. **The ст. 12 urgency moves up again: both a shipped app and a
   running backend exist.** The legal reasoning is unchanged — it rests on the processor being
   domestic — but nothing here is theoretical any more.
7. **The store-version claims cited in item 3 are themselves unreliable.** That item repeated
   `PROJECT_KNOWLEDGE.md`'s «1.0.4 live with 1.0.5 submitted». The public App Store listing for
   `ascAppId 6776447873` shows **1.1.3**, released 2026-07-19, and the backend's own `/version`
   endpoint returns a hardcoded `1.0.2`. Three sources, three answers, none reconcilable from this
   tree. Do not cite a version number from this repository as fact without checking the store.
8. **Deployed code lagged the tree by 38 commits.** Until 2026-07-29 production ran `576c31b`
   (20 June), predating the entire security release. Any argument of the form «the code does X, so
   production does X» was unsound for that whole period. Check `git rev-parse HEAD` on the VM first.

### Revision, 2026-07-30 — option (b) implemented, scoped to the border

9. **Status moves from Proposed to Partially Accepted.** Option (b) — the tool emits handles, the
   server substitutes names back before the answer reaches the user — is now built and tested. It is
   scoped to the cross-border case: `get_rep_performance` emits `Сотрудник XXXX` when the configured
   provider is not a declared domestic processor, and the real ФИО when it is.

   What that settles and what it does not:

   - **Gate item 2 is satisfied for Wave A.** After a repoint, no operator ФИО is in the
     model-facing composition from this tool. The transfer becomes uuids, aggregates and opaque
     handles, which is the same legal property options (a) and (d) would have bought.
   - **Gate item 4 is satisfied.** `tests/unit/backend/mcp-analytics-cone.test.ts` now pins both
     halves: the ФИО present under the domestic provider (the two pre-existing assertions this
     record predicted would need updating did NOT need updating, because the domestic path is
     unchanged) and every fixture ФИО absent from the serialized result under a foreign one.
   - **Gate item 7 is satisfied.** This tool is now inside the set the masking condition covers
     rather than an unexamined exception to it.
   - **What is deliberately NOT settled: whether ч. 5 ст. 5 minimisation alone justifies aliasing
     under the domestic provider too.** The Recommendation argues for (b) unconditionally. Doing
     that would change what a shipped production assistant answers today, and the only cost of
     waiting is the one this record already accepted for the whole period it sat open. That is the
     owner's call, and implementing it silently inside a change requested as "fix the Wave A
     precondition" would have been making it for them. The switch is one condition in
     `analytics.ts`; flipping it needs no new machinery.
   - **`{ operatorNames: 'allowed' }` stays, and the count stays at exactly one.** The Recommendation
     said to remove it once the tool emits handles. That holds only if the tool ALWAYS emits handles;
     under the scoping above it still emits a real ФИО on the domestic path, so the exemption is
     still true and removing it would be a false claim in the one place this exception is greppable
     from. Remove it in the same change that makes aliasing unconditional, not before.

10. **The mechanism is shared with contact-name masking, not a second copy of it.**
    `backend/services/contact-alias.ts` issues both `Клиент XXXX` and `Сотрудник XXXX` from one
    id-derived token, and `backend/services/contact-alias-resolver.ts` resolves both in a single
    pass, so an answer naming a rep and a customer in one sentence comes back whole. Two prefixes
    rather than one shared `USER-<hex>`: the system prompt's rule 6 tells the model not to print
    machine handles, and this record's own cost #2 flagged that reusing them would need that
    instruction to be true for one tool and false for another.

11. **Persistence question (cost #3) answered: the stored copy holds handles.** `AssistantMessage`
    rows are written with whatever the provider saw, and `getAssistantConversation` rehydrates on
    read. This is the more expensive of the two options at read time and was chosen anyway, because
    it makes replay safe by construction — a stored row cannot contain a name the provider was not
    already allowed to see, so re-sending history is never a fresh disclosure. The read cost is two
    narrow queries, paid only when a transcript actually contains an alias.
