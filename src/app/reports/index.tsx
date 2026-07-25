// Reports screen — five tabbed reports over one shared date range.
//
// Backend: GET /api/v1/reports/{funnel,reps,win-loss,revenue,pipeline-health}
// i18n:    reports.*
//
// The backend returns raw numbers and ISO strings; every figure on this screen goes through
// src/market/profile.ts so money, dates and separators follow the active market (RUB / ru-RU).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { formatMarketDate, formatMarketNumber, formatMoney } from '../../market/profile';
import { useUserStore } from '../../store/userStore';
import { usePipelinesStore } from '../../store/pipelinesStore';
import {
  DEFAULT_REPORT_FILTERS,
  REVENUE_GRANULARITIES,
  useFunnelReport,
  usePipelineHealthReport,
  useRepPerformanceReport,
  useRevenueReport,
  useWinLossReport,
  type PipelineHealthReport,
  type ReportEnvelope,
  type ReportFilters,
  type ReportKind,
  type ReportMeta,
  type RepPerformanceReport,
  type RepPerformanceTotals,
  type RevenueBucket,
  type RevenueGranularity,
  type RevenueReport,
  type SalesFunnelReport,
  type WinLossReport,
} from '../../hooks/useReports';
import ReportFilterBar from '../../components/analytics/ReportFilterBar';
import FunnelChart, { type FunnelBarDatum } from '../../components/analytics/FunnelChart';
import BarChart, { type BarDatum } from '../../components/analytics/BarChart';
import ShareDonut from '../../components/analytics/ShareDonut';
import ScoreGauge from '../../components/analytics/ScoreGauge';
import {
  ChartLegend,
  MetricRow,
  ReportCard,
  ReportEmpty,
  ReportError,
  ReportLoading,
  ReportNote,
  ShareBar,
  StatGrid,
  StatTile,
} from '../../components/analytics/ReportCards';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

const TAB_LABEL_KEYS: Record<ReportKind, string> = {
  funnel: 'reports.funnel',
  reps: 'reports.reps',
  'win-loss': 'reports.winLoss',
  revenue: 'reports.revenue',
  'pipeline-health': 'reports.pipelineHealth',
};

const TABS: ReportKind[] = ['funnel', 'reps', 'win-loss', 'revenue', 'pipeline-health'];

const GRANULARITY_LABEL_KEYS: Record<RevenueGranularity, string> = {
  day: 'reports.granularityDay',
  week: 'reports.granularityWeek',
  month: 'reports.granularityMonth',
};

const UNSET_VALUE = '—';

// ─── Formatting (always through the market profile) ───────────────────────────

function money(value: number, currency: string): string {
  return formatMoney(value, currency, { maximumFractionDigits: 0 });
}

function count(value: number): string {
  return formatMarketNumber(value, { maximumFractionDigits: 0 });
}

function percent(value: number): string {
  return `${formatMarketNumber(value, { maximumFractionDigits: 1 })}%`;
}

function decimal(value: number): string {
  return formatMarketNumber(value, { maximumFractionDigits: 2 });
}

/** `date_to` is an exclusive upper bound — show the last day the range actually covers. */
function inclusiveEnd(isoDate: string): Date {
  return new Date(new Date(isoDate).getTime() - 1);
}

function healthTone(score: number, colors: ThemeColors): string {
  if (score >= 60) return colors.orange;
  if (score >= 35) return colors.amber;
  return colors.red;
}

// ─── Generic loading / error / empty wrapper ──────────────────────────────────

interface ReportSectionProps<T> {
  query: UseQueryResult<ReportEnvelope<T>, Error>;
  children: (data: T, meta: ReportMeta) => React.ReactNode;
}

function ReportSection<T>({ query, children }: ReportSectionProps<T>): JSX.Element {
  if (query.isPending) return <ReportLoading />;
  if (query.isError) return <ReportError onRetry={() => { void query.refetch(); }} />;
  if (!query.data) return <ReportEmpty />;

  // The previous range stays on screen while a new one loads (keepPreviousData); dim it so the
  // numbers are not mistaken for the range that is currently selected.
  const stale = query.isFetching;
  return (
    <View style={stale ? sectionStyles.stale : undefined}>
      {children(query.data.data, query.data.meta)}
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  stale: { opacity: 0.55 },
});

// ─── 1. Sales funnel ──────────────────────────────────────────────────────────

