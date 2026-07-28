# 4КУБ → OpenAI proxy (Cloudflare Worker)

`api.openai.com` is not reachable from Russia. This Worker sits in between: the
CRM backend calls the Worker, the Worker calls OpenAI. It holds the OpenAI key,
so the CRM never does.

It is deliberately not a general-purpose proxy. It forwards exactly one
endpoint, for an allowlist of models, behind its own shared secret, under a
daily request ceiling.

```
backend/services/assistant.ts
        │  Authorization: Bearer <PROXY_TOKEN>
        ▼
  this Worker  ──(daily counter: Durable Object)
        │  Authorization: Bearer <OPENAI_API_KEY>   ← injected here, never leaves Cloudflare
        ▼
  api.openai.com/v1/chat/completions
```

---

## No secrets live in this directory

This repository is **public**, and a real database password has already leaked
through its history once. Nothing in `wrangler.toml`, `.dev.vars.example`, the
source, or this README is a real credential, and no placeholder is written to
look like one. Secrets exist in exactly two places:

| Where | What | How |
| --- | --- | --- |
| Cloudflare (production) | `OPENAI_API_KEY`, `PROXY_TOKEN` | `wrangler secret put` |
| `.dev.vars` (your machine, local dev only) | the same two | copied from `.dev.vars.example`, git-ignored |

The `.gitignore` in this directory ignores `.dev.vars`. The repository root
`.gitignore` covers `.env` but knows nothing about wrangler, so **do not delete
that file**.

---

## Setup

Everything below runs from `workers/openai-proxy/`. All of it requires your own
Cloudflare account and your own OpenAI key — none of it has been run for you.

### 1. Install

```sh
cd workers/openai-proxy
npm install
```

Dependencies stay in this directory. Nothing is installed into the repo root.

### 2. Generate a proxy token

`PROXY_TOKEN` is a secret you invent, unrelated to your OpenAI key. Generate it
randomly — do not type one out by hand:

```sh
openssl rand -hex 32
```

PowerShell, if you have no `openssl`:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Keep the output somewhere safe for a moment — you will paste it twice, once into
Cloudflare and once into the CRM's environment.

### 3. Authenticate wrangler and deploy

```sh
npx wrangler login
npx wrangler deploy
```

The first deploy creates the Worker and the `DailyQuota` Durable Object class.
Note the `*.workers.dev` URL it prints.

### 4. Set the secrets

Run these **after** the first deploy (the Worker must exist first). Each command
prompts for the value on a hidden line — never pass a key as a command-line
argument, since that lands in your shell history.

```sh
npx wrangler secret put OPENAI_API_KEY   # paste your OpenAI key at the prompt
npx wrangler secret put PROXY_TOKEN      # paste the random token from step 2
```

Optional, only if your OpenAI key is scoped to a specific org or project:

```sh
npx wrangler secret put OPENAI_ORG_ID
npx wrangler secret put OPENAI_PROJECT_ID
```

Until both required secrets are set the Worker answers `503
proxy_not_configured` and forwards nothing — it fails closed, not open.

### 5. Smoke-test it

```sh
curl -i https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
```

Expected: `200` with an OpenAI completion, plus `x-proxy-quota-used` and
`x-proxy-quota-limit` headers. Then check the guards actually hold:

```sh
# no token → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-worker>.workers.dev/v1/chat/completions

# any other path → 404
curl -s -o /dev/null -w '%{http_code}\n' https://<your-worker>.workers.dev/v1/models

# unlisted model → 400 model_not_allowed
curl -s https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4-turbo","messages":[]}'
```

---

## What the CRM side needs

Two environment variables in the backend (`.env` — not touched by this work):

```
OPENAI_BASE_URL=https://<your-worker>.workers.dev/v1
OPENAI_PROXY_TOKEN=<the random token from step 2>
```

`OPENAI_PROXY_TOKEN` goes where an OpenAI key would normally go. The Worker
speaks OpenAI's wire format on both ends, so the official SDK works unchanged:

```ts
const client = new OpenAI({
  apiKey: process.env.OPENAI_PROXY_TOKEN,   // NOT the OpenAI key — the backend never sees that
  baseURL: process.env.OPENAI_BASE_URL,
});
```

Or with plain `fetch`, matching the style of `backend/services/yandex-gpt.ts`:

```ts
await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_PROXY_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
});
```

Errors come back in OpenAI's own envelope, so one error path handles both the
proxy and OpenAI:

```json
{ "error": { "message": "...", "type": "proxy_error", "code": "model_not_allowed" } }
```

Proxy-specific codes worth handling in the backend: `model_not_allowed` (400),
`payload_too_large` (413), `daily_limit_exceeded` (429, with `Retry-After` in
seconds), `upstream_timeout` (504), `proxy_not_configured` / `quota_unavailable`
(503).

---

## Privacy: bodies are never logged

**Request and response bodies are never logged, never stored, and never
buffered longer than it takes to forward them.** They carry contact names, deal
titles and free-text notes about real people.

The Worker emits exactly one structured line per request:

