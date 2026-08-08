import net from 'node:net';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class OutboundRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

type RequiredSecretOptions = {
  minLength?: number;
};

type CorsOrigin = boolean | string[];
type DeploymentSafeUrlOptions = {
  requiredInProduction?: boolean;
  allowedProtocols?: string[];
};

type ProductionUrlOptions = {
  allowedProtocols: string[];
  requirePassword?: boolean;
};

const weakSecretValues = new Set([
  'secret',
  'jwt_secret',
  'jwtsecret',
  'changeme',
  'change_me',
  'password',
  'test',
  'development',
  'dev',
]);

function readTrimmedEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * THE MOMENT A PROVEN EMAIL ADDRESS BECAME A CONDITION OF HOLDING A SESSION.
 *
 * Every account that existed before this instant is GRANDFATHERED: it keeps its
 * session and its doors even with is_verified = false. Everything created after
 * it must prove its address before a token is worth anything.
 *
 * Why a grandfather clause at all. Until this constant landed, the invite flow
 * created accounts with is_verified = false and handed them a 7-day session
 * anyway (backend/api/controllers/invites.ts), and /auth/join never asked the
 * question. Real people are therefore sitting in production on unverified rows
 * through no fault of their own, and none of them ever received an OTP. Gating
 * them out would revoke live sessions mid-shift from users whose only remaining
 * door — /auth/join — this same change closes, leaving them no recovery path at
 * all. The set is finite and can only shrink: nothing after this instant joins
 * it, and any member of it that verifies leaves it for good.
 *
 * IT MUST STAY A LITERAL. Written as `new Date()` it would be re-evaluated at
 * every process start, grandfather every account that exists at boot, and turn
 * the whole gate into a no-op that still reads like a gate. The unit tests
 * assert against dates on either side of a hard-coded literal for that reason.
 */
export const VERIFICATION_ENFORCED_SINCE = new Date('2026-08-07T00:00:00.000Z');

/**
 * The revert switch for the three gates that depend on the constant above.
 *
 * Default ON. Set REQUIRE_EMAIL_VERIFICATION=false to put the server back to its
 * pre-fix behaviour — invite acceptance mints a session again, /auth/join and
 * the API preHandler stop asking — without a code change or a rebuild. It exists
 * because the OTP leg of invite acceptance needs a client that knows how to
 * enter a code: a backend that ships ahead of that client strands invitees on
 * already-installed binaries, and ten seconds is the right amount of time for
 * that to be undone.
 */
export function isEmailVerificationEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return readTrimmedEnv('REQUIRE_EMAIL_VERIFICATION', env) !== 'false';
}

/**
 * Does this account still owe proof of its email address?
 *
 * The one place the two rules above are combined, so the API preHandler,
 * /auth/join and anything added later cannot drift apart on either of them.
 *
 * A row with no created_at — which Prisma never produces, the column is NOT NULL
 * with a default — is treated as grandfathered rather than blocked. Failing open
 * on a value that cannot occur is the right direction for a gate whose worst
 * outcome is locking real users out of a live CRM.
 */
export function requiresEmailVerification(
  user: { is_verified?: boolean | null; created_at?: Date | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isEmailVerificationEnforced(env)) return false;
  if (user.is_verified === true) return false;
  const createdAt = user.created_at;
  if (!(createdAt instanceof Date)) return false;
  return createdAt > VERIFICATION_ENFORCED_SINCE;
}

export function getRequiredSecret(
  name: string,
  options: RequiredSecretOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const minLength = options.minLength ?? 32;
  const value = readTrimmedEnv(name, env);

  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }

  if (value.length < minLength) {
    throw new ConfigurationError(`${name} must be at least ${minLength} characters`);
  }

  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (weakSecretValues.has(normalized) || normalized.includes('change_me')) {
    throw new ConfigurationError(`${name} is too weak`);
  }

  return value;
}

export function getJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  return getRequiredSecret('JWT_SECRET', { minLength: 32 }, env);
}

export function getTokenEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = readTrimmedEnv('TOKEN_ENCRYPTION_KEY', env);

  if (!value) {
    if (env.NODE_ENV === 'production') {
      throw new ConfigurationError('TOKEN_ENCRYPTION_KEY is required in production');
    }

    return getJwtSecret(env);
  }

  const secret = getRequiredSecret('TOKEN_ENCRYPTION_KEY', { minLength: 32 }, env);
  const jwtSecret = readTrimmedEnv('JWT_SECRET', env);
  if (env.NODE_ENV === 'production' && jwtSecret && secret === jwtSecret) {
    throw new ConfigurationError('TOKEN_ENCRYPTION_KEY must be different from JWT_SECRET in production');
  }

  return secret;
}

