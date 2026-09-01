import React from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius } from '../../theme';

export interface CardProps {
  /** When given, the card becomes tappable. */
  onPress?: () => void;
  /** Inner padding. Default true (spacing.md). */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  children: React.ReactNode;
}

export default function Card({
  onPress,
  padded = true,
  style,
  accessibilityLabel,
  children,
}: CardProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const composed: StyleProp<ViewStyle> = [styles.card, padded && styles.padded, style];

  if (onPress) {
    return (
      <TouchableOpacity
        style={composed}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </TouchableOpacity>
    );
  }

  return <View style={composed} accessibilityLabel={accessibilityLabel}>{children}</View>;
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
  },
  padded: { padding: spacing.md },
});
