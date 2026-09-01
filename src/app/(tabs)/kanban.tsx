import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Kanban as KanbanIcon } from 'lucide-react-native';
import KanbanBoard from '../../screens/KanbanBoard';
import { useDealsStore } from '../../store/dealsStore';
import { usePipelinesStore } from '../../store/pipelinesStore';
import { formatMoney } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { EmptyState, Skeleton } from '../../components/ui';

type ViewMode = 'board' | 'list';

type Deal = {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost' | 'archived';
  pipeline_id: string | null;
  stage_id: string | null;
  contact: { id: string; first_name: string; last_name: string } | null;
  stage: { id: string; name: string; position: number } | null;
};

type PipelineStage = {
  id: string;
  name: string;
  position: number;
};

type DealRow = { type: 'header'; stageId: string; stageName: string; count: number } | { type: 'deal'; deal: Deal };

function formatValue(value: number | null, currency: string | null): string {
  return formatMoney(value, currency, { empty: '--' });
}

/** Loading placeholder shaped like a real deal row. */
function SkeletonDealRow({ styles }: { styles: ReturnType<typeof makeListStyles> }): JSX.Element {
  return (
    <View style={styles.dealRow}>
      <View style={styles.dealMain}>
        <Skeleton width="60%" height={14} />
        <Skeleton width="35%" height={13} style={styles.skeletonContact} />
      </View>
      <Skeleton width={72} height={14} />
    </View>
  );
}

function DealListView(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const listStyles = makeListStyles(colors);
  const deals = useDealsStore((s) => s.deals) as Deal[];
  const isLoading = useDealsStore((s) => s.isLoading);
  const error = useDealsStore((s) => s.error);
  const fetchDeals = useDealsStore((s) => s.fetchDeals);

  const pipelines = usePipelinesStore((s) => s.pipelines);
  const pipelinesLoading = usePipelinesStore((s) => s.isLoading);
  const pipelinesError = usePipelinesStore((s) => s.error);
  const fetchPipelines = usePipelinesStore((s) => s.fetchPipelines);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  useEffect(() => {
    void fetchPipelines().then(() => fetchDeals());
  }, [fetchDeals, fetchPipelines]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void fetchPipelines().then(() => fetchDeals()).finally(() => setIsRefreshing(false));
  }, [fetchDeals, fetchPipelines]);

  const defaultPipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];

  const rows: DealRow[] = useMemo(() => {
    if (!defaultPipeline) return [];
    const stages: PipelineStage[] = defaultPipeline.stages
      .slice()
      .sort((a: PipelineStage, b: PipelineStage) => a.position - b.position);

    const result: DealRow[] = [];
    for (const stage of stages) {
      const stageDeals = deals.filter((d) => d.status === 'open' && d.stage_id === stage.id);
      result.push({ type: 'header', stageId: stage.id, stageName: stage.name, count: stageDeals.length });
      for (const deal of stageDeals) {
        result.push({ type: 'deal', deal });
      }
    }
    return result;
  }, [defaultPipeline, deals]);

  if (isLoading || pipelinesLoading) {
    return (
      <View style={listStyles.list}>
        {Array.from({ length: 8 }, (_, i) => <SkeletonDealRow key={i} styles={listStyles} />)}
      </View>
    );
  }

  if (error || pipelinesError) {
    return (
      <EmptyState
        icon={<AlertTriangle size={48} color={colors.danger} strokeWidth={1.5} />}
        title={error ?? pipelinesError ?? ''}
        actionLabel={t('common.retry')}
        onAction={() => void fetchPipelines().then(() => fetchDeals())}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<KanbanIcon size={48} color={colors.skeleton} strokeWidth={1.5} />}
        title={t('deals.noOpenDeals')}
      />
    );
  }

  return (
    <FlatList<DealRow>
      data={rows}
      keyExtractor={(item) => item.type === 'header' ? 'header-' + item.stageId : 'deal-' + item.deal.id}
      style={listStyles.list}
      contentContainerStyle={listStyles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={handleRefresh}
          colors={[colors.accent]}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => {
        if (item.type === 'header') {
          return (
            <View style={listStyles.stageHeader}>
              <Text style={listStyles.stageHeaderText}>{item.stageName}</Text>
              <Text style={listStyles.stageCount}>{item.count}</Text>
            </View>
          );
        }
        const { deal } = item;
        const contactName = deal.contact
          ? deal.contact.first_name + (deal.contact.last_name ? ' ' + deal.contact.last_name : '')
          : '';
        return (
          <TouchableOpacity
            style={listStyles.dealRow}
            onPress={() => router.push({ pathname: '/deal/[id]', params: { id: deal.id } })}
            accessibilityRole="button"
            activeOpacity={0.7}
          >
            <View style={listStyles.dealMain}>
              <Text style={listStyles.dealTitle} numberOfLines={1}>{deal.title}</Text>
              <Text style={listStyles.dealContact} numberOfLines={1}>{contactName}</Text>
            </View>
            <Text style={listStyles.dealValue}>{formatValue(deal.value, deal.currency)}</Text>
          </TouchableOpacity>
        );
      }}
    />
  );
}

export default function PipelineScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [viewMode, setViewMode] = useState<ViewMode>('board');

  return (
    <View style={styles.container}>
      <View style={styles.toggleBar}>
        <TouchableOpacity
          style={[styles.toggleBtn, viewMode === 'board' ? styles.toggleActive : null]}
          onPress={() => setViewMode('board')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ selected: viewMode === 'board' }}
        >
          <Text style={[styles.toggleText, viewMode === 'board' ? styles.toggleTextActive : null]}>
            {t('deals.board')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, viewMode === 'list' ? styles.toggleActive : null]}
          onPress={() => setViewMode('list')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ selected: viewMode === 'list' }}
        >
          <Text style={[styles.toggleText, viewMode === 'list' ? styles.toggleTextActive : null]}>
            {t('deals.list')}
          </Text>
        </TouchableOpacity>
      </View>
      <View style={styles.content}>
        {viewMode === 'board' ? <KanbanBoard /> : <DealListView />}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  toggleBar: {
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.bg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  toggleBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.xxl,
    backgroundColor: c.bg,
  },
  toggleActive: { backgroundColor: c.accent },
  toggleText: { ...type.body, fontWeight: '600', color: c.amber },
  toggleTextActive: { color: c.onAccent },
  content: { flex: 1 },
});

const makeListStyles = (c: ThemeColors) => StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingBottom: spacing.xl },
  skeletonContact: { marginTop: spacing.sm },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    marginTop: spacing.sm,
  },
  stageHeaderText: { ...type.label, fontWeight: '700', color: c.text1, textTransform: 'uppercase', letterSpacing: 0.5 },
  stageCount: { ...type.caption, color: c.textMuted, fontVariant: ['tabular-nums'] },
  dealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.bg,
  },
  dealMain: { flex: 1, marginRight: spacing.md },
  dealTitle: { ...type.body, color: c.text1, marginBottom: spacing.xs },
  dealContact: { ...type.label, fontWeight: '500', color: c.textMuted },
  dealValue: { ...type.body, fontWeight: '600', color: c.accent, fontVariant: ['tabular-nums'] },
});
