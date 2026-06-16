import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus } from 'lucide-react-native';
import CreateSheet from './CreateSheet';

const ACCENT = '#C45A10';
const DARK = '#2B2724';

const TAB_PATHS = new Set([
  '/', '/contacts', '/kanban', '/tasks',
  '/chat', '/notifications', '/calendar', '/settings',
]);

type HeaderRight = ((props: { tintColor?: string; canGoBack: boolean }) => React.ReactNode) | undefined;

interface NavHeaderProps {
  title?: string;
  headerRight?: HeaderRight;
}

export default function NavHeader({ title, headerRight }: NavHeaderProps): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);

  const isTabScreen = TAB_PATHS.has(pathname);

  return (
    <View style={[styles.headerWrap, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        {isTabScreen ? (
          <TouchableOpacity
            onPress={() => setSheetOpen(true)}
            style={styles.leftBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.create')}
            hitSlop={8}
          >
            <Plus size={26} color={ACCENT} strokeWidth={2.4} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => router.canGoBack() ? router.back() : router.replace('/' as never)}
            style={styles.leftBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            hitSlop={8}
          >
            <ArrowLeft size={26} color="#EDE5DF" strokeWidth={2.4} />
          </TouchableOpacity>
        )}
        <Text style={styles.title} numberOfLines={1}>{title ?? ''}</Text>
        <View style={styles.right}>
          {headerRight ? headerRight({ tintColor: ACCENT, canGoBack: false }) : null}
        </View>
      </View>

      <CreateSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    backgroundColor: DARK,
    borderBottomWidth: 1,
    borderBottomColor: '#3D3330',
  },
  headerRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  leftBtn: { padding: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#EDE5DF', marginLeft: 4, flex: 1 },
  right: { flexDirection: 'row', alignItems: 'center' },
});
