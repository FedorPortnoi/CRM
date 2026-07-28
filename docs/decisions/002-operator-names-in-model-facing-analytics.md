# 002 - Operator Names in the Model-Facing Analytics Surface

## Status

**Proposed — open. No code change has been made and none should be made from this document alone.**

This record exists because `get_rep_performance` is the one remaining place where an operator's
real name reaches the language model, and unlike the two cases already closed it cannot be fixed
by deleting a field: the name *is* what the feature returns. The choice is a product decision, so
this document lays out the options and recommends one rather than making it.

`001-russia-first-market-profile.md` is a settled decision and uses `Decision / Why / Consequences`.
This one is pending, so it adds `Status`, `Options`, `Recommendation` and `Gate` around that spine.
Future pending records should follow this shape; settled ones can stay with the 001 shape.

The legal reading below is an engineering summary written to make the trade-off legible. It is not
legal advice and should be confirmed with counsel before it is relied on.

---

## Context — what the tool does today

`get_rep_performance` is one of six analytics tools registered in
`backend/mcp/tools/analytics.ts`. It answers "how is each sales rep doing" over a date range.

Registration and handler: `backend/mcp/tools/analytics.ts:447-511`.

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

### What reaches the model, exactly

One row per rep, each carrying `user_id`, `name`, `deals_total`, `deals_won`, `deals_lost`,
`total_value`, `win_rate`. The row set is bounded by the caller's visibility cone
(`analytics.ts:465,473,483,499` via `getAccessibleUserIds` / `canSeeUser` in
`backend/services/visibility.ts:69-81`): an owner or admin sees every rep in the organisation, a
member sees only themselves and their reports. So the exposure is "every name inside the caller's
cone", not "every name in the database" — but for an owner asking the obvious question, those are
the same set.

The path from the tool to the provider:

1. `backend/services/assistant.ts:668` — `serializeToolResult(outcome.result)`.
2. `backend/services/assistant.ts:382-384` — that function calls `redactToolResult` and stringifies.
3. `backend/services/assistant.ts:374` — `redactToolResult` walks the object and masks a key when
   `REDACTED_KEYS.has(key)` **or** `keyLooksLikePii(key)` (`assistant.ts:359`).

Neither test matches `name`:

- `REDACTED_KEYS` (`assistant.ts:264-272`) is an exact-match set: `email`, `phone`, `mobile`,
  `email_bidx`, `phone_bidx`, `mobile_bidx`, `unsubscribe_token`.
- `PII_KEY_FRAGMENTS` (`assistant.ts:331`, used by `keyLooksLikePii` at `:334-336`) is
  `['email', 'phone', 'mobile', 'telephone', 'e_mail', 'tel_']`.

So the row passes through unchanged, and the same serialized string is both sent to the provider
and persisted into `AssistantMessage.content` as plain text (`assistant.ts:245-247`).

**Adding `name` to the redaction set is not available as a fix.** `keyLooksLikePii` matches on
*substring*, so a `name` fragment would mask `pipeline_name`, `stage_name`, `from_stage_name`,
`to_stage_name`, `first_name` and `last_name` as well — including the legitimate business labels
this very file returns from `get_pipeline_health` (`analytics.ts:256,258,267`) and the ones
`get_deals` selects (`backend/mcp/tools/deals.ts:257-258`). An exact-match entry for the bare key
`name` would still eat `pipeline: { name }` and `stage: { name }` from those same tools. The
redaction layer is the wrong place for this; the decision has to be made at the tool.

### The same numbers already have a non-model path

Worth knowing before weighing the options: the named leaderboard is **not** exclusive to the
assistant. There is a second, independent implementation that never touches a model —
`getRepPerformance` in `backend/services/reporting.ts:462`, selecting
`{ id: true, name: true, role: true }` at `:523`, exposed as `GET /api/v1/reports/reps`
(`backend/api/routes/reporting.ts:32-35` → `backend/api/controllers/reporting.ts:20`) and rendered
by the app's Reports screen at `src/app/reports/index.tsx:283` (`{rep.name ?? UNSET_VALUE}`).

That path is fine as it stands — it is a server rendering an operator's own organisation's data to
an authorised operator, with no third-party processor in the middle. It matters here only because
it bounds the blast radius of every option below: whatever is decided about the MCP tool, the
product keeps a named rep leaderboard.

### There is no per-tool gate today

