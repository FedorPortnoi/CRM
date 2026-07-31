import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A HALF-FINISHED TELEGRAM LOGIN IS A CREDENTIAL, AND IT LIVED IN A GLOBAL MAP
// KEYED BY PHONE NUMBER.
//
// `backend/services/importTelegram.ts` holds in-flight logins between
// `tgSendCode` and `tgVerifyAndPull`: a connected MTProto client plus the
// `phoneCodeHash` that a login code was issued against. Hash + code is the whole
// credential for somebody's PERSONAL Telegram account — not a CRM row, the
// human's own messenger.
//
// The map was keyed on the phone number alone, with no organisation and no user
// in the key, on a server that is multi-tenant by construction. A phone number is
// neither secret nor owned by the caller, so any authenticated user of any
// organisation could name one and reach another tenant's entry: `tgSendCode`
// disconnected whatever client it found there, and `tgVerifyAndPull` signed in on
// it.
//
// The two halves of the fix, one test each:
//
//   1. THE KEY. Caller scope (when supplied) plus the `phoneCodeHash` Telegram
//      minted for that specific sendCode. The hash is what makes this work for
//      the caller that supplies no scope, which is the one shipping today: it is
//      a per-attempt capability returned to exactly one HTTP client.
//   2. THE TTL. The old map only dropped an entry on a SUCCESSFUL verify, so a
//      user who asked for a code and walked away left a connected,
//      credential-bearing client in memory until the process restarted.
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  // Read at module scope by importTelegram.ts, so they have to be in place before
  // the dynamic import below runs.
  process.env.TELEGRAM_API_ID = '424242';
  process.env.TELEGRAM_API_HASH = 'test-api-hash';
});

type FakeClient = {
  index: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendCode: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  session: { save: () => string };
};

const tg = vi.hoisted(() => ({ clients: [] as unknown[] }));

// Every constructed client is recorded in order, and each one answers sendCode
// with its own hash — which is what Telegram does for two independent attempts on
// the same number, and what the keying now depends on.
vi.mock('telegram', () => ({
  // A plain function rather than vi.fn(): the module calls `new TelegramClient`,
  // and an arrow-function mock implementation is not constructible.
  TelegramClient: function TelegramClientMock() {
    const index = tg.clients.length + 1;
    const client = {
      index,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      sendCode: vi.fn(async () => ({ phoneCodeHash: `hash-${index}`, isCodeViaApp: false })),
      invoke: vi.fn(async () => ({})),
      session: { save: () => `session-${index}` },
    };
    tg.clients.push(client);
    return client;
  },
}));

vi.mock('telegram/sessions', () => ({
  StringSession: class StringSessionMock {},
}));

vi.mock('telegram/tl', () => ({
  Api: {
    auth: { SignIn: class SignInMock {} },
    contacts: {
      GetContacts: class GetContactsMock {},
      Contacts: class ContactsMock {},
    },
    User: class UserMock {},
  },
}));

const { tgSendCode, tgVerifyAndPull, TELEGRAM_LOGIN_TTL_MS } = await import(
  '../../../backend/services/importTelegram'
);

const TENANT_A = { orgId: 'aaaaaaaa-0000-4000-8000-00000000000a', userId: 'aaaaaaaa-0000-4000-8000-00000000000b' };
const TENANT_B = { orgId: 'bbbbbbbb-0000-4000-8000-00000000000a', userId: 'bbbbbbbb-0000-4000-8000-00000000000b' };

/** The client constructed by the most recent makeClient(). */
function lastClient(): FakeClient {
  return tg.clients[tg.clients.length - 1] as FakeClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('importTelegram — one tenant cannot reach another tenant\'s in-flight login', () => {
  it('does not hang up on tenant A\'s client when tenant B asks about the same number', async () => {
    // The eviction. B names a number it does not own; A's login dies.
    const phone = '+79990000001';

    await tgSendCode(phone, TENANT_A);
    const clientA = lastClient();

    await tgSendCode(phone, TENANT_B);
    const clientB = lastClient();

    expect(clientB).not.toBe(clientA);
    expect(clientA.disconnect).not.toHaveBeenCalled();
  });

  it('signs in on the caller\'s OWN client, not on whoever wrote to the phone last', async () => {
    // The takeover. Under a phone-only key the map holds one entry per number, so
    // the last writer wins and A's verify runs against B's socket.
    const phone = '+79990000002';

    const a = await tgSendCode(phone, TENANT_A);
    const clientA = lastClient();
    await tgSendCode(phone, TENANT_B);
    const clientB = lastClient();

    const constructedBefore = tg.clients.length;
    await tgVerifyAndPull(phone, '11111', a.phoneCodeHash, TENANT_A);

    expect(clientA.invoke).toHaveBeenCalled();
    expect(clientB.invoke).not.toHaveBeenCalled();
    // And it found the entry rather than falling through to the reconnect branch.
    expect(tg.clients.length).toBe(constructedBefore);
  });

  it('separates two attempts on the same number even when NO caller scope is passed', async () => {
    // The path that actually ships: api/controllers/imports.ts calls these
    // functions with the phone only. The phoneCodeHash carries the isolation on
    // its own, which is why it is the half of the key that is never optional.
    const phone = '+79990000003';

    const first = await tgSendCode(phone);
    const clientFirst = lastClient();
    const second = await tgSendCode(phone);
    const clientSecond = lastClient();

    expect(first.phoneCodeHash).not.toBe(second.phoneCodeHash);
    expect(clientFirst.disconnect).not.toHaveBeenCalled();

    await tgVerifyAndPull(phone, '22222', first.phoneCodeHash);

    expect(clientFirst.invoke).toHaveBeenCalled();
    expect(clientSecond.invoke).not.toHaveBeenCalled();
  });

  it('spends the entry on a successful verify', async () => {
    // Replaying the same hash finds nothing and has to build a fresh client. The
    // credential does not stay resident after it has been used.
    const phone = '+79990000004';

    const sent = await tgSendCode(phone);
    const client = lastClient();

    await tgVerifyAndPull(phone, '33333', sent.phoneCodeHash);
    expect(client.disconnect).toHaveBeenCalled();

    const constructedBefore = tg.clients.length;
    await tgVerifyAndPull(phone, '33333', sent.phoneCodeHash);
    expect(tg.clients.length).toBe(constructedBefore + 1);
  });
});

describe('importTelegram — an abandoned login does not stay resident', () => {
  it('drops the entry and hangs up once the code is stale', async () => {
    vi.useFakeTimers();

    const phone = '+79990000005';
    const sent = await tgSendCode(phone);
    const client = lastClient();

    expect(client.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TELEGRAM_LOGIN_TTL_MS + 1);

    expect(client.disconnect).toHaveBeenCalled();

    // Gone from the map too, not merely disconnected: a later verify has to build
    // its own client rather than finding the dead one.
    const constructedBefore = tg.clients.length;
    await tgVerifyAndPull(phone, '44444', sent.phoneCodeHash);
    expect(tg.clients.length).toBe(constructedBefore + 1);
  });
});
