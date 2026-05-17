// Wire up: import and render <ConflictToast /> in src/app/_layout.tsx
// (done after onboarding wiring — do not add here)
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSyncStore } from '../store/syncStore';

export function ConflictToast(): JSX.Element | null {
  const conflicts = useSyncStore((s) => s.conflicts);
  const clearConflicts = useSyncStore((s) => s.clearConflicts);
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (conflicts.length === 0) {
      opacity.setValue(0);
      return;
    }

    Animated.timing(opacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();

    timerRef.current = setTimeout(() => {
      clearConflicts();
    }, 4000);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [conflicts.length, clearConflicts, opacity]);

  if (conflicts.length === 0) return null;

  const label =
    conflicts.length === 1
      ? '1 item updated by server during sync'
      : `${conflicts.length} items updated by server during sync`;

  return (
    <Animated.View style={[styles.container, { opacity }]}>
      <View style={styles.row}>
        <Text style={styles.text}>{label}</Text>
        <TouchableOpacity onPress={clearConflicts} style={styles.dismiss}>
          <Text style={styles.dismissText}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
    backgroundColor: '#F9AB00',
    borderRadius: 8,
    padding: 12,
    zIndex: 9999,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  dismiss: {
    marginLeft: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dismissText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
