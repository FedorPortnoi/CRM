import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CheckSquare, MessageSquare, Bell, Calendar, Settings, BarChart3, MapPin } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  chatUnread: number;
  notifUnread: number;
}

export default function MoreSheet({ visible, onClose, chatUnread, notifUnread }: Props): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  // Tab screens swap the active tab (replace); sections that live outside the tab
  // navigator are pushed so the header's back arrow returns to where you were.
  const navigate = (path: string, push: boolean): void => {
    onClose();
    if (push) {
      router.push(path as never);
      return;
    }
    router.replace(path as never);
  };

  const items = [
    { label: t('tabs.tasks'), Icon: CheckSquare, path: '/tasks', badge: 0, push: false },
    { label: t('tabs.chat'), Icon: MessageSquare, path: '/chat', badge: chatUnread, push: false },
    { label: t('tabs.notifications'), Icon: Bell, path: '/notifications', badge: notifUnread, push: false },
    { label: t('tabs.calendar'), Icon: Calendar, path: '/calendar', badge: 0, push: false },
    { label: t('tabs.reports'), Icon: BarChart3, path: '/reports', badge: 0, push: true },
    { label: t('tabs.nearby'), Icon: MapPin, path: '/nearby', badge: 0, push: true },
    { label: t('tabs.settings'), Icon: Settings, path: '/settings', badge: 0, push: false },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.handle} />
          {items.map(({ label, Icon, path, badge, push }) => (
            <TouchableOpacity
              key={path}
              style={styles.option}
              onPress={() => navigate(path, push)}
              activeOpacity={0.7}
            >
              <View style={styles.optionIcon}>
                <Icon size={20} color={colors.orange} strokeWidth={2.2} />
              </View>
              <Text style={styles.optionLabel}>{label}</Text>
              {badge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
    marginBottom: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(204,120,92,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLabel: {
    fontSize: 16,
    color: c.text1,
    fontWeight: '500',
    flex: 1,
  },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: c.red,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
