#!/usr/bin/env node
'use strict';

/**
 * Inspect and control the self-hosted Expo Updates store.
 *
 * This script never builds a bundle. Use publish-update.js for that. Its two
 * mutating commands only create/remove rollback markers, and both support
 * --dry-run so an operator can verify the exact target first.
 *
 * Examples:
 *   node scripts/manage-updates.js status
 *   node scripts/manage-updates.js status --runtime 1.1.8-native2 --channel production
 *   node scripts/manage-updates.js rollback --runtime 1.1.8-native2 --channel production --platform ios --dry-run
 *   node scripts/manage-updates.js resume --runtime 1.1.8-native2 --channel production --platform ios
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PLATFORMS = ['ios', 'android'];
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['status', 'rollback', 'resume'].includes(command)) {
    fail('first argument must be status, rollback, or resume');
  }

  const args = {
    command,
    runtime: null,
    channel: null,
    platform: 'all',
    store: null,
    dryRun: false,
    json: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') args.runtime = argv[++i];
    else if (arg === '--channel') args.channel = argv[++i];
    else if (arg === '--platform') args.platform = argv[++i];
    else if (arg === '--store') args.store = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else fail(`unknown argument: ${arg}`);
  }

  if (args.runtime && !isSafeSegment(args.runtime)) fail('invalid --runtime');
  if (args.channel && !isSafeSegment(args.channel)) fail('invalid --channel');
  if (!['all', ...PLATFORMS].includes(args.platform)) {
    fail('--platform must be all, ios, or android');
  }
  if (command !== 'status' && (!args.runtime || !args.channel)) {
    fail(`${command} requires --runtime and --channel`);
  }
  if (command === 'status' && args.dryRun) fail('--dry-run is only valid for rollback or resume');

  return args;
}

function isSafeSegment(value) {
  return (
    typeof value === 'string' &&
    value !== '.' &&
    value !== '..' &&
    SAFE_SEGMENT.test(value)
  );
}

function storeDirectory(args, env = process.env) {
  return path.resolve(args.store || env.UPDATES_STORE_DIR || path.join(os.homedir(), 'crm-updates'));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function directories(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeSegment(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function markerState(channelDir, platform) {
  for (const markerName of [`rollback.${platform}.json`, 'rollback.json']) {
    const commitTime = readJson(path.join(channelDir, markerName))?.commitTime;
    if (typeof commitTime === 'string' && Number.isFinite(Date.parse(commitTime))) {
      return commitTime;
    }
  }
  return null;
}

function latestUpdate(channelDir, runtime, channel, platform) {
  let latest = null;
  for (const updateId of directories(channelDir)) {
    const update = readJson(path.join(channelDir, updateId, 'update.json'));
    if (
      update?.id !== updateId ||
      update?.runtimeVersion !== runtime ||
      update?.channel !== channel ||
      !update?.platforms?.[platform]?.launchAsset ||
      !Number.isFinite(Date.parse(update.createdAt))
    ) {
      continue;
    }

    if (
      !latest ||
      Date.parse(update.createdAt) > Date.parse(latest.createdAt) ||
      (update.createdAt === latest.createdAt && update.id > latest.id)
    ) {
      latest = update;
    }
  }
  return latest;
}

function inspectStore(storeDir, filters = {}) {
  const rows = [];
  for (const runtime of directories(storeDir)) {
    if (filters.runtime && filters.runtime !== runtime) continue;
    const runtimeDir = path.join(storeDir, runtime);
    for (const channel of directories(runtimeDir)) {
      if (filters.channel && filters.channel !== channel) continue;
      const channelDir = path.join(runtimeDir, channel);
      for (const platform of PLATFORMS) {
        if (filters.platform && filters.platform !== 'all' && filters.platform !== platform) continue;
        const latest = latestUpdate(channelDir, runtime, channel, platform);
        const rollbackCommitTime = markerState(channelDir, platform);
        if (!latest && !rollbackCommitTime) continue;
        rows.push({
          runtime,
          channel,
          platform,
          latestUpdateId: latest?.id ?? null,
          latestCreatedAt: latest?.createdAt ?? null,
          commit: latest?.extra?.commit ?? null,
          rollbackCommitTime,
        });
      }
    }
  }
  return rows;
}

function printStatus(rows, storeDir, asJson) {
  if (asJson) {
    console.log(JSON.stringify({ storeDir, targets: rows }, null, 2));
    return;
  }

  console.log(`Update store: ${storeDir}`);
  if (rows.length === 0) {
    console.log('No matching update targets.');
    return;
  }
  for (const row of rows) {
    const update = row.latestCreatedAt
      ? `${row.latestCreatedAt} ${row.latestUpdateId}`
      : '(no remote update)';
    const rollback = row.rollbackCommitTime ? `ROLLBACK ${row.rollbackCommitTime}` : 'active';
    console.log(`${row.runtime}  ${row.channel}  ${row.platform}  ${rollback}`);
    console.log(`  latest: ${update}`);
    if (row.commit) console.log(`  commit: ${row.commit}`);
  }
}

function targetPlatforms(value) {
  return value === 'all' ? PLATFORMS : [value];
}

function atomicWriteJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
}

function rollback(args, storeDir) {
  const channelDir = path.join(storeDir, args.runtime, args.channel);
  if (!fs.existsSync(channelDir)) {
    fail(`target does not exist in the update store: ${args.runtime}/${args.channel}`);
  }

  const actions = [];
  for (const platform of targetPlatforms(args.platform)) {
    const latest = latestUpdate(channelDir, args.runtime, args.channel, platform);
    if (!latest) {
      fail(`no ${platform} update exists for ${args.runtime}/${args.channel}`);
    }
    // A rollback is accepted only when it is newer than the launched update.
    // Account for a slightly future-skewed publisher clock as well as Date.now().
    const commitTime = new Date(
      Math.max(Date.now(), Date.parse(latest.createdAt) + 1),
    ).toISOString();
    actions.push({
      platform,
      file: path.join(channelDir, `rollback.${platform}.json`),
      value: { commitTime },
    });
  }

  for (const action of actions) {
    console.log(
      `${args.dryRun ? 'Would enable' : 'Enabling'} rollback: ${args.runtime}/${args.channel}/${action.platform} at ${action.value.commitTime}`,
    );
    if (!args.dryRun) atomicWriteJson(action.file, action.value);
  }
}

function resume(args, storeDir) {
  const channelDir = path.join(storeDir, args.runtime, args.channel);
  if (!fs.existsSync(channelDir)) {
    fail(`target does not exist in the update store: ${args.runtime}/${args.channel}`);
  }

  const legacyMarker = path.join(channelDir, 'rollback.json');
  if (args.platform !== 'all' && fs.existsSync(legacyMarker)) {
    fail('a legacy all-platform rollback.json exists; resume with --platform all');
  }

  const files = targetPlatforms(args.platform).map((platform) => ({
    platform,
    file: path.join(channelDir, `rollback.${platform}.json`),
  }));
  if (args.platform === 'all') files.push({ platform: 'all (legacy)', file: legacyMarker });

  const existing = files.filter((entry) => fs.existsSync(entry.file));
  if (existing.length === 0) {
    console.log(`No rollback marker is active for ${args.runtime}/${args.channel}/${args.platform}.`);
    return;
  }

  for (const entry of existing) {
    console.log(
      `${args.dryRun ? 'Would resume' : 'Resuming'} updates: ${args.runtime}/${args.channel}/${entry.platform}`,
    );
    if (!args.dryRun) fs.unlinkSync(entry.file);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const storeDir = storeDirectory(args);
  if (args.command === 'status') {
    printStatus(
      inspectStore(storeDir, {
        runtime: args.runtime,
        channel: args.channel,
        platform: args.platform,
      }),
      storeDir,
      args.json,
    );
  } else if (args.command === 'rollback') {
    rollback(args, storeDir);
  } else {
    resume(args, storeDir);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`manage-updates: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  inspectStore,
  latestUpdate,
  main,
  markerState,
  parseArgs,
  rollback,
  resume,
  storeDirectory,
};
