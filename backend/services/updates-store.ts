/**
 * Self-hosted Expo Updates store — the on-disk half of the OTA channel.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * EAS Update (`u.expo.dev`) is a US-hosted CDN. ФЗ-242 keeps Russian citizens'
 * personal data on Russian servers, and the app is already being moved off
 * Google FCM because Russian devices cannot reliably reach it. Pointing the
 * update channel at a US CDN would reintroduce exactly that silent-failure mode
 * on the one channel that can fix bugs remotely. So the manifest, the bundle and
 * every asset are served by this backend and nothing calls an Expo server at
 * runtime.
 *
 * Everything below is implemented against the expo-updates protocol v1 spec
 * (https://docs.expo.dev/technical-specs/expo-updates-1/) AND cross-checked
 * against the CLIENT source that ships in node_modules — because the client is
 * what actually accepts or rejects the response:
 *   node_modules/expo-updates/android/src/main/java/expo/modules/updates/
 *     loader/FileDownloader.kt                    (multipart parsing, headers)
 *     codesigning/CodeSigningConfiguration.kt     (signature verification)
 *     codesigning/SignatureHeaderInfo.kt          (expo-signature field names)
 *     manifest/ExpoUpdatesUpdate.kt               (required manifest fields)
 *     selectionpolicy/SelectionPolicies.kt        (manifest-filter matching)
 *   node_modules/expo-updates/ios/EXUpdates/AppLoader/UpdateResponse.swift
 *                                                 (directive types)
 *   node_modules/expo-updates/e2e/fixtures/project_files/maestro/
 *     updates-server/{server,update}.ts           (Expo's own reference server)
 *
 * ─── ON-DISK LAYOUT ─────────────────────────────────────────────────────────
 *
 * The store lives OUTSIDE the repo. github.com/FedorPortnoi/CRM is PUBLIC, and
 * an update bundle is the entire compiled app; it has no business in git, and a
 * `dist/` under the repo is already taken by the built backend that pm2 runs.
 *
 *   $UPDATES_STORE_DIR/                        default: %USERPROFILE%/crm-updates
 *     <runtimeVersion>/                        fingerprint hash, per PLATFORM
 *       <channel>/                             "production" | "rustore"
 *         rollback.json                        optional: {"commitTime":"<ISO>"}
 *         <updateId>/                          a UUID, one directory per publish
 *           update.json                        metadata this module reads
 *           _expo/static/js/<platform>/<n>.hbc the launch asset (from expo export)
 *           assets/<md5>                       content-addressed assets
 *
 * `<runtimeVersion>` is per-platform on purpose. The policy in app.json is
 * `fingerprint`, and the iOS and Android fingerprints of the same commit are
 * different strings. scripts/publish-update.js therefore writes the same publish
 * under each platform's own runtimeVersion directory, carrying only that
 * platform's bundle and assets. A directory whose name no installed build's
 * fingerprint matches is simply never requested — which is the failure the
 * publish script's `--new-runtime` guard exists to make loud.
 *
 * `update.json` is the ONLY file this module parses. The tree beside it is
 * served verbatim by the asset route, so the paths inside update.json are
 * relative to the update directory and are the paths `expo export` produced.
 *
 * ─── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * No caching. Every manifest request lists one directory and reads one small
 * JSON file. A cache would add a staleness window right after a publish — the
 * moment an operator is watching to see whether the fix went out — in exchange
 * for I/O that is already trivial. If this ever shows up in a profile, cache on
 * directory mtime, not on a TTL.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ─── Public path constants ───────────────────────────────────────────────────
//
// Exported so backend/api/authenticate.ts can allowlist the exact same strings
// the routes are mounted at, instead of repeating them. That is the same
// arrangement TRACKING_OPEN_PATH_PREFIX has, and for the same reason: the
// allowlist and the route cannot drift apart if there is only one copy.
//
// BOTH are unauthenticated by necessity — expo-updates fetches the manifest
// during native startup, before any JS has run and long before anyone has
// logged in. There is no token it could present.

/** Exact path of the manifest endpoint. Must equal `updates.url` in app.json. */
export const UPDATES_MANIFEST_PATH = '/api/v1/updates/manifest';

/**
 * Prefix of the asset endpoint. The trailing slash is load-bearing: it stops a
 * bare `/api/v1/updates/assets` from matching, exactly as with the tracking
 * pixel prefix.
 */
export const UPDATES_ASSETS_PATH_PREFIX = '/api/v1/updates/assets/';

// ─── Types stored in update.json ─────────────────────────────────────────────

export type UpdatePlatform = 'ios' | 'android';

