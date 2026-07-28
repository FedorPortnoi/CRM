// ---------------------------------------------------------------------------
// Configuration parsing.
//
// Everything in this file is pure: it turns the plain-string `[vars]` block
// from wrangler.toml into typed, bounded values. No secrets are read here —
// secrets live in `Env` and are only ever touched by auth.ts and the upstream
// request builder in index.ts.
// ---------------------------------------------------------------------------

export type ProxyConfig = {
  /** Exact model ids the proxy will forward. Empty means "nothing is allowed". */
  allowedModels: string[];
  /** Hard ceiling on forwarded requests per day. */
  dailyRequestLimit: number;
  /** Largest request body we will read, in bytes. */
  maxBodyBytes: number;
  /** Abort the upstream call after this long. */
  upstreamTimeoutMs: number;
  /** Whether `"stream": true` is accepted (see README — off by default). */
  allowStreaming: boolean;
  /** Minutes to shift the daily-quota day boundary away from UTC. */
  dayBoundaryOffsetMinutes: number;
  /** Reject requests asking for more output tokens than this. 0 disables. */
  maxOutputTokens: number;
};

export type ConfigVars = {
  ALLOWED_MODELS?: string;
  DAILY_REQUEST_LIMIT?: string;
  MAX_BODY_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  ALLOW_STREAMING?: string;
  DAY_BOUNDARY_OFFSET_MINUTES?: string;
  MAX_OUTPUT_TOKENS?: string;
};

export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

export function parseBoundedInt(
  raw: string | undefined,
  options: { fallback: number; min: number; max: number },
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return options.fallback;
  if (parsed < options.min) return options.min;
  if (parsed > options.max) return options.max;
  return parsed;
}

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

export function loadConfig(vars: ConfigVars): ProxyConfig {
  return {
    allowedModels: parseList(vars.ALLOWED_MODELS),
    dailyRequestLimit: parseBoundedInt(vars.DAILY_REQUEST_LIMIT, {
      fallback: 500,
      min: 0,
      max: 10_000_000,
    }),
    maxBodyBytes: parseBoundedInt(vars.MAX_BODY_BYTES, {
      fallback: 262_144,
      min: 1_024,
      max: 8_388_608,
    }),
    upstreamTimeoutMs: parseBoundedInt(vars.UPSTREAM_TIMEOUT_MS, {
      fallback: 60_000,
      min: 1_000,
      max: 600_000,
    }),
    allowStreaming: parseBool(vars.ALLOW_STREAMING, false),
    dayBoundaryOffsetMinutes: parseBoundedInt(vars.DAY_BOUNDARY_OFFSET_MINUTES, {
      fallback: 0,
      min: -720,
      max: 840,
    }),
    maxOutputTokens: parseBoundedInt(vars.MAX_OUTPUT_TOKENS, {
      fallback: 0,
      min: 0,
      max: 1_000_000,
    }),
  };
}

/**
 * Exact-match only. Deliberately no prefix or wildcard matching: `gpt-4o` must
 * not silently authorise `gpt-4o-2099-01-01` or some future far pricier model
 * that happens to share a prefix. Dated snapshots have to be listed explicitly.
 */
export function isModelAllowed(model: unknown, allowed: string[]): model is string {
  return typeof model === 'string' && allowed.includes(model);
}

/**
 * `YYYY-MM-DD` bucket key for the daily counter, shifted by `offsetMinutes`
 * so the quota can roll over at local midnight instead of UTC midnight
 * (Moscow = 180).
 */
export function dayKey(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Seconds until the next day boundary — used for `Retry-After` when the daily
 * ceiling is hit, so the caller knows to back off for hours, not seconds.
 */
export function secondsUntilNextDay(now: Date, offsetMinutes: number): number {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const nextMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((nextMidnight - shifted.getTime()) / 1000));
}
