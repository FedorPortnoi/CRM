# Session log — 2026-08-07 — TRUST section, SEO/GEO, auth audit

Four commits, all on `main`, all live on 4kub.ru at the moment of writing
(`website/` is served straight off disk, so every save is a deploy).

| Commit | What |
|---|---|
| `b28d07d` | terracotta TRUST section + the whole paper redesign that had been serving uncommitted since 06 Aug |
| `1a23981` | real 404s, sitemap, canonicals, meta descriptions, single `h1` per page |
| `c6f959f` | four verified auth defects |
| `fe3345a` | corrected the data-residency claim on both public pages |
| `d3af4af` | llms.txt + JSON-LD + two missing MIME types |
| `46752bb` | deleted 179 KB of unreferenced files |

---

## 1. The TRUST section

Three studies before one landed. Kept in `crm/` (NOT `website/`, which is
public): `trust-concept.html` (night — rejected), `trust-concept-2.html`
(terracotta — accepted and ported).

**The design that got rejected and why it matters.** The first terracotta
attempt was a straight palette swap of the night version: cream record panel,
white sheet sliding under the active claim, soft drop shadow. Verdict was
blunt and correct — it read as two pale slips on a tablecloth. The lesson is
that a *night composition* does not survive a palette swap, because the night
version worked by having the panel be a light source in the dark. On terracotta
nothing is a light source, so the same layout is just faded boxes.

The fix came from the CTA's own rule, already written in `sections.css`:

```
/* On terracotta the primary button inverts: ink field, paper label. */
```

So the record became an INK panel with cream type. It is then the darkest thing
on screen, which restores the thing that made the mechanism work at all.

**The constraint that shaped everything else.** Ink on terracotta measures
5.32:1. Ink at 90% is 4.65:1; at 55% it is 2.54:1 and fails outright. So on
this ground **text cannot carry state** — dimming a claim to mark it inactive
would make a legal claim unreadable. State moved into a folio chip that fills
with ink and flips its numeral to paper. Contrast rises on both sides of the
change; nothing ever fades. The record keeps its dimming because it is
`aria-hidden` illustration and contrast rules do not govern decoration.

### Traps, in the order they bit

1. **`overflow: hidden` on the section silently kills the sticky pin.** It makes
   the section a scroll container, so the sticky stage pins to *it* rather than
   the viewport, i.e. does not pin. `overflow: clip` does not create a scroll
   container and is the fix. Cost the first hour.
2. **`perspective: 1500px` fisheyes a 23rem cube** until the drawn screen on the
   front face is unreadable. 2400px reads as a long lens. (CAPS study.)
3. **An absolutely-positioned `<svg>` sizes from its viewBox ratio, not from
   `inset`.** `inset: -9px` on a 1:1 viewBox produced a 609×609 square around a
   593×425 panel. Explicit `width: calc(100% + 18px)` fixes it.
4. **SVG `stroke-dashoffset` on a scroll timeline paints stale.**
   `getComputedStyle` reported `0` while the browser painted a partial stroke.
   Replaced with four transformed 1px divs — transform-only, composites, and
   repaints reliably. This is also the better design: one edge per claim, so the
   seal is closed by the proofs rather than by a decorative sweep.
5. **The `animation` shorthand resets `animation-timeline` and
   `animation-range`.** And a scroll-driven animation with a *fixed* duration
   does not span its range. Set `animation-name` only, and put the timeline
   properties in a shared rule.
6. **Merging keyframes that need different floors.** The folio chip's fill must
   reach `opacity: 0` or the ink block never lifts; a record row that reaches 0
   deletes half the exhibit. Same timings, separate names.
7. **`html { scroll-behavior: smooth }` makes every measure-after-scroll probe
   read a stale mid-flight value.** Scroll-driven state looked frozen at claim
   01 when it was fine. Set `documentElement.style.scrollBehavior = 'auto'`
   before probing, and treat screenshots as ground truth.
   `getComputedStyle(el, '::before')` also reports pseudo-elements unanimated
   under a scroll timeline — measure the element, not the pseudo.

### Gates on the pin

Four, not three: `min-width: 1000px`, **`min-height: 660px`**,
`@supports (animation-timeline: view())`, and `prefers-reduced-motion:
no-preference`. The height gate exists because four claims plus the record do
not fit a short laptop window, and pinning there clipped the first claim rather
than revealing it. The sticky stage also needs `padding-top: 4.5rem` because
`header.nav` is fixed, translucent cream, z-index 50.

### Naming

Every class is `trust-` prefixed. The study used `.track`, `.stage`, `.claim`,
`.rec`, `.row`, `.find`, `.chip`, `.seal`, `.status` — fine in a file of its
own, catastrophic in this cascade.

### Open

