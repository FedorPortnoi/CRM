import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

export interface ActionMenuOption {
  label: string;
  icon?: React.ReactNode;
  onPress: () => void;
  destructive?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: ActionMenuOption[];
}

export default function ActionMenuSheet({ visible, onClose, title, options }: Props): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const handleSelect = (option: ActionMenuOption): void => {
    option.onPress();
    onClose();
  };

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
        <Text style={styles.heading}>{title}</Text>
        {options.map((option) => (
          <TouchableOpacity
            key={option.label}
            style={styles.option}
            onPress={() => handleSelect(option)}
            activeOpacity={0.7}
          >
            {option.icon ? <View style={styles.optionIcon}>{option.icon}</View> : null}
            <Text
              style={[styles.optionLabel, option.destructive ? styles.optionLabelDestructive : null]}
            >
              {option.label}
            </Text>
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
    flex: 1,
  },
  optionLabelDestructive: {
    color: c.red,
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
