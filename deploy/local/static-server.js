/**
 * Serves website/ the way the production nginx vhost does.
 *
 * Self-hosting replaces nginx with cloudflared, and cloudflared is a tunnel, not
 * a web server — it forwards to an origin and does nothing else. So the routing
 * rules that lived in the vhost have to live somewhere, and this is that
 * somewhere. Every behaviour below exists because the nginx config had it; where
 * it differs, that is a bug.
 *
 * Deliberately dependency-free. This process holds no secrets and touches no
 * database — it reads files out of one directory and nothing else — so it should
 * not be able to break in ways a dependency update could cause.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../website');
const PORT = Number(process.env.STATIC_PORT || 8080);

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
 * Resolve a URL path to a file, refusing anything that escapes the web root.
 *
 * The check is on the RESOLVED absolute path, not on the raw string: `..` can
 * arrive percent-encoded, doubled, or mixed with backslashes, and only
 * resolution collapses all of those into one comparable answer. Same reasoning
 * as backend/services/storage.ts, and for the same reason — a prefix test on the
 * un-normalised string is the bug that audit found.
 */
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // malformed escape — refuse rather than guess
  }

  const candidates = [];
  const clean = decoded.replace(/\/+$/, '') || '/';

  if (clean === '/') {
    candidates.push('index.html');
  } else {
    // nginx: try_files $uri $uri.html $uri/ /index.html
    candidates.push(clean.slice(1), `${clean.slice(1)}.html`, path.join(clean.slice(1), 'index.html'));
  }

  for (const rel of candidates) {
    const abs = path.resolve(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) continue; // escaped the root
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const file = resolveFile(urlPath);

  if (!file) {
    // Was an SPA fallback answering 200 with the homepage. There is no client
    // router on this site, so that bought nothing and cost real damage: every
    // scanner probe for /.env or /wp-login recorded a hit, and every mistyped
    // URL became a soft 404 that search engines index as a duplicate of the
    // homepage. Answer 404 with a 404, and serve a real page while doing it.
    const notFound = path.join(ROOT, '404.html');
    if (fs.existsSync(notFound)) {
      res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      fs.createReadStream(notFound).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };

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
       with the ETag below that is a 304 and costs nothing. */
    headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
  }

  /* Conditional requests, so `must-revalidate` above costs a 304 rather than a
     fresh copy of every stylesheet on every page view. nginx did this for free
     and this file is meant to match it. The validator is mtime + size, which is
     what nginx's own weak ETag is built from. */
  const stat = fs.statSync(file);
  const lastModified = stat.mtime.toUTCString();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  headers['Last-Modified'] = lastModified;
  headers['ETag'] = etag;

  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  // Never 304 a no-store response: /i renders a claim code, and answering "use
  // your copy" is only safe if a copy was allowed to exist in the first place.
  const storable = !String(headers['Cache-Control'] || '').includes('no-store');
  // If-None-Match wins outright when present; that is the rule in RFC 9110.
  const fresh = storable && (inm
    ? inm.split(',').some((t) => t.trim() === etag)
    : Boolean(ims) && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000);

  if (fresh) {
    // A 304 carries no body, and must not claim a Content-Length for one.
    delete headers['Content-Type'];
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`static server: http://127.0.0.1:${PORT} serving ${ROOT}`);
});