interface FunnelViewProps {
  data: SalesFunnelReport;
  meta: ReportMeta;
}

function FunnelView({ data, meta }: FunnelViewProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  if (data.totals.deal_count === 0) return <ReportEmpty />;

  const legend = [
    { key: 'open', label: t('reports.funnelOpen'), color: colors.amber },
    { key: 'won', label: t('reports.funnelWon'), color: colors.orange },
    { key: 'lost', label: t('reports.funnelLost'), color: colors.red },
  ];

  return (
    <>
      <StatGrid>
        <StatTile label={t('reports.funnelDeals')} value={count(data.totals.deal_count)} />
        <StatTile
          label={t('reports.funnelValue')}
          value={money(data.totals.total_value, meta.currency)}
          tone="positive"
        />
        {data.totals.unstaged_deal_count > 0 ? (
          <StatTile
            label={t('reports.funnelUnstaged')}
            value={count(data.totals.unstaged_deal_count)}
            sub={money(data.totals.unstaged_value, meta.currency)}
            tone="warning"
          />
        ) : null}
      </StatGrid>

      {data.pipelines.map((pipeline) => {
        const stages: FunnelBarDatum[] = pipeline.stages.map((stage) => ({
          key: stage.stage_id,
          label: stage.stage_name,
          total: stage.deal_count,
          open: stage.open_count,
          won: stage.won_count,
          lost: stage.lost_count,
          countLabel: count(stage.deal_count),
          valueLabel: money(stage.total_value, meta.currency),
          conversionLabel:
            stage.conversion_to_next === null ? null : percent(stage.conversion_to_next),
        }));

        return (
          <ReportCard key={pipeline.pipeline_id} title={pipeline.pipeline_name}>
            {stages.length === 0 ? (
              <Text style={styles.mutedText}>{t('reports.funnelNoStages')}</Text>
            ) : (
              <>
                <FunnelChart stages={stages} conversionLabelPrefix={t('reports.funnelConversion')} />
                <ChartLegend items={legend} />
                <View style={styles.divider} />
                <MetricRow
                  label={t('reports.funnelTotals')}
                  value={`${count(pipeline.totals.deal_count)} · ${money(pipeline.totals.total_value, meta.currency)}`}
                />
              </>
            )}
          </ReportCard>
        );
      })}

      <ReportNote text={t('reports.funnelHint')} />
    </>
  );
}

// ─── 2. Rep performance ───────────────────────────────────────────────────────

interface RepsViewProps {
  data: RepPerformanceReport;
  meta: ReportMeta;
}

function RepMetrics({
  row,
  currency,
}: {
  row: RepPerformanceTotals;
  currency: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <MetricRow label={t('reports.repsWon')} value={count(row.deals_won)} tone="positive" />
      <MetricRow label={t('reports.repsLost')} value={count(row.deals_lost)} tone="negative" />
      <MetricRow label={t('reports.repsOpen')} value={count(row.deals_open)} />
      <MetricRow
        label={t('reports.repsStalled')}
        value={count(row.stalled_deals)}
        tone={row.stalled_deals > 0 ? 'warning' : 'default'}
      />
      <MetricRow label={t('reports.repsOpenValue')} value={money(row.open_value, currency)} />
      <MetricRow label={t('reports.repsLostValue')} value={money(row.lost_value, currency)} />
      <MetricRow
        label={t('reports.repsAverageDeal')}
        value={money(row.average_deal_value, currency)}
      />
      <MetricRow label={t('reports.repsTasksCompleted')} value={count(row.tasks_completed)} />
      <MetricRow label={t('reports.repsActivity')} value={count(row.activity_count)} />
      <MetricRow
        label={t('reports.repsHealthScore')}
        value={percent(row.pipeline_health_score)}
      />
    </>
  );
}

