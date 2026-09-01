import React, { useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, Users, Kanban, MoreHorizontal } from 'lucide-react-native';
import { useChatStore } from '../store/chatStore';
import { useNotificationStore } from '../store/notificationStore';
import MoreSheet from './MoreSheet';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../theme';

const MORE_PATHS = new Set([
  '/tasks', '/chat', '/notifications', '/calendar', '/settings', '/reports', '/nearby',
]);

export default function BottomTabBar(): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const chatUnread = useChatStore((s) => s.channels.reduce((sum, c) => sum + c.unread, 0));
  const notifUnread = useNotificationStore((s) => s.unreadCount);
  const moreBadge = chatUnread + notifUnread;

  const tabs = [
    { path: '/', label: t('tabs.today'), Icon: CalendarCheck },
    { path: '/contacts', label: t('tabs.contacts'), Icon: Users },
    { path: '/kanban', label: t('tabs.pipeline'), Icon: Kanban },
  ] as const;

  const isMoreActive = MORE_PATHS.has(pathname);

  return (
    <>
      <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
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
                <Icon size={24} color={active ? colors.accent : colors.textMuted} strokeWidth={2.6} />
                <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity
            style={styles.tab}
            onPress={() => setMoreOpen(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <View>
              <MoreHorizontal size={24} color={isMoreActive ? colors.accent : colors.textMuted} strokeWidth={2.6} />
              {moreBadge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{moreBadge > 99 ? '99+' : moreBadge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, isMoreActive && styles.labelActive]}>{t('tabs.more')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <MoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        chatUnread={chatUnread}
        notifUnread={notifUnread}
      />
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: c.bgDark,
    borderTopWidth: 1,
    borderTopColor: c.border,
    shadowColor: '#000', // fixed: shadows read dark in both themes
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  bar: {
    flexDirection: 'row',
    paddingTop: spacing.sm,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingBottom: spacing.xs,
  },
  label: {
    ...type.micro,
    color: c.textMuted,
  },
  labelActive: {
    color: c.accent,
    fontWeight: '700',
  },
  badge: {
    position: 'absolute',
    top: -spacing.xs,
    right: -spacing.sm,
    minWidth: 18,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: c.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  badgeText: {
    ...type.micro,
    color: c.onAccent,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
