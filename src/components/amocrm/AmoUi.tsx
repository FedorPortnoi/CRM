import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../../theme';
import { spacing, radius, type, tabular } from '../../theme';
import { Card, Button } from '../ui';

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
    <Card style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <View style={styles.body}>{children}</View>
    </Card>
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
      <Text style={[styles.metricValue, tabular, danger && styles.dangerText]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

// `colors` stays in the signature so every call site keeps working unchanged —
// the primitive underneath pulls its own theme via useTheme().
export function AmoButton({
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
  return (
    <Button
      title={label}
      onPress={onPress}
      loading={busy}
      disabled={disabled}
      variant={secondary ? 'secondary' : 'primary'}
      block
    />
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
    card: { gap: spacing.xs },
    title: { ...type.subtitle, color: c.text1 },
    subtitle: { color: c.textMuted, fontSize: 13, lineHeight: 18 },
    body: { marginTop: spacing.sm, gap: spacing.sm },
    metric: {
      flex: 1,
      minWidth: 88,
      backgroundColor: c.bg,
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    metricDanger: { borderColor: c.danger },
    metricValue: { ...type.heading, color: c.text1 },
    metricLabel: { color: c.textMuted, fontSize: 11, marginTop: spacing.xs },
    dangerText: { color: c.danger },
    notice: {
      borderRadius: radius.md,
      padding: spacing.md,
      backgroundColor: c.neutralSoft,
      borderWidth: 1,
      borderColor: c.border,
    },
    noticeWarning: { backgroundColor: c.warningSoft, borderColor: c.warning },
    noticeError: { backgroundColor: c.dangerSoft, borderColor: c.danger },
    noticeSuccess: { backgroundColor: c.successSoft, borderColor: c.success },
    noticeText: { color: c.text1, fontSize: 13, lineHeight: 18 },
  });
