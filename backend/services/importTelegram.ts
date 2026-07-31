import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';

const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH ?? '';

export interface TgContact {
  first_name: string;
  last_name?: string;
  phone?: string;
  username?: string;
}

/**
 * Who a half-finished Telegram login belongs to.
 *
 * Optional only because the one caller today (api/controllers/imports.ts) does
 * not yet pass it; it has `request.user` in hand and should. Supplying it is the
 * belt to the phoneCodeHash's braces — see the note on `pending` below.
 */
export type TelegramLoginScope = { orgId: string; userId: string };

/**
 * How long a half-finished login may sit here.
 *
 * Exported so a test can wait it out without hard-coding a magic number.
 */
export const TELEGRAM_LOGIN_TTL_MS = 5 * 60_000;

type PendingLogin = {
  client: TelegramClient;
  phoneCodeHash: string;
  expiry: ReturnType<typeof setTimeout>;
};

/**
 * Half-finished Telegram logins, in memory, on a single server.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS IN HERE
 * -----------------------------------------------------------------------------
 * A connected MTProto client that has already been handed a login code for
 * somebody's PERSONAL Telegram account, plus the `phoneCodeHash` that code was
 * issued against. Hash + code is the whole credential: anything that can reach an
 * entry here is one SMS digit-string away from a full account takeover — not of a
 * CRM row, of the human's own messenger. This map is therefore treated as a store
 * of live credentials rather than as a cache.
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS NOT KEYED BY PHONE NUMBER
 * -----------------------------------------------------------------------------
 * It used to be, on a multi-tenant server, with no org and no user in the key. A
 * phone number is not private and not owned by the caller, so any authenticated
 * user of any organisation could name one and:
 *
 *   - EVICT: `tgSendCode` disconnected whatever client it found under that phone
 *     before storing its own, killing another tenant's in-flight login;
 *   - LAND ON: `tgVerifyAndPull` looked the phone up and signed in on whatever
 *     client it found — another tenant's connected socket.
 *
 * The key now carries the caller scope (when the caller supplies one) AND the
 * `phoneCodeHash` Telegram minted for that specific sendCode. The hash is the
 * important half, because it works even for the caller that passes no scope: it
 * is a per-attempt capability returned to exactly one HTTP client, so a second
 * tenant asking about the same phone gets its own hash, its own key, and its own
 * entry. Neither tenant can name the other's, and neither can guess it. Adding
 * org+user closes the residual case where Telegram hands two attempts the same
 * hash, and costs one argument at the call site.
 *
 * -----------------------------------------------------------------------------
 * WHY ENTRIES EXPIRE
 * -----------------------------------------------------------------------------
 * The old map only ever dropped an entry on a SUCCESSFUL verify. A user who
 * requested a code and walked away, or typed it wrong and gave up, left a
 * connected, credential-bearing client in memory until the process restarted —
 * and with the key no longer being just the phone, a retry no longer overwrites
 * the previous attempt, so nothing would ever collect them. A login code is valid
 * for minutes; the entry outlives it by nothing.
 */
const pending = new Map<string, PendingLogin>();

/**
 * NUL cannot appear in a uuid, a phone number or a Telegram hash, so no two
 * distinct tuples can collide by running into one another («org1|user» + «2» vs
 * «org1» + «user2»).
 */
function pendingKey(phone: string, phoneCodeHash: string, scope?: TelegramLoginScope): string {
  return [scope?.orgId ?? '', scope?.userId ?? '', phone, phoneCodeHash].join('\u0000');
}

/** Drop an entry and hang up on its client. Safe to call on a missing key. */
function forget(key: string): void {
  const entry = pending.get(key);
  if (!entry) return;

  pending.delete(key);
  clearTimeout(entry.expiry);
  void entry.client.disconnect().catch(() => null);
}

function remember(key: string, client: TelegramClient, phoneCodeHash: string): void {
  // Same caller, same phone, same hash — Telegram reissuing a hash on a resend is
  // the one way to land here. Replace the entry rather than orphaning its socket.
  forget(key);

  const expiry = setTimeout(() => forget(key), TELEGRAM_LOGIN_TTL_MS);
  // The expiry must not be a reason for the process to stay alive. Same shape as
  // the sweeper in idempotency.ts: `unref` exists on Node's Timeout and not on
  // the DOM's numeric handle, and this file is typechecked against both libs.
  const unref = (expiry as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') {
    unref.call(expiry);
  }

  pending.set(key, { client, phoneCodeHash, expiry });
}

function makeClient(session = ''): TelegramClient {
  return new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 3,
    requestRetries: 3,
  });
}

export async function tgSendCode(
  phone: string,
  scope?: TelegramLoginScope,
): Promise<{ phoneCodeHash: string }> {
  if (!API_ID || !API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not configured');

  const client = makeClient();
  await client.connect();

  let result: { phoneCodeHash: string };
  try {
    result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
  } catch (err) {
    // Nothing was stored, so nothing will ever collect this socket. FLOOD_WAIT on
    // a phone somebody is hammering is exactly the case that would accumulate.
    await client.disconnect().catch(() => null);
    throw err;
  }

  remember(pendingKey(phone, result.phoneCodeHash, scope), client, result.phoneCodeHash);

  return { phoneCodeHash: result.phoneCodeHash };
}

export async function tgVerifyAndPull(
  phone: string,
  code: string,
  phoneCodeHash: string,
  scope?: TelegramLoginScope,
): Promise<{ session: string; contacts: TgContact[] }> {
  if (!API_ID || !API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not configured');

  // Same key the caller's own tgSendCode wrote. A caller that names somebody
  // else's phone number finds nothing here, whatever is in flight for it.
  const key = pendingKey(phone, phoneCodeHash, scope);

  let client: TelegramClient;
  const p = pending.get(key);

  if (p) {
    client = p.client;
  } else {
    // Server may have restarted, or the entry timed out — reconnect. This branch
    // is not a hole in the keying: signing in needs the code AND the hash, which
    // is the credential Telegram itself gates the account on. What the map adds
    // is that one tenant cannot ride another tenant's already-connected client.
    client = makeClient();
    await client.connect();
  }

  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash,
      phoneCode: code,
    }));
  } catch (err) {
    // A wrong code is the ordinary case, and the user will retry with the same
    // hash — so a pending entry is LEFT in place, still holding its expiry. An
    // ad-hoc client from the branch above has nobody to collect it, so it is hung
    // up here rather than leaked once per mistyped digit.
    if (!p) await client.disconnect().catch(() => null);
    throw err;
  }

  const session = (client.session.save() as unknown as string);

  // Pull contacts
  const result = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as unknown as import('big-integer').BigInteger }));

  const contacts: TgContact[] = [];
  if (result instanceof Api.contacts.Contacts) {
    for (const u of result.users) {
      if (u instanceof Api.User && !u.bot) {
        contacts.push({
          first_name: u.firstName ?? 'Telegram',
          last_name: u.lastName ?? undefined,
          phone: u.phone ? `+${u.phone}` : undefined,
          username: u.username ?? undefined,
        });
      }
    }
  }

  // The credential is spent. Drop the entry, cancel its expiry, hang up.
  pending.delete(key);
  if (p) clearTimeout(p.expiry);
  await client.disconnect();

  return { session, contacts };
}
