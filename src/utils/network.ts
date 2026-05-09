import { useEffect, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as offlineQueue from './offlineQueue';

let previouslyOnline: boolean | null = null;

NetInfo.addEventListener((state: NetInfoState) => {
  const isOnline: boolean = state.isConnected === true && state.isInternetReachable !== false;

  if (previouslyOnline === false && isOnline === true) {
    void offlineQueue.flush();
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
      const nextIsOnline = state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(nextIsOnline);
    });

    return unsubscribe;
  }, []);

  return {
    isOnline,
    isOffline: !isOnline,
  };
}
