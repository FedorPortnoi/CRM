import { useEffect, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as offlineQueue from './offlineQueue';
import { useSyncStore } from '../store/syncStore';
// Piggybacking on this module's existing side-effect-import wiring in
// src/app/_layout.tsx rather than adding a line there directly, since that
// file has unrelated work in flight. Move this to _layout.tsx once that
// settles — there's nothing network-specific about it, this is just the
// first already-wired-at-startup file that wasn't also mid-edit.
import { initRemoteLogger } from './remoteLogger';

initRemoteLogger();

let previouslyOnline: boolean | null = null;

// Reset to synced on module load (clears any stale offline state from previous session)
useSyncStore.getState().setSynced();

NetInfo.addEventListener((state: NetInfoState) => {
  const isOnline: boolean = state.isConnected !== false;
  const { setSyncing, setSynced } = useSyncStore.getState();

  if (previouslyOnline === false && isOnline === true) {
    setSyncing();
    void offlineQueue.flush().then(setSynced, setSynced);
  }

  previouslyOnline = isOnline;
});

type NetworkStatus = {
  isOnline: boolean;
  isOffline: boolean;
};

export function useNetworkStatus(): NetworkStatus {
  const [isOnline, setIsOnline] = useState<boolean>(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const nextIsOnline = state.isConnected !== false;
      setIsOnline(nextIsOnline);
    });

    return unsubscribe;
  }, []);

  return {
    isOnline,
    isOffline: !isOnline,
  };
}
