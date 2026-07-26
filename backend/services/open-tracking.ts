/**
 * Open tracking for outbound sequence email.
 *
 * ФЗ-152 (О персональных данных) — READ BEFORE ENABLING FOR CUSTOMERS.
 * An open event IS processing of personal data: it ties a named contact to a
 * timestamp and, unavoidably, exposes their IP address and mail-client user
 * agent to our server at fetch time. It therefore has to be disclosed in the
 * privacy policy (docs/privacy-policy-ru.md and docs/privacy-policy-en.md) in
 * the list of processed data and purposes, before the first tracked message
 * goes out. It is also covered by the same consent record as the mailing itself
 * (Contact.marketing_consent / ФЗ-38 «О рекламе» ст. 18), so a contact who
 * never consented must never receive a message carrying this pixel.
 *
 * To keep that disclosure small and honest we persist exactly ONE thing: the
 * EmailSend.opened_at timestamp, on first open. No IP, no user agent, no open
 * count, no geolocation, no read duration. Do not add a column here without
 * updating both policy documents first.
 *
 * The endpoint that serves the pixel is PUBLIC (mail clients fetch it with no
 * session) and unauthenticated, which drives the rest of the design:
 *   - an unknown or malformed token still gets a normal 200 + pixel, so the
 *     endpoint cannot be used as an oracle for "does this token exist";
 *   - nothing here throws, so a database blip degrades to "the open was not
 *     recorded" instead of a 500 with a stack trace in a mail client;
 *   - the only write is the single guarded updateMany below.
 */

import crypto from 'node:crypto';
import { EmailSendStatus } from '@prisma/client';
import { db } from './db';

// ─── The pixel ────────────────────────────────────────────────────────────────

/** 43-byte 1x1 fully transparent GIF89a. Decoded once at module load. */
export const TRACKING_PIXEL_GIF: Buffer = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export const TRACKING_PIXEL_CONTENT_TYPE = 'image/gif';

/**
 * Path prefix the wiring agent must add to the public allowlist in
 * backend/api/authenticate.ts. Kept here so the allowlist and the route cannot
 * drift apart silently.
 */
export const TRACKING_OPEN_PATH_PREFIX = '/api/v1/tracking/open/';

// ─── Tokens ───────────────────────────────────────────────────────────────────

/**
 * 32 bytes of CSPRNG output -> 43 base64url characters, 256 bits of entropy.
 * The token is the ONLY thing protecting an open record, so it can never be
 * derived from the send id, the contact id, a counter or a timestamp: those are
 * all guessable, and a guessable token lets a stranger mark other people's mail
 * as read. `randomSource` exists so a test can prove the length/alphabet, not
 * so callers can supply their own entropy.
 */
export const OPEN_TOKEN_BYTES = 32;

export function generateOpenToken(
  randomSource: (size: number) => Buffer = crypto.randomBytes,
): string {
  return randomSource(OPEN_TOKEN_BYTES).toString('base64url');
}

// Tokens we mint are 43 chars; the range accepts a little slack so a token
// minted by an earlier or later version still resolves. Anything outside the
// base64url alphabet is rejected before it ever reaches a query.
const OPEN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export function isValidOpenTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && OPEN_TOKEN_PATTERN.test(token);
}

/**
 * Mail clients and proxies happily append or keep an extension. The route takes
 * the whole last path segment, so strip a trailing image extension before the
 * token is used.
 */
export function stripPixelExtension(value: string | undefined | null): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\.(gif|png|jpg|jpeg)$/i, '');
}

/** Absolute URL for the tracking pixel, or null when no public base URL is configured. */
export function buildTrackingPixelUrl(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = (env.TRACKING_BASE_URL ?? env.PUBLIC_API_BASE_URL ?? '').trim();
  if (configured === '' || !isValidOpenTokenFormat(token)) {
    return null;
  }

  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    return null;
  }

  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    return null;
  }

  const origin = base.origin;
  return `${origin}${TRACKING_OPEN_PATH_PREFIX}${token}.gif`;
}

// ─── Recording an open ────────────────────────────────────────────────────────

export type OpenTrackingOutcome = 'recorded' | 'ignored';

type MinimalLogger = { warn: (obj: unknown, msg?: string) => void };

/**
 * Mark the EmailSend behind `token` as opened. First open wins.
 *
 * The whole thing is ONE `updateMany` on purpose:
 *   - `opened_at: null` in the WHERE makes it a compare-and-set, so two pixel
 *     fetches racing each other cannot both write and the second one cannot
 *     overwrite the first open's timestamp. A read-then-write would lose that
 *     race, and `update()` cannot express the guard at all (it keys on the
 *     unique column only, and throws P2025 when nothing matches — which would
 *     also turn "unknown token" into an error path).
 *   - the status filter keeps a hit from resurrecting a `failed` send, and
 *     `open_token` is globally unique so exactly one row can ever match. There
 *     is no organization_id to filter on here — the request is unauthenticated
 *     and carries no org — but a token addresses a single row, so this can
 *     never widen into a cross-org or bulk write. Do not relax the WHERE.
 *   - `data` sets opened_at and status and NOTHING else. A tracking hit is not
 *     allowed to touch any other column or any other table.
 *
 * Never throws: a malformed token, an unknown token and a database failure all
 * resolve to 'ignored', and the caller still returns the pixel.
 */
export async function recordEmailOpen(
  token: unknown,
  options: { logger?: MinimalLogger; now?: Date } = {},
): Promise<OpenTrackingOutcome> {
  if (!isValidOpenTokenFormat(token)) {
    return 'ignored';
  }

  try {
    const result = await db.emailSend.updateMany({
      where: {
        open_token: token,
        opened_at: null,
        status: { in: [EmailSendStatus.queued, EmailSendStatus.sent] },
      },
      data: {
        opened_at: options.now ?? new Date(),
        status: EmailSendStatus.opened,
      },
    });

    return result.count > 0 ? 'recorded' : 'ignored';
  } catch (error) {
    // Deliberately swallowed. The token is never logged: it is a bearer
    // credential for someone else's open record.
    options.logger?.warn(
      { err: error instanceof Error ? error.message : 'unknown' },
      'open tracking write failed',
    );
    return 'ignored';
  }
}