export function getYandexWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!readTrimmedEnv('YANDEX_WEBHOOK_SECRET', env)) {
    if (env.NODE_ENV === 'production') {
      throw new ConfigurationError('YANDEX_WEBHOOK_SECRET is required in production');
    }

    return undefined;
  }

  return getRequiredSecret('YANDEX_WEBHOOK_SECRET', { minLength: 32 }, env);
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getCorsOrigin(env: NodeJS.ProcessEnv = process.env): CorsOrigin {
  const allowlist = [
    ...parseCsvEnv(env.CORS_ORIGINS),
    ...parseCsvEnv(env.CRM_CORS_ORIGINS),
    ...parseCsvEnv(env.ALLOWED_ORIGINS),
  ];

  if (env.NODE_ENV === 'production') {
    if (allowlist.length === 0) {
      throw new ConfigurationError('CORS_ORIGINS or CRM_CORS_ORIGINS must be set in production');
    }

    return Array.from(new Set(allowlist));
  }

  return allowlist.length > 0 ? Array.from(new Set(allowlist)) : true;
}

function parseIpv4Part(part: string): number | null {
  if (part.length === 0) {
    return null;
  }

  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    value = parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = parseInt(part, 8);
  } else if (/^[0-9]+$/.test(part)) {
    value = parseInt(part, 10);
  } else {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}

// Parse an IPv4 literal in any inet_aton form (dotted-decimal, bare decimal,
// hex, octal, and short a.b / a.b.c notations) into four octets, or null when
// the host is not a numeric IPv4 literal.
function parseIpv4Literal(hostname: string): [number, number, number, number] | null {
  const rawParts = hostname.split('.');
  if (rawParts.length < 1 || rawParts.length > 4) {
    return null;
  }

  const parts: number[] = [];
  for (const raw of rawParts) {
    const parsed = parseIpv4Part(raw);
    if (parsed === null || parsed < 0) {
      return null;
    }
    parts.push(parsed);
  }

  const octets: number[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] > 255) {
      return null;
    }
    octets.push(parts[i]);
  }

  const last = parts[parts.length - 1];
  const remaining = 4 - (parts.length - 1);
  const maxLast = 2 ** (8 * remaining) - 1;
  if (last > maxLast) {
    return null;
  }
  for (let i = remaining - 1; i >= 0; i -= 1) {
    octets.push((last >>> (8 * i)) & 0xff);
  }

  return octets as [number, number, number, number];
}

function isReservedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  return false;
}

// Expand an IPv6 literal (including :: compression and IPv4-mapped tails) into
// eight 16-bit groups, or null when the host is not a valid IPv6 literal.
function expandIpv6(hostname: string): number[] | null {
  if (net.isIP(hostname) !== 6) {
    return null;
  }

  let value = hostname;
  const embedded = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded && embedded.index !== undefined) {
    const v4 = parseIpv4Literal(embedded[1]);
    if (!v4) {
      return null;
    }
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    value = `${value.slice(0, embedded.index)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  }

  if (groups.length !== 8) {
    return null;
  }

  const result: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    result.push(parseInt(group, 16));
  }

  return result;
}

function isReservedIpv6(groups: number[]): boolean {
  if (groups.every((g) => g === 0)) return true; // :: (unspecified)
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 (loopback)

  const first = groups[0];
  const firstByte = first >> 8;
  const secondByte = first & 0xff;
  if (firstByte === 0xfc || firstByte === 0xfd) return true; // fc00::/7 (unique local)
  if (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) return true; // fe80::/10 (link-local)

  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d): re-check the embedded IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isReservedIpv4([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }

  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  const ipv6 = expandIpv6(host);
  if (ipv6) {
    return isReservedIpv6(ipv6);
  }

  const ipv4 = parseIpv4Literal(host);
  if (ipv4) {
    return isReservedIpv4(ipv4);
  }

  return false;
}

// Bitrix24 cloud-portal allowlist (single-level subdomain of a known TLD).
const BITRIX_WEBHOOK_HOST = /^([a-z0-9-]+\.)?bitrix24\.(ru|com|by|kz|eu|de)$/i;

// Guard outbound Bitrix24 webhook requests against SSRF. Rejects anything that
// is not an https URL pointing at an allowlisted Bitrix24 cloud portal, and, as
// defense-in-depth, rejects hosts that are private/reserved IP literals.
export function assertAllowedBitrixWebhookUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OutboundRequestError('Webhook URL is not a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new OutboundRequestError('Webhook URL must use https');
  }

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!BITRIX_WEBHOOK_HOST.test(hostname)) {
    throw new OutboundRequestError('Webhook URL host is not an allowed Bitrix24 portal');
  }

  if (isPrivateHostname(hostname)) {
    throw new OutboundRequestError('Webhook URL must not point to a private or reserved address');
  }
}

function normalizeProtocol(protocol: string): string {
  const lower = protocol.toLowerCase();
  return lower.endsWith(':') ? lower : `${lower}:`;
}

export function getDeploymentSafeUrl(
  name: string,
  options: DeploymentSafeUrlOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readTrimmedEnv(name, env);

  if (!value) {
    if (env.NODE_ENV === 'production' && options.requiredInProduction) {
      throw new ConfigurationError(`${name} is required in production`);
    }

    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid absolute URL`);
  }

  const allowedProtocols = options.allowedProtocols?.map(normalizeProtocol)
    ?? (env.NODE_ENV === 'production' ? ['https:'] : undefined);

  if (allowedProtocols && !allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(`${name} must use one of these protocols: ${allowedProtocols.join(', ')}`);
  }

  if (
    env.NODE_ENV === 'production' &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    isPrivateHostname(parsed.hostname)
  ) {
    throw new ConfigurationError(`${name} must not point to a private or local host in production`);
  }

  return parsed.toString();
}

