import { Clipboard } from 'react-native';
import { API_URL } from './api';

/**
 * How a freshly installed app finds out which invite it belongs to.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * Somebody taps an invite link on a phone with no app. The link opens a browser,
 * the browser sends them to the store, they install, they launch — and the app
 * has no idea any of that happened. Neither platform hands a fresh install the
 * URL that led to it: iOS has never provided an API for it, and RuStore is not
 * Google Play so there is no Play Install Referrer either.
 *
 * The industry answer is a third-party attribution SDK that fingerprints the
 * browser and the app and matches them server-side. All of them are foreign
 * SaaS, and shipping device fingerprints abroad is exactly what the rest of this
 * codebase spends its effort preventing. An in-house version of the same idea
 * was built and then deleted — behind nginx every request arrives from the same
 * address, so its "match only if exactly one candidate" guard degraded to "only
 * one invite open anywhere", which is the normal case for a small tenant.
 *
 * ---------------------------------------------------------------------------
 * SO: FOUR PATHS, TRIED IN ORDER OF RELIABILITY
 * ---------------------------------------------------------------------------
 *   1. LINK      the app was already installed and a verified App Link opened it
 *                directly, token and all. Zero friction, and the common case
 *                once a team is established.
 *   2. REFERRER  RuStore carried the handoff through the install as
 *                `?referrerId=`. Android only, silent, exact.
 *   3. CLIPBOARD the landing page copied the handoff before sending the user to
 *                the App Store. iOS only in practice, one "Allow Paste" tap.
 *   4. CODE      six characters the invitee retypes. The floor: every path above
 *                can fail, and something has to catch that.
 *
 * Each is a DIFFERENT secret with a different exposure, which is why the backend
 * keeps them in separate columns — see backend/services/invites.ts. Nothing here
 * can create an account; every path below trades its credential for a
 * short-lived accept token, and only that token is spendable.
 */

export type InviteCredential =
  | { via: 'link'; token: string }
  | { via: 'referrer'; handoff: string }
  | { via: 'clipboard'; handoff: string }
  | { via: 'code'; claim_code: string };

export type InvitePreview = {
  name: string;
  role: string;
  org_name: string;
  accept_token: string;
};

export type InviteLookupResult =
  | { ok: true; preview: InvitePreview; via: InviteCredential['via'] }
  | { ok: false; code: string; message: string };

/**
 * The link token is 32 bytes base64url, which is 43 characters and never any
 * other number: unpadded base64 of 32 bytes is ceil(32 × 4 / 3) = 43. See
 * LINK_TOKEN_BYTES in backend/services/invites.ts, which is the only thing that
 * mints one.
 *
 * The length is stated rather than bracketed because it is knowable. An earlier
 * `{20,200}` came with a comment claiming "anything shorter is a fragment that
 * means something else" while accepting a 20-character anchor and a
 * 200-character router artefact alike — the comment described this regex, not
 * that one.
 */
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The invite token rides in the URL FRAGMENT (`https://4kub.ru/i#<token>`) so it
 * is never sent to a server and never lands in an access log. Both platforms
 * hand the app the complete URL including the fragment, so it survives the trip.
 */
export function tokenFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const hash = url.indexOf('#');
  if (hash === -1) return null;
  const token = url.slice(hash + 1).trim();
  return LINK_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * The handoff is 16 bytes base64url: 22 characters, and the last of them carries
 * only 2 bits of the final byte, so it is always one of A, Q, g, w. Both halves
 * of that are checked — the tail costs nothing on a real handoff and rejects
 * three quarters of everything else of the right length.
 */
const HANDOFF_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;

