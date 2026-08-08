/**
 * Security response headers for the static site.
 *
 * Split out of static-server.js on purpose. That file calls `server.listen()` at
 * top level, and port 8080 is held by the live PM2 `crm-static` process — a test
 * that required it would EADDRINUSE against production. Guarding the listen with
 * `require.main === module` is NOT an acceptable alternative: PM2 fork mode
 * loads the script through its own ProcessContainerFork, and betting the whole
 * public website on that internal staying true is the same shape as the failures
 * this deployment has already collected (see the node_args note in
 * ecosystem.config.js). A separate module has no such failure mode.
 *
 * Dependency-free for the same reason static-server.js is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE HASHES ARE DERIVED AND NEVER WRITTEN DOWN
 *
 * A stale hash on index.html costs an animation. A stale hash on register.html,
 * verify.html or i.html takes registration, email verification and invite claim
 * down for every new user, with no server error, nothing in logs/static-error.log
 * and no failing check anywhere — the only evidence is a console message on the
 * visitor's machine. This site already shipped a hand-maintained `?v=` counter
 * that was missed twice (static-server.js:116-129); the same mistake with a hash
 * is not a stale stylesheet, it is a silent signup outage that could run for
 * days. So the hashes are computed from the bytes actually being served, on
 * every change to those bytes, and there is no list for anyone to forget.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Script types a browser will EXECUTE. Everything else in a <script> element is
 * a data block — `application/ld+json` on index.html:52 is the one here — and a
 * browser never applies CSP to it, so hashing it would add a permitted digest
 * for content that is never run. An absent `type` means classic JavaScript.
 */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/**
 * THE TRAP THIS FUNCTION EXISTS FOR.
 *
 * Every .html file in website/ is CRLF on disk (core.autocrlf=true, and the
 * files are served straight out of the working tree). CSP hashes "the element's
 * child text content" — but the HTML parser's input stream preprocessing
 * (HTML Standard 13.2.3.5) has already turned every CRLF and every bare CR into
 * a single LF before tokenisation. So the text a browser hashes never contains
 * a CR, and hashing the raw file bytes yields a digest no browser will ever
 * compute. On a CRLF checkout that is not a subtle weakening — it blocks every
 * inline script on the site.
 *
 * Normalising also makes the answer identical on an LF checkout, so this is
 * correct on both and the deployment's line endings stop being load-bearing.
 */
function normaliseTextContent(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * The surrounding single quotes are part of the grammar, not decoration: CSP's
 * hash-source production is `'sha256-<base64>'`, and Chrome answers a bare
 * sha256-… with "contains an invalid source: … It will be ignored", then blocks
 * the very script the hash was computed for. Emitting these unquoted shipped a
 * policy that was strictly worse than none — every inline script on the site was
 * refused while the header still looked correct in `curl -I`.
 */
function sha256(text) {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * Digests for one inline body: the spec-correct LF-normalised one, plus the raw
 * bytes when they differ.
 *
 * The normalised digest is the one browsers match; the raw one is 48 bytes of
 * insurance against being wrong about the preprocessing on some engine. Both
 * are digests of the SAME script modulo line endings, so the extra entry permits
 * nothing the first does not — it only removes the single way this change is
 * able to take signup down.
 */
function hashesForBody(body) {
  const normalised = normaliseTextContent(body);
  const out = [sha256(normalised)];
  if (body !== normalised) out.push(sha256(body));
  return out;
}

function parseAttributes(attrs) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrs)) !== null) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

/**
 * Inline <script> bodies that a browser will execute, in document order.
 *
 * Elements carrying `src` are external and covered by 'self' — their body is
 * ignored by the parser, so hashing it would be meaningless. Verified against
 * this site: <script> open/close counts match on every page, no inline body
 * contains a literal `</script`, and no `<script` appears inside an HTML comment.
 */
function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttributes(m[1]);
    if (attrs.src) continue;
    if (!EXECUTABLE_SCRIPT_TYPES.has((attrs.type || '').toLowerCase())) continue;
    out.push(m[2]);
  }
  return out;
}

/** Inline <style> bodies, in document order. 404.html:13 is the only one today. */
function extractInlineStyles(html) {
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[2]);
  return out;
}

function scriptHashes(html) {
  return extractInlineScripts(html).flatMap(hashesForBody);
}

/**
 * Unused while style-src keeps 'unsafe-inline' (see cspForDocument). Shipped so
 * that tightening later is a one-line change rather than a rewrite.
 */
function styleHashes(html) {
  return extractInlineStyles(html).flatMap(hashesForBody);
}

