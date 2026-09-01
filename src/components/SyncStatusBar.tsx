import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSyncStore, SyncStatus } from '../store/syncStore';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, type } from '../theme';

export default function SyncStatusBar(): JSX.Element | null {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const status = useSyncStore((s) => s.status);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const TEXT: Record<SyncStatus, string> = {
    syncing: t('sync.syncing'),
    synced: t('sync.synced'),
  };

  // Semantic, not decorative: syncing is a state still in flight (warning),
  // synced is a settled good state (success) — same two roles the rest of the
  // app maps to these tokens. Legible against onAccent text in both themes.
  const syncBg: Record<SyncStatus, string> = {
    syncing: colors.warning,
    synced: colors.success,
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
    <Animated.View pointerEvents="none" style={[styles.bar, { top: insets.top, backgroundColor: syncBg[status], opacity }]}>
      <Text style={styles.text}>{TEXT[status]}</Text>
    </Animated.View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 100,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    ...type.label,
    color: c.onAccent,
  },
});