`buildToolDefinitions` (`backend/services/assistant.ts:488-499`) offers the model everything
`listMcpTools()` returns, and `listMcpTools` (`backend/mcp/server.ts:184-192`) returns the whole
registry, populated by unconditional module imports in `loadMcpTools`
(`backend/mcp/server.ts:147-159`). The same registry also backs the stdio MCP transport
(`startMcp`, `backend/mcp/server.ts:161-165`). So "just turn this tool off for the model" is not a
config flag that exists — it is a small feature that would have to be built, and it would need to
distinguish the two transports if the tool should stay available over stdio.

---

## Why this is different from the two cases already fixed

Three instances of the same underlying issue have now been looked at. Two were straightforward.
This one is not, and the reason is worth stating precisely, because it is the whole basis of the
decision.

| | `ea2572f` — assistant system prompt | `c456e0f` — contact-ai summary | `cb88ba9` — `merge_contacts` | **this one — `get_rep_performance`** |
|---|---|---|---|---|
| What carried the name | org name + operator ФИО in the system prompt | «Ответственный менеджер: ФИО» in the summary prompt | `include: { assignee: { select: { name } } }` | `select: { name: true }`, returned as `name` per rep |
| What the name was for | nothing — the model answers in the second person | nothing — the prompt asks about the *relationship* | nothing — no consumer read it | **the answer itself** |
| Fix | replaced with a one-way handle | deleted | deleted | *not obvious — hence this record* |

In all three closed cases the name was **passenger data**: it rode along in a payload that was
about something else, and removing it cost nothing because nothing downstream read it. `c456e0f`
could delete the field outright; `cb88ba9` could drop the whole `include` because
`Contact.assigned_to` already carried the uuid the model chains on; `ea2572f` could substitute an
opaque handle because the system prompt's identities are things the model *refers to*, never things
it *reports*.

Here the name is the **payload**. A user asking «кто лучший менеджер в этом месяце» is asking for a
name. A row of `{user_id: "…", win_rate: 62}` does not answer that question, and an answer reading
«лучший результат у USER-1a2b3c» is worse than no answer — it is a technical token surfaced inside
user-facing Russian prose. That is precisely the trap `c456e0f` avoided by deleting rather than
substituting: a handle only works where something downstream turns it back into meaning, and in
`contact-ai.ts` nothing did.

The difference here — and it is the crux of option (b) below — is that in the assistant there *is*
something downstream. The response is composed by the backend before the user sees it, so unlike
`contact-ai.ts` there is a place to put a substitution pass. Whether that pass is trustworthy is
the question option (b) has to answer honestly.

---

## Legal position

Stated narrowly, in the order the duties actually apply.

**Whose data.** An operator's ФИО. Under the repository's own privacy policy
(`docs/privacy_policy.md §4.2.1`) ФИО is the first listed category of personal data processed for
app users, and `§4.2.2` records that for user data the Operator acts as an **independent
controller** (самостоятельный оператор) — not as a processor acting on a client organisation's
instruction, which is the basis `§3.2` uses for *customer* data. So this is a category where the
Operator carries the duties directly and cannot point at a client's instruction.

**Today the provider is domestic.** `backend/services/yandex-gpt.ts` is the only model client in
the backend, and its endpoint is `https://llm.api.cloud.yandex.net/foundationModels/v1/completion`
(`yandex-gpt.ts:18-19`) — Yandex Cloud, a Russian legal entity, infrastructure in Russia.

**Therefore ст. 12 does not apply today.** Трансграничная передача is defined in п. 11 ст. 3 ФЗ-152
as transfer to a foreign state / foreign person. A transfer to a domestic processor is not one, and
`docs/privacy_policy.md §8.8` already says exactly that about Yandex Cloud. **This is not a
cross-border transfer today and should not be described as one.** An earlier note in this codebase
got that wrong; the correction is deliberate.

**What does apply today** is the minimisation duty of **ч. 5 ст. 5 ФЗ-152** — the composition of
processed data must be adequate and not excessive for the stated purpose — together with the
requirement of a lawful basis and purpose (ч. 1, 2 ст. 5; ст. 6) and the processor-instruction
requirements of ч. 3 ст. 6 for engaging a processor at all. Two concrete observations:

- Minimisation is a genuine question, not a formality. The names are sent so the model can put them
  back in a sentence. If they can be reinserted after the model instead of before it, the transfer
  of names to the processor is by definition not necessary — and a duty to avoid excess bites
  hardest exactly where the excess is avoidable.
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