function RepsView({ data, meta }: RepsViewProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  if (data.reps.length === 0) return <ReportEmpty text={t('reports.repsEmpty')} />;

  const maxRevenue = data.reps.reduce((max, rep) => (rep.revenue > max ? rep.revenue : max), 0);

  return (
    <>
      <StatGrid>
        <StatTile
          label={t('reports.repsRevenue')}
          value={money(data.totals.revenue, meta.currency)}
          tone="positive"
        />
        <StatTile label={t('reports.repsWon')} value={count(data.totals.deals_won)} />
        <StatTile
          label={t('reports.repsStalled')}
          value={count(data.totals.stalled_deals)}
          tone={data.totals.stalled_deals > 0 ? 'warning' : 'default'}
        />
      </StatGrid>

      {data.reps.map((rep) => (
        <ReportCard key={rep.user_id}>
          <View style={styles.repHeader}>
            <Text style={styles.repName} numberOfLines={1}>{rep.name ?? UNSET_VALUE}</Text>
            <Text style={styles.repRevenue}>{money(rep.revenue, meta.currency)}</Text>
          </View>
          <ShareBar
            fraction={maxRevenue > 0 ? rep.revenue / maxRevenue : 0}
            color={colors.orange}
          />
          <View style={styles.divider} />
          <RepMetrics row={rep} currency={meta.currency} />
        </ReportCard>
      ))}

      <ReportCard title={t('reports.repsTotals')}>
        <MetricRow
          label={t('reports.repsRevenue')}
          value={money(data.totals.revenue, meta.currency)}
          tone="positive"
        />
        <RepMetrics row={data.totals} currency={meta.currency} />
      </ReportCard>

      {typeof meta.stalled_threshold_days === 'number' ? (
        <ReportNote
          text={t('reports.repsStalledThreshold', { count: meta.stalled_threshold_days })}
        />
      ) : null}
    </>
  );
}

// ─── 3. Win / loss ────────────────────────────────────────────────────────────

interface WinLossViewProps {
  data: WinLossReport;
  meta: ReportMeta;
}

function WinLossView({ data, meta }: WinLossViewProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  if (data.totals.decided_count === 0) return <ReportEmpty />;

  return (
    <>
      <ReportCard>
        <ShareDonut
          segments={[
            { key: 'won', value: data.totals.won_count, color: colors.orange },
            { key: 'lost', value: data.totals.lost_count, color: colors.red },
          ]}
          centerValue={percent(data.totals.won_share)}
          centerLabel={t('reports.wlWonShare')}
        />
        <ChartLegend
          items={[
            { key: 'won', label: t('reports.wlWon'), color: colors.orange },
            { key: 'lost', label: t('reports.wlLost'), color: colors.red },
          ]}
        />
      </ReportCard>

      <StatGrid>
        <StatTile
          label={t('reports.wlWon')}
          value={count(data.totals.won_count)}
          sub={money(data.totals.won_value, meta.currency)}
          tone="positive"
        />
        <StatTile
          label={t('reports.wlLost')}
          value={count(data.totals.lost_count)}
          sub={money(data.totals.lost_value, meta.currency)}
          tone="negative"
        />
        <StatTile
          label={t('reports.wlDecided')}
          value={count(data.totals.decided_count)}
          sub={money(data.totals.decided_value, meta.currency)}
        />
        <StatTile
          label={t('reports.wlAverageWon')}
          value={money(data.totals.average_won_value, meta.currency)}
        />
        <StatTile
          label={t('reports.wlAverageLost')}
          value={money(data.totals.average_lost_value, meta.currency)}
        />
      </StatGrid>

      <ReportCard title={t('reports.wlByReason')}>
        {data.by_lost_reason.length === 0 ? (
          <Text style={styles.mutedText}>{t('reports.empty')}</Text>
        ) : (
          data.by_lost_reason.map((row) => (
            <View key={row.lost_reason ?? 'unspecified'} style={styles.listRow}>
              <View style={styles.listRowHeader}>
                <Text style={styles.listRowLabel} numberOfLines={2}>
                  {row.lost_reason ?? t('reports.wlReasonUnspecified')}
                </Text>
                <Text style={styles.listRowValue}>{percent(row.share)}</Text>
              </View>
              <ShareBar fraction={row.share / 100} color={colors.red} />
              <Text style={styles.listRowSub}>
                {`${t('reports.wlCount')}: ${count(row.count)} · ${t('reports.wlValue')}: ${money(row.value, meta.currency)}`}
              </Text>
            </View>
          ))
        )}
      </ReportCard>

      <ReportCard title={t('reports.wlBySource')}>
        {data.by_source.length === 0 ? (
          <Text style={styles.mutedText}>{t('reports.empty')}</Text>
        ) : (
          data.by_source.map((row) => (
            <View key={row.source ?? 'unspecified'} style={styles.listRow}>
              <View style={styles.listRowHeader}>
                <Text style={styles.listRowLabel} numberOfLines={2}>
                  {row.source ?? t('reports.wlSourceUnspecified')}
                </Text>
                <Text style={styles.listRowValue}>{percent(row.won_share)}</Text>
              </View>
              <ShareBar fraction={row.won_share / 100} color={colors.orange} />
              <Text style={styles.listRowSub}>
                {`${t('reports.wlWon')}: ${count(row.won_count)} · ${t('reports.wlLost')}: ${count(row.lost_count)} · ${money(row.decided_value, meta.currency)}`}
              </Text>
            </View>
          ))
        )}
      </ReportCard>
    </>
  );
}

