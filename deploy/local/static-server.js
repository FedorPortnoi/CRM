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
const {
  assetVersion,
  baseSecurityHeaders,
  documentForFile,
  notFoundHeaders,
  responseHeaders,
} = require('./static-headers');

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

/**
 * The current content hash of the file a page's reference points at.
 *
 * Resolution goes through resolveFile(), the same function that will answer the
 * request for that URL — so the bytes a stamp names and the bytes the next
 * request receives cannot be resolved differently. Null when the reference
 * names nothing on disk, which stampAssetVersions() reads as "leave this one
 * alone".
 */
function versionFor(urlPath) {
  try {
    const abs = resolveFile(urlPath);
    return abs ? assetVersion(abs) : null;
  } catch {
    return null;
  }
}

/**
 * Send a file as a stream, without letting one unreadable file take the site
 * down with it.
 *
 * A ReadStream's 'error' event is NOT forwarded by pipe(), and an 'error' with
 * no listener is rethrown — so a locked or vanished file was an uncaught
 * exception in a request handler, which is a PM2 restart of the public website.
 * The response is already committed by then (the head is out), so there is no
 * status code left to send: destroying the socket is the only honest signal,
 * and it is the one a client reads as a failed transfer rather than a complete
 * short file.
 *
 * The 'close' handler is the other direction — a visitor who navigates away
 * mid-download would otherwise leave the descriptor open until GC.
 */
function sendFile(file, res) {
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * If-None-Match is defined to use the WEAK comparison function (RFC 9110
 * §8.8.3.2), so `W/"x"` and `"x"` are a match. String equality is not merely
 * pedantically wrong here: this origin sits behind Cloudflare, which rewrites
 * index.html's mailto and may weaken the validator on the way past. Comparing
 * strictly would then answer 200 with a full page to every conditional request
 * that should have cost a 304.
 */
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === bare(etag));
}

const server = http.createServer((req, res) => {
  const target = req.url || '/';
  const mark = target.indexOf('?');
  const urlPath = mark === -1 ? target : target.slice(0, mark);
  // slice, not split('?')[1]: a second '?' is legal inside a query string and
  // splitting would drop everything after it.
  const query = new URLSearchParams(mark === -1 ? '' : target.slice(mark + 1));
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
      const doc404 = documentForFile(notFound, null, versionFor);
      if (doc404) {
        headers404['Content-Security-Policy'] = doc404.csp;
        headers404['Content-Length'] = doc404.body.length;
        res.writeHead(404, headers404);
        res.end(doc404.body);
        return;
      }
      res.writeHead(404, headers404);
      sendFile(notFound, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', ...baseSecurityHeaders() }).end('Not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();

  /* Between resolveFile()'s stat and this one the file can be renamed by an
     editor writing in place. That was an uncaught throw inside a request
     handler — the one shape that takes the whole public site down rather than
     one response with it. */
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...baseSecurityHeaders() }).end('Not found');
    return;
  }

  /* An asset is `immutable` only when the stamp on the URL is the hash of the
     file about to be sent — see the ?v= discussion in static-headers.js. The
     hash is computed solely for requests that carry a stamp, so pages, fonts
     and everything else never pay for it. */
  const requestedVersion = query.get('v');
  const pinned = Boolean(requestedVersion) && requestedVersion === assetVersion(file, stat);

  /* Content type, the security set and the caching rules, in that order — see
     responseHeaders(). Content-Security-Policy is added further down, with the
     body, because its hashes come from the bytes being served. */
  const headers = responseHeaders(urlPath, ext, { pinned });

  /* Conditional requests, so a `must-revalidate` asset costs a 304 rather than
     a fresh copy on every page view. nginx did this for free and this file is
     meant to match it. For an asset the validator is mtime + size, which is
     what nginx's own weak ETag is built from; a page overrides it below with a
     hash of the bytes it actually sends, because those bytes move when a
     stylesheet moves and the file's own mtime does not. */
  const lastModified = stat.mtime.toUTCString();
  let etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

  /* Documents only. A CSP on a stylesheet or a woff2 governs nothing, and the
     hashes cost a synchronous read of the file — cheap and memoised on
     (mtime, size), but not worth spending on every asset. `document` is null
     only when the page could not be read at this instant, in which case it is
     streamed from disk unstamped and without a policy; see documentForFile(). */
  const document = ext === '.html' ? documentForFile(file, stat, versionFor) : null;
  if (document) {
    headers['Content-Security-Policy'] = document.csp;
    etag = document.etag;
  }

  headers['Last-Modified'] = lastModified;
  headers['ETag'] = etag;

  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  // Never 304 a no-store response: /i renders a claim code, and answering "use
  // your copy" is only safe if a copy was allowed to exist in the first place.
  const storable = !String(headers['Cache-Control'] || '').includes('no-store');
  // If-None-Match wins outright when present; that is the rule in RFC 9110.
  const fresh = storable && (inm
    ? etagMatches(inm, etag)
    : Boolean(ims) && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000);

  if (fresh) {
    // A 304 carries no body, and must not claim a Content-Length for one.
    delete headers['Content-Type'];
    res.writeHead(304, headers);
    res.end();
    return;
  }

  /* Declared rather than left to chunked transfer encoding. A response cut off
     mid-flight — which is the normal failure of a tunnel that drops several
     times a day — is then short by a length the client was told to expect, so
     it is a failed transfer everywhere instead of a judgement call. */
  if (document) {
    headers['Content-Length'] = document.body.length;
    res.writeHead(200, headers);
    res.end(document.body);
    return;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  sendFile(file, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`static server: http://127.0.0.1:${PORT} serving ${ROOT}`);
});
