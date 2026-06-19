import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSyncStore, SyncStatus } from '../store/syncStore';

type Config = {
  bg: string;
  autoHide: boolean;
};

const STYLE_CONFIG: Record<SyncStatus, Config> = {
  syncing: { bg: '#F9AB00', autoHide: false },
  synced: { bg: '#C4704F', autoHide: true },
};

export default function SyncStatusBar(): JSX.Element | null {
  const { t } = useTranslation();
  const status = useSyncStore((s) => s.status);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const TEXT: Record<SyncStatus, string> = {
    syncing: t('sync.syncing'),
    synced: t('sync.synced'),
  };

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

  const config = STYLE_CONFIG[status];

  return (
    <Animated.View style={[styles.bar, { backgroundColor: config.bg, opacity }]}>
      <Text style={styles.text}>{TEXT[status]}</Text>
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
