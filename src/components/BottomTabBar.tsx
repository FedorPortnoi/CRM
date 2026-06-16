import React, { useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, Users, Kanban, Plus } from 'lucide-react-native';
import CreateSheet from './CreateSheet';

const ACCENT = '#C45A10';
const MUTED = '#9C8677';

export default function BottomTabBar(): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);

  const tabs = [
    { path: '/', label: t('tabs.today'), Icon: CalendarCheck },
    { path: '/contacts', label: t('tabs.contacts'), Icon: Users },
    { path: '/kanban', label: t('tabs.pipeline'), Icon: Kanban },
  ] as const;

  return (
    <>
      <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setSheetOpen(true)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('common.create')}
        >
          <Plus size={24} color="#FFFFFF" strokeWidth={2.5} />
        </TouchableOpacity>

        <View style={styles.bar}>
          {tabs.map(({ path, label, Icon }) => {
            const active = pathname === path;
            return (
              <TouchableOpacity
                key={path}
                style={styles.tab}
                onPress={() => router.replace(path as never)}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <Icon size={24} color={active ? ACCENT : MUTED} strokeWidth={2.2} />
                <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <CreateSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E8DDD6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 8,
  },
  fab: {
    position: 'absolute',
    right: 20,
    top: -22,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 12,
    zIndex: 10,
  },
  bar: {
    flexDirection: 'row',
    paddingTop: 10,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingBottom: 4,
  },
  label: {
    fontSize: 11,
    color: MUTED,
    fontWeight: '500',
  },
  labelActive: {
    color: ACCENT,
    fontWeight: '700',
  },
});
