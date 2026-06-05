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

// Pending auth clients: phone → client (in-memory, single server)
const pending = new Map<string, { client: TelegramClient; phoneCodeHash: string }>();

function makeClient(session = ''): TelegramClient {
  return new TelegramClient(new StringSession(session), API_ID, API_HASH, {
    connectionRetries: 3,
    requestRetries: 3,
  });
}

export async function tgSendCode(phone: string): Promise<{ phoneCodeHash: string }> {
  if (!API_ID || !API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not configured');

  // Disconnect stale pending client for this phone if any
  const stale = pending.get(phone);
  if (stale) {
    await stale.client.disconnect().catch(() => null);
    pending.delete(phone);
  }

  const client = makeClient();
  await client.connect();

  const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
  pending.set(phone, { client, phoneCodeHash: result.phoneCodeHash });

  return { phoneCodeHash: result.phoneCodeHash };
}

export async function tgVerifyAndPull(
  phone: string,
  code: string,
  phoneCodeHash: string,
): Promise<{ session: string; contacts: TgContact[] }> {
  if (!API_ID || !API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not configured');

  let client: TelegramClient;
  const p = pending.get(phone);

  if (p) {
    client = p.client;
  } else {
    // Server may have restarted — reconnect
    client = makeClient();
    await client.connect();
  }

  await client.invoke(new Api.auth.SignIn({
    phoneNumber: phone,
    phoneCodeHash,
    phoneCode: code,
  }));

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

  pending.delete(phone);
  await client.disconnect();

  return { session, contacts };
}
