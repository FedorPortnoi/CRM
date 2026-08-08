import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfigurationError,
  getCorsOrigin,
  getDeploymentSafeUrl,
  getJwtSecret,
  getRequiredSecret,
  getTokenEncryptionSecret,
  getYandexWebhookSecret,
  validateProductionConfig,
} from '../../../backend/config/security';
// The static site's response headers. Imported from static-headers.js and never
// from static-server.js: that file calls server.listen(8080) at top level and
// 8080 is held by the live PM2 `crm-static` process, so requiring it here would
// EADDRINUSE against production.
import {
  baseSecurityHeaders,
  cspForDocument,
  cspForFile,
  notFoundHeaders,
  responseHeaders,
} from '../../../deploy/local/static-headers';

const jwtSecret = 'j'.repeat(32);
const tokenEncryptionKey = 't'.repeat(32);
const webhookSecret = 'w'.repeat(32);

function validProductionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    JWT_SECRET: jwtSecret,
    TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    YANDEX_WEBHOOK_SECRET: webhookSecret,
    CRM_CORS_ORIGINS: 'https://app.example.com',
    DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@db.example.com:5432/crm_db',
    // Load-bearing, and not decoration. validateProductionConfig now refuses a
    // production env with no TRUSTED_PROXY, so leaving it out of the BASE would
    // make every other case in this file throw the proxy error instead of the
    // one it names. The `.toThrow(ConfigurationError)` assertions would all stay
    // green while asserting something entirely different — a passing suite
    // measuring the wrong thing, which is the exact failure this codebase keeps
    // collecting. Each proxy test below overrides this explicitly.
    TRUSTED_PROXY: '127.0.0.1',
  };

  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

