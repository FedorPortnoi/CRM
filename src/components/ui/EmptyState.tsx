import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, type } from '../../theme';
import Button from './Button';

export interface EmptyStateProps {
  /** Illustrative icon, e.g. a lucide-react-native node. */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** Optional call to action, rendered as a primary Button. */
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

export default function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  style,
}: EmptyStateProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <View style={[styles.wrap, style]}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {actionLabel && onAction ? (
        <Button title={actionLabel} onPress={onAction} style={styles.action} />
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrap: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  icon: { marginBottom: spacing.md },
  title: { ...type.heading, color: c.text1, textAlign: 'center' },
  description: {
    ...type.body,
    color: c.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  action: { marginTop: spacing.lg },
});
