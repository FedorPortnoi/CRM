import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useSyncStore, SyncStatus } from '../store/syncStore';

type Config = {
  bg: string;
  text: string;
  autoHide: boolean;
};

const CONFIG: Record<SyncStatus, Config> = {
  offline: { bg: '#ef4444', text: 'No internet connection', autoHide: false },
  syncing: { bg: '#F9AB00', text: 'Syncing...', autoHide: false },
  synced: { bg: '#10b981', text: 'All synced', autoHide: true },
};

export default function SyncStatusBar(): JSX.Element | null {
  const status = useSyncStore((s) => s.status);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);

    if (status === 'synced') {
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();
      }, 2000);
    } else {
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    }

    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [status, opacity]);

  const config = CONFIG[status];

  return (
    <Animated.View style={[styles.bar, { backgroundColor: config.bg, opacity }]}>
      <Text style={styles.text}>{config.text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
