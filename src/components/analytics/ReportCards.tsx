// Shared building blocks for the report screens: panel cards, stat tiles, metric rows and the
// loading / error / empty states. Same visual language as the dashboard cards.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BarChart3 } from 'lucide-react-native';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Card, EmptyState, Skeleton } from '../ui';

export type ReportTone = 'default' | 'positive' | 'negative' | 'warning';

function toneColor(tone: ReportTone, c: ThemeColors): string {
  if (tone === 'positive') return c.success;
  if (tone === 'negative') return c.danger;
  if (tone === 'warning') return c.warning;
  return c.text1;
}

interface ReportCardProps {
  title?: string;
  hint?: string;
  children: React.ReactNode;
}

export function ReportCard({ title, hint, children }: ReportCardProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <Card style={s.card}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {hint ? <Text style={s.cardHint}>{hint}</Text> : null}
      {children}
    </Card>
  );
}

interface StatGridProps {
  children: React.ReactNode;
}

export function StatGrid({ children }: StatGridProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return <View style={s.statGrid}>{children}</View>;
}

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  tone?: ReportTone;
}

export function StatTile({ label, value, sub, tone = 'default' }: StatTileProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.statTile}>
      <Text style={s.statLabel} numberOfLines={2}>{label}</Text>
      <Text style={[s.statValue, { color: toneColor(tone, colors) }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={s.statSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

interface MetricRowProps {
  label: string;
  value: string;
  tone?: ReportTone;
}

export function MetricRow({ label, value, tone = 'default' }: MetricRowProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.metricRow}>
      <Text style={s.metricLabel} numberOfLines={2}>{label}</Text>
      <Text style={[s.metricValue, { color: toneColor(tone, colors) }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

interface ShareBarProps {
  /** 0..1 */
  fraction: number;
  color: string;
}

/** Thin horizontal bar used by the share lists (loss reasons, sources, per-rep revenue). */
export function ShareBar({ fraction, color }: ShareBarProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
  return (
    <View style={s.shareTrack}>
      <View style={[s.shareFill, { width: `${percent}%`, backgroundColor: color }]} />
    </View>
  );
}

export type LegendItem = { key: string; label: string; color: string };

interface ChartLegendProps {
  items: LegendItem[];
}

export function ChartLegend({ items }: ChartLegendProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.legend}>
      {items.map((item) => (
        <View key={item.key} style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: item.color }]} />
          <Text style={s.legendLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

interface ReportNoteProps {
  text: string;
}

export function ReportNote({ text }: ReportNoteProps): JSX.Element {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  return <Text style={s.note}>{text}</Text>;
}

export function ReportLoading(): JSX.Element {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const s = makeStyles(colors);
  return (
    <View style={s.stateWrap} accessibilityRole="progressbar" accessibilityLabel={t('reports.loading')}>
      <View style={s.tileSkeletonRow}>
        <View style={s.tileSkeletonItem}><Skeleton height={76} rounded={radius.lg} /></View>
        <View style={s.tileSkeletonItem}><Skeleton height={76} rounded={radius.lg} /></View>
        <View style={s.tileSkeletonItem}><Skeleton height={76} rounded={radius.lg} /></View>
      </View>
      <Skeleton height={150} rounded={radius.lg} />
      <Skeleton height={56} rounded={radius.lg} />
      <Skeleton height={56} rounded={radius.lg} />
    </View>
  );
}

interface ReportErrorProps {
  onRetry: () => void;
}

export function ReportError({ onRetry }: ReportErrorProps): JSX.Element {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<AlertCircle size={28} color={colors.danger} />}
      title={t('reports.failedToLoad')}
      actionLabel={t('common.retry')}
      onAction={onRetry}
    />
  );
}

interface ReportEmptyProps {
  text?: string;
}

export function ReportEmpty({ text }: ReportEmptyProps): JSX.Element {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<BarChart3 size={28} color={colors.textMuted} />}
      title={text ?? t('reports.empty')}
    />
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  card: {
    marginBottom: spacing.md,
  },
  cardTitle: {
    ...type.label,
    color: c.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  cardHint: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.sm,
    lineHeight: 17,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  statTile: {
    flexGrow: 1,
    flexBasis: '30%',
    minWidth: 100,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  statLabel: {
    ...type.micro,
    color: c.textMuted,
    marginBottom: spacing.sm,
  },
  statValue: {
    ...type.subtitle,
    fontVariant: ['tabular-nums'],
  },
  statSub: {
    ...type.micro,
    color: c.textMuted,
    marginTop: spacing.xs,
    fontVariant: ['tabular-nums'],
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs + 1,
  },
  metricLabel: {
    flex: 1,
    ...type.label,
    color: c.textMuted,
  },
  metricValue: {
    ...type.body,
    fontWeight: '600',
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
  shareTrack: {
    height: 6,
    borderRadius: radius.sm,
    backgroundColor: c.skeleton,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  shareFill: {
    height: 6,
    borderRadius: radius.sm,
  },
  note: {
    ...type.micro,
    color: c.textMuted,
    lineHeight: 16,
    marginTop: spacing.sm,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: radius.sm,
  },
  legendLabel: {
    ...type.micro,
    color: c.textMuted,
  },
  stateWrap: {
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  tileSkeletonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  tileSkeletonItem: {
    flex: 1,
  },
});