/**
 * One downloadable file.
 *
 * `hash` is base64url(SHA-256(file bytes)) — the client re-hashes what it
 * downloads and rejects a mismatch, so this is the integrity link that makes
 * the manifest signature cover the assets transitively.
 *
 * `key` is the client's local filename and its index into assetRequestHeaders,
 * so it must be unique per distinct content. `expo export` already names assets
 * by content hash, which gives that for free.
 */
export type StoredAsset = {
  key: string;
  /** Path relative to the update directory, POSIX separators. */
  path: string;
  contentType: string;
  /** With the leading dot, per spec. The client tolerates either. */
  fileExtension?: string;
  hash: string;
};

export type StoredPlatformPayload = {
  launchAsset: StoredAsset;
  assets: StoredAsset[];
};

export type StoredUpdate = {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  channel: string;
  platforms: Partial<Record<UpdatePlatform, StoredPlatformPayload>>;
  metadata?: Record<string, string>;
  extra?: Record<string, unknown>;
};

export type RollbackDirectiveState = {
  commitTime: string;
};

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Where the store lives. Outside the repo by default and next to the backup
 * directory the self-hosted deployment already writes to
 * (deploy/local/backup.js -> %USERPROFILE%/crm-backups).
 */
export function getUpdatesStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.UPDATES_STORE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const home = env.USERPROFILE || env.HOME || process.cwd();
  return path.resolve(home, 'crm-updates');
}

/**
 * Origin the client is told to fetch assets from.
 *
 * Absolute URLs are required by the protocol (the client is given a URL, not a
 * path). Derived from configuration rather than from the request Host header:
 * cloudflared rewrites Host to 4kub.ru anyway, and trusting an attacker-supplied
 * Host would let a stranger get a signed manifest that points at their server.
 * The signature covers the URLs, so a wrong origin here is a wrong signed
 * promise.
 */
export function getUpdatesBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.UPDATES_BASE_URL?.trim();
  return (configured || 'https://4kub.ru').replace(/\/+$/, '');
}

/**
 * PEM of the RSA private key that signs manifests and directives.
 *
 * This key is the whole security boundary of the feature: whoever holds it can
 * publish arbitrary JavaScript to every install. It never leaves this machine —
 * /certs/ is gitignored and .easignore excludes the key while admitting the
 * certificate.
 */
export function getCodeSigningPrivateKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.UPDATES_CODE_SIGNING_PRIVATE_KEY?.trim();
  return path.resolve(configured || path.join(process.cwd(), 'certs', 'updates', 'private-key.pem'));
}

