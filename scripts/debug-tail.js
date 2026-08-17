#!/usr/bin/env node
'use strict';

/**
 * Central debugging system, viewer half.
 *
 * PM2 already writes each process's stdout/stderr to logs/<name>-out-N.log /
 * logs/<name>-error-N.log (see deploy/local/ecosystem.config.js) — the N is
 * PM2's pm_id, which increments every time a process is `pm2 delete`d and
 * restarted, so several stale numbers can pile up per prefix. This tails the
 * highest-numbered (= current) file per prefix, across all four PM2 apps,
 * merges them into one time-ordered stream, and color-codes by level.
 *
 * Backend code logs structured JSON via backend/services/logger.ts (winston)
 * or Fastify's own request.log (pino) — both parsed here. Mobile errors
 * shipped through POST /debug/log (src/utils/remoteLogger.ts) land in the
 * api-* files tagged "mobile", same as everything else — that's the point of
 * "central": one merged stream instead of a phone nobody can plug in.
 *
 * Usage: node scripts/debug-tail.js [options]
 *   --source=api|static|tunnel|vps-tunnel|mobile   only one source (mobile = api entries tagged [mobile])
 *   --level=error|warn|info|debug                  only at/above this level
 *   --grep=<text>                                  only lines containing text (case-insensitive)
 *   --history=<n>                                  backlog lines to print first per file (default 50, 0 = none)
 *   --all                                           also tail stale/rotated numbered files, not just the current one
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');

const SOURCES = {
  api: { out: 'api-out', err: 'api-error' },
  static: { out: 'static-out', err: 'static-error' },
  tunnel: { out: 'tunnel-out', err: 'tunnel-error' },
  'vps-tunnel': { out: 'vps-tunnel-out', err: 'vps-tunnel-error' },
};

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m',
  reset: '\x1b[0m', dim: '\x1b[2m',
};

function printHelp() {
  console.log(`Usage: node scripts/debug-tail.js [options]

  --source=api|static|tunnel|vps-tunnel|mobile   only one source
  --level=error|warn|info|debug                  only at/above this level
  --grep=<text>                                  only lines containing text
  --history=<n>                                  backlog lines first (default 50, 0 = none)
  --all                                          also tail stale/rotated files, not just current
`);
}

function parseArgs(argv) {
  const opts = { source: null, level: null, grep: null, history: 50, all: false };
  for (const arg of argv) {
    if (arg.startsWith('--source=')) opts.source = arg.slice(9);
    else if (arg.startsWith('--level=')) opts.level = arg.slice(8).toLowerCase();
    else if (arg.startsWith('--grep=')) opts.grep = arg.slice(7);
    else if (arg.startsWith('--history=')) opts.history = Number(arg.slice(10)) || 0;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function latestLogFiles(prefix, includeStale) {
  if (!fs.existsSync(LOG_DIR)) return [];
  const rx = new RegExp(`^${prefix}-(\\d+)\\.log$`);
  const matches = fs
    .readdirSync(LOG_DIR)
    .map((name) => {
      const m = rx.exec(name);
      return m ? { name, n: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  if (matches.length === 0) return [];
  return includeStale ? matches.map((m) => m.name) : [matches[matches.length - 1].name];
}

function pinoLevelName(n) {
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  return 'debug';
}

// PM2's `time: true` (set on every app in ecosystem.config.js) prepends its
// own "YYYY-MM-DDTHH:mm:ss: " to EVERY line written to stdout/stderr, ahead
// of whatever the process itself wrote — including our JSON. Strip it before
// parsing, and fall back to it as the timestamp for lines that carry none of
// their own (e.g. multi-line console.error dumps split one line at a time).
const PM2_TIME_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):\s(.*)$/;

function parseLine(raw, sourceKey) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefixMatch = PM2_TIME_PREFIX.exec(trimmed);
  const pm2Ts = prefixMatch ? prefixMatch[1] : null;
  const line = prefixMatch ? prefixMatch[2] : trimmed;
  try {
    const obj = JSON.parse(line);
    let level = obj.level;
    if (typeof level === 'number') level = pinoLevelName(level);
    level = String(level || 'info').toLowerCase();
    if (!LEVEL_RANK[level]) level = 'info';
    const ts = obj.timestamp || (obj.time ? new Date(obj.time).toISOString() : null) || pm2Ts || new Date().toISOString();
    const msg = obj.msg || obj.message || '';
    const tag = obj.tag || (obj.err && obj.err.type) || null;
    return { ts, level, tag: tag || sourceKey, msg, raw: obj, source: sourceKey };
  } catch {
    const tagMatch = /^\[([\w-]+)\]/.exec(line);
    const level = /error|failed|exception/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info';
    return { ts: pm2Ts || new Date().toISOString(), level, tag: tagMatch ? tagMatch[1] : sourceKey, msg: line, raw: null, source: sourceKey };
  }
}

function formatEntry(e) {
  const color = COLORS[e.level] || '';
  const time = e.ts.length >= 19 ? e.ts.slice(11, 19) : e.ts;
  const tag = e.tag ? `[${e.tag}]` : '';
  return `${COLORS.dim}${time}${COLORS.reset} ${color}${e.level.padEnd(5)}${COLORS.reset} ${COLORS.dim}${tag}${COLORS.reset} ${e.msg}`;
}

function matchesFilters(entry, opts) {
  if (opts.source === 'mobile' && entry.tag !== 'mobile') return false;
  if (opts.level && LEVEL_RANK[entry.level] < LEVEL_RANK[opts.level]) return false;
  if (opts.grep) {
    const haystack = `${entry.msg} ${JSON.stringify(entry.raw || '')}`.toLowerCase();
    if (!haystack.includes(opts.grep.toLowerCase())) return false;
  }
  return true;
}

function readTail(filePath, n) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  return n > 0 ? lines.slice(-n) : [];
}

function watchFile(fullPath, sourceKey, startPosition, onLines) {
  let position = startPosition;
  return setInterval(() => {
    fs.stat(fullPath, (err, stat) => {
      if (err) return; // rotated away or not yet created — next tick may find it again
      if (stat.size < position) position = 0; // truncated or replaced
      if (stat.size <= position) return;
      const stream = fs.createReadStream(fullPath, { start: position, end: stat.size - 1, encoding: 'utf8' });
      let buf = '';
      stream.on('data', (chunk) => { buf += chunk; });
      stream.on('end', () => {
        position = stat.size;
        onLines(buf.split('\n').filter(Boolean));
      });
    });
  }, 500);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wanted = opts.source && opts.source !== 'mobile' ? [opts.source] : Object.keys(SOURCES);

  if (opts.source && opts.source !== 'mobile' && !SOURCES[opts.source]) {
    console.error(`Unknown source "${opts.source}". Known: ${Object.keys(SOURCES).join(', ')}, mobile`);
    process.exit(1);
  }

  const targets = []; // { sourceKey, fullPath }
  for (const key of wanted) {
    const def = SOURCES[key];
    for (const kind of ['out', 'err']) {
      for (const file of latestLogFiles(def[kind], opts.all)) {
        targets.push({ sourceKey: key, fullPath: path.join(LOG_DIR, file) });
      }
    }
  }

  if (targets.length === 0) {
    console.error(`No log files found in ${LOG_DIR}. Is the API running under PM2?`);
    process.exit(1);
  }

  if (opts.history > 0) {
    const historyEntries = [];
    for (const { sourceKey, fullPath } of targets) {
      try {
        for (const line of readTail(fullPath, opts.history)) {
          const entry = parseLine(line, sourceKey);
          if (entry && matchesFilters(entry, opts)) historyEntries.push(entry);
        }
      } catch {
        // File appeared in the listing then vanished (rotation race) — skip it.
      }
    }
    historyEntries.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const entry of historyEntries) console.log(formatEntry(entry));
  }

  for (const { sourceKey, fullPath } of targets) {
    let startPosition = 0;
    try {
      startPosition = fs.statSync(fullPath).size;
    } catch {
      // Will pick it up once it exists.
    }
    watchFile(fullPath, sourceKey, startPosition, (lines) => {
      for (const line of lines) {
        const entry = parseLine(line, sourceKey);
        if (entry && matchesFilters(entry, opts)) console.log(formatEntry(entry));
      }
    });
  }

  console.error(`${COLORS.dim}Tailing ${wanted.join(', ')} (${targets.length} file${targets.length === 1 ? '' : 's'}) — Ctrl+C to stop${COLORS.reset}`);
}

main();
