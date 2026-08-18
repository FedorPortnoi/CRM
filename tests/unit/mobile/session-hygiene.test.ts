import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Session hygiene: everything that must not survive a logout, and everything that must not be
// replayed under a token it was not authored with.
//
// These live under tests/unit/mobile/ (a new directory) rather than alongside the backend
// suites because they cover src/, the React Native client. `npm run test:unit` is
// `vitest run tests/unit`, so any *.test.ts below that path is collected — tests/unit/utils/
// already covers src/utils the same way. Nothing extra had to be wired up.
//
// The whole file shares one set of module mocks, which is why the offline queue is exercised
// through its real implementation here instead of being stubbed: userStore.logout() calls into
// it, and the interesting assertion is that the bytes actually leave storage.

const mocks = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  secureStorage: new Map<string, string>(),
  // Keys whose SecureStore operations reject, so a locked keychain can be simulated for one
  // step of logout at a time rather than for the whole run.
  secureStoreFailures: new Set<string>(),
  // Keys whose AsyncStorage.removeItem rejects. Used to model "the process died before this
  // removal happened", which is what makes clearQueue()'s ordering observable.
  asyncRemoveFailures: new Set<string>(),
  // Ordered log of every storage write/delete, so ordering between two stores can be asserted.
  storageOps: [] as string[],
  fetch: vi.fn(),
  authHeaders: vi.fn(),
  addConflict: vi.fn(),
  queryClientClear: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string): Promise<string | null> => mocks.asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string): Promise<void> => {
      mocks.storageOps.push(`async:set:${key}`);
      mocks.asyncStorage.set(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      if (mocks.asyncRemoveFailures.has(key)) {
        throw new Error(`AsyncStorage unavailable for ${key}`);
      }
      mocks.storageOps.push(`async:remove:${key}`);
      mocks.asyncStorage.delete(key);
    },
  },
}));

vi.mock('expo-secure-store', () => {
  const failIfMarked = (key: string): void => {
    if (mocks.secureStoreFailures.has(key)) {
      throw new Error(`SecureStore unavailable for ${key}`);
    }
  };

  return {
    getItemAsync: async (key: string): Promise<string | null> => {
      failIfMarked(key);
      return mocks.secureStorage.get(key) ?? null;
    },
    setItemAsync: async (key: string, value: string): Promise<void> => {
      failIfMarked(key);
      mocks.storageOps.push(`secure:set:${key}`);
      mocks.secureStorage.set(key, value);
    },
    deleteItemAsync: async (key: string): Promise<void> => {
      failIfMarked(key);
      mocks.storageOps.push(`secure:delete:${key}`);
      mocks.secureStorage.delete(key);
    },
  };
});

vi.mock('../../../src/utils/api', () => ({
  API_URL: 'https://api.example.com/api/v1',
  authHeaders: mocks.authHeaders,
}));

vi.mock('../../../src/utils/queryClient', () => ({
  queryClient: { clear: mocks.queryClientClear },
}));

vi.mock('../../../src/store/syncStore', () => ({
  useSyncStore: { getState: () => ({ addConflict: mocks.addConflict }) },
}));

import {
  clearDroppedMutations,
  clearQueue,
  enqueue,
  flush,
  getDroppedMutations,
} from '../../../src/utils/offlineQueue';
import { useChatStore } from '../../../src/store/chatStore';
import { useNotificationStore } from '../../../src/store/notificationStore';
import { useUserStore } from '../../../src/store/userStore';
import { openHandshake, resolveWsUrl } from '../../../src/utils/websocket';

const QUEUE_KEY = 'crm-offline-queue';
const BODY_KEY_PREFIX = 'crm-offline-queue-body-';
const LAST_SYNC_KEY = 'crm-last-sync-at';
const TOKEN_KEY = 'crm_auth_token';
const USER_KEY = 'crm_auth_user';

const CONTACT_ID = '11111111-1111-1111-1111-111111111111';

function signIn(userId: string): void {
  mocks.secureStorage.set(TOKEN_KEY, `token-for-${userId}`);
  mocks.secureStorage.set(
    USER_KEY,
    JSON.stringify({
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      role: 'manager',
      org_id: `org-of-${userId}`,
    }),
  );
}