**Nothing is deployed.** There is no production database and no live service; today's system runs
against local PostgreSQL with test data. Everything above is about what the code would do when it
is run for real, which is why it is worth settling before that happens rather than after.

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
- **Engineering cost.** Larger than it sounds, because no gate exists (see above). Unregistering the
  tool also removes it from the stdio MCP transport, which may not be intended. Building a
  model-facing allowlist is the cleaner form and is useful independently — it is the mechanism any
  future "this tool is not for the model" decision needs.
- **Ancillary.** `tests/unit/backend/mcp-analytics-cone.test.ts:384-399` exercises the tool and pins
  `name: 'Outsider'` at `:390`; that test needs updating under this option and under (d).

### (b) Return handles from the tool, substitute names back server-side

The tool emits `USER-<hex>` handles in place of names, using the existing
`identityHandle('user', id)` (`backend/services/assistant.ts:165`). The model composes prose
referring to handles. Before the answer is returned, a server-side pass rewrites each handle back
to the real name from a table built for that request.

**Is re-substitution actually tractable? Mostly yes — and this is where the earlier framing needs
correcting.**

This was initially filed alongside the reversible token vault that was rejected on 2026-07-27, and
the two are not the same problem. The vault was an **inbound** matcher: it held `Иванов` and had to
recognise `Иванова`, `Иванову`, `Ивановым` in free user input. Russian inflection made it
unreliable, and — decisively — its failure mode was **fail-open**: a missed match meant an
unmasked name went out. The comment at `assistant.ts:142-146` records that reasoning, and it
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
2. **Prompt rules conflict.** Rule 6 (`assistant.ts:200`) currently instructs the model *not* to
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

### (c) Accept the exposure and cover it in the Roskomnadzor filing

Leave the tool as it is, add the model provider to `docs/privacy_policy.md §8.7` and `§14.2`, and
name operator ФИО in the composition of transferred data in the ч. 3/4 ст. 12 notification.

- **Effect.** Legally coherent — this is what the filing mechanism is for, and the policy already
  documents this exact route for four US recipients.
- **Cost.** It converts a solvable engineering question into a permanent disclosure obligation over
  a category the Operator controls directly. It also sits awkwardly with `§8.12`, which commits the
  Operator to assessing adequacy and non-excess before each cross-border transfer and to
  pseudonymising *where technically possible* — and options (a), (b) and (d) are all existence
  proofs that it is technically possible here. Choosing (c) means asserting that a named
  conversational leaderboard is worth a transfer that the Operator's own policy says should be
  avoided when avoidable. That is a defensible commercial judgement, but it should be made
  knowingly.
- **Note.** The register work in (c) is required under *every* option, because no model provider is
  listed today. What is optional is the part that names operator ФИО in the transferred composition.

### (d) Ids to the model, names resolved on the client

The tool returns `user_id` + metrics only. The model refers to reps by ordinal («первый по
выручке») or by id, and the app renders a small structured leaderboard alongside the prose,
resolving ids to names locally from data it already holds.

- **Effect.** Strongest and most durable: names never leave Postgres on this path at all, matching
  the structural approach `c456e0f` and `cb88ba9` took. No substitution pass to trust, no prompt
  rule to balance.
- **Cost.** The largest, and it lands on the slowest surface. `AssistantToolCall`
  (`src/utils/assistantTools.ts:18-24`) carries `round`, `name`, `arguments`, `ok`, `error` and
  deliberately **no result payload**, so the assistant response contract would have to start
  carrying structured tool results to the client, plus a new render component and i18n. That is a
  mobile app release through the stores, not a backend deploy.
- Also produces stiffer prose: a model told to avoid names writes more awkwardly than one given a
  substitution frame.

### (e) Considered and rejected: mask inside `redactToolResult`

Covered above — `keyLooksLikePii` is a substring test, so any `name` rule would mask
`pipeline_name`, `stage_name` and `first_name`/`last_name` across every other tool. Recorded here so
it is not re-proposed.

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
   separate proofs that it is technically possible in this case. Choosing (c) would mean filing for
   a transfer of operator ФИО — a category where `§4.2.2` makes the Operator an independent
   controller — in order to preserve a phrasing convenience in one chat answer. That trade is
   available, and it is the owner's to make, but it is a poor one on the merits.

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
   name never leaves the database, which is the same structural move `c456e0f` and `cb88ba9` made,
   and structural beats procedural every time. But its cost lands on the client: the assistant
   response contract does not carry tool result payloads today (`src/utils/assistantTools.ts:18-24`),
   so it needs a contract change, a new component, i18n, and an app-store release cycle. (b) is
   backend-only and can ship in an afternoon. If the client is being changed for other reasons
   anyway, promote (d) — and note that (b) is a strict subset of the work, not wasted effort, since
   both require the tool to stop emitting names.

