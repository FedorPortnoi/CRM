/**
 * Keeps 4kub.ru readable while the origin is unreachable.
 *
 * WHY THIS EXISTS. The origin is a laptop behind a cloudflared tunnel. When it
 * is off — power, lid, ISP, a tunnel that has not reconnected yet — Cloudflare
 * answers `error code: 502` in Times New Roman, to everyone, including whoever
 * clicked an App Store link for the first time. Cloudflare sells the cure as
 * "Always Online", which is a toggle in a dashboard this deployment holds no
 * credential for: the cloudflared token, the wrangler OAuth token and the DNS
 * token were each tried against /zones/{id}/settings and each answered 9109
 * "Unauthorized to access requested resource". So it is built here instead,
 * out of the permissions that ARE on the box.
 *
 * WHAT IT DOES. Every routed request goes to the origin exactly as before. When
 * the origin answers, the response is passed through untouched and — in the
 * background, off the visitor's critical path — a copy is kept in KV. When the
 * origin does NOT answer, the last copy is served instead of the 502.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. The routes are the four public documents
 * and the stylesheets, and nothing else. /api/* is the CRM that real phones
 * talk to; putting it behind a Worker would mean a bug here, or the free plan's
 * daily request ceiling, could take the product down to save a marketing page.
 * That trade is not worth making, so the API never reaches this code.
 *
 * SAFETY. passThroughOnException() is the first statement: if anything in here
 * throws, Cloudflare forwards the request to the origin and the visitor gets
 * exactly what they would have got with no Worker at all. The failure mode of
 * this file is "no Worker", not "no site".
 */

/**
 * The paths this Worker is allowed to keep and serve a copy of.
 *
 * THE ALLOWLIST LIVES HERE, NOT IN THE ROUTE PATTERNS, and that is forced.
 * Cloudflare matches a route against the whole URL and refuses a `?` inside a
 * pattern (API error 10022), so only a pattern ending in `*` can ever match a
 * URL carrying a query string — `4kub.ru/` does not match `4kub.ru/?utm_source=x`.
 * Measured with the origin stopped: the bare homepage served its copy, the same
 * URL with one tracking parameter got the 502. Since every ad, share and
 * campaign link arrives with a query string, the routes have to be `/*`, and
 * the narrowing has to happen in code.
 *
 *   /          the page a stranger lands on
 *   /privacy   the URL App Store and RuStore reviewers fetch
 *   /css/…     without which a served page is readable but plain
 *
 * Everything else is proxied and never stored. /register and /verify are
 * deliberately absent: their forms cannot work while the API is down, so a
 * cached copy would only look like it worked. /i renders a live claim code.
 */
export function isFailoverPath(pathname) {
  return pathname === '/' || pathname === '/privacy' || pathname.startsWith('/css/');
}

/** Origin is considered down when it cannot answer, or answers 5xx. */
export function isOriginFailure(response) {
  return !response || response.status >= 500;
}

/**
 * Whether a healthy response is worth keeping a copy of.
 *
 * `no-store` is the important exclusion and it is not a guess: /i renders a
 * live invite claim code and says so in its own headers. Honouring the header
 * the origin already sends means this list cannot drift from that decision.
 */
export function isStorable(response, method) {
  if (!response || response.status !== 200) return false;
  /* GET only. A HEAD answers 200 with the right content-type and NO BODY, so
     without this the first monitoring probe or link-checker would overwrite a
     good snapshot with an empty string — and nothing would look wrong until
     the origin went down and the fallback served a blank page. */
  if (method !== 'GET') return false;
  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  if (cacheControl.includes('no-store')) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  return type.startsWith('text/html') || type.startsWith('text/css');
}

/**
 * Headers worth carrying into a snapshot.
 *
 * The CSP is not optional decoration here: the pages carry inline scripts whose
 * hashes live in that header, so a snapshot served without it is a page whose
 * own scripts are blocked. The rest is the site's security set, which should
 * not quietly weaken just because the origin is down.
 */
