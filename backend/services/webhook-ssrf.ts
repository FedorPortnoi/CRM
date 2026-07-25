/**
 * SSRF guard for customer-supplied outbound webhook URLs.
 *
 * Follows the same approach as `assertAllowedBitrixWebhookUrl` in backend/config/security.ts
 * (https only, reject private/reserved IP literals in every inet_aton notation), but the
 * destination host is arbitrary customer input rather than an allowlisted Bitrix24 portal, so
 * this module additionally resolves DNS and pins the validated address into the connection.
 * Callers must pass the returned address to `lookup` so DNS cannot change between validation
 * and send (DNS rebinding).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type ResolvedWebhookAddress = {
  address: string;
  family: 4 | 6;
};

export type WebhookDnsResolver = (hostname: string) => Promise<readonly ResolvedWebhookAddress[]>;

export type SafeWebhookTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export class UnsafeWebhookUrlError extends Error {
  readonly code = 'UNSAFE_WEBHOOK_URL';

  constructor(message = 'Webhook URL must resolve to a public https address') {
    super(message);
    this.name = 'UnsafeWebhookUrlError';
  }
}

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 — can embed an internal IPv4 destination
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo — tunnels IPv4, can target internal hosts
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — embeds an IPv4 address that may be internal
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

const INTERNAL_HOST_SUFFIXES = [
  '.internal',
  '.local',
  '.localhost',
  '.localdomain',
  '.home',
  '.lan',
  '.intranet',
  '.corp',
];

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

// Normalize an IPv4 literal written in any inet_aton form (dotted-decimal, bare
// decimal, hex, octal and the short a.b / a.b.c notations) to dotted-decimal, or
// null when the host is not a numeric IPv4 literal. `https://2130706433/` and
// `https://0x7f.1/` both reach 127.0.0.1 and must not slip past the block list.
function canonicalIpv4Literal(hostname: string): string | null {
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

  return octets.join('.');
}

export function normalizeWebhookHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

/**
 * Resolve a hostname to a canonical IP literal when it is one, in any notation.
 * Returns null for real DNS names.
 */
export function canonicalIpLiteral(hostname: string): ResolvedWebhookAddress | null {
  const host = normalizeWebhookHostname(hostname);
  const family = isIP(host);
  if (family === 4 || family === 6) {
    return { address: host, family };
  }

  const dotted = canonicalIpv4Literal(host);
  return dotted ? { address: dotted, family: 4 } : null;
}

/** True when the address is private/reserved, IPv4-mapped, or not an IP at all. */
export function isBlockedWebhookAddress(address: string): boolean {
  const withoutZone = address.split('%')[0] ?? address;
  const family = isIP(withoutZone);

  if (family === 4) {
    return blockedAddresses.check(withoutZone, 'ipv4');
  }

  if (family === 6) {
    // IPv4-mapped / IPv4-compatible literals embed an IPv4 destination that would
    // otherwise bypass the IPv4 subnet list — reject them outright.
    const lower = withoutZone.toLowerCase();
    if (lower.startsWith('::ffff:') || (lower.startsWith('::') && /\d+\.\d+\.\d+\.\d+$/.test(lower))) {
      return true;
    }
    return blockedAddresses.check(withoutZone, 'ipv6');
  }

  const dotted = canonicalIpv4Literal(withoutZone);
  if (dotted) {
    return blockedAddresses.check(dotted, 'ipv4');
  }

  return true;
}

function isInternalHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname === 'localhost') {
    return true;
  }

  // A single-label host can only be an intranet name (no public TLD).
  if (!hostname.includes('.')) {
    return true;
  }

  return INTERNAL_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedWebhookAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

/**
 * Validate a webhook URL and resolve it to a single pinned address.
 * Every address the hostname resolves to is checked, so a rebinding record that
 * mixes one public and one private answer is rejected outright.
 */
export async function resolveSafeWebhookUrl(
  rawUrl: string,
  resolver: WebhookDnsResolver = defaultResolver,
): Promise<SafeWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError('Webhook URL must be a valid absolute URL');
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeWebhookUrlError('Webhook URL must use https');
  }

  if (url.username || url.password) {
    throw new UnsafeWebhookUrlError('Webhook URL must not contain credentials');
  }

  const hostname = normalizeWebhookHostname(url.hostname);

  const literal = canonicalIpLiteral(hostname);
  if (literal) {
    if (isBlockedWebhookAddress(literal.address)) {
      throw new UnsafeWebhookUrlError('Webhook URL must not point to a private or reserved address');
    }
    return { url, address: literal.address, family: literal.family };
  }

  if (isInternalHostname(hostname)) {
    throw new UnsafeWebhookUrlError('Webhook URL must not point to an internal host');
  }

  let addresses: readonly ResolvedWebhookAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UnsafeWebhookUrlError('Webhook hostname could not be resolved');
  }

  if (addresses.length === 0) {
    throw new UnsafeWebhookUrlError('Webhook hostname did not resolve to an address');
  }

  for (const resolved of addresses) {
    if (
      (resolved.family !== 4 && resolved.family !== 6)
      || isIP(resolved.address.split('%')[0] ?? resolved.address) !== resolved.family
      || isBlockedWebhookAddress(resolved.address)
    ) {
      throw new UnsafeWebhookUrlError('Webhook URL must not point to a private or reserved address');
    }
  }

  const first = addresses[0];
  return { url, address: first.address, family: first.family };
}

/** Config-time validation. The send path calls resolveSafeWebhookUrl again just before connecting. */
export async function assertSafeWebhookUrl(
  rawUrl: string,
  resolver?: WebhookDnsResolver,
): Promise<string> {
  const target = await resolveSafeWebhookUrl(rawUrl, resolver);
  return target.url.toString();
}