TRUST now sits directly above the CTA, so two terracotta fields abut, held apart
only by a 1px ink fold on `.trust + .cta`. The CTA was the page's only saturated
moment and that is now diluted. Cheapest fix is moving TRUST above TEAM.

---

## 2. The claim that was false

`index.html` asserted «Серверы и база данных в Yandex Cloud, зона ru-central1.
Требование ФЗ-152 о локализации выполнено по факту.» The cloud was deleted on
3 Aug; production runs on the laptop, **physically in the United States**,
pending a Yandex Cloud grant.

`privacy.html:53` was the page telling the truth («за пределами Российской
Федерации»). Two public indexable pages on one domain disagreeing about a
compliance claim.

The claim lived in **eight** places, not one: meta description, og:description,
the intro plate, the hero spec list, the section `h2`, trust claim 01, the drawn
record's region chip, and the footer badge. The meta and og descriptions
mattered most — those were the version in search snippets and every messenger
link preview.

`privacy.html` now names the country and labels it a cross-border transfer.

**«Российский провайдер» for the assistant was verified TRUE and left alone** —
the endpoint really is `llm.api.cloud.yandex.net`
(`backend/services/yandex-gpt.ts:19`).

**Order of operations that mattered:** `llms.txt` and the JSON-LD were written
but deliberately NOT shipped while the page was still false. Their entire
function is to restate the page's claims in the form machines quote verbatim —
shipping them then would have made a false compliance claim *more* citable.
`llms.txt` now closes with an explicit note asking that the hosting answer not
be shortened to «данные в России», because that is exactly the compression an
assistant would apply.

---

## 3. SEO/GEO

**The one that was actively harmful:** the static server answered *every*
unknown path with **200 + the homepage** — an SPA fallback inherited from the
nginx config, for a site with no client router. So `/.env`, `/wp-login` and
every scanner probe recorded a hit, and every typo became a soft 404 indexed as
a duplicate homepage. Now 404 with a real page that renders off `base.css`
alone.

**Two MIME types the server never had**, both found by `curl -I` rather than by
looking:
- `.xml` — `sitemap.xml` went out as `application/octet-stream`. Crawlers may
  refuse a sitemap on content type alone, so the sitemap shipped an hour earlier
  was probably being ignored.
- `.webp` — **every hero image, including the preloaded LCP element**, was
  `application/octet-stream`. Browsers sniff and render anyway, which is exactly
  why it survived unnoticed.

Also shipped: sitemap.xml, robots.txt with a `Sitemap:` line and named
AI-crawler allows, canonicals on `/register` and `/verify`, meta descriptions on
`/verify` and `/i`, and the duplicate `<h1>` demoted on both of those pages
(each shipped two because both view states live in the source at once).

Deleted 179 KB of unreferenced files: `css/main.css`, `img/hero-bg.jpg`,
`img/logo.png`. Verified unreferenced across `website/`, `src/`, `backend/` and
`dist/` first — backend email templates being the usual hiding place for a stray
logo URL. All git-tracked, so recoverable.

**Still open:** `og:image` (every link paste is a bare text card), and `.reveal`
starting at `opacity: 0` means a *rendering* crawler that never scrolls sees an
invisible page.

**Cloudflare purge owed:** `hero-bg.jpg` went out under `max-age=2592000,
immutable` from before the headers were softened, and the old webp content-type
is cached at the edge. Origin is correct for both.

---

## 4. Auth audit — five read-only investigators

Prompted by a viral "five things Claude forgot" checklist. **Scored two outright
false, two mostly false, one half true against this codebase.** Worth recording
because the same list will come back.

| Claim | Verdict |
|---|---|
| Token in localStorage → XSS | **FALSE.** `localStorage` appears **zero times** in the repo. Bearer JWT → `expo-secure-store`. No cookies at all, so no CSRF surface. Stateful sessions: every request re-checks the session row, so revocation works. There is no web login page. |
| Admin check client-side | **FALSE.** One global Fastify `preHandler`, 8 roles / 18 capabilities, fails closed twice (unmapped action → `org.manage`; unknown role → zero capabilities). Every client `isAdmin` has a server mirror. |
| No 2FA/OTP | **PARTIALLY.** Email OTP exists (SHA-256 at rest, 10-min TTL, single-use, 5 attempts). No second factor at login — true. |
| Login/reset missing rate limiting | **FALSE for login** — 5/15min keyed on IP **+ email**, plus DB lockout 10 failures/30min. Password reset has none *because the endpoint does not exist at all*. |
| No client password rules, no leak check | **PARTIALLY.** Rules correct on `register.html` and `InviteScreen.tsx`; leak check genuinely absent. |

### Fixed this session (`c6f959f`) — 1835 tests pass, typecheck clean

