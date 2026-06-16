import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  Menu, ArrowLeft, LayoutDashboard, Users, Kanban, CheckSquare,
  MessageSquare, Bell, Calendar, Settings,
} from 'lucide-react-native';
import { useChatStore } from '../store/chatStore';
import { useNotificationStore } from '../store/notificationStore';

const ACCENT = '#C45A10';
const DARK = '#2B2724';

type HeaderRight = ((props: { tintColor?: string; canGoBack: boolean }) => React.ReactNode) | undefined;

interface NavHeaderProps {
  title?: string;
  headerRight?: HeaderRight;
}

export default function NavHeader({ title, headerRight }: NavHeaderProps): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isHome = pathname === '/';

  const chatUnread = useChatStore((s) => s.channels.reduce((sum, c) => sum + c.unread, 0));
  const notifUnread = useNotificationStore((s) => s.unreadCount);

  const items = [
    { key: 'index', label: t('tabs.today'), path: '/', Icon: LayoutDashboard, badge: 0 },
    { key: 'contacts', label: t('tabs.contacts'), path: '/contacts', Icon: Users, badge: 0 },
    { key: 'kanban', label: t('tabs.pipeline'), path: '/kanban', Icon: Kanban, badge: 0 },
    { key: 'tasks', label: t('tabs.tasks'), path: '/tasks', Icon: CheckSquare, badge: 0 },
    { key: 'chat', label: t('tabs.chat'), path: '/chat', Icon: MessageSquare, badge: chatUnread },
    { key: 'notifications', label: t('tabs.notifications'), path: '/notifications', Icon: Bell, badge: notifUnread },
    { key: 'calendar', label: t('tabs.calendar'), path: '/calendar', Icon: Calendar, badge: 0 },
    { key: 'settings', label: t('tabs.settings'), path: '/settings', Icon: Settings, badge: 0 },
  ] as const;

  const go = (path: string): void => {
    setOpen(false);
    if (pathname !== path) {
      router.replace(path as never);
    }
  };

  return (
    <View style={[styles.headerWrap, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        {isHome ? (
          <TouchableOpacity
            onPress={() => setOpen(true)}
            style={styles.menuBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.menu')}
            hitSlop={8}
          >
            <Menu size={26} color={DARK} strokeWidth={2.4} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => router.canGoBack() ? router.back() : router.replace('/' as never)}
            style={styles.menuBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            hitSlop={8}
          >
            <ArrowLeft size={26} color={DARK} strokeWidth={2.4} />
          </TouchableOpacity>
        )}
        <Text style={styles.title} numberOfLines={1}>{title ?? ''}</Text>
        <View style={styles.right}>{headerRight ? headerRight({ tintColor: ACCENT, canGoBack: false }) : null}</View>
      </View>

      <Modal visible={open && isHome} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={[styles.panel, { top: insets.top + 52 }]}>
          {items.map((it) => {
            const active = pathname === it.path;
            const Icon = it.Icon;
            return (
              <TouchableOpacity
                key={it.key}
                style={[styles.menuItem, active && styles.menuItemActive]}
                onPress={() => go(it.path)}
                activeOpacity={0.7}
              >
                <Icon size={22} color={active ? ACCENT : DARK} strokeWidth={2.2} />
                <Text style={[styles.menuLabel, active && styles.menuLabelActive]}>{it.label}</Text>
                {it.badge > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{it.badge > 99 ? '99+' : it.badge}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  headerRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  menuBtn: { padding: 8 },
  title: { fontSize: 18, fontWeight: '700', color: DARK, marginLeft: 4, flex: 1 },
  right: { flexDirection: 'row', alignItems: 'center' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  panel: {
    position: 'absolute',
    left: 8,
    width: 248,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 12,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 14,
  },
  menuItemActive: { backgroundColor: '#FEF0E8' },
  menuLabel: { fontSize: 16, color: DARK, fontWeight: '500', flex: 1 },
  menuLabelActive: { color: ACCENT, fontWeight: '700' },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E5484D',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
