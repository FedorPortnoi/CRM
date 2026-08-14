#!/usr/bin/env node
'use strict';
/**
 * Publish an over-the-air JS update to the self-hosted Expo Updates store.
 *
 * This is the counterpart of backend/api/routes/updates.ts. It produces the
 * directory tree that endpoint reads. Nothing here talks to an Expo server: the
 * bundle is built locally and copied to a directory on this machine, which is
 * the same machine that serves 4kub.ru. See backend/services/updates-store.ts
 * for why (ФЗ-242, and Russian devices already cannot reliably reach Google's
 * CDNs — a US-hosted update channel would put the one remote-fix mechanism
 * behind the exact failure push is being moved off FCM to escape).
 *
 * Usage:
 *   node scripts/publish-update.js --channel production
 *   node scripts/publish-update.js --channel rustore --dry-run
 *   node scripts/publish-update.js --channel production --new-runtime
 *
 * Options:
 *   --channel <name>   REQUIRED. production | rustore | preview | huawei.
 *   --profile <name>   eas.json build profile to take env from. Defaults to the
 *                      profile whose "channel" equals --channel.
 *   --platform <p>     all (default, = ios+android) | ios | android.
 *   --new-runtime      Allow publishing under a runtimeVersion the store has
 *                      never seen. See THE GUARD below.
 *   --dry-run          Do everything except write into the store.
 *   --store <dir>      Override UPDATES_STORE_DIR for this run.
 *
 * ─── THE GUARD ──────────────────────────────────────────────────────────────
 *
 * The runtime version policy is `appVersion` (app.json — deliberately not
 * `fingerprint`, see the comment on resolveRuntimeVersion() below for why that
 * one could not converge). A runtimeVersion this script computes but that no
 * build has ever declared means the update you just published is addressed to
 * a runtime no installed binary will ever ask for. Nothing errors. The publish
 * "succeeds", every device keeps running the old bundle, and the only symptom
 * is that the fix never arrives.
 *
 * So a runtimeVersion that matches nothing already in the store aborts the
 * publish. `--new-runtime` is the acknowledgement that you know a new native
 * build — carrying the version bump appVersion requires — has to ship to the
 * stores before this update can reach anyone.
 *
 * ─── WHY THE BUILD PROFILE'S ENV IS APPLIED ─────────────────────────────────
 *
 * EXPO_PUBLIC_* variables are INLINED INTO THE BUNDLE at export time. eas.json's
 * production and rustore profiles set EXPO_PUBLIC_API_URL=https://4kub.ru/api/v1;
 * exporting without them produces a bundle that points wherever a developer's
 * shell happened to point — localhost, most likely — and shipping that over the
 * air breaks the API for every install at once, with no way to fix it except
 * another OTA that the broken app may not be able to fetch.
 *
 * The same env also feeds app.config.js, and therefore the fingerprint. Computing
 * the fingerprint under different env than the build used would produce a
 * runtimeVersion that does not match the installed app — the exact silent
 * failure the guard above exists to catch. Both steps use the same env for that
 * reason.
 *
 * ─── WHY THE WORKING TREE MUST BE CLEAN ─────────────────────────────────────
 *
 * An OTA update is unattributable after the fact: the bundle is minified
 * bytecode with no commit in it. If the tree is dirty, the thing running on
 * every phone corresponds to no commit that exists anywhere, and the next
 * developer cannot reproduce it. Untracked files count as dirty — Metro bundles
 * whatever is on disk, tracked or not.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_PLATFORMS = ['android', 'ios'];

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    channel: null,
    profile: null,
    platform: 'all',
    newRuntime: false,
    dryRun: false,
    store: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--channel':
        args.channel = argv[++i];
        break;
      case '--profile':
        args.profile = argv[++i];
        break;
      case '--platform':
        args.platform = argv[++i];
        break;
      case '--store':
        args.store = argv[++i];
        break;
      case '--new-runtime':
        args.newRuntime = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '-h':
      case '--help':
        printUsageAndExit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsageAndExit(code) {
  console.log(
    [
      'Usage: node scripts/publish-update.js --channel <name> [options]',
      '',
      '  --channel <name>   REQUIRED. production | rustore | preview | huawei',
      '  --profile <name>   eas.json build profile to take env from',
      '  --platform <p>     all (default) | ios | android',
      '  --new-runtime      allow a runtimeVersion the store has never seen',
      '  --dry-run          do everything except write into the store',
      '  --store <dir>      override UPDATES_STORE_DIR',
    ].join('\n'),
  );
  process.exit(code);
}

function fail(message) {
  console.error(`\n  publish-update: ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`  → ${message}`);
}

// ---------------------------------------------------------------------------
// preconditions
// ---------------------------------------------------------------------------
function assertCleanWorkingTree() {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    fail(`could not run git status: ${err.message}`);
  }

  const dirty = status.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (dirty.length > 0) {
    fail(
      [
        'the working tree is dirty; refusing to publish.',
        '',
        'An OTA bundle carries no commit id. Publishing from an uncommitted tree',
        'puts code on every phone that exists in no commit anywhere.',
        '',
        ...dirty.slice(0, 20).map((line) => `    ${line}`),
        ...(dirty.length > 20 ? [`    … and ${dirty.length - 20} more`] : []),
      ].join('\n'),
    );
  }

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

  return commit;
}

/**
 * Env the matching eas.json build profile would have used.
 *
 * Refuses to guess: if no profile declares this channel, the export would run
 * with whatever is in the current shell and the resulting bundle would be
 * unrelated to what the store builds ship.
 */
