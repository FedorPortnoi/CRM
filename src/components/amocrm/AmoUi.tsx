import React, { type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ThemeColors } from '../../theme';

export function AmoSectionCard({
  colors,
  title,
  subtitle,
  children,
}: {
  colors: ThemeColors;
  title: string;
  subtitle?: string;
  children: ReactNode;
}): JSX.Element {
  const styles = makeStyles(colors);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

export function AmoMetric({
  colors,
  label,
  value,
  danger = false,
}: {
  colors: ThemeColors;
  label: string;
  value: string | number;
  danger?: boolean;
}): JSX.Element {
  const styles = makeStyles(colors);
  return (
    <View style={[styles.metric, danger && styles.metricDanger]}>
      <Text style={[styles.metricValue, danger && styles.dangerText]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

export function AmoButton({
  colors,
  label,
  onPress,
  busy = false,
  disabled = false,
  secondary = false,
}: {
  colors: ThemeColors;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  secondary?: boolean;
}): JSX.Element {
  const styles = makeStyles(colors);
  const unavailable = disabled || busy;
  return (
    <TouchableOpacity
      style={[
        styles.button,
        secondary ? styles.buttonSecondary : styles.buttonPrimary,
        unavailable && styles.disabled,
      ]}
      onPress={onPress}
      disabled={unavailable}
      accessibilityRole="button"
      accessibilityState={{ disabled: unavailable, busy }}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? colors.orange : '#FFFFFF'} size="small" />
      ) : (
        <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

export function AmoNotice({
  colors,
  children,
  tone = 'neutral',
}: {
  colors: ThemeColors;
  children: ReactNode;
  tone?: 'neutral' | 'warning' | 'error' | 'success';
}): JSX.Element {
  const styles = makeStyles(colors);
  return (
    <View
      style={[
        styles.notice,
        tone === 'warning' && styles.noticeWarning,
        tone === 'error' && styles.noticeError,
        tone === 'success' && styles.noticeSuccess,
      ]}
    >
      <Text style={[styles.noticeText, tone === 'error' && styles.dangerText]}>{children}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.bgPanel,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 4,
    },
    title: { color: c.text1, fontSize: 17, fontWeight: '700' },
    subtitle: { color: c.textMuted, fontSize: 13, lineHeight: 18 },
    body: { marginTop: 10, gap: 10 },
    metric: {
      flex: 1,
      minWidth: 88,
      backgroundColor: c.bg,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 9,
      borderWidth: 1,
      borderColor: c.border,
    },
    metricDanger: { borderColor: c.red },
    metricValue: { color: c.text1, fontSize: 18, fontWeight: '700' },
    metricLabel: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    dangerText: { color: c.red },
    button: {
      minHeight: 46,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      borderWidth: 1,
    },
    buttonPrimary: { backgroundColor: c.orange, borderColor: c.orange },
    buttonSecondary: { backgroundColor: 'transparent', borderColor: c.orange },
    buttonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', textAlign: 'center' },
    buttonSecondaryText: { color: c.orange },
    disabled: { opacity: 0.55 },
    notice: {
      borderRadius: 10,
      padding: 11,
      backgroundColor: c.skeleton,
      borderWidth: 1,
      borderColor: c.border,
    },
    noticeWarning: { borderColor: c.orange },
    noticeError: { borderColor: c.red },
    noticeSuccess: { borderColor: c.orange },
    noticeText: { color: c.text1, fontSize: 13, lineHeight: 18 },
  });
