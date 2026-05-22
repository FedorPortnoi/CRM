import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  flush: vi.fn(),
  setOffline: vi.fn(),
  setSyncing: vi.fn(),
  setSynced: vi.fn(),
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: mocks.addEventListener,
  },
}));

vi.mock('../../../src/utils/offlineQueue', () => ({
  flush: mocks.flush,
}));

vi.mock('../../../src/store/syncStore', () => ({
  useSyncStore: {
    getState: () => ({
      setOffline: mocks.setOffline,
      setSyncing: mocks.setSyncing,
      setSynced: mocks.setSynced,
    }),
  },
}));

describe('network listener', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('marks sync complete even when flushing the offline queue fails', async () => {
    const listenerRef: {
      current: ((state: { isConnected: boolean; isInternetReachable: boolean | null }) => void) | null;
    } = { current: null };
    mocks.addEventListener.mockImplementation((callback) => {
      listenerRef.current = callback;
      return vi.fn();
    });
    mocks.flush.mockRejectedValueOnce(new Error('flush failed'));

    await import('../../../src/utils/network');

    const listener = listenerRef.current as NonNullable<typeof listenerRef.current>;
    listener({ isConnected: false, isInternetReachable: false });
    listener({ isConnected: true, isInternetReachable: true });

    expect(mocks.setSyncing).toHaveBeenCalledTimes(1);
    expect(mocks.flush).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.setSynced).toHaveBeenCalledTimes(1));
  });
});
