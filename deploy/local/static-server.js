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
/* Content types, the security set and the caching rules live in static-headers.js
   as pure functions. They are separated so a test can call them: this process
   binds port 8080, which the live PM2 `crm-static` holds, so nothing may require
   THIS file. See the header of that module for why a `require.main === module`
   guard around listen() was not an acceptable alternative. */
const { baseSecurityHeaders, cspForFile, notFoundHeaders, responseHeaders } = require('./static-headers');

const ROOT = path.resolve(__dirname, '../../website');
const PORT = Number(process.env.STATIC_PORT || 8080);

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
      // 404.html is a real document with an inline <style> block, so it needs
      // the same treatment as any other page. This branch never reaches the
      // header assembly below and is invisible to anything applied only there.
      const headers404 = notFoundHeaders();
      const csp404 = cspForFile(notFound);
      if (csp404) headers404['Content-Security-Policy'] = csp404;
      res.writeHead(404, headers404);
      fs.createReadStream(notFound).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', ...baseSecurityHeaders() }).end('Not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  /* Content type, the security set and the caching rules, in that order — see
     responseHeaders(). Content-Security-Policy is added further down, once
     `stat` exists, because its hashes come from the bytes being served. */
  const headers = responseHeaders(urlPath, ext);

  /* Conditional requests, so `must-revalidate` above costs a 304 rather than a
     fresh copy of every stylesheet on every page view. nginx did this for free
     and this file is meant to match it. The validator is mtime + size, which is
     what nginx's own weak ETag is built from. */
  const stat = fs.statSync(file);
  const lastModified = stat.mtime.toUTCString();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  headers['Last-Modified'] = lastModified;
  headers['ETag'] = etag;

  /* Documents only. A CSP on a stylesheet or a woff2 governs nothing, and the
     hashes cost a synchronous read of the file — cheap and memoised on
     (mtime, size), but not worth spending on every asset. Placed after `stat` so
     the cache key is the same validator the ETag above is built from, and it
     rides into the 304 branch below, which reuses this object and so refreshes
     the policy stored against a cached copy. */
  if (ext === '.html') {
    const csp = cspForFile(file, stat);
    if (csp) headers['Content-Security-Policy'] = csp;
  }

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
