import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSyncStore, SyncStatus } from '../store/syncStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

export default function SyncStatusBar(): JSX.Element | null {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const status = useSyncStore((s) => s.status);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const TEXT: Record<SyncStatus, string> = {
    syncing: t('sync.syncing'),
    synced: t('sync.synced'),
  };

  const syncBg: Record<SyncStatus, string> = {
    syncing: '#F9AB00',
    synced: colors.orange,
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

  return (
    <Animated.View style={[styles.bar, { top: insets.top, backgroundColor: syncBg[status], opacity }]}>
      <Text style={styles.text}>{TEXT[status]}</Text>
    </Animated.View>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeStyles = (_c: ThemeColors) => StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 100,
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
