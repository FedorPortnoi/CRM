// ---------------------------------------------------------------------------
// Caller authentication.
//
// The CRM proves itself with PROXY_TOKEN, a shared secret that is NOT the
// OpenAI key. If PROXY_TOKEN leaks, an attacker gets a rate-limited, model-
// restricted chat endpoint; the OpenAI key itself never leaves Cloudflare.
// ---------------------------------------------------------------------------

/**
 * A random per-isolate HMAC key used only to blind string comparisons.
 *
 * Created lazily: Workers forbid `crypto.getRandomValues()` at global scope
 * (module top level runs before any request and randomness is disallowed
 * there), so this must be built inside a request context.
 */
let comparisonKey: Promise<CryptoKey> | null = null;

function getComparisonKey(): Promise<CryptoKey> {
  if (!comparisonKey) {
    comparisonKey = crypto.subtle.importKey(
      'raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return comparisonKey;
}

/**
 * Constant-time string equality — never `===`.
 *
 * `===` on strings short-circuits at the first differing byte, so response
 * latency leaks how many leading characters of PROXY_TOKEN a guess got right,
 * and the token can be recovered one character at a time.
 *
 * Both sides are HMAC'd with a secret random key first (the "double HMAC"
 * construction). That gives two fixed-length 32-byte digests regardless of the
 * input lengths, so unlike `crypto.subtle.timingSafeEqual` this cannot throw on
 * a length mismatch and does not leak the secret's length either. The digest
 * comparison then scans all 32 bytes with no early exit.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const key = await getComparisonKey();
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = viewA.length ^ viewB.length;
  for (let i = 0; i < viewA.length; i += 1) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}

/** Pulls the token out of `Authorization: Bearer <token>`. */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token ? token : null;
}

/**
 * Accepts the presented token if it matches the current PROXY_TOKEN or, during
 * a rotation window, the optional PROXY_TOKEN_PREVIOUS. Every candidate is
 * compared in constant time, and empty/absent secrets never match — an unset
 * PROXY_TOKEN must fail closed, not authorise everyone.
 */
export async function isAuthorized(
  presented: string | null,
  current: string | undefined,
  previous: string | undefined,
): Promise<boolean> {
  if (!presented) return false;

  const candidates = [current, previous].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (candidates.length === 0) return false;

  // Check every candidate — no early return on the first match, so the number
  // of HMAC operations does not depend on which token was presented.
  let matched = false;
  for (const candidate of candidates) {
    if (await timingSafeEqualString(presented, candidate)) {
      matched = true;
    }
  }
  return matched;
}
