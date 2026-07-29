import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CheckSquare, UserPlus, Briefcase, UserCog } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../hooks/useTheme';
import { useUserStore } from '../store/userStore';
import { ThemeColors } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function CreateSheet({ visible, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const navigate = (path: string): void => {
    onClose();
    router.push(path as never);
  };

  // Adding a person is owner/admin only — the same gate the team screen applies
  // to its own button. Offering it to a member or viewer would put them one tap
  // from a screen that refuses them, which reads as a broken app rather than a
  // permission boundary.
  const role = useUserStore((s) => s.user?.role);
  const canManageTeam = role === 'owner' || role === 'admin';

  const options = [
    { label: t('tasks.add'), Icon: CheckSquare, path: '/task/new' },
    { label: t('contacts.add'), Icon: UserPlus, path: '/contact/new' },
    { label: t('deals.add'), Icon: Briefcase, path: '/deal/new' },
    // `?add=1` opens the add-employee form straight away. Without it this is a
    // shortcut to a screen where you still have to find the button, which is the
    // discoverability problem it exists to solve.
    ...(canManageTeam
      ? [{ label: t('team.addMember'), Icon: UserCog, path: '/settings/team?add=1' }]
      : []),
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.handle} />
        <Text style={styles.heading}>{t('common.create')}</Text>
        {options.map(({ label, Icon, path }) => (
          <TouchableOpacity
            key={path}
            style={styles.option}
            onPress={() => navigate(path)}
            activeOpacity={0.7}
          >
            <View style={styles.optionIcon}>
              <Icon size={20} color={colors.orange} strokeWidth={2.2} />
            </View>
            <Text style={styles.optionLabel}>{label}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.cancelRow} onPress={onClose} activeOpacity={0.7}>
          <Text style={styles.cancelLabel}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
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
    marginBottom: 16,
  },
  heading: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text1,
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
  },
  cancelRow: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  cancelLabel: {
    fontSize: 16,
    color: c.textMuted,
    fontWeight: '500',
  },
});
