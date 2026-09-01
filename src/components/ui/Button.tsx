import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  StyleProp,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Swaps the label for a spinner without changing the button's width. */
  loading?: boolean;
  disabled?: boolean;
  /** Leading icon, e.g. a lucide-react-native node. */
  icon?: React.ReactNode;
  /** Stretch to the container width. */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/**
 * Control heights. The token scale covers spacing, radius and type but not
 * control heights; 52 / 36 are the sizes the app already uses for its
 * primary buttons and chips.
 */
const HEIGHT: Record<ButtonSize, number> = { md: 52, sm: 36 };

export default function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  block = false,
  style,
  accessibilityLabel,
}: ButtonProps): JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const isInert = disabled || loading;

  const container: StyleProp<ViewStyle> = [
    styles.base,
    { minHeight: HEIGHT[size] },
    size === 'sm' ? styles.padSm : styles.padMd,
    styles[variant],
    block && styles.block,
    disabled && styles.disabled,
    style,
  ];

  const label: StyleProp<TextStyle> = [
    size === 'sm' ? styles.labelSm : styles.labelMd,
    styles[`${variant}Label` as const],
  ];

  const spinnerColor =
    variant === 'primary' || variant === 'danger' ? colors.onAccent : colors.accent;

  return (
    <TouchableOpacity
      style={container}
      onPress={onPress}
      disabled={isInert}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: isInert, busy: loading }}
    >
      {/* Kept mounted while loading so the button holds its intrinsic width. */}
      <View style={[styles.content, loading && styles.contentHidden]}>
        {icon}
        <Text style={label} numberOfLines={1}>{title}</Text>
      </View>
      {loading ? (
        <View style={styles.spinner} pointerEvents="none">
          <ActivityIndicator size="small" color={spinnerColor} />
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  base: {
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  block: { alignSelf: 'stretch' },
  padMd: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  padSm: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  content: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  contentHidden: { opacity: 0 },
  spinner: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.5 },

  primary:   { backgroundColor: c.accent },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.borderStrong },
  ghost:     { backgroundColor: 'transparent' },
  danger:    { backgroundColor: c.danger },

  primaryLabel:   { color: c.onAccent },
  secondaryLabel: { color: c.text1 },
  ghostLabel:     { color: c.accent },
  dangerLabel:    { color: c.onAccent },

  labelMd: { ...type.heading },
  labelSm: { ...type.label },
});
