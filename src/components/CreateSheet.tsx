import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CheckSquare, UserPlus, Briefcase } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../hooks/useTheme';
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

  const options = [
    { label: t('tasks.add'), Icon: CheckSquare, path: '/task/new' },
    { label: t('contacts.add'), Icon: UserPlus, path: '/contact/new' },
    { label: t('deals.add'), Icon: Briefcase, path: '/deal/new' },
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
    backgroundColor: '#D1C4B8',
    marginBottom: 16,
  },
  heading: {
    fontSize: 16,
    fontWeight: '700',
    color: c.bgDark,
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
    backgroundColor: 'rgba(204,120,92,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLabel: {
    fontSize: 16,
    color: c.bgDark,
    fontWeight: '500',
  },
  cancelRow: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  cancelLabel: {
    fontSize: 16,
    color: '#9C8677',
    fontWeight: '500',
  },
});
