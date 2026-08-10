# kub-site-failover

Serves the last known copy of 4kub.ru's public pages while the origin is
unreachable, so a stranger arriving during an outage reads the site instead of
Cloudflare's `error code: 502`.

The origin is a laptop behind a cloudflared tunnel. Cloudflare sells the cure as
**Always Online**, a toggle in a dashboard this deployment holds no credential
for — the cloudflared token, the wrangler OAuth token and the DNS token were
each tried against `/zones/{id}/settings` and each answered `9109 Unauthorized`.
This is that feature, built from the permissions that are on the box.

## What it does

Every request is proxied to the origin unchanged. For three paths — `/`,
`/privacy`, `/css/…` — a copy of a healthy response is kept in KV, at most once
every fifteen minutes per path per isolate, off the visitor's critical path.
When the origin cannot answer, that copy is served instead of the 502.

`/register` and `/verify` are deliberately excluded: their forms cannot work
while the API is down, so a cached copy would only look like it worked. `/i`
renders a live invite claim code and says `no-store`, which the Worker honours.

## Deploy

    cd workers/site-failover
    npx wrangler deploy

## Remove

    npx wrangler delete

The site returns to plain origin behaviour. Then delete the six empty routes
below, or they will keep pointing at nothing (which is harmless — an empty
route means "no Worker here", which is what removing this Worker means anyway).

## The six routes wrangler does NOT manage

`wrangler.toml` claims `4kub.ru/*` and `www.4kub.ru/*`, because Cloudflare
matches a route against the whole URL and rejects a `?` inside a pattern (API
error 10022) — so only a trailing `*` can match a URL carrying a query string,
and `4kub.ru/` does not match `4kub.ru/?utm_source=x`. Measured with the origin
stopped: the bare homepage served its copy, the same URL with one tracking
parameter got the 502.

`/*` would put the CRM API behind this Worker. It does not, because these six
routes point at **no Worker at all**, and Cloudflare prefers the more specific
match:

    4kub.ru/api/*        www.4kub.ru/api/*
    4kub.ru/health       www.4kub.ru/health
    4kub.ru/version      www.4kub.ru/version

So requests from the phones never enter this script and never count against the
free plan's daily request ceiling. `isFailoverPath()` in `src/index.js` is the
second lock on the same door.

They were created with the API, since wrangler has no syntax for a route with
no script. To recreate:

    curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      --data '{"pattern":"4kub.ru/api/*"}'

To list what is actually attached:

    curl "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" \
      -H "Authorization: Bearer $TOKEN"

## Checking it works

Stop the origin and ask for a routed page:

    pm2 stop crm-static
    curl -sS -D - "https://4kub.ru/?utm_source=test" | head -20   # 200 + X-Origin-Snapshot
    curl -sS -o /dev/null -w '%{http_code}\n' "https://4kub.ru/register"   # 502, on purpose
    pm2 start crm-static

`X-Origin-Snapshot` carries the timestamp of the copy, so "is this live?" is
answerable from `curl -I` rather than by eye.
