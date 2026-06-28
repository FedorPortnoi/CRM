import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus } from 'lucide-react-native';
import CreateSheet from './CreateSheet';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

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
  const { colors } = useTheme();
  const styles = makeStyles(colors);

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
            <Plus size={26} color={colors.orange} strokeWidth={2.4} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => router.canGoBack() ? router.back() : router.replace('/' as never)}
            style={styles.leftBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            hitSlop={8}
          >
            <ArrowLeft size={26} color={colors.text1} strokeWidth={2.4} />
          </TouchableOpacity>
        )}
        <Text style={styles.title} numberOfLines={1}>{title ?? ''}</Text>
        <View style={styles.right}>
          {headerRight ? headerRight({ tintColor: colors.orange, canGoBack: false }) : null}
        </View>
      </View>

      <CreateSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  headerWrap: {
    backgroundColor: c.bgDark,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  leftBtn: { padding: 8 },
  title: { fontSize: 18, fontWeight: '700', color: c.text1, marginLeft: 4, flex: 1 },
  right: { flexDirection: 'row', alignItems: 'center' },
});
