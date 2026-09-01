import React from 'react';
import {
  View,
  ScrollView,
  RefreshControl,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing } from '../../theme';

export interface ScreenProps {
  /** Render the body inside a ScrollView. Default true. */
  scroll?: boolean;
  /** Pull-to-refresh state. Only wired when `onRefresh` is given. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Horizontal page gutter. Default true (spacing.lg). */
  padded?: boolean;
  /**
   * Pad for the top notch. Default false — screens sit under NavHeader,
   * which already owns `insets.top`. Set for screens rendered without one.
   */
  topInset?: boolean;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

export default function Screen({
  scroll = true,
  refreshing = false,
  onRefresh,
  padded = true,
  topInset = false,
  style,
  contentContainerStyle,
  children,
}: ScreenProps): JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);

  const inner: StyleProp<ViewStyle> = [
    padded && styles.padded,
    { paddingTop: topInset ? insets.top : 0, paddingBottom: insets.bottom + spacing.xl },
    contentContainerStyle,
  ];

  if (!scroll) {
    return <View style={[styles.root, inner, style]}>{children}</View>;
  }

  return (
    <ScrollView
      style={[styles.root, style]}
      contentContainerStyle={inner}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh
          ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
          : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  padded: { paddingHorizontal: spacing.lg },
});
