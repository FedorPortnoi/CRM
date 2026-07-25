// Shared building blocks for the report screens: panel cards, stat tiles, metric rows and the
// loading / error / empty states. Same visual language as the dashboard cards.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

export type ReportTone = 'default' | 'positive' | 'negative' | 'warning';

function toneColor(tone: ReportTone, c: ThemeColors): string {
  if (tone === 'positive') return c.orange;
  if (tone === 'negative') return c.red;
  if (tone === 'warning') return c.amber;
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
    <View style={s.card}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {hint ? <Text style={s.cardHint}>{hint}</Text> : null}
      {children}
    </View>
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
        <View style={s.tileSkeleton} />
        <View style={s.tileSkeleton} />
        <View style={s.tileSkeleton} />
      </View>
      <View style={s.blockSkeleton} />
      <View style={s.rowSkeleton} />
      <View style={s.rowSkeleton} />
      <Text style={s.stateText}>{t('reports.loading')}</Text>
    </View>
  );
}

interface ReportErrorProps {
  onRetry: () => void;
}

export function ReportError({ onRetry }: ReportErrorProps): JSX.Element {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const s = makeStyles(colors);
  return (
    <View style={s.errorBox}>
      <Text style={s.errorText}>{t('reports.failedToLoad')}</Text>
      <TouchableOpacity style={s.retryButton} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>{t('common.retry')}</Text>
      </TouchableOpacity>
    </View>
  );
}

interface ReportEmptyProps {
  text?: string;
}

export function ReportEmpty({ text }: ReportEmptyProps): JSX.Element {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const s = makeStyles(colors);
  return (
    <View style={s.stateWrap}>
      <Text style={s.stateText}>{text ?? t('reports.empty')}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: c.amber,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  cardHint: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 6,
    lineHeight: 17,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12,
  },
  statTile: {
    flexGrow: 1,
    flexBasis: '30%',
    minWidth: 100,
    backgroundColor: c.bgPanel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  statLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.amber,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
  },
  statSub: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 3,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 7,
  },
  metricLabel: {
    flex: 1,
    fontSize: 13,
    color: c.textMuted,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 0,
  },
  shareTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.skeleton,
    overflow: 'hidden',
    marginTop: 6,
  },
  shareFill: {
    height: 6,
    borderRadius: 3,
  },
  note: {
    fontSize: 11,
    color: c.textMuted,
    lineHeight: 16,
    marginTop: 8,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginTop: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  legendLabel: {
    fontSize: 11,
    color: c.textMuted,
  },
  stateWrap: {
    paddingVertical: 12,
    gap: 10,
  },
  stateText: {
    fontSize: 13,
    color: c.textMuted,
    textAlign: 'center',
    paddingVertical: 8,
  },
  tileSkeletonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  tileSkeleton: {
    flex: 1,
    height: 76,
    borderRadius: 14,
    backgroundColor: c.skeleton,
  },
  blockSkeleton: {
    height: 150,
    borderRadius: 14,
    backgroundColor: c.skeleton,
  },
  rowSkeleton: {
    height: 56,
    borderRadius: 12,
    backgroundColor: c.skeleton,
  },
  errorBox: {
    backgroundColor: 'rgba(204,82,71,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(204,82,71,0.12)',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    flex: 1,
    color: c.red,
    fontSize: 13,
  },
  retryButton: {
    backgroundColor: c.orange,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    minHeight: 36,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