function resolveProfileEnv(channel, explicitProfile) {
  const easPath = path.join(ROOT, 'eas.json');
  let eas;
  try {
    eas = JSON.parse(fs.readFileSync(easPath, 'utf8'));
  } catch (err) {
    fail(`could not read eas.json: ${err.message}`);
  }

  const profiles = eas.build || {};
  let name = explicitProfile;

  if (!name) {
    const matches = Object.keys(profiles).filter((key) => profiles[key].channel === channel);
    if (matches.length === 0) {
      fail(
        `no eas.json build profile declares "channel": "${channel}". ` +
          'Publishing to a channel no build subscribes to reaches nobody. ' +
          'Pass --profile <name> if that is genuinely what you want.',
      );
    }
    if (matches.length > 1) {
      fail(
        `eas.json has ${matches.length} profiles on channel "${channel}" (${matches.join(', ')}); ` +
          'pass --profile to say which env to build with.',
      );
    }
    name = matches[0];
  }

  const profile = profiles[name];
  if (!profile) {
    fail(`eas.json has no build profile named "${name}"`);
  }

  return { profileName: name, env: profile.env || {} };
}

// ---------------------------------------------------------------------------
// expo CLI
// ---------------------------------------------------------------------------
function runExpo(args, env, { capture = true } = {}) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return execFileSync(npx, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 1024 * 1024 * 64,
    // npx is a .cmd shim on Windows; execFileSync cannot launch it without a shell.
    shell: process.platform === 'win32',
  });
}

/**
 * Runtime version for one platform.
 *
 * This used to compute `fingerprint:generate` and cross-check it against
 * `runtimeversion:resolve`, which only makes sense under
 * runtimeVersion.policy: "fingerprint" — the two commands are supposed to
 * derive the same string from the same inputs. app.json moved OFF that policy
 * in 776c1bd5 (2026-08-02): react-native-rustore-push is fetched via a git
 * checkout from GitFlic, and a git checkout does not hash identically across
 * machines, so `fingerprint:generate` returned a DIFFERENT value per machine —
 * sometimes per run — with zero real native changes. Comparing that against
 * anything was not a consistency check, it was a coin flip that happened to
 * read like one, and it would fail this script's own guard on every single
 * invocation from this point on.
 *
 * policy is now "appVersion", which is deterministic, and
 * `runtimeversion:resolve` already applies whichever policy app.json
 * declares — it is the sole authority under any policy, fingerprint or
 * appVersion or otherwise. Trust it directly rather than re-deriving a second
 * opinion that cannot agree with itself.
 */
function resolveRuntimeVersion(platform, env) {
  let resolved;
  try {
    const raw = runExpo(['expo-updates', 'runtimeversion:resolve', '--platform', platform], env);
    resolved = JSON.parse(raw).runtimeVersion;
  } catch (err) {
    fail(`runtimeversion:resolve failed for ${platform}: ${err.message}`);
  }

  if (!resolved) {
    fail(`could not compute a runtime version for ${platform}`);
  }

  return resolved;
}

