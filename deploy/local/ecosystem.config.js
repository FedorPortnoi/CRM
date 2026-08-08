/**
 * PM2 processes for the self-hosted deployment.
 *
 * Four processes replace what the VM ran: the API, a static file server in
 * place of nginx, cloudflared in place of a public IP, and the database backup
 * job the self-hosted deployment otherwise does not have.
 *
 *   pm2 start deploy/local/ecosystem.config.js --only crm-api,crm-static,crm-tunnel
 *   pm2 save                 remember them across reboots
 *   pm2 logs                 watch
 *
 * The `--only` is not optional politeness. Four apps are declared here and PM2
 * currently manages three; the bare form additionally starts crm-backup, which
 * runs a pg_dump against crm_prod the instant it comes up and installs a
 * `30 3 * * *` cron restart that may duplicate an existing schedule. Add
 * crm-backup to the list deliberately, when that is what you mean.
 *
 * `instances: 1` is stated explicitly on the API and it is load-bearing, not
 * decoration. Several things in this codebase are correct only in a single
 * process — the scheduler's overlap guard, the workflow cache, the in-memory
 * rate-limit buckets, the Telegram login map. `pm2 scale` on the API would break
 * all four silently. See the notes in backend/services/scheduler.ts.
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const ENV_FILE = path.join(ROOT, '.env.localprod');

/**
 * Read .env.localprod HERE rather than relying on a `-r dotenv/config` preload.
 *
 * The preload works when you run node by hand and silently does not when PM2
 * launches the process — PM2 did not pass node_args through on Windows, so the
 * API came up attached to the DEV database while every check said it was
 * healthy. It answered /health, it answered login for a seed user, and it would
 * have served an empty product to real users. That is the same shape as the
 * other failures this codebase has collected: a green check measuring the wrong
 * thing.
 *
 * Reading the file here removes the question entirely — whatever is in `env`
 * below is what the process gets, with no interpreter flags in between.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file} — the API cannot start without it`);
  }
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const APP_ENV = loadEnvFile(ENV_FILE);

// Fail loudly at config load rather than quietly at runtime. Attaching to the
// wrong database is the exact failure this block exists to prevent, and it is
// invisible from the outside — the API is perfectly healthy, just empty.
if (!String(APP_ENV.DATABASE_URL || '').includes('/crm_prod')) {
  throw new Error('DATABASE_URL in .env.localprod does not point at crm_prod');
}
if (!APP_ENV.TOKEN_ENCRYPTION_KEY) {
  throw new Error('TOKEN_ENCRYPTION_KEY missing — encrypted contact columns would be unreadable');
}

module.exports = {
  apps: [
    {
      name: 'crm-api',
      cwd: ROOT,
      script: 'dist/backend/index.js',
      env: {
        ...APP_ENV,
        NODE_ENV: 'production',
        // backend/config/env.ts skips any key already present, so everything
        // above wins over the repo's .env. This flag stops it reading that file
        // at all, so there is one source of truth rather than two.
        CRM_SKIP_LOCAL_ENV: 'true',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      max_memory_restart: '600M',
      time: true,
      error_file: path.join(ROOT, 'logs/api-error.log'),
      out_file: path.join(ROOT, 'logs/api-out.log'),
    },
    {
      name: 'crm-static',
      cwd: ROOT,
      script: path.join(__dirname, 'static-server.js'),
      env: { STATIC_PORT: '8080' },
      /**
       * WHY THIS EXISTS. The security headers this server sends — the CSP with
       * its per-page script hashes, nosniff, X-Frame-Options, Referrer-Policy —
       * are computed by static-headers.js, which Node `require`s ONCE at process
       * start. The site is deployed by editing files in place and nothing
       * restarts this process, so the headers were correct in git and absent
       * from every live response for hours, with no error anywhere and every
       * unit test green. This closes that seam: change either file, PM2 bounces
       * the process, and source and runtime cannot silently disagree again.
       *
       * PATHS ARE RELATIVE TO cwd, NOT TO THIS FILE. PM2 hands `watch` to
       * chokidar with `cwd: pm_cwd` (pm2/lib/Watcher.js), and cwd is ROOT above,
       * not deploy/local. Written as ['static-server.js','static-headers.js']
       * these resolve to two paths that do not exist; with chokidar's
       * ignoreInitial that emits nothing and errors nothing, so the watcher
       * would look configured and fire on nothing — the same green-check-
       * measuring-the-wrong-thing shape it is here to prevent. A test asserts
       * every entry below resolves to a real file.
       *
       * website/ is deliberately NOT watched: every content edit would bounce
       * the public site, and content changes need no restart (the CSP hashes are
       * recomputed per request, memoised on mtime+size).
       *
       * This block only reaches the runtime through `pm2 delete crm-static &&
       * pm2 start deploy/local/ecosystem.config.js --only crm-static`. A plain
       * `pm2 restart` replays the STORED environment and never re-reads this
       * file. Keep the `--only`: without it PM2 also starts crm-backup, which
       * immediately runs a pg_dump against crm_prod.
       */
      watch: ['deploy/local/static-server.js', 'deploy/local/static-headers.js'],
      watch_delay: 2000,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      time: true,
      error_file: path.join(ROOT, 'logs/static-error.log'),
      out_file: path.join(ROOT, 'logs/static-out.log'),
    },
    {
      // The public door. Without it nothing outside this machine can reach
      // either process above — there is no public IP and no port forwarding.
      name: 'crm-tunnel',
      cwd: ROOT,
      // Forward slashes on purpose: Windows accepts them, and a backslash path in
      // a JS string is a minefield of escape sequences (\c, \P) that mangle
      // silently rather than erroring.
      script: 'C:/Program Files (x86)/cloudflared/cloudflared.exe',
      args: ['tunnel', '--config', path.join(__dirname, 'cloudflared.yml'), 'run'],
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      time: true,
      error_file: path.join(ROOT, 'logs/tunnel-error.log'),
      out_file: path.join(ROOT, 'logs/tunnel-out.log'),
    },
    {
      // A one-shot process: PM2 starts it once when this ecosystem is installed, then its cron
      // restart runs it every night. autorestart stays false so a successful dump does not loop.
      // Dumps default to C:\Users\<user>\crm-backups and keep 30 generations; BACKUP_DIR and
      // BACKUP_KEEP in .env.localprod override those values. An off-machine copy is still required
      // to survive loss of this laptop.
      name: 'crm-backup',
      cwd: ROOT,
      script: path.join(__dirname, 'backup.js'),
      env: { ...APP_ENV, NODE_ENV: 'production' },
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '30 3 * * *',
      time: true,
      error_file: path.join(ROOT, 'logs/backup-error.log'),
      out_file: path.join(ROOT, 'logs/backup-out.log'),
    },
  ],
};