function storedQueue(): Array<Record<string, unknown>> {
  const raw = mocks.asyncStorage.get(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
}

function storedBodyKeys(): string[] {
  return [...mocks.secureStorage.keys()].filter((key) => key.startsWith(BODY_KEY_PREFIX));
}

// Source-level invariants below are asserted against the code with comments removed, so that a
// comment explaining why a pattern is banned cannot itself trip the assertion.
function sourceWithoutComments(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('mobile session hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.asyncStorage.clear();
    mocks.secureStorage.clear();
    mocks.secureStoreFailures.clear();
    mocks.asyncRemoveFailures.clear();
    mocks.storageOps.length = 0;
    mocks.authHeaders.mockResolvedValue({
      'Content-Type': 'application/json',
      Authorization: 'Bearer session-token',
    });
    vi.stubGlobal('fetch', mocks.fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clearDroppedMutations();
    useUserStore.setState({
      user: null,
      token: null,
      pendingVerification: null,
      pendingTotp: null,
      error: null,
      isLoading: false,
    });
    useNotificationStore.setState({ notifications: [], unreadCount: 0, loading: false, page: 1, total: 0 });
    useChatStore.setState({ ws: null, connectingToken: null, channels: [], messages: {}, hasMore: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('credential-change session rotation', () => {
    const credentialUser = {
      id: 'user-a',
      email: 'temporary@example.com',
      name: 'Invitee',
      role: 'member',
      org_id: 'org-of-user-a',
      must_change_password: true,
      must_change_email: true,
    };

    function seedCredentialSession(): void {
      mocks.secureStorage.set(TOKEN_KEY, 'revoked-caller-token');
      mocks.secureStorage.set(USER_KEY, JSON.stringify(credentialUser));
      useUserStore.setState({ user: credentialUser, token: 'revoked-caller-token' });
    }

    it('stores the replacement token returned after a password change', async () => {
      seedCredentialSession();
      mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
        data: { updated: true, token: 'fresh-password-session' },
        meta: {},
      }), { status: 200 }));

      const outcome = await useUserStore.getState().changePassword('Brand-New-1!');

      expect(outcome).toBe('authenticated');
      expect(mocks.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/v1/auth/me/password',
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({ Authorization: 'Bearer revoked-caller-token' }),
        }),
      );
      expect(mocks.secureStorage.get(TOKEN_KEY)).toBe('fresh-password-session');
      expect(useUserStore.getState().token).toBe('fresh-password-session');
      expect(useUserStore.getState().user?.must_change_password).toBe(false);
    });

    it('fails safely against an older password endpoint with no replacement token', async () => {
      seedCredentialSession();
      mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
        data: { updated: true },
        meta: {},
      }), { status: 200 }));

      const outcome = await useUserStore.getState().changePassword('Brand-New-1!');

      expect(outcome).toBe('login-required');
      expect(mocks.secureStorage.has(TOKEN_KEY)).toBe(false);
      expect(useUserStore.getState().token).toBeNull();
    });

    it('stores a fail-open set-credentials replacement session', async () => {
      seedCredentialSession();
      const updatedUser = {
        ...credentialUser,
        email: 'invitee@example.com',
        must_change_password: false,
        must_change_email: false,
      };
      mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
        data: { user: updatedUser, token: 'fresh-credentials-session' },
        meta: {},
      }), { status: 200 }));

      const outcome = await useUserStore
        .getState()
        .setCredentials('invitee@example.com', 'Brand-New-1!');

      expect(outcome).toBe('authenticated');
      expect(mocks.secureStorage.get(TOKEN_KEY)).toBe('fresh-credentials-session');
      expect(useUserStore.getState()).toMatchObject({
        token: 'fresh-credentials-session',
        user: updatedUser,
        pendingVerification: null,
      });
    });

    it('keeps the verification branch sessionless until the OTP succeeds', async () => {
      seedCredentialSession();
      const updatedUser = {
        ...credentialUser,
        email: 'invitee@example.com',
        must_change_password: false,
        must_change_email: false,
      };
      mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
        data: {
          user: updatedUser,
          pending_verification: { user_id: 'user-a', email: 'invitee@example.com' },
        },
        meta: {},
      }), { status: 200 }));

      const outcome = await useUserStore
        .getState()
        .setCredentials('invitee@example.com', 'Brand-New-1!');

      expect(outcome).toBe('verification-required');
      expect(mocks.secureStorage.has(TOKEN_KEY)).toBe(false);
      expect(useUserStore.getState()).toMatchObject({
        token: null,
        pendingVerification: { userId: 'user-a', email: 'invitee@example.com' },
      });
    });

    it('routes the no-token compatibility outcome to login before authenticated screens', () => {
      const source = sourceWithoutComments('src/app/set-password.tsx');
      const fallbackIndex = source.indexOf("outcome === 'login-required'");
      const authenticatedIndex = source.indexOf("'/onboarding' : '/(tabs)'");

      expect(fallbackIndex).toBeGreaterThan(-1);
      expect(source.slice(fallbackIndex, authenticatedIndex)).toContain("router.replace('/login'");
      expect(fallbackIndex).toBeLessThan(authenticatedIndex);
    });
  });

  describe('offline queue ownership', () => {
    it('stamps a queued write with the id of the account that authored it', async () => {
      signIn('user-a');

      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });

      expect(storedQueue()).toEqual([expect.objectContaining({ owner: 'user-a' })]);
    });

    it('never replays a previous account’s queue under the next account’s token', async () => {
      signIn('user-a');
      await enqueue({
        url: `https://api.example.com/api/v1/contacts/${CONTACT_ID}`,
        method: 'PATCH',
        body: JSON.stringify({ first_name: 'Ada' }),
      });

      // User B signs in on the same phone. This models a logout that never got as far as
      // clearing the queue (force-quit, crash, OS kill) — the case the owner stamp exists for.
      signIn('user-b');

      await flush();

      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(storedQueue()).toEqual([]);
      expect(storedBodyKeys()).toEqual([]);
      expect(getDroppedMutations()).toEqual([
        expect.objectContaining({
          reason: 'foreign-session',
          method: 'PATCH',
          url: `https://api.example.com/api/v1/contacts/${CONTACT_ID}`,
        }),
      ]);
    });

    it('still flushes a queue for the account that authored it', async () => {
      signIn('user-a');
      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });

      mocks.fetch.mockResolvedValue(new Response('', { status: 201 }));

      await flush();

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(storedQueue()).toEqual([]);
      expect(getDroppedMutations()).toEqual([]);
    });

    // The owner check reads "drop on positive evidence of a mismatch", which only works while
    // "no id" means one thing. It used to mean three: no user record, JSON that would not parse,
    // and an id that was not a string — all reported as null, so a signed-in user with a corrupt
    // record compared EQUAL to an unstamped item left behind by somebody else.
    describe.each([
      ['the record is not valid JSON', '{"id":"user-a'],
      ['the record parses but the id is not a string', JSON.stringify({ id: 42, name: 'user-b' })],
      ['the record parses to a non-object', JSON.stringify('user-b')],
    ])('when a session exists but %s', (_label: string, corruptRecord: string) => {
      it('sends nothing and keeps the queue', async () => {
        // A queue written by a build that predates the owner stamp: token present, no user
        // record, so the item goes in unstamped.
        mocks.secureStorage.set(TOKEN_KEY, 'token-for-user-a');
        await enqueue({
          url: `https://api.example.com/api/v1/contacts/${CONTACT_ID}`,
          method: 'PATCH',
          body: JSON.stringify({ first_name: 'Ada' }),
        });
        expect(storedQueue()[0].owner).toBeUndefined();

        // User B is signed in on the same device, but their record cannot be deciphered.
        mocks.secureStorage.set(TOKEN_KEY, 'token-for-user-b');
        mocks.secureStorage.set(USER_KEY, corruptRecord);

        await flush();

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(storedQueue()).toHaveLength(1);
        expect(storedBodyKeys()).toHaveLength(1);
        expect(getDroppedMutations()).toEqual([]);
      });
    });

    it('sends nothing when the user record cannot be read at all', async () => {
      mocks.secureStorage.set(TOKEN_KEY, 'token-for-user-a');
      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });

      signIn('user-b');
      // SecureStore itself refuses: the record may well be there and belong to somebody else.
      mocks.secureStoreFailures.add(USER_KEY);

      await flush();

      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(storedQueue()).toHaveLength(1);
      expect(getDroppedMutations()).toEqual([]);
    });

    it('still sends an unstamped write when there is genuinely no user record', async () => {
      // The other half of the distinction: "absent" is not "unreadable". A device with a token
      // and no user record is the pre-stamp state this leniency was written for, and it must
      // keep working — otherwise the fix silently strands writes made across an app upgrade.
      mocks.secureStorage.set(TOKEN_KEY, 'token-for-user-a');
      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });
      mocks.fetch.mockResolvedValue(new Response('', { status: 201 }));

      await flush();

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(storedQueue()).toEqual([]);
      expect(getDroppedMutations()).toEqual([]);
    });

    it('neither sends nor destroys the queue when no session is on the device', async () => {
      signIn('user-a');
      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });

      mocks.secureStorage.delete(TOKEN_KEY);
      mocks.secureStorage.delete(USER_KEY);

      await flush();

      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(storedQueue()).toHaveLength(1);
      expect(storedBodyKeys()).toHaveLength(1);
      expect(getDroppedMutations()).toEqual([]);
    });
  });

  describe('offline queue wedging', () => {
    async function queueTwoWrites(): Promise<void> {
      signIn('user-a');
      await enqueue({
        url: `https://api.example.com/api/v1/contacts/${CONTACT_ID}`,
        method: 'PATCH',
        body: JSON.stringify({ first_name: 'Ada' }),
      });
      await enqueue({
        url: 'https://api.example.com/api/v1/deals',
        method: 'POST',
        body: JSON.stringify({ title: 'Second write' }),
      });
    }

    it.each([403, 404, 422])(
      'drops a permanently failing item (%i) and keeps flushing the ones behind it',
      async (status: number) => {
        await queueTwoWrites();

        mocks.fetch
          .mockResolvedValueOnce(new Response('', { status }))
          .mockResolvedValueOnce(new Response('', { status: 201 }));

        await flush();

        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(storedQueue()).toEqual([]);
        expect(storedBodyKeys()).toEqual([]);
        expect(getDroppedMutations()).toEqual([
          expect.objectContaining({ reason: 'terminal-response', status, method: 'PATCH' }),
        ]);
      },
    );

    it.each([408, 429, 500, 503])(
      'stops on a retryable failure (%i) and preserves the queue in order',
      async (status: number) => {
        await queueTwoWrites();

        mocks.fetch.mockResolvedValueOnce(new Response('', { status }));

        await flush();

        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(storedQueue().map((item) => item.method)).toEqual(['PATCH', 'POST']);
        expect(storedBodyKeys()).toHaveLength(2);
        expect(getDroppedMutations()).toEqual([]);
      },
    );

    it('stops on a transport failure rather than discarding the write', async () => {
      await queueTwoWrites();

      mocks.fetch.mockRejectedValueOnce(new TypeError('Network request failed'));

      await flush();

      expect(storedQueue()).toHaveLength(2);
      expect(getDroppedMutations()).toEqual([]);
    });
  });

  // clearQueue() spans two stores: the index in AsyncStorage and one body per item in
  // SecureStore. Only the index can enumerate the bodies, so the order the two are torn down in
  // decides what an interrupted logout leaves behind.
  describe('offline queue teardown', () => {
    async function queueTwoBodies(): Promise<void> {
      signIn('user-a');
      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });
      await enqueue({
        url: 'https://api.example.com/api/v1/deals',
        method: 'POST',
        body: JSON.stringify({ title: 'Second write' }),
      });
      mocks.storageOps.length = 0;
    }

    it('deletes every body before removing the index that points at them', async () => {
      await queueTwoBodies();

      await clearQueue();

      const bodyDeletions = mocks.storageOps
        .map((op, index) => ({ op, index }))
        .filter(({ op }) => op.startsWith(`secure:delete:${BODY_KEY_PREFIX}`))
        .map(({ index }) => index);
      const indexRemoval = mocks.storageOps.indexOf(`async:remove:${QUEUE_KEY}`);

      expect(bodyDeletions).toHaveLength(2);
      expect(indexRemoval).toBeGreaterThan(Math.max(...bodyDeletions));
    });

    it('leaves no orphaned bodies when the index removal never happens', async () => {
      await queueTwoBodies();
      // Models the process being killed at the point the index would have been removed. Whatever
      // ran before this must already have been enough to leave nothing recoverable behind.
      mocks.asyncRemoveFailures.add(QUEUE_KEY);

      await expect(clearQueue()).rejects.toThrow();

      expect(storedBodyKeys()).toEqual([]);
    });

    it('survives the opposite interruption: an index pointing at bodies already gone', async () => {
      await queueTwoBodies();
      mocks.asyncRemoveFailures.add(QUEUE_KEY);
      await expect(clearQueue()).rejects.toThrow();

      // The index is still there and every body it names is not. flush() must read that as an
      // empty queue rather than sending empty payloads or throwing.
      expect(mocks.asyncStorage.has(QUEUE_KEY)).toBe(true);
      mocks.asyncRemoveFailures.clear();

      await flush();

      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(storedQueue()).toEqual([]);
    });
  });

  describe('logout', () => {
    async function signInAndQueueWork(): Promise<void> {
      signIn('user-a');
      await enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      });
      mocks.asyncStorage.set(LAST_SYNC_KEY, '2026-07-29T00:00:00.000Z');
      useUserStore.setState({
        user: {
          id: 'user-a',
          email: 'user-a@example.com',
          name: 'user-a',
          role: 'manager',
          org_id: 'org-of-user-a',
        },
        token: 'token-for-user-a',
      });
    }

    it('clears the queue, its SecureStore bodies, the query cache and the sync watermark', async () => {
      await signInAndQueueWork();
      mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));

      await useUserStore.getState().logout();

      expect(mocks.secureStorage.has(TOKEN_KEY)).toBe(false);
      expect(mocks.secureStorage.has(USER_KEY)).toBe(false);
      expect(mocks.asyncStorage.has(QUEUE_KEY)).toBe(false);
      expect(storedBodyKeys()).toEqual([]);
      expect(mocks.queryClientClear).toHaveBeenCalledTimes(1);
      expect(mocks.asyncStorage.has(LAST_SYNC_KEY)).toBe(false);
      expect(useUserStore.getState().user).toBeNull();
      expect(useUserStore.getState().token).toBeNull();
    });

    it('clears everything locally even when the server logout call fails', async () => {
      await signInAndQueueWork();
      mocks.fetch.mockRejectedValue(new TypeError('Network request failed'));

      await useUserStore.getState().logout();

      expect(mocks.secureStorage.has(TOKEN_KEY)).toBe(false);
      expect(mocks.asyncStorage.has(QUEUE_KEY)).toBe(false);
      expect(storedBodyKeys()).toEqual([]);
      expect(mocks.asyncStorage.has(LAST_SYNC_KEY)).toBe(false);
      expect(useUserStore.getState().user).toBeNull();
    });

    // The credential deletes used to be bare awaits. A rejection on the second one skipped the
    // queue purge, the cache clear, the watermark reset and the set() that actually signs the
    // user out — leaving the previous account's PII queued and the app still showing them as
    // signed in, which is the state logout() claims cannot happen.
    it.each([TOKEN_KEY, USER_KEY])(
      'finishes every other step when SecureStore rejects on %s',
      async (failingKey: string) => {
        await signInAndQueueWork();
        mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));
        mocks.secureStoreFailures.add(failingKey);

        await expect(useUserStore.getState().logout()).resolves.toBeUndefined();

        expect(mocks.asyncStorage.has(QUEUE_KEY)).toBe(false);
        expect(storedBodyKeys()).toEqual([]);
        expect(mocks.queryClientClear).toHaveBeenCalledTimes(1);
        expect(mocks.asyncStorage.has(LAST_SYNC_KEY)).toBe(false);
        expect(useUserStore.getState().user).toBeNull();
        expect(useUserStore.getState().token).toBeNull();
      },
    );

    it('clears the store even when every storage call fails', async () => {
      await signInAndQueueWork();
      mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));
      mocks.secureStoreFailures.add(TOKEN_KEY);
      mocks.secureStoreFailures.add(USER_KEY);
      mocks.asyncRemoveFailures.add(QUEUE_KEY);
      mocks.asyncRemoveFailures.add(LAST_SYNC_KEY);

      await expect(useUserStore.getState().logout()).resolves.toBeUndefined();

      // Signing the user out of the UI has no storage behind it, so it is never conditional on
      // storage cooperating. The steps that do need storage still each got their turn.
      expect(useUserStore.getState().user).toBeNull();
      expect(useUserStore.getState().token).toBeNull();
      expect(mocks.queryClientClear).toHaveBeenCalledTimes(1);
      expect(storedBodyKeys()).toEqual([]);
    });

    it('leaves a queue written by the next account alone', async () => {
      await signInAndQueueWork();
      mocks.fetch.mockResolvedValue(new Response('', { status: 200 }));
      await useUserStore.getState().logout();

      signIn('user-b');
      await enqueue({
        url: 'https://api.example.com/api/v1/deals',
        method: 'POST',
        body: JSON.stringify({ title: 'B only' }),
      });
      mocks.fetch.mockResolvedValue(new Response('', { status: 201 }));

      await flush();

      expect(mocks.fetch).toHaveBeenLastCalledWith(
        'https://api.example.com/api/v1/deals',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(getDroppedMutations()).toEqual([]);
    });
  });

  describe('websocket handshake', () => {
    it('builds a ticket URL and never a token URL', () => {
      expect(resolveWsUrl('ticket-1')).toBe('wss://api.example.com/api/v1/ws?ticket=ticket-1');
    });

    it('fails closed when no ticket could be obtained', () => {
      expect(resolveWsUrl(null)).toBeNull();
    });

    it('has no code path that puts the bearer token in a URL', () => {
      const source = sourceWithoutComments('src/utils/websocket.ts');

      expect(source).not.toContain('getTokenWsUrl');
      expect(source).not.toContain('token=');
    });

    // useOrgWebSocket's connect() is a useCallback keyed on [token] and its effect depends on
    // [connect], so changing accounts runs the cleanup and the new effect body back-to-back and
    // synchronously — mount state is already true again by the time an in-flight ticket request
    // resolves. Guarding on it therefore proves nothing about who the ticket belongs to.
    describe('in-flight session change', () => {
      function ticketResponse(ticket: string): Response {
        return new Response(JSON.stringify({ data: { ticket } }), { status: 200 });
      }

      it('uses a ticket that still belongs to the session that asked for it', async () => {
        mocks.fetch.mockResolvedValue(ticketResponse('ticket-a'));

        const outcome = await openHandshake('token-a', () => 'token-a', () => true);

        expect(outcome).toEqual({
          status: 'ready',
          url: 'wss://api.example.com/api/v1/ws?ticket=ticket-a',
        });
      });

      it('discards a ticket minted for the previous account, mounted or not', async () => {
        let signedIn: string | null = 'token-a';
        mocks.fetch.mockImplementation(async () => {
          // The account changes while the exchange is in flight, and the hook re-mounts as part
          // of that — so `mounted` below stays true throughout. That is the whole scenario.
          signedIn = 'token-b';
          return ticketResponse('ticket-a');
        });

        const outcome = await openHandshake('token-a', () => signedIn, () => true);

        expect(outcome).toEqual({ status: 'stale' });
      });

      it('discards a ticket after a sign-out that left no session behind', async () => {
        let signedIn: string | null = 'token-a';
        mocks.fetch.mockImplementation(async () => {
          signedIn = null;
          return ticketResponse('ticket-a');
        });

        expect(await openHandshake('token-a', () => signedIn, () => true)).toEqual({
          status: 'stale',
        });
      });

      it('discards a ticket once the hook has unmounted for good', async () => {
        mocks.fetch.mockResolvedValue(ticketResponse('ticket-a'));

        expect(await openHandshake('token-a', () => 'token-a', () => false)).toEqual({
          status: 'stale',
        });
      });

      it('separates "no ticket" from "not ours" so only the first is retried', async () => {
        mocks.fetch.mockResolvedValue(new Response('', { status: 503 }));

        expect(await openHandshake('token-a', () => 'token-a', () => true)).toEqual({
          status: 'no-ticket',
        });
      });

      it('checks the resolved ticket against the session, not against mount state', () => {
        const source = sourceWithoutComments('src/utils/websocket.ts');
        const body = source.slice(source.indexOf('const connect = useCallback'));

        // The hook must hand openHandshake a reader for the session it is currently serving;
        // a bare mount check in its place is the bug this pins.
        expect(body).toContain('openHandshake(');
        expect(body).toContain('tokenRef.current');
      });
    });
  });

  // The Chat tab opened the same /api/v1/ws endpoint with `?token=<JWT>` — the fallback
  // websocket.ts deleted and documented as "must not come back". It had never left: this was a
  // second implementation of the same handshake and only the first one was migrated.
  describe('chat socket handshake', () => {
    function stubWebSocket(): string[] {
      const opened: string[] = [];
      vi.stubGlobal(
        'WebSocket',
        class {
          onopen: (() => void) | null = null;
          onclose: (() => void) | null = null;
          onerror: (() => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          constructor(public url: string) {
            opened.push(url);
          }
          close(): void {}
        },
      );
      return opened;
    }

    it('opens on a ticket and never puts the bearer token in the URL', async () => {
      const opened = stubWebSocket();
      mocks.fetch.mockResolvedValue(
        new Response(JSON.stringify({ data: { ticket: 'chat-ticket' } }), { status: 200 }),
      );

      useChatStore.getState().connect('jwt-for-user-a');
      await vi.waitFor(() => expect(useChatStore.getState().ws).not.toBeNull());

      expect(mocks.fetch).toHaveBeenCalledWith('https://api.example.com/api/v1/ws/ticket', {
        headers: {
          Authorization: 'Bearer jwt-for-user-a',
          'Content-Type': 'application/json',
        },
      });
      expect(opened).toEqual(['wss://api.example.com/api/v1/ws?ticket=chat-ticket']);
      expect(opened[0]).not.toContain('jwt-for-user-a');
    });

    it('fails closed when no ticket can be obtained', async () => {
      const opened = stubWebSocket();
      mocks.fetch.mockResolvedValue(new Response('', { status: 500 }));

      useChatStore.getState().connect('jwt-for-user-a');
      await vi.waitFor(() => expect(useChatStore.getState().connectingToken).toBeNull());

      expect(opened).toEqual([]);
      expect(useChatStore.getState().ws).toBeNull();
    });

    it('opens one socket when the tab is visited twice before the ticket arrives', async () => {
      const opened = stubWebSocket();
      mocks.fetch.mockResolvedValue(
        new Response(JSON.stringify({ data: { ticket: 'chat-ticket' } }), { status: 200 }),
      );

      useChatStore.getState().connect('jwt-for-user-a');
      useChatStore.getState().connect('jwt-for-user-a');
      await vi.waitFor(() => expect(useChatStore.getState().ws).not.toBeNull());

      expect(opened).toHaveLength(1);
    });

    it('drops a ticket minted for an account that has since signed out', async () => {
      const opened = stubWebSocket();
      mocks.fetch.mockImplementation(async () => {
        // Somebody else signs in on the same device while the exchange is in flight.
        useChatStore.setState({ connectingToken: 'jwt-for-user-b' });
        return new Response(JSON.stringify({ data: { ticket: 'ticket-for-a' } }), { status: 200 });
      });

      useChatStore.getState().connect('jwt-for-user-a');
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());

      expect(opened).toEqual([]);
      expect(useChatStore.getState().ws).toBeNull();
    });

    it('has no code path that puts the bearer token in a chat socket URL', () => {
      const source = sourceWithoutComments('src/store/chatStore.ts');

      expect(source).not.toContain('token=');
      expect(source).not.toContain('new WebSocket(`');
    });
  });

  describe('notification API base', () => {
    it('uses the shared resolved API URL', async () => {
      useUserStore.setState({ token: 'token-for-user-a' });
      mocks.fetch.mockResolvedValue(
        new Response(JSON.stringify({ data: { count: 3 } }), { status: 200 }),
      );

      await useNotificationStore.getState().fetchUnreadCount();

      expect(mocks.fetch).toHaveBeenCalledWith(
        'https://api.example.com/api/v1/notifications/unread-count',
        {
          headers: {
            Authorization: 'Bearer token-for-user-a',
            'Content-Type': 'application/json',
          },
        },
      );
      expect(useNotificationStore.getState().unreadCount).toBe(3);
    });

    it('does not resolve its own base URL behind the shared guard', () => {
      const source = sourceWithoutComments('src/store/notificationStore.ts');

      expect(source).not.toContain('process.env');
      expect(source).not.toContain('localhost');
    });
  });
});