```json
{"evt":"openai_proxy","outcome":"ok","status":200,"upstream_status":200,
 "model":"gpt-4o-mini","quota_used":37,"quota_limit":500,"duration_ms":812,"ray":"…"}
```

Status, outcome, duration, model name, quota counters and the Cloudflare ray id.
No bodies, no headers, no tokens, no client IP.

Two structural defences back this up, and both should stay:

- The response body is piped straight through (`new Response(upstream.body, …)`).
  The Worker never reads it, so there is nothing to accidentally log.
- Error messages are static strings. Nothing derived from the body — not even a
  JSON parse error — is ever interpolated into a response or a log line.

`test/proxy.test.ts` asserts this: it sends a body containing a Russian contact
name and deal value, then fails if any captured log line contains any fragment
of it. **If you add logging here, that test is what will catch you. Do not
weaken it.** If you need to see a payload, reproduce it locally against
`wrangler dev`.

Cloudflare Workers Logs is enabled in `wrangler.toml` (`[observability]`), which
retains those sanitized lines for a few days. That is safe precisely because
they contain no body content.

---

## Security decisions

**One route, no passthrough.** Only `POST /v1/chat/completions` is served;
everything else — including `GET` on that same path — returns 404. A proxy that
forwards whatever path it is given is an open relay in front of a funded OpenAI
account: anyone with the token could reach `/v1/images/generations`,
`/v1/fine_tuning/jobs`, or the account's own management surface. The CRM calls
exactly one endpoint, so exactly one endpoint is exposed. There is deliberately
no `/health` route either — a 404 from the Worker is already proof it is alive.

**Two separate secrets.** `PROXY_TOKEN` authenticates the caller;
`OPENAI_API_KEY` authenticates the Worker to OpenAI. The CRM only ever holds the
former. If the CRM's environment leaks, the attacker gets a model-restricted,
daily-capped chat endpoint — not a key that can spend your OpenAI balance
freely. Rotating the proxy token then costs nothing at OpenAI.

**Constant-time token comparison.** `===` on strings stops at the first
differing byte, so response latency reveals how many leading characters of a
guess were right and the token can be recovered one character at a time. Both
values are HMAC'd with a random per-isolate key and the resulting 32-byte
digests are compared with a full-scan XOR (`src/auth.ts`). The double-HMAC form
was chosen over `crypto.subtle.timingSafeEqual` because it does not throw on a
length mismatch and does not leak the secret's length.

**Auth before anything expensive.** Authentication runs before the body is
read and before the quota is touched, so unauthenticated traffic can neither
allocate memory nor burn the CRM's daily budget. There is a test for that.

**Exact-match model allowlist, checked before the upstream call.**
`ALLOWED_MODELS` is compared exactly — no prefixes, no wildcards — so allowing
`gpt-4o` cannot silently authorise a far more expensive future model that
happens to share the prefix. Dated snapshots must be listed individually. An
empty allowlist allows nothing.

**Headers are rebuilt, not forwarded.** The upstream request is constructed
from scratch, so a caller cannot smuggle a second `Authorization`, an
`OpenAI-Organization`, or a rewritten `Host` into it. Response headers are
copied back through an allowlist, so upstream cookies or tracing headers are
dropped rather than relayed into the CRM.

**Body cap enforced on the stream.** `Content-Length` is checked first as a
cheap rejection but is not trusted — it can be absent on a chunked request or
simply a lie. The body is counted chunk by chunk and the stream is cancelled the
moment it goes over.

**No CORS headers.** None are sent, so a browser cannot call this Worker from a
web page. The only intended caller is the Fastify backend, server-side.

**Fails closed everywhere.** Missing secrets → 503. Unreachable quota counter →
503. Neither falls through to an unmetered forward.

---

## Why a Durable Object for the daily counter, not KV

KV is the simpler binding, and it is the wrong one here.

The threat is a runaway agent loop hammering the proxy as fast as it can, and
that is precisely the case KV cannot count:

- KV reads are served from a cache with a **60-second minimum TTL**, so a burst
  keeps reading a stale count for up to a minute.
- Writes to a single key are throttled to roughly **one per second** and are
  eventually consistent, so concurrent increments overwrite each other rather
  than accumulating.

A loop firing 50 requests/second would keep seeing `count: 12` and blow past the
ceiling by thousands of requests before KV noticed. The counter would be
decorative exactly when it is needed.

A Durable Object is a single addressable instance with strongly consistent
storage. Cloudflare serialises event delivery to it, and `blockConcurrencyWhile`
makes the read-modify-write explicitly atomic, so no increment can be lost and
the ceiling is a real ceiling. `test/proxy.test.ts` fires 50 concurrent requests
at a limit of 10 and asserts that exactly 10 reach upstream.

The cost is real and worth stating: every request makes a round trip to one
object in one location, adding tens of milliseconds. Against a multi-second LLM
call that is noise, and a single object handles far more throughput than this
CRM will produce.

Two consequences of the design to be aware of:

- **Reservations are not refunded.** The counter is incremented before the
  upstream call and is not decremented if OpenAI then fails. A loop that keeps
  failing still costs money and connections, so the ceiling counts attempts,
  not successes.
