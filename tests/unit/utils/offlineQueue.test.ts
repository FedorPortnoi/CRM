import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  asyncGetItem: vi.fn(),
  asyncSetItem: vi.fn(),
  asyncRemoveItem: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  fetch: vi.fn(),
  addConflict: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mocks.asyncGetItem,
    setItem: mocks.asyncSetItem,
    removeItem: mocks.asyncRemoveItem,
  },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
  deleteItemAsync: mocks.deleteItemAsync,
}));

vi.mock('../../../src/store/syncStore', () => ({
  useSyncStore: {
    getState: () => ({
      addConflict: mocks.addConflict,
    }),
  },
}));

import { enqueue, flush } from '../../../src/utils/offlineQueue';

const STORAGE_KEY = 'crm-offline-queue';

describe('offlineQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.getItemAsync.mockResolvedValue('auth-token');
    mocks.setItemAsync.mockResolvedValue(undefined);
    mocks.deleteItemAsync.mockResolvedValue(undefined);
  });

  it('stores queued bodies outside AsyncStorage and serializes concurrent enqueues', async () => {
    const storage = new Map<string, string>();
    const secureStorage = new Map<string, string>();

    mocks.asyncGetItem.mockImplementation(async (key: string) => storage.get(key) ?? null);
    mocks.asyncSetItem.mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    });
    mocks.setItemAsync.mockImplementation(async (key: string, value: string) => {
      secureStorage.set(key, value);
    });
    mocks.getItemAsync.mockImplementation(async (key: string) => secureStorage.get(key) ?? null);

    await Promise.all([
      enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Ada' }),
      }),
      enqueue({
        url: 'https://api.example.com/api/v1/contacts',
        method: 'POST',
        body: JSON.stringify({ first_name: 'Grace' }),
      }),
    ]);

    const serializedQueue = storage.get(STORAGE_KEY);
    expect(serializedQueue).toEqual(expect.any(String));
    expect(serializedQueue).not.toContain('Ada');
    expect(serializedQueue).not.toContain('Grace');

    const queued = JSON.parse(serializedQueue ?? '[]') as Array<{
      body?: string;
      bodyKey?: string;
    }>;
    expect(queued).toHaveLength(2);
    expect(queued.every((item) => item.body === undefined)).toBe(true);
    expect(queued.map((item) => item.bodyKey)).toEqual([
      expect.stringMatching(/^crm-offline-queue-body:queue-/),
      expect.stringMatching(/^crm-offline-queue-body:queue-/),
    ]);
    expect([...secureStorage.values()].sort()).toEqual([
      JSON.stringify({ first_name: 'Ada' }),
      JSON.stringify({ first_name: 'Grace' }),
    ]);
  });

  it('records and removes DELETE conflicts without parsing an empty body', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    mocks.asyncGetItem.mockResolvedValue(
      JSON.stringify([
        {
          id: 'q-delete',
          url: `https://api.example.com/api/v1/contacts/${id}`,
          method: 'DELETE',
          body: '',
          enqueuedAt: 1,
        },
      ]),
    );
    mocks.fetch.mockResolvedValue(new Response('', { status: 409 }));

    await flush();

    expect(mocks.addConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'contacts',
        id,
        localValue: null,
        serverValue: null,
      }),
    );
    expect(mocks.asyncSetItem).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify([]));
  });

  it('runs capture matching after a queued captured contact is created', async () => {
    mocks.asyncGetItem.mockResolvedValue(
      JSON.stringify([
        {
          id: 'q-create',
          url: 'https://api.example.com/api/v1/contacts',
          method: 'POST',
          body: JSON.stringify({ first_name: 'Ada' }),
          enqueuedAt: 1,
          followUp: {
            kind: 'matchCaptureToCreatedContact',
            url: 'https://api.example.com/api/v1/captures/capture-1/match',
            method: 'POST',
          },
        },
      ]),
    );
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'contact-1' } }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'capture-1' } }), { status: 200 }));

    await flush();

    expect(mocks.fetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/api/v1/captures/capture-1/match', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer auth-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contact_id: 'contact-1' }),
    });
    expect(mocks.asyncSetItem).toHaveBeenLastCalledWith(STORAGE_KEY, JSON.stringify([]));
  });

  it('keeps a concrete capture match queued if the dependent request fails', async () => {
    mocks.asyncGetItem.mockResolvedValue(
      JSON.stringify([
        {
          id: 'q-create',
          url: 'https://api.example.com/api/v1/contacts',
          method: 'POST',
          body: JSON.stringify({ first_name: 'Ada' }),
          enqueuedAt: 1,
          followUp: {
            kind: 'matchCaptureToCreatedContact',
            url: 'https://api.example.com/api/v1/captures/capture-1/match',
            method: 'POST',
          },
        },
      ]),
    );
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'contact-1' } }), { status: 201 }),
      )
      .mockRejectedValueOnce(new TypeError('Network request failed'));

    await flush();

    const [, serializedQueue] = mocks.asyncSetItem.mock.calls.at(-1) as [string, string];
    const queued = JSON.parse(serializedQueue) as Array<{ url: string; method: string; body?: string; bodyKey?: string }>;
    expect(queued).toEqual([
      {
        id: 'q-create-follow-up',
        url: 'https://api.example.com/api/v1/captures/capture-1/match',
        method: 'POST',
        bodyKey: 'crm-offline-queue-body:q-create-follow-up',
        enqueuedAt: expect.any(Number),
      },
    ]);
    expect(mocks.setItemAsync).toHaveBeenLastCalledWith(
      'crm-offline-queue-body:q-create-follow-up',
      JSON.stringify({ contact_id: 'contact-1' }),
    );
  });
});