/**
 * Recognises a handoff token sitting on the clipboard.
 *
 * WHAT THIS GUARD ACTUALLY EXCLUDES. It exists so the app does not POST whatever
 * the user happened to copy last, but it is a shape test and shape is all it can
 * see. It rejects anything containing a space or a punctuation mark outside
 * `-_`, anything of a different length, and anything whose last character the
 * encoder could not have produced: messages, URLs, phone numbers, card numbers,
 * ordinary human-chosen passwords, and three quarters of everything left over.
 *
 * It does NOT exclude a 22-character string drawn from the same alphabet whose
 * last character happens to land in A/Q/g/w — a password-manager password with
 * symbols disabled, a base64url-encoded UUID, a short API key. There is no
 * marker on the clipboard to test for (the landing page copies the bare token,
 * see website/i.html), so the client cannot narrow this further on its own.
 *
 * What bounds the damage is on the other side rather than here: the value goes
 * to this product's own `/auth/invites/lookup` and nowhere else, it is compared
 * as a SHA-256 against the invite table, and a string that is not a live handoff
 * gets the same 404 an invented token gets.
 */
export function handoffFromClipboard(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return HANDOFF_PATTERN.test(value) ? value : null;
}

export async function readClipboardHandoff(): Promise<string | null> {
  try {
    // On iOS 16+ this raises the system "Allow Paste?" prompt. That is the cost
    // of the silent path on a platform with no install referrer, and it is one
    // tap rather than six keystrokes. A refusal just falls through to the code.
    return handoffFromClipboard(await Clipboard.getString());
  } catch {
    return null;
  }
}

/**
 * RuStore's Install Referrer, the one platform mechanism that genuinely solves
 * this. `referrerId` is attached to the store URL by the landing page, held
 * through the install, and handed back on first launch.
 *
 * Loaded through an optional require so the app runs unchanged when the native
 * module is absent — Expo Go, an iOS build, a dev client without the config
 * plugin, or a device with no RuStore installed. The SDK also returns the value
 * exactly ONCE and then discards it, so this must not be called speculatively:
 * a call that succeeds and whose result is thrown away has burned the referrer.
 */
export async function readInstallReferrer(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./rustoreInstallReferrer') as {
      getInstallReferrer?: () => Promise<string | null>;
    };
    if (typeof mod?.getInstallReferrer !== 'function') return null;
    const referrer = await mod.getInstallReferrer();
    return referrer && referrer.trim() ? referrer.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Trade a credential for an accept token.
 *
 * Exactly one credential per request — the backend rejects a mixture rather than
 * guessing which one the caller meant.
 */
export async function lookupInvite(credential: InviteCredential): Promise<InviteLookupResult> {
  const body: Record<string, string> =
    credential.via === 'link' ? { token: credential.token }
    : credential.via === 'code' ? { claim_code: credential.claim_code }
    : { handoff: credential.handoff };

  try {
    const res = await fetch(`${API_URL}/auth/invites/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      data?: InvitePreview;
      error?: { code?: string; message?: string };
    };

    if (!res.ok || !json.data) {
      return {
        ok: false,
        code: json.error?.code ?? 'INVITE_UNAVAILABLE',
        message: json.error?.message ?? 'Приглашение недействительно или уже использовано',
      };
    }
    return { ok: true, preview: json.data, via: credential.via };
  } catch {
    return { ok: false, code: 'NETWORK', message: 'Нет связи с сервером. Проверьте подключение.' };
  }
}

/**
 * Try every automatic path, best first, and stop at the first that resolves.
 *
 * Returns null when nothing was found — which is not an error. It is the
 * ordinary state of an app launched by someone who was never invited, so the
 * caller must treat it as "carry on to the login screen", never as a failure to
 * report.
 */
export async function discoverInvite(deepLinkUrl?: string | null): Promise<InviteLookupResult | null> {
  const token = tokenFromUrl(deepLinkUrl);
  if (token) return lookupInvite({ via: 'link', token });

  const referrer = await readInstallReferrer();
  if (referrer) return lookupInvite({ via: 'referrer', handoff: referrer });

  const clipboard = await readClipboardHandoff();
  if (clipboard) return lookupInvite({ via: 'clipboard', handoff: clipboard });

  return null;
}
