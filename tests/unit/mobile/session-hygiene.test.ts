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
  fetch: vi.fn(),
  authHeaders: vi.fn(),
  addConflict: vi.fn(),
  queryClientClear: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string): Promise<string | null> => mocks.asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string): Promise<void> => {
      mocks.asyncStorage.set(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      mocks.asyncStorage.delete(key);
    },
  },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string): Promise<string | null> => mocks.secureStorage.get(key) ?? null,
  setItemAsync: async (key: string, value: string): Promise<void> => {
    mocks.secureStorage.set(key, value);
  },
  deleteItemAsync: async (key: string): Promise<void> => {
    mocks.secureStorage.delete(key);
  },
}));

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
  enqueue,
  flush,
  getDroppedMutations,
} from '../../../src/utils/offlineQueue';
import { useNotificationStore } from '../../../src/store/notificationStore';
import { useUserStore } from '../../../src/store/userStore';
import { resolveWsUrl } from '../../../src/utils/websocket';

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
    mocks.authHeaders.mockResolvedValue({
      'Content-Type': 'application/json',
      Authorization: 'Bearer session-token',
    });
    vi.stubGlobal('fetch', mocks.fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clearDroppedMutations();
    useUserStore.setState({ user: null, token: null, error: null, isLoading: false });
    useNotificationStore.setState({ notifications: [], unreadCount: 0, loading: false, page: 1, total: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