5. **(a) is the correct emergency answer, not the correct answer.** If Wave A is ready before (b) is
   built, dropping the tool from the model-facing set is the right call for that window: it is
   cheap, it is certain, and the Reports screen means the product keeps a named leaderboard
   regardless. It is listed as the gate's fallback below for exactly that reason. As a permanent
   choice it gives up a capability that (b) shows is retainable.

6. **Do the register work regardless.** `docs/privacy_policy.md §14.2` and `§8.7` list no language
   model provider at all, while `backend/services/assistant.ts` has been sending CRM data to one.
   That gap is independent of this decision and is not fixed by any option above. It should be
   closed on its own schedule, not bundled into this choice.

**Two things this recommendation deliberately does not decide.** First, the same operator ФИО
reaches the model through `assignee: { select: { id: true, name: true } }` in shared services —
`backend/services/contact-domain.ts:211` (behind MCP `get_contact`) and
`backend/services/task-domain.ts:187,504` (behind `get_task`, `get_tasks`, `get_overdue_tasks`).
Those are a wider decision because the app renders those names (`src/app/task/[id].tsx`,
`src/app/task/edit/[id].tsx`), so the same options do not map cleanly onto them. They belong in
their own record. Second, whether the *contact's* own name should reach the model at all is
untouched here; `backend/services/contact-ai.ts` sends it deliberately and that is a separate,
already-made decision.

---

## Gate — what must be true before Wave A ships

Wave A repoints `backend/services/yandex-gpt.ts` at OpenAI through `workers/openai-proxy/`. From
that moment `get_rep_performance` output crosses the border with **no change to
`backend/mcp/tools/analytics.ts`**. All of the following must hold before that repoint lands:

1. **This record is resolved** — an option is chosen, `Status` is updated to Accepted, and the
   chosen option is either implemented or explicitly deferred with (a) applied in the interim.
2. **No operator ФИО is in the model-facing composition**, unless (c) was chosen knowingly and the
   filing in item 4 names that category explicitly.
3. **A regression test pins it.** Whichever option is chosen, a test in the shape of
   `tests/unit/backend/mcp-merge-contacts-pii.test.ts` — distinctive fixture ФИО, absent from the
   rest of the repository, asserted absent from the serialized tool result — must fail if the name
   comes back. `tests/unit/backend/mcp-analytics-cone.test.ts:390` currently pins the *presence* of
   the name and will need updating in the same change.
4. **The Roskomnadzor notification of intent (ч. 3, 4 ст. 12 ФЗ-152) is filed and the 30-day period
   under ч. 4 ст. 12 has elapsed**, with the model provider and the Cloudflare transit hop both
   described, and the composition of transferred data stated accurately for whichever option was
   chosen.
5. **`docs/privacy_policy.md` is updated** — the model provider added to the `§14.2` processor
   register and to the `§8.7` cross-border table, with the `§8.12` adequacy-and-non-excess
   assessment recorded for this transfer.
6. **The masking condition attached to the Wave A exception is met** — names masked before they
   cross — and this tool is confirmed to be inside the set that condition covers, not an
   unexamined exception to it.

Items 4 and 5 are required for Wave A irrespective of this decision; items 1, 2, 3 and 6 are what
this record adds.

---

## Consequences of leaving this open

Recorded so that "no decision yet" is a visible state rather than an invisible one:

- Today the exposure is to a domestic processor, so nothing is urgent — this is a ч. 5 ст. 5
  minimisation question, not a ст. 12 one.
- The transition is silent. No code in `analytics.ts` changes when the provider does, so there is no
  diff to review at the moment the legal character of the payload changes. That is exactly why the
  gate above is written as a precondition on Wave A rather than as a task on this file.
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
- `backend/services/assistant.ts:126-152` — why masking is by one-way handle and not a reversible
  vault. Correct for the inbound direction; see option (b) for why the outbound direction differs.
- `docs/privacy_policy.md` — `§4.2.1` (ФИО as user personal data), `§4.2.2` and `§3.2` (independent
  controller vs. processor), `§8.5-8.6` (the ч. 4 ст. 12 route for US recipients), `§8.8` (domestic
  transfer is not cross-border), `§8.12` (minimisation and pseudonymisation before transfer),
  `§14.2` (processor register).