/**
 * Headers that go on EVERY response, HTML or not.
 *
 * Returns a fresh object each call — callers mutate it.
 *
 * No Strict-Transport-Security. It is the one header here that cannot be undone
 * by reverting a file: max-age pins in every visitor's browser and outlives the
 * rollback. It belongs to the Cloudflare dashboard toggle and to an explicit
 * decision by the owner, not to this change. includeSubDomains would also
 * capture test.4kub.ru.
 */
function baseSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    // Overridden to 'no-referrer' for /i by static-server.js, which is stricter
    // and must win. That is why this is seeded BEFORE the branch chain there.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Belt to frame-ancestors' braces, for anything that predates CSP Level 2.
    'X-Frame-Options': 'DENY',
    /* clipboard-write is DELIBERATELY ABSENT and must stay absent. i.html:163
       writes the invite handoff to the clipboard, and on iOS that is not a
       convenience — there is no install-referrer API, so the clipboard IS the
       channel the app reads on first launch. clipboard-write defaults to 'self';
       disabling it here would break iOS invite acceptance silently, with no
       error surfaced anywhere. */
    'Permissions-Policy': [
      'accelerometer=()',
      'autoplay=()',
      'browsing-topics=()',
      'camera=()',
      'display-capture=()',
      'encrypted-media=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'usb=()',
      'xr-spatial-tracking=()',
    ].join(', '),
  };
}

/**
 * Content types, by extension. Anything unlisted falls to
 * application/octet-stream — which, now that nosniff is sent, a browser will
 * refuse to render rather than sniff. Adding a file type to website/ means
 * adding it here in the same change.
 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  // Without this, sitemap.xml fell through to application/octet-stream and
  // crawlers are entitled to refuse a sitemap on content type alone.
  '.xml': 'application/xml; charset=utf-8',
  '.webp': 'image/webp',
};

/**
 * Every header a 200 carries except the validators and the CSP — content type,
 * the security set, and the caching rules the nginx vhost had.
 *
 * Pure, and separate from static-server.js, because the ORDER below is
 * load-bearing and an order bug here is invisible. The security defaults are
 * seeded BEFORE the branch chain so that /i can override Referrer-Policy with
 * the stricter 'no-referrer'; seeding them after would silently downgrade the
 * one page on the site that renders a live claim code. A comment cannot fail;
 * a test can, which is the whole reason this is a function you can call.
 */
function responseHeaders(urlPath, ext) {
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    ...baseSecurityHeaders(),
  };

  // App Link / Universal Link association files. iOS refuses an
  // apple-app-site-association served as anything but application/json, and the
  // file has no extension — so the type is forced rather than inferred.
  if (urlPath.startsWith('/.well-known/')) {
    headers['Content-Type'] = 'application/json';
    headers['Cache-Control'] = 'public, max-age=300';
  } else if (urlPath === '/i' || urlPath === '/i.html') {
    // The invite landing page. The token rides in the URL fragment so it never
    // reaches this process at all, but the page renders a claim code, and that
    // must not sit in a shared cache or a back-forward cache.
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers['Referrer-Policy'] = 'no-referrer';
    headers['X-Robots-Tag'] = 'noindex, nofollow';
  } else if (urlPath.startsWith('/fonts/')) {
    // Genuinely immutable: these are pinned subsets, and replacing one would
    // mean a new file. Safe to promise a browser it never has to ask again.
    headers['Cache-Control'] = 'public, max-age=2592000, immutable';
  } else if (['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'].includes(ext)) {
    /* These are edited IN PLACE at a fixed path — website/ is served straight to
       4kub.ru — so the only thing separating a visitor from a stale stylesheet
       is the ?v= query the HTML appends. That is a sound scheme and `immutable`
       is the correct header FOR it, but the counter is bumped by hand and has
       been missed twice: base.css was rewritten for the 2026-08-06 redesign
       while privacy/register/verify/i went on asking for ?v=7, and the 08-07
       clock fix sat on disk behind an unbumped ?v=37. `immutable` makes either
       slip permanent for thirty days, because the browser will not revalidate
       even on a reload.

       So: still cached, but staleness is bounded to five minutes instead of a
       month. A forgotten bump becomes a short delay rather than a silent month
       of serving the wrong site. Restore `immutable` once these carry a content
       hash generated at deploy rather than a number someone remembers. */
    headers['Cache-Control'] = 'public, max-age=300, must-revalidate';
  } else if (ext === '.html') {
    /* The pages carry the ?v= stamps, so a stale page pins stale assets no
       matter how the assets themselves are cached — this is the gate. It used
       to send no Cache-Control at all, which does not mean "do not cache": with
       no explicit policy a browser is free to guess a lifetime from
       Last-Modified, and that guess grows as the file ages. Always revalidate;
       with the ETag alongside that is a 304 and costs nothing. */
    headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
  }

  return headers;
}