function validateProductionUrl(
  name: string,
  options: ProductionUrlOptions,
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const value = readTrimmedEnv(name, env);
  if (!value) {
    throw new ConfigurationError(`${name} is required in production`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid absolute URL`);
  }

  const allowedProtocols = options.allowedProtocols.map(normalizeProtocol);
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ConfigurationError(`${name} must use one of these protocols: ${allowedProtocols.join(', ')}`);
  }

  if (isPrivateHostname(parsed.hostname)) {
    // SELF-HOSTED DEPLOYMENTS ARE THE ONE LEGITIMATE EXCEPTION.
    //
    // This check exists to catch a CLOUD deployment left pointing at localhost
    // — a real and easy mistake, and one that produces a service which looks
    // healthy while talking to a database nobody else can reach. That reasoning
    // does not hold when the whole product runs on one machine on purpose:
    // there the database IS local, and requiring a public database host would
    // mean exposing Postgres to the internet, which is strictly worse.
    //
    // So it is an opt-out rather than a relaxation, and deliberately an awkward
    // one: the operator has to name this variable, set it to exactly 'true', and
    // it applies ONLY to the private-host rule. Every other production check —
    // password strength, protocol, secret quality — still runs. A deployment
    // that sets this and is not in fact self-hosted has said something false
    // about itself in writing, which is the most an environment variable can be
    // asked to guarantee.
    if (readTrimmedEnv('ALLOW_LOCAL_DATABASE', env) !== 'true') {
      throw new ConfigurationError(
        `${name} must not point to a private or local host in production. ` +
          'If this deployment is genuinely self-hosted and the database runs on the same ' +
          'machine, set ALLOW_LOCAL_DATABASE=true to acknowledge that deliberately.',
      );
    }
  }

  if (options.requirePassword) {
    const password = decodeURIComponent(parsed.password);
    if (!password) {
      throw new ConfigurationError(`${name} must include a database password in production`);
    }

    const weakPassword = password.toLowerCase().replace(/[\s-]+/g, '_');
    if (weakSecretValues.has(weakPassword) || weakPassword.includes('change_me')) {
      throw new ConfigurationError(`${name} uses a default or weak database password`);
    }
  }

  return parsed;
}

/**
 * The three literals `proxy-addr` accepts in place of an address, passed through
 * unchanged. Everything else must be an IP or an IP/CIDR.
 */
const PROXY_ADDR_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isTrustedProxySegment(segment: string): boolean {
  if (PROXY_ADDR_KEYWORDS.has(segment.toLowerCase())) {
    return true;
  }

  const slash = segment.indexOf('/');
  if (slash === -1) {
    return net.isIP(segment) !== 0;
  }

  const address = segment.slice(0, slash);
  const prefix = segment.slice(slash + 1);
  const family = net.isIP(address);
  if (family === 0 || !/^\d{1,3}$/.test(prefix)) {
    return false;
  }

  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 6 ? 128 : 32);
}

/**
 * Is this process serving production traffic?
 *
 * Deliberately NOT `NODE_ENV === 'production'` alone. The failure this exists to
 * catch is an operator hand-starting the API from the repo's own `.env` — and
 * that file says NODE_ENV=development, so a guard keyed on NODE_ENV would be
 * switched off by exactly the mistake it is meant to catch.
 *
 * The second clause is the predicate deploy/local/ecosystem.config.js already
 * uses for the same reason: whatever NODE_ENV claims, a process attached to
 * crm_prod is production.
 */
function isServingProduction(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return true;
  return (readTrimmedEnv('DATABASE_URL', env) ?? '').includes('/crm_prod');
}

/**
 * TRUSTED_PROXY: present, and an address rather than something that merely looks
 * like one.
 *
 * WHY IT IS REQUIRED. backend/index.ts hands this value to Fastify's
 * `trustProxy`. Unset, request.ip is the socket address — and behind cloudflared
 * that is 127.0.0.1 for every human on Earth. Every per-IP rate limit then
 * collapses into ONE bucket (the shared auth-IP floor is 60 requests / 15 min,
 * so the 61st login attempt from anywhere locks out every customer), and every
 * AuditEvent.ip_address is written 127.0.0.1, which destroys the forensic record
 * permanently rather than for a window.
 *
 * WHY THE VALUE IS CHECKED AND NOT JUST ITS PRESENCE, and this is the part that
 * matters most: `process.env` values are always strings, and Fastify only trusts
 * every hop when trustProxy is the BOOLEAN true, so the "hop-count integer"
 * form that reads like a sensible setting is not one. `TRUSTED_PROXY=2` is
 * handed to proxy-addr, parsed by ipaddr.js as the address 0.0.0.2, compiles
 * without complaint, trusts nothing, and collapses request.ip exactly as an
 * unset value does — while looking correctly configured in the env file. That is
 * strictly worse than the honest absence this check is named for, so an
 * allowlist (IP, IP/CIDR, or a proxy-addr keyword) is the only safe shape;
 * net.isIP rejects bare integers, which is what makes it work.
 *
 * `true`, `TRUE` and `yes` are rejected here too. They already fail — inside
 * Fastify's constructor, as `TypeError: invalid IP address: true` — so this only
 * converts an obscure library crash into a sentence naming the variable.
 *
 * THE ESCAPE HATCH. A deployment that genuinely takes client connections
 * directly, with no proxy in front, has no address to name and must still boot.
 * TRUSTED_PROXY_NOT_REQUIRED=true says so deliberately, in writing, in the same
 * shape as ALLOW_LOCAL_DATABASE above.
 */
export function getTrustProxySetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = readTrimmedEnv('TRUSTED_PROXY', env);

  if (raw) {
    const segments = raw.split(',').map((part) => part.trim());
    if (segments.length === 0 || segments.some((segment) => !isTrustedProxySegment(segment))) {
      throw new ConfigurationError(
        'TRUSTED_PROXY must be an IP address, an IP/CIDR range, one of ' +
          'loopback/linklocal/uniquelocal, or a comma-separated list of those. ' +
          'It is not a hop count and it is not a boolean: a bare integer parses as an ' +
          'address (2 becomes 0.0.0.2), trusts nothing, and silently collapses every ' +
          "client's IP to the proxy's own.",
      );
    }
    return raw;
  }

  if (isServingProduction(env) && readTrimmedEnv('TRUSTED_PROXY_NOT_REQUIRED', env) !== 'true') {
    throw new ConfigurationError(
      'TRUSTED_PROXY is required when serving production. Without it request.ip is the ' +
        "reverse proxy's own address for every client, every per-IP rate limit collapses " +
        'into a single shared bucket, and every audit record is written 127.0.0.1. Set it ' +
        'to the proxy address (127.0.0.1 for a cloudflared tunnel on the same machine). If ' +
        'this deployment really does receive client connections directly with no proxy in ' +
        'front, set TRUSTED_PROXY_NOT_REQUIRED=true to acknowledge that deliberately.',
    );
  }

  return undefined;
}

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  // Before the NODE_ENV gate below, on purpose. The scenario this catches is a
  // hand-start that sourced the repo's .env, and that file sets
  // NODE_ENV=development — so a check placed after the early return would be
  // disabled by the very mistake it is looking for. getTrustProxySetting decides
  // for itself whether this process is serving production.
  getTrustProxySetting(env);

  if (env.NODE_ENV !== 'production') {
    return;
  }

  getJwtSecret(env);
  getTokenEncryptionSecret(env);
  getYandexWebhookSecret(env);
  getCorsOrigin(env);
  validateProductionUrl('DATABASE_URL', {
    allowedProtocols: ['postgresql:', 'postgres:'],
    requirePassword: true,
  }, env);

  const yandexClientId = readTrimmedEnv('YANDEX_CLIENT_ID', env);
  const yandexClientSecret = readTrimmedEnv('YANDEX_CLIENT_SECRET', env);
  if (yandexClientId || yandexClientSecret) {
    if (!yandexClientId || !yandexClientSecret) {
      throw new ConfigurationError('YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET must be set together');
    }

    getDeploymentSafeUrl('YANDEX_REDIRECT_URI', {
      requiredInProduction: true,
      allowedProtocols: ['https:'],
    }, env);
  }

  if (readTrimmedEnv('YANDEX_CALENDAR_SUCCESS_URL', env)) {
    getDeploymentSafeUrl('YANDEX_CALENDAR_SUCCESS_URL', {
      allowedProtocols: ['https:', 'crm:'],
    }, env);
  }

}