// ─── 4. Revenue over time ─────────────────────────────────────────────────────

function bucketAxisLabel(bucket: RevenueBucket, granularity: RevenueGranularity): string {
  if (granularity === 'month') {
    return formatMarketDate(bucket.period_start, { month: 'short' });
  }
  return formatMarketDate(bucket.period_start, { day: 'numeric', month: 'short' });
}

interface RevenueViewProps {
  data: RevenueReport;
  meta: ReportMeta;
  granularity: RevenueGranularity;
  onGranularityChange: (next: RevenueGranularity) => void;
}

function RevenueView({
  data,
  meta,
  granularity,
  onGranularityChange,
}: RevenueViewProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const bars: BarDatum[] = data.series.map((bucket) => ({
    key: bucket.period_start,
    label: bucketAxisLabel(bucket, data.granularity),
    value: bucket.revenue,
  }));

  const selected =
    data.series.find((bucket) => bucket.period_start === selectedKey) ??
    data.series[data.series.length - 1];

  const selectedTitle = ((): string => {
    if (!selected) return '';
    if (data.granularity === 'month') {
      return formatMarketDate(selected.period_start, { month: 'long', year: 'numeric' });
    }
    if (data.granularity === 'day') {
      return formatMarketDate(selected.period_start, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }
    return t('reports.periodRange', {
      from: formatMarketDate(selected.period_start, { day: 'numeric', month: 'short' }),
      to: formatMarketDate(inclusiveEnd(selected.period_end), { day: 'numeric', month: 'short' }),
    });
  })();

  const granularityRow = (
    <View style={styles.granularityRow}>
      {REVENUE_GRANULARITIES.map((option) => {
        const active = granularity === option;
        return (
          <TouchableOpacity
            key={option}
            style={[styles.granularityChip, active && styles.granularityChipActive]}
            onPress={() => onGranularityChange(option)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.granularityText, active && styles.granularityTextActive]}>
              {t(GRANULARITY_LABEL_KEYS[option])}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  if (data.totals.deal_count === 0 && data.other_currencies.length === 0) {
    return (
      <>
        <Text style={styles.groupLabel}>{t('reports.granularity')}</Text>
        {granularityRow}
        <ReportEmpty />
      </>
    );
  }

  return (
    <>
      <Text style={styles.groupLabel}>{t('reports.granularity')}</Text>
      {granularityRow}

      <StatGrid>
        <StatTile
          label={t('reports.revenueTotal')}
          value={money(data.totals.revenue, data.currency)}
          tone="positive"
        />
        <StatTile label={t('reports.revenueDeals')} value={count(data.totals.deal_count)} />
        <StatTile
          label={t('reports.revenueAverage')}
          value={money(data.totals.average_deal_value, data.currency)}
        />
      </StatGrid>

      <ReportCard title={t('reports.revenue')}>
        <View style={styles.chartWrap}>
          <BarChart data={bars} selectedKey={selected?.period_start ?? null} onSelect={setSelectedKey} />
        </View>

        {selected ? (
          <>
            <View style={styles.divider} />
            <Text style={styles.bucketTitle}>{`${t('reports.revenueColumn')}: ${selectedTitle}`}</Text>
            <MetricRow
              label={t('reports.revenue')}
              value={money(selected.revenue, data.currency)}
              tone="positive"
            />
            <MetricRow label={t('reports.revenueDeals')} value={count(selected.deal_count)} />
            <MetricRow
              label={t('reports.revenueAverage')}
              value={money(selected.average_deal_value, data.currency)}
            />
          </>
        ) : null}
      </ReportCard>

      {data.other_currencies.length > 0 ? (
        <ReportCard
          title={t('reports.revenueOtherCurrencies')}
          hint={t('reports.revenueOtherCurrenciesNote')}
        >
          {data.other_currencies.map((entry) => (
            <MetricRow
              key={entry.currency}
              label={`${entry.currency} · ${count(entry.deal_count)}`}
              value={money(entry.revenue, entry.currency)}
            />
          ))}
        </ReportCard>
      ) : null}

      {meta.buckets_truncated === true ? <ReportNote text={t('reports.revenueTruncated')} /> : null}
    </>
  );
}

// ─── 5. Pipeline health ───────────────────────────────────────────────────────

interface HealthViewProps {
  data: PipelineHealthReport;
  meta: ReportMeta;
}

function HealthView({ data, meta }: HealthViewProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const decayFactor = meta.decay_factor ?? data.components.decay_factor;
  const threshold = meta.stalled_threshold_days ?? data.components.stalled_threshold_days;

  return (
    <>
      <ReportCard>
        <ScoreGauge
          score={data.pipeline_health_score}
          valueLabel={percent(data.pipeline_health_score)}
          caption={t('reports.healthScore')}
          color={healthTone(data.pipeline_health_score, colors)}
        />
        <ReportNote text={t('reports.healthNote')} />
      </ReportCard>

      <StatGrid>
        <StatTile label={t('reports.healthWon')} value={count(data.components.won)} tone="positive" />
        <StatTile label={t('reports.healthLost')} value={count(data.components.lost)} tone="negative" />
        <StatTile
          label={t('reports.healthStalled')}
          value={count(data.components.stalled)}
          tone={data.components.stalled > 0 ? 'warning' : 'default'}
        />
        <StatTile label={t('reports.healthOpen')} value={count(data.components.open)} />
      </StatGrid>

      <ReportCard title={t('reports.healthByPipeline')}>
        {data.pipelines.length === 0 ? (
          <Text style={styles.mutedText}>{t('reports.empty')}</Text>
        ) : (
          data.pipelines.map((row) => (
            <View key={row.pipeline_id ?? 'unassigned'} style={styles.listRow}>
              <View style={styles.listRowHeader}>
                <Text style={styles.listRowLabel} numberOfLines={2}>
                  {row.pipeline_name ?? UNSET_VALUE}
                </Text>
                <Text style={[styles.listRowValue, { color: healthTone(row.pipeline_health_score, colors) }]}>
                  {percent(row.pipeline_health_score)}
                </Text>
              </View>
              <ShareBar
                fraction={row.pipeline_health_score / 100}
                color={healthTone(row.pipeline_health_score, colors)}
              />
              <Text style={styles.listRowSub}>
                {`${t('reports.healthWon')}: ${count(row.won)} · ${t('reports.healthLost')}: ${count(row.lost)} · ${t('reports.healthStalled')}: ${count(row.stalled)} · ${t('reports.healthOpen')}: ${count(row.open)}`}
              </Text>
            </View>
          ))
        )}
      </ReportCard>

      <ReportCard hint={t('reports.healthFormula')}>
        <MetricRow label={t('reports.healthDecay')} value={decimal(decayFactor)} />
        <MetricRow label={t('reports.healthThreshold')} value={count(threshold)} />
      </ReportCard>
    </>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ReportsScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const queryClient = useQueryClient();

  const role = useUserStore((s) => s.user?.role ?? null);
  const pipelines = usePipelinesStore((s) => s.pipelines);
  const fetchPipelines = usePipelinesStore((s) => s.fetchPipelines);

  const [tab, setTab] = useState<ReportKind>('funnel');
  const [filters, setFilters] = useState<ReportFilters>(DEFAULT_REPORT_FILTERS);
  const [granularity, setGranularity] = useState<RevenueGranularity>('month');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void fetchPipelines();
  }, [fetchPipelines]);

  const funnelQuery = useFunnelReport(filters, tab === 'funnel');
  const repsQuery = useRepPerformanceReport(filters, tab === 'reps');
  const winLossQuery = useWinLossReport(filters, tab === 'win-loss');
  const revenueQuery = useRevenueReport(filters, granularity, tab === 'revenue');
  const healthQuery = usePipelineHealthReport(filters, tab === 'pipeline-health');

  const activeMeta: ReportMeta | null = useMemo(() => {
    const metaByTab: Record<ReportKind, ReportMeta | undefined> = {
      funnel: funnelQuery.data?.meta,
      reps: repsQuery.data?.meta,
      'win-loss': winLossQuery.data?.meta,
      revenue: revenueQuery.data?.meta,
      'pipeline-health': healthQuery.data?.meta,
    };
    return metaByTab[tab] ?? null;
  }, [tab, funnelQuery.data, repsQuery.data, winLossQuery.data, revenueQuery.data, healthQuery.data]);

  const rangeLabel = useMemo((): string | null => {
    if (!activeMeta) return null;
    const dateOptions: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
    return t('reports.periodRange', {
      from: formatMarketDate(activeMeta.date_from, dateOptions),
      to: formatMarketDate(inclusiveEnd(activeMeta.date_to), dateOptions),
    });
  }, [activeMeta, t]);

  const onRefresh = useCallback((): void => {
    setRefreshing(true);
    void queryClient
      .invalidateQueries({ queryKey: ['reports', tab] })
      .finally(() => setRefreshing(false));
  }, [queryClient, tab]);

  const pipelineOptions = useMemo(
    () => pipelines.map((pipeline) => ({ id: pipeline.id, name: pipeline.name })),
    [pipelines],
  );

  // Owners and admins are never narrowed by the visibility cone, so the scope toggle would be
  // a no-op control for them.
  const showScope = role !== 'owner' && role !== 'admin';

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('reports.title') }} />

      <View style={styles.tabBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
          {TABS.map((key) => {
            const active = tab === key;
            return (
              <TouchableOpacity
                key={key}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => setTab(key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {t(TAB_LABEL_KEYS[key])}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.orange} />
        }
      >
        <Text style={styles.subtitle}>{t('reports.subtitle')}</Text>

        <ReportFilterBar
          filters={filters}
          onChange={setFilters}
          pipelines={pipelineOptions}
          showScope={showScope}
          rangeLabel={rangeLabel}
        />

        <View style={styles.body}>
          {activeMeta?.restricted_to_visible_users === true ? (
            <ReportNote text={t('reports.restrictedNote')} />
          ) : null}

          {tab === 'funnel' ? (
            <ReportSection query={funnelQuery}>
              {(data, meta) => <FunnelView data={data} meta={meta} />}
            </ReportSection>
          ) : null}

          {tab === 'reps' ? (
            <ReportSection query={repsQuery}>
              {(data, meta) => <RepsView data={data} meta={meta} />}
            </ReportSection>
          ) : null}

          {tab === 'win-loss' ? (
            <ReportSection query={winLossQuery}>
              {(data, meta) => <WinLossView data={data} meta={meta} />}
            </ReportSection>
          ) : null}

          {tab === 'revenue' ? (
            <ReportSection query={revenueQuery}>
              {(data, meta) => (
                <RevenueView
                  data={data}
                  meta={meta}
                  granularity={granularity}
                  onGranularityChange={setGranularity}
                />
              )}
            </ReportSection>
          ) : null}

          {tab === 'pipeline-health' ? (
            <ReportSection query={healthQuery}>
              {(data, meta) => <HealthView data={data} meta={meta} />}
            </ReportSection>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: 48,
  },
  subtitle: {
    fontSize: 13,
    color: c.amber,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  tabBar: {
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.bgDark,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  tab: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  tabActive: {
    backgroundColor: c.orange,
    borderColor: c.orange,
  },
  tabText: {
    fontSize: 13,
    color: c.text1,
  },
  tabTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  body: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.amber,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  granularityRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  granularityChip: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  granularityChipActive: {
    backgroundColor: c.orange,
    borderColor: c.orange,
  },
  granularityText: {
    fontSize: 13,
    color: c.text1,
  },
  granularityTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  chartWrap: {
    marginTop: 14,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginVertical: 12,
  },
  mutedText: {
    fontSize: 13,
    color: c.textMuted,
    marginTop: 10,
  },
  bucketTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: c.text1,
    marginBottom: 4,
  },
  repHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  repName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: c.text1,
  },
  repRevenue: {
    fontSize: 15,
    fontWeight: '700',
    color: c.orange,
  },
  listRow: {
    marginTop: 14,
  },
  listRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  listRowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: c.text1,
  },
  listRowValue: {
    fontSize: 14,
    fontWeight: '700',
    color: c.text1,
  },
  listRowSub: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 6,
  },
});
