import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CheckSquare, MessageSquare, Bell, Calendar, Settings } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = '#C45A10';
const DARK = '#2B2724';

interface Props {
  visible: boolean;
  onClose: () => void;
  chatUnread: number;
  notifUnread: number;
}

export default function MoreSheet({ visible, onClose, chatUnread, notifUnread }: Props): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const navigate = (path: string): void => {
    onClose();
    router.replace(path as never);
  };

  const items = [
    { label: t('tabs.tasks'), Icon: CheckSquare, path: '/tasks', badge: 0 },
    { label: t('tabs.chat'), Icon: MessageSquare, path: '/chat', badge: chatUnread },
    { label: t('tabs.notifications'), Icon: Bell, path: '/notifications', badge: notifUnread },
    { label: t('tabs.calendar'), Icon: Calendar, path: '/calendar', badge: 0 },
    { label: t('tabs.settings'), Icon: Settings, path: '/settings', badge: 0 },
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
          {items.map(({ label, Icon, path, badge }) => (
            <TouchableOpacity
              key={path}
              style={styles.option}
              onPress={() => navigate(path)}
              activeOpacity={0.7}
            >
              <View style={styles.optionIcon}>
                <Icon size={20} color={ACCENT} strokeWidth={2.2} />
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

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
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
    backgroundColor: '#D1C4B8',
    marginBottom: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0E8E2',
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#FEF0E8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLabel: {
    fontSize: 16,
    color: DARK,
    fontWeight: '500',
    flex: 1,
  },
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