describe('backend security config', () => {
  // ── The self-hosted opt-out ────────────────────────────────────────────────
  // A local DATABASE_URL is normally a deployment mistake worth refusing to boot
  // over: a cloud service pointed at localhost looks perfectly healthy while
  // talking to a database nobody else can reach. It is legitimate in exactly one
  // situation — the whole product running on one machine on purpose — so the
  // escape hatch has to exist, and has to stay narrow.

  it('still refuses a local database host in production by default', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@127.0.0.1:5432/crm_prod',
    }))).toThrow(ConfigurationError);
  });

  it('allows a local database host only when the operator opts in explicitly', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@127.0.0.1:5432/crm_prod',
      ALLOW_LOCAL_DATABASE: 'true',
    }))).not.toThrow();
  });

  it('accepts only the exact string "true" as the opt-in', () => {
    // Anything else is treated as "not set". A half-hearted value like `1` or
    // `yes` should not silently disable a production guard.
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', '']) {
      expect(() => validateProductionConfig(validProductionEnv({
        DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@127.0.0.1:5432/crm_prod',
        ALLOW_LOCAL_DATABASE: value,
      })), `ALLOW_LOCAL_DATABASE=${JSON.stringify(value)}`).toThrow(ConfigurationError);
    }
  });

  it('does not let the opt-in weaken any OTHER production check', () => {
    // The flag covers the private-host rule and nothing else. A weak password or
    // a missing secret must still stop the boot even on a self-hosted box.
    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://crm_user:password@127.0.0.1:5432/crm_prod',
      ALLOW_LOCAL_DATABASE: 'true',
    }))).toThrow(ConfigurationError);

    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@127.0.0.1:5432/crm_prod',
      ALLOW_LOCAL_DATABASE: 'true',
      JWT_SECRET: 'short',
    }))).toThrow(ConfigurationError);
  });

  it('requires JWT_SECRET to be present', () => {
    expect(() => getJwtSecret({} as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it('rejects weak or too-short JWT secrets', () => {
    expect(() => getJwtSecret({ JWT_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
    expect(() => getJwtSecret({ JWT_SECRET: 'x'.repeat(31) } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it('accepts a strong required secret', () => {
    const secret = 'a'.repeat(32);
    expect(getRequiredSecret('JWT_SECRET', {}, { JWT_SECRET: secret } as unknown as NodeJS.ProcessEnv)).toBe(secret);
  });

  it('requires a separate token encryption key in production', () => {
    expect(getTokenEncryptionSecret({
      NODE_ENV: 'development',
      JWT_SECRET: jwtSecret,
    } as NodeJS.ProcessEnv)).toBe(jwtSecret);

    expect(() => getTokenEncryptionSecret({
      NODE_ENV: 'production',
      JWT_SECRET: jwtSecret,
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);

    expect(() => getTokenEncryptionSecret({
      NODE_ENV: 'production',
      JWT_SECRET: jwtSecret,
      TOKEN_ENCRYPTION_KEY: jwtSecret,
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);

    expect(getTokenEncryptionSecret(validProductionEnv())).toBe(tokenEncryptionKey);
  });

  it('requires a strong Yandex webhook secret in production', () => {
    expect(getYandexWebhookSecret({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => getYandexWebhookSecret({
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
    expect(getYandexWebhookSecret(validProductionEnv())).toBe(webhookSecret);
  });

  it('uses practical local CORS defaults outside production', () => {
    expect(getCorsOrigin({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('requires an explicit production CORS allowlist', () => {
    expect(() => getCorsOrigin({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);

    expect(getCorsOrigin({
      NODE_ENV: 'production',
      CRM_CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
    } as NodeJS.ProcessEnv)).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('validates deployment URLs before using them for redirects', () => {
    expect(getDeploymentSafeUrl('CALLBACK_URL', {}, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { CALLBACK_URL: 'not a url' } as unknown as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);

    expect(getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { NODE_ENV: 'production', CALLBACK_URL: 'https://app.example.com/oauth/callback' } as NodeJS.ProcessEnv,
    )).toBe('https://app.example.com/oauth/callback');
  });

  it('rejects unsafe production deployment URLs', () => {
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { NODE_ENV: 'production', CALLBACK_URL: 'http://app.example.com/oauth/callback' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      {},
      { NODE_ENV: 'production', CALLBACK_URL: 'https://localhost/oauth/callback' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
    expect(() => getDeploymentSafeUrl(
      'CALLBACK_URL',
      { requiredInProduction: true },
      { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
  });

  it('allows explicitly allowlisted custom app redirect protocols', () => {
    expect(getDeploymentSafeUrl(
      'SUCCESS_URL',
      { allowedProtocols: ['https:', 'crm:'] },
      { NODE_ENV: 'production', SUCCESS_URL: 'crm://calendar' } as NodeJS.ProcessEnv,
    )).toBe('crm://calendar');
    expect(() => getDeploymentSafeUrl(
      'SUCCESS_URL',
      { allowedProtocols: ['https:', 'crm:'] },
      { NODE_ENV: 'production', SUCCESS_URL: 'javascript:alert(1)' } as NodeJS.ProcessEnv,
    )).toThrow(ConfigurationError);
  });

  it('accepts a complete production security configuration', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      EXPO_PUBLIC_API_URL: 'https://api.example.com/api/v1',
      REDIS_URL: 'rediss://cache.example.com:6379',
      YANDEX_CLIENT_ID: 'client-id',
      YANDEX_CLIENT_SECRET: 'client-secret',
      YANDEX_REDIRECT_URI: 'https://api.example.com/api/v1/calendar/sync/yandex/callback',
      YANDEX_CALENDAR_SUCCESS_URL: 'crm://calendar',
    }))).not.toThrow();
  });

  it('rejects unsafe production database and integration configuration', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      DATABASE_URL: 'postgresql://postgres:password@localhost:5432/crm_db',
    }))).toThrow(ConfigurationError);

    expect(() => validateProductionConfig(validProductionEnv({
      YANDEX_CLIENT_ID: 'client-id',
    }))).toThrow(ConfigurationError);
  });

  // ── TRUSTED_PROXY ──────────────────────────────────────────────────────────
  //
  // The variable was correct in the running process and absent from the repo's
  // own .env, which is the file a hand-started API reads. Unset, request.ip is
  // the cloudflared tunnel's loopback address for every client on Earth: every
  // per-IP rate limit becomes one shared bucket, and every audit row is written
  // 127.0.0.1 — recoverable in the first case, not in the second.

  it('refuses to boot in production when TRUSTED_PROXY is unset', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      TRUSTED_PROXY: undefined,
    }))).toThrow(ConfigurationError);
  });

  /**
   * THE ONE THAT MATTERS MOST, because it is the only bad value that BOOTS.
   *
   * backend/index.ts:139 hands Fastify a string, and Fastify only trusts every
   * hop for the BOOLEAN true — so the "hop-count integer" form the code comment
   * there suggests is not reachable. proxy-addr instead parses `2` through
   * ipaddr.js as the address 0.0.0.2: it compiles, it trusts nothing, and
   * request.ip collapses exactly as if the key were missing, while the env file
   * looks correctly configured. A blocklist of true/1/yes would wave it through.
   */
  it('refuses a hop-count integer, which parses as an address and trusts nothing', () => {
    for (const value of ['0', '1', '2', '10']) {
      expect(() => validateProductionConfig(validProductionEnv({
        TRUSTED_PROXY: value,
      })), `TRUSTED_PROXY=${value} must be refused`).toThrow(ConfigurationError);
    }
  });

  /**
   * These already fail — inside Fastify's constructor, as `TypeError: invalid IP
   * address: true`. The check only converts a crash from library internals into
   * a sentence naming the variable, so this is a message test, not a security
   * one. (`.env.example` still describes `true` as "trusting every hop"; it
   * cannot, because process.env values are strings.)
   */
  it('refuses values that are not addresses at all', () => {
    for (const value of ['true', 'TRUE', 'yes', 'localhost', 'cloudflared', '127.0.0.1/64']) {
      expect(() => validateProductionConfig(validProductionEnv({
        TRUSTED_PROXY: value,
      })), `TRUSTED_PROXY=${value} must be refused`).toThrow(ConfigurationError);
    }
  });

  it('accepts the shapes a real deployment uses', () => {
    // Loopback is what this deployment runs: cloudflared connects from the same
    // machine. The comma form and CIDR are supported by Fastify (request.js
    // splits on ','), so a validator that rejected them would brick a legitimate
    // multi-hop config — which is why they are pinned here rather than assumed.
    for (const value of ['127.0.0.1', '::1', 'loopback', '127.0.0.1,::1', '10.0.0.0/8', 'uniquelocal']) {
      expect(() => validateProductionConfig(validProductionEnv({
        TRUSTED_PROXY: value,
      })), `TRUSTED_PROXY=${value} must be accepted`).not.toThrow();
    }
  });

  it('accepts an explicit no-proxy acknowledgement', () => {
    expect(() => validateProductionConfig(validProductionEnv({
      TRUSTED_PROXY: undefined,
      TRUSTED_PROXY_NOT_REQUIRED: 'true',
    }))).not.toThrow();
  });

  /**
   * THE POINT OF THE WHOLE CHECK, and the reason it does not live behind the
   * `NODE_ENV !== 'production'` early return.
   *
   * The scenario is an operator hand-starting the API so it sources the repo's
   * own .env — and that file says NODE_ENV=development. A guard keyed on
   * NODE_ENV would be switched off by precisely the mistake it exists to catch,
   * pass this suite, and protect nothing. Attachment to crm_prod is the
   * predicate deploy/local/ecosystem.config.js already trusts for the same
   * reason.
   */
  it('still requires it when NODE_ENV lies but the database is crm_prod', () => {
    expect(() => validateProductionConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://crm_user:StrongDbPass123!@127.0.0.1:5432/crm_prod',
    } as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it('leaves an ordinary development box alone', () => {
    // The counterweight to the test above. A dev machine on crm_dev has no proxy
    // to name, and refusing to boot over it would be a self-inflicted outage.
    expect(() => validateProductionConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://crm_user:devpass@127.0.0.1:5432/crm_dev',
    } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The static marketing site.
//
// The backend has had a CSP since it grew @fastify/helmet, but cloudflared puts
// the website and /api/* on ONE origin (4kub.ru), and the document half of that
// origin shipped no security headers at all — the self-hosting migration
// reproduced website/nginx.conf faithfully, and the vhost never set any either.
//
// These tests exist because the expensive failure mode of the fix is silent.
// A script-src hash that is wrong by one byte blocks the only script on
// register.html / verify.html / i.html — which IS the registration, email
// verification and invite-claim logic — with no server error, nothing in
// logs/static-error.log and no failing check anywhere. The only evidence would
// be a console message on a stranger's machine, and new signups would be dead
// until someone noticed.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEBSITE = path.join(REPO_ROOT, 'website');

function sha256Base64(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/**
 * Inline <script> bodies, found by a DELIBERATELY DIFFERENT method from the one
 * static-headers.js uses: split on the closing tag and read backwards to the
 * opening tag, rather than matching the element with one regex. If the two
 * disagree the assertion fails, which is the point — a test that reuses the
 * production extractor proves only that the extractor agrees with itself.
 */
function inlineScriptsIndependently(html: string): string[] {
  const bodies: string[] = [];
  for (const chunk of html.split('</script>')) {
    const open = chunk.lastIndexOf('<script');
    if (open === -1) continue;
    const gt = chunk.indexOf('>', open);
    if (gt === -1) continue;
    const attrs = chunk.slice(open + '<script'.length, gt);
    if (/\bsrc\s*=/i.test(attrs)) continue; // external file — covered by 'self'
    const type = (/\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] ?? '').toLowerCase();
    // A data block (application/ld+json) is never executed, so a browser never
    // CSP-checks it and hashing it would permit a digest for nothing.
    if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
    bodies.push(chunk.slice(gt + 1));
  }
  return bodies;
}

/** What the HTML parser hands the CSP hasher: CR and CRLF collapsed to LF. */
function asParsed(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// static-headers.js is plain CommonJS, so TypeScript infers a closed object
// literal for each header builder and refuses a lookup for a key that is not on
// it — including the ones asserted ABSENT below. A response header map is
// open-ended by nature; type it that way.
type HeaderMap = Record<string, string | undefined>;

function directive(csp: string, name: string): string {
  const found = csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));
  return found ?? '';
}

const htmlPages = fs.readdirSync(WEBSITE).filter((f) => f.endsWith('.html'));

describe('static site security headers', () => {
  it('has HTML pages to police', () => {
    // Guards the loops below against silently passing on an empty list if the
    // site is ever moved out from under this path.
    expect(htmlPages.length).toBeGreaterThanOrEqual(6);
  });

  // ── The policy itself ──────────────────────────────────────────────────────

  it('locks down the directives an attacker would otherwise pivot through', () => {
    const csp = cspForDocument('<!doctype html><html></html>');
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    // Clickjacking: https://4kub.ru/register is frameable today.
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('never lets script-src degrade to a policy that permits everything', () => {
    // The failure mode this guards: a stale hash takes signup down, someone
    // "fixes" it by pasting 'unsafe-inline', and the whole policy is voided
    // while still looking present in `curl -I`. 'self' must stay — /js/site.js
    // is an external file, and Cloudflare's Email Obfuscation injects a
    // same-origin decoder script at the edge.
    for (const page of htmlPages) {
      const csp = cspForDocument(fs.readFileSync(path.join(WEBSITE, page), 'utf8'));
      const scriptSrc = directive(csp, 'script-src');
      expect(scriptSrc, page).toContain("'self'");
      expect(scriptSrc, page).not.toContain("'unsafe-inline'");
      expect(scriptSrc, page).not.toContain("'unsafe-eval'");
      expect(scriptSrc, page).not.toContain("'strict-dynamic'");
    }
  });

  // ── THE LOAD-BEARING ONE ───────────────────────────────────────────────────

  it('permits every inline script the site actually serves', () => {
    for (const page of htmlPages) {
      const html = fs.readFileSync(path.join(WEBSITE, page), 'utf8');
      const scriptSrc = directive(cspForDocument(html), 'script-src');
      for (const body of inlineScriptsIndependently(html)) {
        // The digest a browser computes is of the parsed text content, which
        // has already had CRLF collapsed to LF by input stream preprocessing.
        // Every .html file here is CRLF on disk, so hashing the raw bytes would
        // block every inline script on the site.
        expect(scriptSrc, `${page}: inline script not permitted`).toContain(sha256Base64(asParsed(body)));
      }
    }
  });

  it('hashes the pages whose inline script IS the feature', () => {
    // index.html degrades safely (a blocked hash costs the intro animation).
    // These three do not: the inline script is the registration, verification
    // and invite-claim logic. If this ever reads "0 hashes", signup is dead.
    for (const page of ['register.html', 'verify.html', 'i.html', 'index.html']) {
      const html = fs.readFileSync(path.join(WEBSITE, page), 'utf8');
      expect(inlineScriptsIndependently(html).length, page).toBeGreaterThan(0);
      expect(directive(cspForDocument(html), 'script-src'), page).not.toBe("script-src 'self'");
    }
  });

  it('does not hash the JSON-LD data block, and is not fooled by it either', () => {
    const html = fs.readFileSync(path.join(WEBSITE, 'index.html'), 'utf8');
    const ldMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(ldMatch, 'index.html lost its JSON-LD block').not.toBeNull();
    const scriptSrc = directive(cspForDocument(html), 'script-src');
    expect(scriptSrc).not.toContain(sha256Base64(asParsed(ldMatch![1])));
    // ...and its presence did not stop the real inline script being hashed.
    // Tokens are `'sha256-…'` WITH the quotes: CSP's hash-source grammar requires
    // them, and emitting them bare made Chrome discard every digest as an invalid
    // source and block the script it was computed for. Match on the quoted form so
    // this cannot go green again against a policy that disables itself.
    const hashTokens = scriptSrc.split(' ').filter((t) => t.startsWith("'sha256-"));
    expect(hashTokens.length).toBeGreaterThan(0);
    expect(hashTokens.every((t) => t.endsWith("'"))).toBe(true);
  });

  // ── Directives that are load-bearing for the site rendering at all ─────────

  it('keeps data: images and self-hosted fonts loading', () => {
    const csp = cspForDocument('<!doctype html><html></html>');
    // The favicon on every page is a data: SVG, as are four noise textures in
    // the CSS. Dropping data: here blanks all of them at once.
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data:");
    // Eight self-hosted woff2, no external foundry.
    expect(directive(csp, 'font-src')).toBe("font-src 'self'");
    // register/verify/i fetch /api/v1/* on this same origin.
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
  });

  it('keeps style-src permissive on purpose, and says so', () => {
    // Deliberate, documented weakening: the 42 style="" attributes are
    // per-instance custom properties driving the animations, 'unsafe-hashes'
    // does not cover style ATTRIBUTES portably and style-src-attr is
    // unsupported in Safari — tightening this blanks the homepage on iOS.
    // With script-src locked, CSS injection cannot reach JS execution.
    expect(directive(cspForDocument(''), 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  // ── The other headers ──────────────────────────────────────────────────────

  it('sends the base security set on every response', () => {
    const headers: HeaderMap = baseSecurityHeaders();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Permissions-Policy']).toBeTruthy();
    // HSTS is deliberately absent: it is the one header here that a file revert
    // cannot undo, because max-age pins in every visitor's browser. It belongs
    // to the Cloudflare dashboard toggle and to the owner's decision.
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('never disables clipboard-write in Permissions-Policy', () => {
    // i.html:163 writes the invite handoff to the clipboard. On iOS there is no
    // install-referrer API, so the clipboard IS the channel the app reads on
    // first launch — a copy-pasted "deny everything" policy would break invite
    // acceptance on iOS silently, with no error surfaced anywhere.
    expect(baseSecurityHeaders()['Permissions-Policy']).not.toContain('clipboard');
  });

  // ── Header assembly, where the ordering trap lives ─────────────────────────

  it('keeps the stricter per-page overrides on the invite landing page', () => {
    // The security defaults are seeded BEFORE the branch chain precisely so
    // this page can override Referrer-Policy downward. Seed them after and this
    // silently becomes strict-origin-when-cross-origin on the one page that
    // renders a live claim code.
    for (const urlPath of ['/i', '/i.html']) {
      const headers: HeaderMap = responseHeaders(urlPath, '.html');
      expect(headers['Referrer-Policy'], urlPath).toBe('no-referrer');
      expect(headers['Cache-Control'], urlPath).toContain('no-store');
      expect(headers['X-Robots-Tag'], urlPath).toBe('noindex, nofollow');
      expect(headers['X-Content-Type-Options'], urlPath).toBe('nosniff');
    }
    // ...and no other page picked up no-referrer by accident.
    expect(responseHeaders('/register', '.html')['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sends nosniff on assets, not just documents', () => {
    for (const ext of ['.css', '.js', '.woff2', '.xml', '.webp', '.svg', '.txt']) {
      expect(responseHeaders(`/asset${ext}`, ext)['X-Content-Type-Options'], ext).toBe('nosniff');
    }
    // The association files have no extension and iOS refuses anything but
    // application/json, so the forced type must survive the security seed.
    const wellKnown: HeaderMap = responseHeaders('/.well-known/apple-app-site-association', '');
    expect(wellKnown['Content-Type']).toBe('application/json');
    expect(wellKnown['X-Content-Type-Options']).toBe('nosniff');
    expect(wellKnown['Cache-Control']).toBe('public, max-age=300');
  });

  it('does not leave the 404 document bare', () => {
    // A separate branch in static-server.js builds these, and it is invisible
    // to anything applied only to the 200 path. 404.html is a real document
    // with an inline <style> block.
    const headers: HeaderMap = notFoundHeaders();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBeTruthy();
    expect(headers['Cache-Control']).toBe('no-store');
    expect(cspForFile(path.join(WEBSITE, '404.html'))).toContain("frame-ancestors 'none'");
  });

  // ── Derivation, not a hand-maintained list ────────────────────────────────

  it('derives the policy from the bytes on disk and drops it when they change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-'));
    const file = path.join(dir, 'page.html');
    try {
      fs.writeFileSync(file, '<!doctype html><script>alert(1)</script>');
      const first = cspForFile(file);
      expect(first).toContain(sha256Base64('alert(1)'));

      // Memoised on (path, mtimeMs, size): an unchanged file is not re-read.
      const reads = vi.spyOn(fs, 'readFileSync');
      expect(cspForFile(file)).toBe(first);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();

      // ...and a changed one is. This site is deployed by editing files in
      // place, so a cache that missed this would serve a stale hash and take
      // the page's own script down.
      fs.writeFileSync(file, '<!doctype html><script>alert(22222)</script>');
      const second = cspForFile(file);
      expect(second).toContain(sha256Base64('alert(22222)'));
      expect(second).not.toContain(sha256Base64('alert(1)'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the policy rather than emitting an unusable one when a file cannot be read', () => {
    // Fail OPEN. Hashes computed from nothing would block the page's own
    // scripts; briefly omitting a defence-in-depth header on a site that serves
    // fixed files off disk is strictly less harmful than breaking registration.
    expect(cspForFile(path.join(WEBSITE, 'no-such-page.html'))).toBeNull();
  });

  // ── Content regression guards ─────────────────────────────────────────────

  it('keeps the pages free of the two things a hash-based policy cannot cover', () => {
    for (const page of htmlPages) {
      const html = fs.readFileSync(path.join(WEBSITE, page), 'utf8');
      // Script and style bodies are hashed or allowed as a unit; only markup
      // outside them can carry an attribute handler.
      const markup = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
      // Inline event handlers need 'unsafe-hashes' at best, and are simply
      // blocked here. Adding one breaks under the policy with nothing else
      // catching it.
      expect(/\son[a-z]+\s*=/i.exec(markup)?.[0], page).toBeUndefined();
      // javascript: URLs are blocked by script-src without 'unsafe-inline' —
      // which is the defence, but it means one added later just stops working.
      expect(markup.toLowerCase(), page).not.toContain('javascript:');
    }
  });

  it('keeps every subresource same-origin, which is what makes the policy this tight', () => {
    // default-src 'self' holds only while nothing is loaded from another host.
    // Navigation links (<a href>) are not subresources and are not checked.
    for (const page of htmlPages) {
      const html = fs.readFileSync(path.join(WEBSITE, page), 'utf8');
      const external = [...html.matchAll(/\bsrc\s*=\s*"([^"]+)"/gi)]
        .map((m) => m[1])
        .filter((u) => /^(https?:)?\/\//i.test(u));
      expect(external, page).toEqual([]);
      const externalStyles = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>/gi)]
        .filter((m) => /rel\s*=\s*"(stylesheet|preload)"/i.test(m[0]))
        .map((m) => m[1])
        .filter((u) => /^(https?:)?\/\//i.test(u));
      expect(externalStyles, page).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seam the headers above actually fell through.
//
// The whole policy is computed by deploy/local/static-headers.js, which Node
// `require`s ONCE when static-server.js starts. The site is deployed by editing
// files in place, and nothing restarts the PM2 `crm-static` process — so the
// correct headers sat in git for hours while every live response carried none,
// with no error and this file's 33 tests all green. A unit test that only calls
// the header builders can never see that; these two assert the mechanism that
// makes the running process follow the source.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the crm-static app block out of the PM2 config AS TEXT.
 *
 * Deliberately not `require()`: that file throws at load unless .env.localprod
 * exists and names crm_prod (ecosystem.config.js does that on purpose), so
 * importing it would make this suite pass or fail on the contents of an
 * untracked credentials file rather than on the config being asserted.
 */
function crmStaticBlock(): string {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'deploy/local/ecosystem.config.js'), 'utf8');
  const start = source.indexOf("name: 'crm-static'");
  expect(start, 'crm-static app is missing from ecosystem.config.js').toBeGreaterThan(-1);
  const next = source.indexOf("name: '", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('static server deployment config', () => {
  /**
   * PM2 resolves `watch` against the app's cwd (pm2/lib/Watcher.js sets
   * `cwd: pm2_env.pm_cwd` on the chokidar options), and crm-static's cwd is the
   * repo ROOT while its script lives in deploy/local. So the obvious spelling —
   * ['static-server.js', 'static-headers.js'] — names two paths that do not
   * exist, and with chokidar's ignoreInitial that emits nothing and throws
   * nothing. The watcher would appear configured in `pm2 describe` and fire on
   * no file ever: a green safeguard measuring the wrong path, which is the exact
   * bug class this repo keeps collecting.
   */
  it('watches paths that exist, resolved the way PM2 resolves them', () => {
    const block = crmStaticBlock();
    const watch = /watch:\s*\[([^\]]*)\]/.exec(block);
    expect(watch, 'crm-static declares no watch, so a header change never reaches the process')
      .not.toBeNull();

    const entries = [...(watch as RegExpExecArray)[1].matchAll(/'([^']+)'|"([^"]+)"/g)]
      .map((m) => m[1] ?? m[2]);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry)), `watch entry does not exist: ${entry}`)
        .toBe(true);
    }

    // Both halves of the header pipeline, or a change to the one that is not
    // watched still goes live only on the next manual restart.
    expect(entries).toContain('deploy/local/static-server.js');
    expect(entries).toContain('deploy/local/static-headers.js');

    // The premise of every assertion above. If this app ever stops running from
    // ROOT the relative paths silently point somewhere else.
    expect(block).toContain('cwd: ROOT');
  });

  it('does not watch the website content directory', () => {
    // Watching website/ would bounce the public site on every copy edit, and it
    // buys nothing: static-headers.js recomputes each page's script hashes per
    // request, memoised on mtime+size, so content changes need no restart.
    const entries = [...crmStaticBlock().matchAll(/'(website[^']*)'/g)].map((m) => m[1]);
    expect(entries).toEqual([]);
  });
});
