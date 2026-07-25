import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let taskHandler: (() => Promise<string>) | undefined;

  return {
    asyncGetItem: vi.fn(),
    asyncSetItem: vi.fn(),
    flush: vi.fn(),
    fetch: vi.fn(),
    authHeaders: vi.fn(),
    invalidateQueries: vi.fn(),
    defineTask: vi.fn((_taskName: string, handler: () => Promise<string>) => {
      taskHandler = handler;
    }),
    getTaskHandler: () => taskHandler,
    registerTaskAsync: vi.fn(),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mocks.asyncGetItem,
    setItem: mocks.asyncSetItem,
  },
}));

vi.mock('../../../src/utils/offlineQueue', () => ({
  flush: mocks.flush,
}));

vi.mock('../../../src/utils/queryClient', () => ({
  queryClient: {
    invalidateQueries: mocks.invalidateQueries,
  },
}));

vi.mock('expo-background-fetch', () => ({
  BackgroundFetchResult: {
    NewData: 'new-data',
    Failed: 'failed',
  },
  registerTaskAsync: mocks.registerTaskAsync,
}));

vi.mock('expo-task-manager', () => ({
  defineTask: mocks.defineTask,
}));

vi.mock('../../../src/utils/api', () => ({
  API_URL: 'https://api.example.com/api/v1',
  authHeaders: mocks.authHeaders,
}));

import { BACKGROUND_SYNC_TASK_NAME, registerBackgroundSync } from '../../../src/utils/backgroundSync';

describe('background sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.asyncGetItem.mockResolvedValue(null);
    mocks.asyncSetItem.mockResolvedValue(undefined);
    mocks.flush.mockResolvedValue(undefined);
    mocks.authHeaders.mockResolvedValue({ Authorization: 'Bearer token-1' });
    mocks.invalidateQueries.mockResolvedValue(undefined);
    mocks.registerTaskAsync.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a stable background task name and interval', async () => {
    await registerBackgroundSync();

    expect(mocks.registerTaskAsync).toHaveBeenCalledWith(BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  });

  it('defines a background task that reports failed when sync throws', async () => {
    const taskHandler = mocks.getTaskHandler();
    expect(taskHandler).toEqual(expect.any(Function));

    mocks.flush.mockRejectedValue(new Error('offline queue failed'));

    await expect(taskHandler?.()).resolves.toBe('failed');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('flushes queued mutations before fetching delta with the shared API URL', async () => {
    const taskHandler = mocks.getTaskHandler();

    mocks.asyncGetItem.mockResolvedValue('2026-05-20T12:00:00.000Z');
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { contacts: [], deals: [], tasks: [{ id: 'task-1' }], events: [] },
          meta: { since: '2026-05-20T12:00:00.000Z', server_time: '2026-05-21T12:00:00.000Z' },
        }),
        { status: 200 },
      ),
    );

    await expect(taskHandler?.()).resolves.toBe('new-data');

    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[0]);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/sync/delta?since=2026-05-20T12%3A00%3A00.000Z',
      { headers: { Authorization: 'Bearer token-1' } },
    );
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['contacts'] });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['events'] });
    expect(mocks.asyncSetItem).toHaveBeenCalledWith('crm-last-sync-at', '2026-05-21T12:00:00.000Z');
  });

  it('updates the last sync timestamp without invalidating queries when the delta is empty', async () => {
    const taskHandler = mocks.getTaskHandler();

    mocks.asyncGetItem.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { contacts: [], deals: [], tasks: [], events: [] },
          meta: { since: '2026-05-21T11:00:00.000Z', server_time: '2026-05-21T12:30:00.000Z' },
        }),
        { status: 200 },
      ),
    );

    await expect(taskHandler?.()).resolves.toBe('new-data');

    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    expect(mocks.asyncSetItem).toHaveBeenCalledWith('crm-last-sync-at', '2026-05-21T12:30:00.000Z');
  });

  it('still flushes queued mutations when delta fetch returns a server error', async () => {
    const taskHandler = mocks.getTaskHandler();

    mocks.asyncGetItem.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue(new Response('', { status: 503 }));

    await expect(taskHandler?.()).resolves.toBe('new-data');

    expect(mocks.flush).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/sync/delta',
      { headers: { Authorization: 'Bearer token-1' } },
    );
    expect(mocks.asyncSetItem).not.toHaveBeenCalled();
  });
});
