#!/usr/bin/env node
'use strict';
/**
 * RuStore Publisher API automation for 4КУБ (com.fedorportnoi.crm).
 *
 * Auth flow: RSA-SHA512 sign an ISO-8601 timestamp with RUSTORE_PRIVATE_KEY
 * (PKCS#8, base64, no PEM headers), POST to /public/auth/, receive a JWE token
 * (valid ~900s), then send it as the `Public-Token` header on every request.
 *
 * Usage:
 *   node scripts/rustore-publish.js info
 *       Auth + dump the current app card / versions (read-only).
 *
 *   node scripts/rustore-publish.js publish --apk <path.apk> [--whats-new "..."]
 *                                           [--publish-type INSTANTLY|MANUAL]
 *                                           [--no-submit] [--dry-run]
 *       Create a draft version, upload the APK, and (unless --no-submit) send it
 *       to moderation. Metadata (name, description, category, screenshots) is
 *       inherited from the previous published version unless overridden.
 *
 * Credentials are read from crm/.env: RUSTORE_KEY_ID, RUSTORE_PRIVATE_KEY.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PKG = 'com.fedorportnoi.crm';
const BASE = 'https://public-api.rustore.ru';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const txt = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, i).trim()] = v;
  }
  return env;
}

// RuStore wants ISO-8601 with milliseconds and a timezone offset, signed as-is.
function rustoreTimestamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:` +
    `${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

async function auth(env) {
  const keyId = env.RUSTORE_KEY_ID;
  const keyB64 = env.RUSTORE_PRIVATE_KEY;
  if (!keyId || !keyB64) throw new Error('RUSTORE_KEY_ID / RUSTORE_PRIVATE_KEY missing in .env');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8',
  });
  const timestamp = rustoreTimestamp();
  // RuStore signs the concatenation keyId + timestamp with SHA512withRSA (PKCS#1 v1.5), base64.
  const signer = crypto.createSign('RSA-SHA512');
  signer.update(Buffer.from(keyId + timestamp, 'utf8'));
  signer.end();
  const signature = signer.sign(privateKey, 'base64');

  const res = await fetch(`${BASE}/public/auth/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId, timestamp, signature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.body || !data.body.jwe) {
    throw new Error(`Auth failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data.body.jwe;
}

async function api(token, method, urlPath, { json, query, form } = {}) {
  const url = new URL(BASE + urlPath);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const headers = { 'Public-Token': token };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) { body = form; } // FormData -> fetch sets multipart boundary
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function dump(label, r) {
  console.log(`\n=== ${label} (HTTP ${r.status}) ===`);
  console.log(typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2));
}

// Upload a (large) APK with curl — streams from disk and is far more reliable
// than Node's fetch/undici for multipart bodies over ~100 MB.
function uploadApkViaCurl(url, token, apkPath) {
  try {
    const body = execFileSync('curl', [
      '--silent', '--show-error', '--fail-with-body',
      '-X', 'POST',
      '-H', `Public-Token: ${token}`,
      '-F', `file=@${apkPath};type=application/vnd.android.package-archive`,
      url,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, body };
  } catch (e) {
    return { ok: false, body: `${e.stdout || ''}${e.stderr || ''}` || e.message };
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdInfo() {
  const env = loadEnv();
  const token = await auth(env);
  console.log(`AUTH OK — JWE token acquired (length ${token.length}).`);
  const apps = await api(token, 'GET', '/public/v1/application', { query: { pageSize: 100 } });
  dump('GET /public/v1/application', apps);
}

function parseArgs(rest) {
  const args = { submit: true, publishType: 'INSTANTLY', dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--apk') args.apk = rest[++i];
    else if (a === '--whats-new') args.whatsNew = rest[++i];
    else if (a === '--publish-type') args.publishType = rest[++i];
    else if (a === '--no-submit') args.submit = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--version-id') args.versionId = rest[++i];
    else if (a === '--dir') args.dir = rest[++i];
  }
  return args;
}

async function cmdModerate(args) {
  if (!args.versionId) throw new Error('--version-id <id> is required for moderate');
  const env = loadEnv();
  const token = await auth(env);
  console.log(`AUTH OK — token acquired (length ${token.length}).`);
  // NB: the submit-for-moderation endpoint is /commit, NOT /moderation —
  // RuStore's gateway answers unknown routes with 502, not 404.
  const mod = await api(token, 'POST', `/public/v1/application/${PKG}/version/${args.versionId}/commit`);
  dump('POST submit for moderation', mod);
  if (!mod.ok) throw new Error('Moderation submit failed (see response above).');
  console.log(`\n✅ Version ${args.versionId} submitted to RuStore moderation.`);
}

async function cmdDelete(args) {
  if (!args.versionId) throw new Error('--version-id <id> is required for delete');
  const env = loadEnv();
  const token = await auth(env);
  console.log(`AUTH OK — token acquired (length ${token.length}).`);
  // Only unpublished (draft/moderation/ready) versions can be deleted — RuStore
  // rejects deleting anything already live. That is the whole point of this
  // command: cleaning up an orphaned draft that is blocking a versionCode reuse,
  // never a published one.
  const r = await api(token, 'DELETE', `/public/v1/application/${PKG}/version/${args.versionId}`);
  dump('DELETE version', r);
  if (!r.ok) throw new Error('Delete failed (see response above).');
  console.log(`\n✅ Version ${args.versionId} deleted.`);
}

// Screenshots aren't documented in this file's own header because nothing
// here used to touch them — new versions silently inherited whatever was on
// the last published one. Found and fixed 2026-08-17: those inherited shots
// were stale (dated back to June, well before the curated set existed), so
// every draft since then would have shipped the wrong images. Endpoint isn't
// in RuStore's OpenAPI spec bundled with this repo; found via their docs site
// (api-upload-publication-app/apk-screens-upload) — POST, multipart, one
// `file` field per call, path-addressed by orientation + 0-based ordinal.
async function cmdScreenshots(args) {
  if (!args.versionId) throw new Error('--version-id <id> is required for screenshots');
  if (!args.dir) throw new Error('--dir <path> is required for screenshots');
  const env = loadEnv();
  const token = await auth(env);
  console.log(`AUTH OK — token acquired (length ${token.length}).`);
  const files = fs.readdirSync(args.dir).filter((f) => f.endsWith('.png')).sort();
  console.log(`uploading ${files.length} screenshots from ${args.dir}`);
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(args.dir, files[i]);
    const url = `${BASE}/public/v1/application/${PKG}/version/${args.versionId}/image/screenshot/portrait/${i}`;
    try {
      const body = execFileSync('curl', [
        '--silent', '--show-error', '--fail-with-body',
        '-X', 'POST',
        '-H', `Public-Token: ${token}`,
        '-F', `file=@${filePath};type=image/png`,
        url,
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      console.log(`  [${i}] ${files[i]} ->`, body.trim());
    } catch (e) {
      console.log(`  [${i}] ${files[i]} FAILED ->`, `${e.stdout || ''}${e.stderr || ''}` || e.message);
    }
  }
}

async function cmdStatus(args) {
  if (!args.versionId) throw new Error('--version-id <id> is required for status');
  const env = loadEnv();
  const token = await auth(env);
  // There is no per-version GET; list versions and filter client-side.
  const r = await api(token, 'GET', `/public/v1/application/${PKG}/version`, { query: { pageSize: 20 } });
  if (r.ok && r.data && r.data.body && Array.isArray(r.data.body.content)) {
    const v = r.data.body.content.find((x) => String(x.versionId) === String(args.versionId));
    dump('version status', { status: r.status, ok: r.ok, data: v || `versionId ${args.versionId} not found` });
  } else {
    dump('GET versions', r);
  }
}

async function cmdPublish(args) {
  if (!args.apk) throw new Error('--apk <path> is required for publish');
  if (!fs.existsSync(args.apk)) throw new Error(`APK not found: ${args.apk}`);
  const env = loadEnv();
  const token = await auth(env);
  console.log(`AUTH OK — JWE token acquired (length ${token.length}).`);

  const whatsNew = args.whatsNew ||
    'Тёмная тема оформления с переключателем, улучшения интерфейса дашборда и повышение стабильности.';

  // 1) Create draft version. Unspecified fields are inherited from the last
  //    published version (name, description, category, screenshots, icon).
  // Free app: do NOT send priceValue (RuStore rejects it for non-paid apps).
  // Name/description/category/screenshots/icon are inherited from the last published version.
  const createBody = { whatsNew, publishType: args.publishType };
  if (args.dryRun) {
    console.log('\n[dry-run] Would POST create-version with body:');
    console.log(JSON.stringify(createBody, null, 2));
    console.log(`[dry-run] Would upload APK: ${args.apk}`);
    console.log(`[dry-run] Would ${args.submit ? '' : 'NOT '}submit for moderation.`);
    return;
  }

  let versionId = args.versionId;
  if (versionId) {
    console.log(`\nReusing existing draft versionId = ${versionId}`);
  } else {
    const created = await api(token, 'POST', `/public/v1/application/${PKG}/version`, { json: createBody });
    dump('POST create draft version', created);
    versionId = created.data && created.data.body;
    if (!created.ok || !versionId) throw new Error('Failed to create draft version (see response above).');
    console.log(`\nDraft versionId = ${versionId}`);
  }

  // 2) Upload the APK (main APK) via curl.
  const uploadUrl = `${BASE}/public/v1/application/${PKG}/version/${versionId}/apk?isMainApk=true&servicesType=Unknown`;
  console.log(`\nUploading APK to draft ${versionId} via curl ...`);
  const up = uploadApkViaCurl(uploadUrl, token, args.apk);
  console.log('APK upload response:', String(up.body).trim());
  if (!up.ok) throw new Error('APK upload failed (see response above). Draft left in place for inspection.');

  // 3) Submit for moderation (unless --no-submit).
  if (!args.submit) {
    console.log(`\nDraft ${versionId} created + APK uploaded. --no-submit set: NOT sending to moderation.`);
    return;
  }
  const mod = await api(token, 'POST', `/public/v1/application/${PKG}/version/${versionId}/commit`);
  dump('POST submit for moderation', mod);
  if (!mod.ok) throw new Error('Moderation submit failed (see response above).');
  console.log(`\n✅ Version ${versionId} (vc from APK) submitted to RuStore moderation. publishType=${args.publishType}`);
}

// ---------------------------------------------------------------------------
(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'info') await cmdInfo();
    else if (cmd === 'publish') await cmdPublish(parseArgs(rest));
    else if (cmd === 'moderate') await cmdModerate(parseArgs(rest));
    else if (cmd === 'status') await cmdStatus(parseArgs(rest));
    else if (cmd === 'delete') await cmdDelete(parseArgs(rest));
    else if (cmd === 'screenshots') await cmdScreenshots(parseArgs(rest));
    else {
      console.error('Usage:\n  node scripts/rustore-publish.js info\n' +
        '  node scripts/rustore-publish.js publish --apk <path> [--whats-new "..."] [--publish-type INSTANTLY|MANUAL] [--no-submit] [--dry-run]\n' +
        '  node scripts/rustore-publish.js moderate --version-id <id>\n' +
        '  node scripts/rustore-publish.js status --version-id <id>\n' +
        '  node scripts/rustore-publish.js delete --version-id <id>   (unpublished versions only)\n' +
        '  node scripts/rustore-publish.js screenshots --version-id <id> --dir <path>');
      process.exit(2);
    }
  } catch (e) {
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  }
})();
