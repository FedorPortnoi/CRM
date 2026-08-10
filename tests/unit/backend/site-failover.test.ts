import { describe, expect, it } from 'vitest';
// The failover Worker's decision logic. Imported as plain module functions: the
// root vitest config excludes workers/** as a TEST location, which says nothing
// about importing from it, and these are the parts worth asserting without a
// Workers runtime.
import {
  isFailoverPath,
  isOriginFailure,
  isStorable,
  shouldRefresh,
  snapshotFrom,
} from '../../../workers/site-failover/src/index.js';

function response(status: number, headers: Record<string, string>): Response {
  // 204 and 304 are null-body statuses and the Response constructor refuses a
  // body for them, which is also why the Worker never reads one.
  const body = status === 204 || status === 304 ? null : '<!doctype html>';
  return new Response(body, { status, headers });
}

describe('site failover worker', () => {
  it('keeps a copy of only the pages a stranger can usefully land on', () => {
    /* The allowlist is in code because it CANNOT be in the routes: Cloudflare
       matches a route against the whole URL and refuses a '?' in a pattern, so
       only a trailing '*' matches a URL with a query string. The routes are
       therefore /*, and this is what narrows them. */
    expect(isFailoverPath('/')).toBe(true);
    expect(isFailoverPath('/privacy')).toBe(true);
    expect(isFailoverPath('/css/base.css')).toBe(true);

    // The CRM the phones talk to. It also has a route pointing at no Worker,
    // so this is the second lock on the same door.
    expect(isFailoverPath('/api/v1/auth/login')).toBe(false);
    expect(isFailoverPath('/health')).toBe(false);
    // Forms that cannot work while the API is down would only LOOK like they
    // worked, and /i renders a live claim code.
    expect(isFailoverPath('/register')).toBe(false);
    expect(isFailoverPath('/verify')).toBe(false);
    expect(isFailoverPath('/i')).toBe(false);
  });

  it('treats only a missing or 5xx answer as the origin being down', () => {
    // Cloudflare answers 502 when the tunnel has no origin behind it; a fetch
    // that throws arrives here as null.
    expect(isOriginFailure(null)).toBe(true);
    expect(isOriginFailure(response(502, {}))).toBe(true);
    expect(isOriginFailure(response(523, {}))).toBe(true);

    /* A 404 is the origin working correctly and must NOT trigger a snapshot —
       serving a cached homepage in place of a real 404 would resurrect the soft
       404 that static-server.js deleted on purpose. Same for a 304 and a 301. */
    expect(isOriginFailure(response(404, {}))).toBe(false);
    expect(isOriginFailure(response(304, {}))).toBe(false);
    expect(isOriginFailure(response(200, {}))).toBe(false);
  });

  it('never keeps a copy of a page the origin marked no-store', () => {
    const html = { 'content-type': 'text/html; charset=utf-8' };

    /* /i renders a live invite claim code. This is the assertion that keeps
       this Worker from becoming the place that caches it, and it works off the
       header the origin already sends rather than a second list of paths that
       could drift from it. */
    expect(isStorable(response(200, {
      ...html,
      'cache-control': 'no-store, no-cache, must-revalidate, no-transform',
    }), 'GET')).toBe(false);

    expect(isStorable(response(200, {
      ...html,
      'cache-control': 'public, max-age=0, must-revalidate, no-transform',
    }), 'GET')).toBe(true);

    expect(isStorable(response(200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    }), 'GET')).toBe(true);

    /* HEAD answers 200 with the right type and NO BODY. Storing one would
       replace a good snapshot with an empty string, and nothing would look
       wrong until the origin went down and the fallback served a blank page. */
    expect(isStorable(response(200, {
      ...html,
      'cache-control': 'public, max-age=0, must-revalidate',
    }), 'HEAD')).toBe(false);

    // Nothing else is worth keeping: a font or an image missing during an
    // outage costs appearance, not readability.
    expect(isStorable(response(200, { 'content-type': 'font/woff2' }), 'GET')).toBe(false);
    expect(isStorable(response(404, html), 'GET')).toBe(false);
  });

  it('leaves the ordinary request a bare proxy, refreshing only now and then', () => {
    /* Every line that runs on a healthy request is a line that can fail on a
       healthy request. Cloning the body and touching KV on every view is work
       on the critical path of a page that is almost always fine, so it happens
       at most four times an hour per isolate. */
    const hour = 3600000;
    expect(shouldRefresh(hour, 0, 900000)).toBe(true);          // first view
    expect(shouldRefresh(hour, hour - 1000, 900000)).toBe(false); // just did it
    expect(shouldRefresh(hour, hour - 900000, 900000)).toBe(true);
  });

  it('carries the policy into the snapshot, or the page blocks its own scripts', () => {
    const csp = "default-src 'self'; script-src 'self' 'sha256-abc='";
    const snap = snapshotFrom(response(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      etag: '"abc"',
    }), '<!doctype html>', '2026-08-10T00:00:00.000Z');

    // snapshotFrom builds its header map by iterating a list, so TypeScript
    // infers `{}` for it; a header map is open-ended by nature.
    const headers = snap.headers as Record<string, string | undefined>;
    expect(headers['content-security-policy']).toBe(csp);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(snap.etag).toBe('"abc"');
    expect(snap.savedAt).toBe('2026-08-10T00:00:00.000Z');
  });
});