/** The public expo config, which the client reads back as manifest.extra.expoClient. */
function readPublicExpoConfig(env) {
  try {
    return JSON.parse(runExpo(['expo', 'config', '--json', '--type', 'public'], env));
  } catch (err) {
    console.warn(`  ! could not read the public expo config (${err.message}); extra.expoClient will be omitted`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
/**
 * Export to a staging directory in the OS temp dir.
 *
 * Deliberately NOT `dist/`, which `expo export` defaults to: on this machine
 * dist/backend is the compiled backend that pm2 is running right now, and
 * exporting over it would take production down.
 */
function exportBundle(platforms, env) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-expo-export-'));

  const args = ['expo', 'export', '--output-dir', stagingDir];
  for (const platform of platforms) {
    args.push('--platform', platform);
  }

  step(`expo export --platform ${platforms.join(',')} → ${stagingDir}`);
  runExpo(args, env, { capture: false });

  const metadataPath = path.join(stagingDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    fail(`expo export produced no metadata.json in ${stagingDir}`);
  }

  return { stagingDir, metadata: JSON.parse(fs.readFileSync(metadataPath, 'utf8')) };
}

const CONTENT_TYPES = {
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
};

function contentTypeFor(ext) {
  const normalized = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
  return CONTENT_TYPES[normalized] || 'application/octet-stream';
}

/** base64url(SHA-256) — the hash the client re-computes and compares. */
function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64url');
}

/**
 * `createMetadataJson` in @expo/cli builds asset paths with path.join, so on
 * Windows they arrive as `assets\<md5>`. The manifest and the URL both need
 * POSIX separators, and a backslash would additionally be rejected by the asset
 * route's path allowlist — as a 404 on every asset, i.e. an update that
 * downloads its bundle and then fails.
 */
function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/').replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.channel) {
    console.error('\n  publish-update: --channel is required.\n');
    printUsageAndExit(1);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(args.channel)) {
    fail(`invalid channel name: ${args.channel}`);
  }

  const platforms =
    args.platform === 'all'
      ? NATIVE_PLATFORMS
      : NATIVE_PLATFORMS.filter((platform) => platform === args.platform);
  if (platforms.length === 0) {
    fail(`invalid --platform: ${args.platform} (expected all, ios or android)`);
  }

  const storeDir = path.resolve(
    args.store || process.env.UPDATES_STORE_DIR || path.join(os.homedir(), 'crm-updates'),
  );

  console.log('');
  const commit = assertCleanWorkingTree();
  step(`working tree clean at ${commit.slice(0, 12)}`);

  const { profileName, env } = resolveProfileEnv(args.channel, args.profile);
  step(`channel "${args.channel}" ← eas.json build profile "${profileName}"`);
  const inlined = Object.keys(env).filter((key) => key.startsWith('EXPO_PUBLIC_'));
  step(`inlined into the bundle: ${inlined.length > 0 ? inlined.join(', ') : '(none)'}`);

  // ── runtime versions, one per platform ─────────────────────────────────────
  const runtimeVersions = {};
  for (const platform of platforms) {
    step(`computing runtimeVersion for ${platform} …`);
    runtimeVersions[platform] = resolveRuntimeVersion(platform, env);
    step(`  ${platform}: ${runtimeVersions[platform]}`);
  }

  // ── THE GUARD ──────────────────────────────────────────────────────────────
  let known = [];
  try {
    known = fs
      .readdirSync(storeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    known = [];
  }

  const unknown = platforms.filter((platform) => !known.includes(runtimeVersions[platform]));
  if (unknown.length > 0 && !args.newRuntime) {
    fail(
      [
        `these runtime versions are not in the store yet: ${unknown
          .map((platform) => `${platform}=${runtimeVersions[platform]}`)
          .join(', ')}`,
        '',
        'The native side of the app changed, so no installed build has this',
        'fingerprint and none will ever request this update. Publishing anyway',
        'looks like success and reaches nobody.',
        '',
        `Store: ${storeDir}`,
        `Known runtime versions: ${known.length > 0 ? known.join(', ') : '(store is empty)'}`,
        '',
        'If a new native build is genuinely going to the stores, re-run with',
        '--new-runtime.',
      ].join('\n'),
    );
  }
  if (unknown.length > 0) {
    console.warn(
      `  ! --new-runtime: publishing to ${unknown.length} runtime version(s) no installed build has yet`,
    );
  }

  // ── export ─────────────────────────────────────────────────────────────────
  const expoConfig = readPublicExpoConfig(env);
  const { stagingDir, metadata } = exportBundle(platforms, env);

  const updateId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // Group platforms by runtimeVersion: iOS and Android fingerprints usually
  // differ, so the same publish is written under each one, carrying only that
  // platform's files. When they happen to be equal it is written once.
  const byRuntimeVersion = new Map();
  for (const platform of platforms) {
    const runtimeVersion = runtimeVersions[platform];
    if (!byRuntimeVersion.has(runtimeVersion)) {
      byRuntimeVersion.set(runtimeVersion, []);
    }
    byRuntimeVersion.get(runtimeVersion).push(platform);
  }

  const published = [];

  for (const [runtimeVersion, groupPlatforms] of byRuntimeVersion) {
    const updateDir = path.join(storeDir, runtimeVersion, args.channel, updateId);
    const record = {
      id: updateId,
      createdAt,
      runtimeVersion,
      channel: args.channel,
      platforms: {},
      metadata: { branchName: args.channel },
      extra: {
        commit,
        easBuildProfile: profileName,
        ...(expoConfig ? { expoClient: expoConfig } : {}),
      },
    };

    const filesToCopy = new Set();

    for (const platform of groupPlatforms) {
      const fileMetadata = metadata.fileMetadata && metadata.fileMetadata[platform];
      if (!fileMetadata || !fileMetadata.bundle) {
        fail(`expo export produced no bundle for ${platform}`);
      }

      const bundleRelative = toPosix(fileMetadata.bundle);
      const bundleFile = path.join(stagingDir, ...bundleRelative.split('/'));
      if (!fs.existsSync(bundleFile)) {
        fail(`bundle listed in metadata.json is missing on disk: ${bundleRelative}`);
      }
      filesToCopy.add(bundleRelative);

      const launchAsset = {
        // The client saves the launch asset as `<key><fileExtension>`, so the key
        // has to be filesystem-safe and unique per distinct bundle. The export
        // filename already contains a content hash, which gives both.
        key: path.basename(bundleRelative, path.extname(bundleRelative)),
        path: bundleRelative,
        contentType: 'application/javascript',
        hash: hashFile(bundleFile),
      };

      const assets = (fileMetadata.assets || []).map((asset) => {
        const assetRelative = toPosix(asset.path);
        const assetFile = path.join(stagingDir, ...assetRelative.split('/'));
        if (!fs.existsSync(assetFile)) {
          fail(`asset listed in metadata.json is missing on disk: ${assetRelative}`);
        }
        filesToCopy.add(assetRelative);

        const ext = asset.ext ? (asset.ext.startsWith('.') ? asset.ext : `.${asset.ext}`) : '';
        return {
          // Exported assets are named by content hash with no extension, so the
          // basename is a stable, unique key.
          key: path.basename(assetRelative),
          path: assetRelative,
          contentType: contentTypeFor(ext || path.extname(assetRelative)),
          // MUST be present: ExpoUpdatesUpdate.kt reads it with getString() and
          // silently DROPS any asset that lacks it.
          fileExtension: ext || path.extname(assetRelative) || '.bin',
          hash: hashFile(assetFile),
        };
      });

      record.platforms[platform] = { launchAsset, assets };
    }

    if (!args.dryRun) {
      fs.mkdirSync(updateDir, { recursive: true });
      for (const relative of filesToCopy) {
        const source = path.join(stagingDir, ...relative.split('/'));
        const destination = path.join(updateDir, ...relative.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }

      // update.json is written LAST. findLatestUpdate() skips a directory whose
      // update.json is missing or unparseable, so a publish interrupted halfway
      // is invisible to clients rather than half-served.
      fs.writeFileSync(
        path.join(updateDir, 'update.json'),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
    }

    published.push({
      runtimeVersion,
      platforms: groupPlatforms,
      updateDir,
      fileCount: filesToCopy.size,
    });
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });

  // ── the only output that matters ───────────────────────────────────────────
  console.log('');
  console.log(args.dryRun ? '  DRY RUN — nothing was written' : '  PUBLISHED');
  console.log(`  channel:  ${args.channel}   (eas.json profile "${profileName}")`);
  console.log(`  updateId: ${updateId}`);
  console.log(`  commit:   ${commit}`);
  for (const entry of published) {
    console.log(
      `  runtimeVersion ${entry.runtimeVersion}  [${entry.platforms.join(', ')}]  ` +
        `${entry.fileCount} files → ${entry.updateDir}`,
    );
  }
  console.log('');
  console.log('  Devices on any OTHER runtimeVersion will not receive this update.');
  console.log('');
}

main();