/** Channel served when the client sends no `expo-channel-name`. Unset = none. */
export function getDefaultChannel(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.UPDATES_DEFAULT_CHANNEL?.trim();
  return configured ? configured : null;
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Every path segment that reaches the filesystem is allowlisted, not
 * blocklisted. `runtimeVersion`, `channel` and the asset sub-path all arrive
 * from the network; a fingerprint is hex, a channel is a short slug and an
 * export path is `_expo/static/js/ios/entry-<hash>.hbc`, so nothing legitimate
 * needs a character outside this set.
 *
 * Blocking `..` alone is not enough on Windows: `C:\Windows\...` is neither a
 * traversal segment nor relative, and path.resolve would happily leave the
 * store. The allowlist rejects `:` and `\` outright, and the containment check
 * in resolveAssetFile() is the second, independent gate.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSafePathSegment(segment: string): boolean {
  return segment !== '.' && segment !== '..' && SAFE_SEGMENT.test(segment) && segment.length <= 255;
}

export function isValidUpdateId(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Percent-decode to a fixed point, or null if it cannot be decoded.
 *
 * Repeated until stable so `%252e%252e` cannot survive one pass; a malformed
 * escape is refused rather than ignored. Same shape as fullyDecodeKey() in
 * backend/services/storage.ts, and for the same reason.
 */
function fullyDecode(value: string): string | null {
  let current = value;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  return null;
}

/**
 * Resolve an asset request to an absolute file path inside the store, or null.
 *
 * Two independent gates, and the second is the one that matters:
 *
 *   1. The path must be syntactically safe and must resolve inside the update
 *      directory (below).
 *   2. The path must be DECLARED by that update — it must appear as the launch
 *      asset or as one of the assets of some platform in update.json.
 *
 * Gate 2 exists because gate 1 alone makes every file in the directory public,
 * including update.json itself, which lists the publishing commit and the whole
 * resolved app config. It also means a stray file that lands in an update
 * directory — an editor backup, a half-finished copy, a source map — is
 * unreachable rather than quietly world-readable on a public hostname. The cost
 * is one small JSON read per asset request, against a response that is already
 * streaming a file off the same disk.
 *
 * Returns null — never throws, never a partial path — for anything that fails
 * any check, so the route can answer one indistinguishable 404 and never reveal
 * which part of a probe was wrong.
 */
export function resolveAssetFile(
  runtimeVersion: string,
  channel: string,
  updateId: string,
  relativePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (relativePath.includes('\0')) {
    return null;
  }

  const decodedRelative = fullyDecode(relativePath);
  if (decodedRelative === null) {
    return null;
  }

  const decodedRuntimeVersion = fullyDecode(runtimeVersion);
  const decodedChannel = fullyDecode(channel);
  const decodedUpdateId = fullyDecode(updateId);
  if (decodedRuntimeVersion === null || decodedChannel === null || decodedUpdateId === null) {
    return null;
  }

  if (
    !isSafePathSegment(decodedRuntimeVersion) ||
    !isSafePathSegment(decodedChannel) ||
    !isValidUpdateId(decodedUpdateId)
  ) {
    return null;
  }

  // Both the raw and the decoded form must pass, so an escape hidden in the
  // encoding cannot slip through one form and resolve in the other.
  for (const form of [relativePath, decodedRelative]) {
    const segments = form.split(/[/\\]/);
    if (segments.length === 0 || segments.some((segment) => !isSafePathSegment(segment))) {
      return null;
    }
  }

  const updateDir = path.join(
    getUpdatesStoreDir(env),
    decodedRuntimeVersion,
    decodedChannel,
    decodedUpdateId,
  );
  const resolved = path.resolve(updateDir, ...decodedRelative.split('/'));

  // Independent containment check on the RESOLVED path. The allowlist above
  // should already make this unreachable; it is here because "should" is not a
  // security property.
  const boundary = updateDir.endsWith(path.sep) ? updateDir : updateDir + path.sep;
  if (!resolved.startsWith(boundary)) {
    return null;
  }

  // Gate 2: only files this update declares. update.json is read here and never
  // served — it is the store's control file, not an asset.
  const update = readJsonFile<StoredUpdate>(path.join(updateDir, 'update.json'));
  if (!update || update.id !== decodedUpdateId || !isDeclaredAssetPath(update, decodedRelative)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }

  return stat.isFile() ? resolved : null;
}

/** True if `relativePath` is the launch asset or an asset of any platform. */
function isDeclaredAssetPath(update: StoredUpdate, relativePath: string): boolean {
  const wanted = relativePath.split(/[/\\]/).join('/');

  for (const payload of Object.values(update.platforms ?? {})) {
    if (!payload) {
      continue;
    }
    if (payload.launchAsset?.path === wanted) {
      return true;
    }
    if ((payload.assets ?? []).some((asset) => asset.path === wanted)) {
      return true;
    }
  }

  return false;
}

// ─── Reading the store ───────────────────────────────────────────────────────

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Runtime versions currently present in the store. Used by the publish guard. */
export function listRuntimeVersions(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return fs
      .readdirSync(getUpdatesStoreDir(env), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafePathSegment(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Newest publish for a (runtimeVersion, channel) that actually carries a bundle
 * for `platform`.
 *
 * "Newest" is by `createdAt`, not by directory mtime: a copy, a restore from
 * backup or a robocopy mirror rewrites mtimes and would otherwise reorder the
 * channel. Ties break on the update id so the answer is stable.
 */
export function findLatestUpdate(
  runtimeVersion: string,
  channel: string,
  platform: UpdatePlatform,
  env: NodeJS.ProcessEnv = process.env,
): StoredUpdate | null {
  if (!isSafePathSegment(runtimeVersion) || !isSafePathSegment(channel)) {
    return null;
  }

  const channelDir = path.join(getUpdatesStoreDir(env), runtimeVersion, channel);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(channelDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: StoredUpdate | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidUpdateId(entry.name)) {
      continue;
    }

    const update = readJsonFile<StoredUpdate>(path.join(channelDir, entry.name, 'update.json'));
    if (!update || update.id !== entry.name) {
      // A directory whose update.json is missing, unparseable, or names a
      // different id is skipped rather than served: the id is what the client
      // stores and de-duplicates on, so a mismatch would make the same update
      // look new forever.
      continue;
    }

    const payload = update.platforms?.[platform];
    if (!payload?.launchAsset) {
      continue;
    }

    const time = Date.parse(update.createdAt);
    if (!Number.isFinite(time)) {
      continue;
    }

    if (time > bestTime || (time === bestTime && best !== null && update.id > best.id)) {
      best = update;
      bestTime = time;
    }
  }

  return best;
}

/**
 * Rollback marker for a channel, if the operator has written one.
 *
 * Present => every client on this runtimeVersion/channel is told to drop back to
 * the update embedded in the binary, whatever is published beside it. Deleting
 * the file resumes normal serving. Deliberately a file rather than a flag inside
 * an update: a rollback has to work when the newest publish is the thing that is
 * broken.
 */
export function findRollback(
  runtimeVersion: string,
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
): RollbackDirectiveState | null {
  if (!isSafePathSegment(runtimeVersion) || !isSafePathSegment(channel)) {
    return null;
  }

  const file = path.join(getUpdatesStoreDir(env), runtimeVersion, channel, 'rollback.json');
  const parsed = readJsonFile<Partial<RollbackDirectiveState>>(file);
  if (!parsed?.commitTime || !Number.isFinite(Date.parse(parsed.commitTime))) {
    return null;
  }

  return { commitTime: parsed.commitTime };
}

// ─── Manifest construction ───────────────────────────────────────────────────

export type ExpoManifest = {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: Record<string, string>;
  assets: Record<string, string>[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
};

function assetUrl(
  update: StoredUpdate,
  channel: string,
  asset: StoredAsset,
  env: NodeJS.ProcessEnv,
): string {
  const segments = asset.path.split('/').map((segment) => encodeURIComponent(segment));
  return [
    getUpdatesBaseUrl(env),
    'api',
    'v1',
    'updates',
    'assets',
    encodeURIComponent(update.runtimeVersion),
    encodeURIComponent(channel),
    update.id,
    ...segments,
  ].join('/');
}

function toManifestAsset(
  update: StoredUpdate,
  channel: string,
  asset: StoredAsset,
  env: NodeJS.ProcessEnv,
  includeFileExtension: boolean,
): Record<string, string> {
  const out: Record<string, string> = {
    hash: asset.hash,
    key: asset.key,
    contentType: asset.contentType,
    url: assetUrl(update, channel, asset, env),
  };

  // The launch asset carries no fileExtension (EAS omits it too, and
  // ExpoUpdatesUpdate.kt reads it with getNullable there and getString for
  // ordinary assets — an ordinary asset missing it is silently DROPPED from the
  // update on Android, so this must never be omitted for those).
  if (includeFileExtension && asset.fileExtension) {
    out.fileExtension = asset.fileExtension;
  }

  return out;
}

/**
 * Build the manifest body exactly as the client parses it.
 *
 * Required by ExpoUpdatesUpdate.kt / ExpoUpdatesUpdate.swift, not merely by the
 * prose spec: `id` must parse as a UUID, `createdAt` as a date, and every entry
 * of `assets` must have key, url, fileExtension and hash.
 */
export function buildManifest(
  update: StoredUpdate,
  channel: string,
  platform: UpdatePlatform,
  env: NodeJS.ProcessEnv = process.env,
): ExpoManifest | null {
  const payload = update.platforms?.[platform];
  if (!payload?.launchAsset) {
    return null;
  }

  return {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: toManifestAsset(update, channel, payload.launchAsset, env, false),
    assets: (payload.assets ?? []).map((asset) =>
      toManifestAsset(update, channel, asset, env, true),
    ),
    // `branchName` is what expo-manifest-filters filters on. SelectionPolicies
    // lowercases metadata keys before comparing, so `branchName` here pairs with
    // `branchname` in the filter header.
    metadata: { branchName: channel, ...(update.metadata ?? {}) },
    extra: update.extra ?? {},
  };
}

export function buildNoUpdateAvailableDirective(): Record<string, unknown> {
  return { type: 'noUpdateAvailable' };
}

export function buildRollbackDirective(commitTime: string): Record<string, unknown> {
  return { type: 'rollBackToEmbedded', parameters: { commitTime } };
}

// ─── Structured field values (RFC 8941 / expo-sfv-0) ─────────────────────────

/**
 * Serialize a dictionary of string values as an RFC 8941 structured-field
 * dictionary: `sig="…", keyid="main", alg="rsa-v1_5-sha256"`.
 *
 * Every value is emitted as an sf-string — a QUOTED string — because
 * SignatureHeaderInfo.parseSignatureHeader only accepts StringItem for `sig`,
 * and falls back to the default keyid ("root") when `keyid` is anything else.
 * A bare token there means the client looks for a key named "root", finds the
 * configured "main" instead, and refuses the update with
 * "Key with keyid=… not found in client configuration" — which from the outside
 * is indistinguishable from "no update available".
 *
 * Only `\` and `"` are escaped; base64's `+/=` are all legal inside sf-string.
 */
export function serializeSfvDictionary(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${key}="${escaped}"`;
    })
    .join(', ');
}

/** Parsed form of the client's `expo-expect-signature` header. */
export type ExpectSignature = {
  keyid: string;
  alg: string | null;
};

/**
 * Read `expo-expect-signature`. Presence of the header is what matters — the
 * client sends it only when code signing is configured, i.e. when it will
 * REFUSE an unsigned response.
 */
export function parseExpectSignature(header: string | undefined): ExpectSignature | null {
  if (!header) {
    return null;
  }

  const keyid = /(?:^|[,\s])keyid\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header)?.[1];
  const alg = /(?:^|[,\s])alg\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header)?.[1];

  return {
    keyid: (keyid ?? 'main').replace(/\\(.)/g, '$1'),
    alg: alg ? alg.replace(/\\(.)/g, '$1') : null,
  };
}

// ─── Signing ─────────────────────────────────────────────────────────────────

let cachedPrivateKey: { path: string; pem: string } | null = null;

/** Drops the memoised key. Tests point the env at a different key between cases. */
export function resetCodeSigningKeyCache(): void {
  cachedPrivateKey = null;
}

function loadPrivateKey(env: NodeJS.ProcessEnv): string {
  const keyPath = getCodeSigningPrivateKeyPath(env);
  if (cachedPrivateKey?.path === keyPath) {
    return cachedPrivateKey.pem;
  }

  const pem = fs.readFileSync(keyPath, 'utf8');
  cachedPrivateKey = { path: keyPath, pem };
  return pem;
}

/**
 * Sign a response part body and return the `expo-signature` header value.
 *
 * The signature is over the EXACT bytes written into the part, so callers must
 * serialize once and pass the same string to both this function and the
 * multipart writer. Re-serializing (different key order, different spacing)
 * produces a signature that verifies against nothing.
 *
 * RSASSA-PKCS1-v1_5 with SHA-256, base64 (not base64url):
 * CodeSigningConfiguration.kt verifies with `Signature.getInstance("SHA256withRSA")`
 * over `Base64.decode(sig, Base64.DEFAULT)`.
 */
export function signBody(body: string, env: NodeJS.ProcessEnv = process.env): string {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(Buffer.from(body, 'utf8'));
  sign.end();
  const signature = sign.sign(loadPrivateKey(env), 'base64');

  return serializeSfvDictionary({
    sig: signature,
    keyid: 'main',
    alg: 'rsa-v1_5-sha256',
  });
}

// ─── multipart/mixed ─────────────────────────────────────────────────────────

export type MultipartPart = {
  name: 'manifest' | 'directive' | 'extensions' | 'certificate_chain';
  contentType: string;
  body: string;
  signature?: string;
};

export function generateBoundary(): string {
  return `expo-updates-${crypto.randomBytes(18).toString('hex')}`;
}

/**
 * Assemble a multipart/mixed body.
 *
 * Part shape is what okhttp's MultipartReader and the iOS parser both accept:
 * a `content-disposition` carrying a `name` parameter is the ONLY thing the
 * client dispatches on (FileDownloader.kt matches "manifest", "extensions",
 * "certificate_chain", "directive" and ignores every other part). The
 * disposition type itself is not inspected — Expo's own reference server emits
 * `form-data`, its iOS test fixture emits `inline` — so `form-data` is used
 * here, matching the reference server.
 */
export function buildMultipartBody(boundary: string, parts: MultipartPart[]): Buffer {
  const chunks: string[] = [];

  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    chunks.push(`content-type: ${part.contentType}\r\n`);
    chunks.push(`content-disposition: form-data; name="${part.name}"\r\n`);
    if (part.signature) {
      chunks.push(`expo-signature: ${part.signature}\r\n`);
    }
    chunks.push('\r\n');
    chunks.push(part.body);
    chunks.push('\r\n');
  }

  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(''), 'utf8');
}

// ─── Content types ───────────────────────────────────────────────────────────

/**
 * `expo export` strips extensions from asset filenames (they are bare content
 * hashes), so the extension recorded in update.json is the only source for a
 * content type. Anything unrecognised is served as octet-stream rather than
 * guessed — the client keys off the manifest's contentType, not this header.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.hbc': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function contentTypeForExtension(ext: string): string {
  const normalized = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
  return CONTENT_TYPES[normalized] ?? 'application/octet-stream';
}

/** base64url(SHA-256(bytes)) — the hash format the client re-computes and checks. */
export function sha256Base64Url(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}