1. **bcrypt 72-byte truncation.** `PasswordSchema` capped 100 *characters*;
   bcrypt reads exactly 72 *bytes*. Verified by running it: a 72-byte prefix
   collision authenticates, and because UTF-8 Cyrillic is 2 bytes/char a Russian
   passphrase was truncated at **~36 characters**. Now measured in bytes and
   refused. **The `.refine()` must come last — it returns `ZodEffects`, which
   has no `.regex()`.**
2. **`sequences.ts:120` checked `visibility.all` instead of `sequences.manage`.**
   Not the same set: `accountant` holds the first and not the second, so a role
   documented "deliberately no writes at all" passed a gate whose own error says
   only owner or admin.
3. **Lockout timing oracle.** `verifyPasswordWithLockout` returned before
   `bcrypt.compare` on the locked path — ~5 ms vs ~300 ms behind an identical
   401. Compare now runs first, result discarded.
4. **`src/app/set-password.tsx` was length-only.** Rule now lives in
   `src/utils/password.ts`, imported by both client screens.
   **`Buffer` does not exist in React Native and this project ships no
   polyfill** — the obvious `Buffer.byteLength` would have thrown
   `ReferenceError` on device. Counts UTF-8 bytes by hand.

Added `tests/unit/backend/password-policy.test.ts`. The pre-existing case named
*"refuses a password longer than the bcrypt-safe cap"* submits 204 chars, which
the length limit catches — **it never exercised the byte rule it was named
for.** A test asserting a guarantee the code did not provide.

### NOT fixed — owner is taking these

1. **Invite path mints a session token for an unverified account.**
   `invites.ts:672` signs the token, `authenticate.ts:386` never re-checks
   verification, `/auth/join` re-issues forever. An invite holder can put any
   email on the account, never prove it, and use the CRM indefinitely. **This is
   the real "sign up as anybody" and it is live.**
2. `resendVerification` is an unauthenticated enumeration oracle
   (distinguishable 404/409/400, can trigger mail to arbitrary accounts).
3. No breach/dictionary screening — `Password1!` passes every path. **Do not
   wire HaveIBeenPwned**: US-fronted, breaks the Russian-providers rule. Offline
   blocklist in the shared zod `.refine()` instead, inherited by all four paths.
4. Rate-limit buckets are in-process — every deploy hands out a fresh budget.
5. `TRUSTED_PROXY` correct in the running process but **absent from the root
   `.env`** — a deploy from that file collapses every per-IP bucket into one.
6. Sequences denials still unaudited (missing `adminRoutePolicy` entry the file
   documents about itself).
7. Team admin runs on raw role strings outside the capability layer.
8. Path-regex read gates miss any future `/deals/<a>/<b>` GET.
9. Tenant scoping repeated per-query with no chokepoint.
10. No password recovery at all; `docs/architecture/api-design.md:44` documents
    two endpoints that do not exist.
11. No CSP on the static site.

---

## 5. Corrections to prior notes

- **The ~11px mobile overflow from `.asst-chat` is GONE.** That class and every
  `--reveal-x` no longer exist in `sections.css`; the section was rebuilt.
  Verified at 390px: `scrollWidth === 390`.
- **chrome-devtools MCP worked fine all session** against `localhost:8080`,
  `https://4kub.ru` and even `file://`. The prior note to prefer Playwright was
  about the *claude-in-chrome extension*, which did fail to connect. Screenshots
  do hang intermittently (~120s) and need a `TaskStop` + retry.
- Serving standalone repros: a local `python -m http.server` in `crm/` works,
  and `@font-face` data-URIs make a study file work over `file://` too. Chrome
  caches `file://` aggressively — a stale tab needs Ctrl+Shift+R.

---

## 6. Invite flow, documented because it was asked

Not a defect, just poorly known. Adding a person: **Настройки → Команда →
«Добавить сотрудника»** → name + role → «Создать ссылку» → the link is shown
**once** (`linkSaved` guards the close) → Копировать / Поделиться.

Three different clocks, and the derivation is load-bearing:

| | Lives |
|---|---|
| The link | **24 h** (`INVITE_TTL_MS`) |
| Claim code | 45 min (`CLAIM_TTL_MS = INSTALL_BUDGET_MS + ACCEPT_TTL_MS`) |
| Accept form | 30 min (`ACCEPT_TTL_MS`) |

`CLAIM_TTL` is *derived* rather than declared, so the code that buys a new form
always outlives the form. As two independent constants (15 and 30) the recovery
window was **empty, not narrow** — and no test caught it because none asked what
happens at `t = I + ε`.

The invitee does **not** need the app pre-installed: the landing page detects
platform, offers the right store, and the handoff survives the install — Android
via `?referrerId=`, iOS via clipboard (no install-referrer API), with the
6-character code as the manual fallback. Alphabet excludes `O/0` and `I/1/l`
because people retype it across phones. Caveat: opening the link on a desktop
and installing on a phone breaks the clipboard path — manual code only.
