import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  style?: StyleProp<ViewStyle>;
}

export default function Badge({ label, variant = 'neutral', style }: BadgeProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <View style={[styles.pill, styles[variant], style]}>
      <Text style={[styles.label, styles[`${variant}Label` as const]]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  label: { ...type.micro },

  neutral: { backgroundColor: c.skeleton },
  accent:  { backgroundColor: c.accentSoft },
  success: { backgroundColor: c.successSoft },
  danger:  { backgroundColor: c.dangerSoft },
  warning: { backgroundColor: c.warningSoft },

  neutralLabel: { color: c.textMuted },
  accentLabel:  { color: c.accent },
  successLabel: { color: c.success },
  dangerLabel:  { color: c.danger },
  warningLabel: { color: c.warning },
});