const KEPT_HEADERS = [
  'content-type',
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'x-frame-options',
  'permissions-policy',
];

export function snapshotFrom(response, body, now) {
  const headers = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return { body, headers, etag: response.headers.get('etag') || '', savedAt: now };
}

async function refresh(env, key, response, now) {
  const body = await response.text();
  // An empty snapshot is worse than none: it would serve a blank page at the
  // exact moment the fallback is meant to prove itself.
  if (!body) return;
  const etag = response.headers.get('etag') || '';

  /* Written only when the bytes have actually changed. KV allows a thousand
     writes a day on this plan and a crawler on the homepage would spend them
     in an afternoon; a read to avoid a write is the cheap side of that trade. */
  const previous = await env.SNAPSHOTS.get(key, { type: 'json' });
  if (previous && etag && previous.etag === etag) return;

  await env.SNAPSHOTS.put(key, JSON.stringify(snapshotFrom(response, body, now)));
}

/**
 * When this isolate last took a copy OF EACH PATH. Module scope, so it survives
 * between requests on the same isolate and costs no storage to consult.
 *
 * The point is to make the ordinary request as close to a bare proxy as it can
 * be: fetch, return, done. Cloning a body and touching KV on every single view
 * is work on the critical path of a page that is almost always healthy, and
 * every line that runs there is a line that can fail there. A snapshot up to a
 * quarter of an hour behind is still an excellent answer to "the laptop is
 * off", and refresh() re-checks the ETag when it does run, so a stale copy is
 * never written.
 *
 * PER PATH, and that is not a detail. One shared timestamp meant an isolate
 * took at most one copy every fifteen minutes across every route between them,
 * so the homepage kept winning and base.css — which the fallback page needs to
 * look like anything — had no copy at all an hour after deployment. Measured,
 * not theorised: `wrangler kv key list` showed three keys where there should
 * have been six.
 */
const lastRefreshAt = new Map();
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function shouldRefresh(now, last = 0, interval = REFRESH_INTERVAL_MS) {
  return now - last >= interval;
}

export default {
  async fetch(request, env, ctx) {
    // First statement, on purpose. See SAFETY above.
    ctx.passThroughOnException();

    if (request.method !== 'GET' && request.method !== 'HEAD') return fetch(request);

    const url = new URL(request.url);
    /* Anything outside the allowlist leaves this Worker as a bare proxy on the
       first line it can. /api/* is the CRM that real phones talk to; it also
       has a route of its own pointing at no Worker, so it should not reach
       here at all — this is the second lock on the same door. */
    if (!isFailoverPath(url.pathname)) return fetch(request);
    // Keyed without the hostname so 4kub.ru and www.4kub.ru share one copy —
    // they serve the same files, and two keys would mean two chances of one
    // being empty when it is needed.
    const key = `page:${url.pathname}`;

    let response = null;
    try {
      response = await fetch(request);
    } catch {
      response = null; // tunnel down: no answer at all rather than a 5xx
    }

    if (!isOriginFailure(response)) {
      const now = Date.now();
      if (shouldRefresh(now, lastRefreshAt.get(key) || 0) && isStorable(response, request.method)) {
        lastRefreshAt.set(key, now);
        ctx.waitUntil(refresh(env, key, response.clone(), new Date(now).toISOString()));
      }
      return response;
    }

    const snapshot = await env.SNAPSHOTS.get(key, { type: 'json' });
    if (!snapshot) return response || new Response('origin unreachable', { status: 502 });

    return new Response(snapshot.body, {
      status: 200,
      headers: {
        ...snapshot.headers,
        /* Never let an emergency copy be cached by anything downstream. The
           moment the origin is back, the next request must reach it. */
        'Cache-Control': 'no-store, no-transform',
        // So "is this live?" is answerable from `curl -I` rather than by eye.
        'X-Origin-Snapshot': snapshot.savedAt,
      },
    });
  },
};