/**
 * Headers for the 404 document. Its own function because static-server.js
 * answers 404 from a separate branch that never reaches responseHeaders() —
 * exactly the branch a fix applied only to the 200 path leaves bare — and
 * 404.html is a real document with an inline <style> block, so it needs the
 * same treatment as any other page.
 */
function notFoundHeaders() {
  return {
    'Content-Type': TYPES['.html'],
    'Cache-Control': 'no-store',
    ...baseSecurityHeaders(),
  };
}

/**
 * The policy for one HTML document.
 *
 * Inventory this is built from — the site was rebuilt to make ZERO external
 * requests, which is what makes a policy this tight achievable at all:
 *   scripts  4 inline blocks (index/i/register/verify) + one same-origin
 *            /js/site.js + one ld+json data block that is never executed
 *   styles   6 same-origin stylesheets, 1 inline <style> (404.html),
 *            42 style="" attributes
 *   fonts    8 self-hosted woff2, no external foundry
 *   images   5 local webp, a data: SVG favicon on every page, 4 data: SVG
 *            noise textures in the CSS
 *   network  fetch to /api/v1 only, same origin
 *   absent   no iframes, no workers, no eval/new Function, no on*= handlers,
 *            no javascript: URLs, no <form>, no <video>/<audio>/<object>
 */
function cspForDocument(html) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",

    /* 'self' STAYS in script-src. /js/site.js is an external file, and
       Cloudflare's Email Obfuscation injects
       /cdn-cgi/scripts/.../email-decode.min.js at the edge to decode the mailto
       on index.html:845 — same origin, so 'self' already covers it. A
       hashes-only script-src would take the site's own JavaScript and the mailto
       decoder down together and buy nothing: 'self' here is the whole website,
       which an attacker cannot write to anyway. */
    ["script-src 'self'", ...scriptHashes(html)].join(' '),

    /* style-src keeps 'unsafe-inline', deliberately, and this is a real
       weakening: CSS injection stays possible. It is not cheaply fixable. The 42
       style="" attributes are per-instance custom properties (--x/--y/--d/--n)
       driving the dust and reveal animations and cannot be lifted into a
       stylesheet without 42 generated selectors; 'unsafe-hashes' does not cover
       style ATTRIBUTES portably, and style-src-attr is unsupported in Safari, so
       tightening this blanks the homepage on iOS. With script-src locked down,
       CSS injection cannot reach JavaScript execution. */
    "style-src 'self' 'unsafe-inline'",

    // data: is load-bearing — the favicon on all six pages is a data: SVG, as
    // are the four noise textures in base.css/sections.css.
    "img-src 'self' data:",
    "font-src 'self'",
    // fetch() targets are /api/v1/* on this same origin. This is also what
    // blocks the Cloudflare RUM beacon's telemetry POST.
    "connect-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "worker-src 'none'",
    // Every subresource is already same-origin and https at the edge, so this
    // guards a future mistake rather than anything present. Loopback origins are
    // potentially-trustworthy and are exempt, so http://127.0.0.1:8080 testing
    // is unaffected.
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * One cached entry per path, replaced when the file changes. The key carries
 * mtimeMs AND size so an in-place edit — which is how this site is deployed —
 * invalidates it; a same-size same-second overwrite is the only miss, and the
 * process already stats every file on every request anyway.
 */
const cspCache = new Map();

function cspForFile(absPath, stat) {
  let csp;
  try {
    const st = stat || fs.statSync(absPath);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cspCache.get(absPath);
    if (hit && hit.key === key) return hit.csp;

    csp = cspForDocument(fs.readFileSync(absPath, 'utf8'));
    cspCache.set(absPath, { key, csp });
    return csp;
  } catch {
    /* Fail OPEN. If the file cannot be read at the instant a request lands —
       an editor rewriting it, a lock — the alternative is emitting a policy
       whose hashes were computed from nothing, which blocks the page's own
       scripts. This is a defence-in-depth header on a site that serves fixed
       files off disk; briefly omitting it is strictly less harmful than briefly
       breaking registration. Not cached, so the next request retries.
       This catch also covers the stat itself, so a file that vanishes between
       the caller's existsSync and this call cannot throw out of a request
       handler and take the process down. */
    return null;
  }
}

module.exports = {
  TYPES,
  extractInlineScripts,
  extractInlineStyles,
  normaliseTextContent,
  scriptHashes,
  styleHashes,
  cspForDocument,
  cspForFile,
  baseSecurityHeaders,
  responseHeaders,
  notFoundHeaders,
};
