/**
 * Scheduled backup of the self-hosted database.
 *
 * Self-hosting trades managed backups for this file. Yandex Managed PostgreSQL
 * took automated backups with point-in-time recovery; nothing does that now, so
 * the entire recovery story is what this script produces. Treat it accordingly:
 * a backup nobody has restored is a hypothesis, not a backup.
 *
 * Usage:
 *   node deploy/local/backup.js            take a backup now
 *   node deploy/local/backup.js --verify   take one, then RESTORE it into a
 *                                          scratch database and count the rows
 *
 * Run --verify by hand every so often. It is the only thing that turns "the file
 * exists" into "the file works".
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PG_BIN = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/17/bin';
const OUT_DIR = process.env.BACKUP_DIR || path.resolve(process.env.USERPROFILE || '.', 'crm-backups');
const KEEP = Number(process.env.BACKUP_KEEP || 30);

function env() {
  const file = path.resolve(__dirname, '../../.env.localprod');
  const text = fs.readFileSync(file, 'utf8');
  const get = (k) => (text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^"|"$/g, '');
  const url = new URL(get('DIRECT_URL'));
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    db: url.pathname.replace(/^\//, '').split('?')[0],
  };
}

function stamp() {
  // No Date-based filename collisions: seconds resolution, sortable, UTC.
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function run(bin, args, extraEnv) {
  return execFileSync(path.join(PG_BIN, bin), args, {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 256,
  });
}

const cfg = env();
fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `crm-${stamp()}.dump`);

run('pg_dump.exe', [
  '-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', cfg.db,
  '--no-owner', '--no-privileges', '--format=custom', '-f', file,
], { PGPASSWORD: cfg.pass });

const size = fs.statSync(file).size;
if (size < 1024) {
  // A dump that is suspiciously small is the failure mode that looks like
  // success: the file exists, the script exited 0, and there is nothing in it.
  throw new Error(`backup is only ${size} bytes — refusing to call that a backup`);
}
console.log(`backup: ${file} (${Math.round(size / 1024)} KB)`);

// Retention. Oldest first, keep the newest KEEP files.
const dumps = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.dump')).sort();
for (const old of dumps.slice(0, Math.max(0, dumps.length - KEEP))) {
  fs.unlinkSync(path.join(OUT_DIR, old));
  console.log(`pruned: ${old}`);
}

if (process.argv.includes('--verify')) {
  const scratch = 'crm_restore_check';
  console.log(`verifying by restoring into ${scratch} …`);
  const psql = (sql, db = 'postgres') => run('psql.exe', [
    '-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', db, '-t', '-c', sql,
  ], { PGPASSWORD: cfg.pass }).toString().trim();

  psql(`DROP DATABASE IF EXISTS ${scratch};`);
  psql(`CREATE DATABASE ${scratch};`);
  run('pg_restore.exe', [
    '-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', scratch,
    '--no-owner', '--no-privileges', file,
  ], { PGPASSWORD: cfg.pass });

  const counts = psql(
    `SELECT 'users='||(SELECT count(*) FROM "User")||
     ' orgs='||(SELECT count(*) FROM organizations)||
     ' contacts='||(SELECT count(*) FROM "Contact")`,
    scratch,
  );
  console.log(`restored OK: ${counts}`);
  psql(`DROP DATABASE ${scratch};`);
  console.log('verify passed — this backup can actually be restored');
}