- **The class is declared as SQLite-backed** (`new_sqlite_classes` in
  `wrangler.toml`), which is the current backend for new Durable Object classes.
  If your Cloudflare plan does not permit Durable Objects, the first
  `wrangler deploy` will say so — I could not verify this against your account.

---

## Streaming

`backend/services/yandex-gpt.ts` sends `"stream": false` and reads a single JSON
body; `assistant.ts` has one non-streaming call site. So streaming is **off**:
a request with `"stream": true` is rejected with `400 streaming_disabled`
rather than silently downgraded, because silently changing a caller's semantics
is worse than refusing.

It is gated, not foreclosed. The Worker already pipes the upstream body through
unbuffered, so enabling it is one variable:

```toml
ALLOW_STREAMING = "true"
```

Then redeploy. The Worker will pass `Accept: text/event-stream` upstream and
relay the SSE stream chunk by chunk. There is a test covering that path, so the
switch is known to work — the backend just has to be able to consume it.

---

## Configuration

All of these are public settings in `wrangler.toml` under `[vars]`. Change and
redeploy. Values are clamped to sane ranges; garbage falls back to the default.

| Var | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_MODELS` | `gpt-4o-mini,gpt-4o` | Comma-separated exact model ids. Empty = nothing allowed. |
| `DAILY_REQUEST_LIMIT` | `500` | Forwarded requests per day before everything is refused. |
| `MAX_BODY_BYTES` | `262144` | Largest accepted request body (256 KiB). |
| `UPSTREAM_TIMEOUT_MS` | `60000` | Abort the OpenAI call after this long. |
| `ALLOW_STREAMING` | `false` | Accept `"stream": true`. See above. |
| `DAY_BOUNDARY_OFFSET_MINUTES` | `180` | Quota resets at midnight Moscow rather than UTC. |
| `MAX_OUTPUT_TOKENS` | `4096` | Reject a single request asking for more. `0` disables. The CRM assistant currently asks for 2000. |

---

## Secret rotation

### Rotating `PROXY_TOKEN` with no downtime

The Worker accepts an optional second secret, `PROXY_TOKEN_PREVIOUS`, so old and
new tokens are both valid during the changeover.

```sh
# 1. Park the current token as the previous one. Nothing changes yet.
npx wrangler secret put PROXY_TOKEN_PREVIOUS      # paste the CURRENT token

# 2. Install the new token. Both are now accepted.
npx wrangler secret put PROXY_TOKEN               # paste the NEW random token

# 3. Update OPENAI_PROXY_TOKEN in the CRM's .env and restart the backend.

# 4. Confirm traffic is flowing, then retire the old token.
npx wrangler secret delete PROXY_TOKEN_PREVIOUS
```

Do not skip step 4 — leaving it set means a token you meant to retire still
works indefinitely.

### Rotating `OPENAI_API_KEY`

```sh
# 1. Create a new key in the OpenAI dashboard (do not revoke the old one yet).
npx wrangler secret put OPENAI_API_KEY            # paste the new key
# 2. Confirm requests still succeed.
# 3. Revoke the old key in the OpenAI dashboard.
```

No CRM change is needed — the backend never sees this key.

### If a key is ever exposed

Revoke it at OpenAI first, then rotate. A `wrangler secret put` alone does not
help if the old key is still live in someone else's hands.

---

## Local development

```sh
cp .dev.vars.example .dev.vars     # then put real values in .dev.vars
npx wrangler dev
```

`wrangler dev` runs locally, including a local simulation of the Durable Object,
so the quota behaves as it will in production. `.dev.vars` is git-ignored.

## Tests

```sh
npm test
```

Runs on plain Node 22.6+ (24 recommended) with no dependencies — the test runner
strips the TypeScript types, and `Request`/`Response`/`crypto.subtle` are
globals there. Upstream `fetch` and the Durable Object binding are stubbed, so
nothing touches the network and no OpenAI key is needed.

The suite covers routing and the 404 policy, every authentication failure mode,
token rotation, the constant-time comparison, the body cap (including a chunked
request with no `Content-Length`), JSON validation, the model allowlist,
the streaming gate in both positions, the output-token cap, the daily ceiling
under a 50-way concurrent burst, day rollover, header sanitisation in both
directions, timeout/network error mapping, and the no-body-logging guarantee.

```sh
npm run typecheck
```

Runs `wrangler types` (which regenerates `worker-configuration.d.ts` with the
Workers runtime declarations — a generated artifact, git-ignored) and then
`tsc --noEmit` over `src/`.

## Files

```
wrangler.toml        config + vars (public — no secrets, ever)
.dev.vars.example    placeholder template for local secrets
.gitignore           keeps .dev.vars out of a public repo
src/index.ts         routing, auth, validation, upstream call, logging
src/auth.ts          constant-time token comparison
src/config.ts        var parsing, model allowlist, day bucketing
src/quota.ts         DailyQuota Durable Object
test/proxy.test.ts   the whole suite
```
