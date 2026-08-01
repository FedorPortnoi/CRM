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
    // The SPA fallback nginx used. Note it answers 200, not 404 — that is
    // deliberate there and copied here so behaviour does not change during the
    // move, but it is why scanners record a "hit" on /.env and similar.
    const fallback = path.join(ROOT, 'index.html');
    if (fs.existsSync(fallback)) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      fs.createReadStream(fallback).pipe(res);
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
  } else if (urlPath === '/i') {
    // The invite landing page. The token rides in the URL fragment so it never
    // reaches this process at all, but the page renders a claim code, and that
    // must not sit in a shared cache or a back-forward cache.
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers['Referrer-Policy'] = 'no-referrer';
    headers['X-Robots-Tag'] = 'noindex, nofollow';
  } else if (['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2'].includes(ext)) {
    headers['Cache-Control'] = 'public, max-age=2592000, immutable';
  }

  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`static server: http://127.0.0.1:${PORT} serving ${ROOT}`);
});
