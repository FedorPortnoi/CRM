/**
 * PM2 processes for the self-hosted deployment.
 *
 * Three processes replace what the VM ran: the API, a static file server in
 * place of nginx, and cloudflared in place of a public IP.
 *
 *   pm2 start deploy/local/ecosystem.config.js
 *   pm2 save                 remember them across reboots
 *   pm2 logs                 watch
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
      script: 'cloudflared',
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
  ],
};
