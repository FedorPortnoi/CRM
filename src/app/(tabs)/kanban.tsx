import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import KanbanBoard from '../../screens/KanbanBoard';
import { useDealsStore } from '../../store/dealsStore';
import { usePipelinesStore } from '../../store/pipelinesStore';
import { formatMoney } from '../../market/profile';

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

function DealListView(): JSX.Element {
  const { t } = useTranslation();
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
    void Promise.all([fetchDeals(), fetchPipelines()]);
  }, [fetchDeals, fetchPipelines]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void Promise.all([fetchDeals(), fetchPipelines()]).finally(() => setIsRefreshing(false));
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
      <View style={listStyles.centered}>
        <ActivityIndicator size="large" color="#C45A10" />
      </View>
    );
  }

  if (error || pipelinesError) {
    return (
      <View style={listStyles.centered}>
        <Text style={listStyles.errorText}>{error ?? pipelinesError}</Text>
        <TouchableOpacity
          style={listStyles.retryButton}
          onPress={() => void Promise.all([fetchDeals(), fetchPipelines()])}
        >
          <Text style={listStyles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={listStyles.centered}>
        <Text style={listStyles.emptyText}>{t('deals.noOpenDeals')}</Text>
      </View>
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
          colors={['#C45A10']}
          tintColor="#C45A10"
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
            activeOpacity={0.75}
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
  const [viewMode, setViewMode] = useState<ViewMode>('board');

  return (
    <View style={styles.container}>
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />
      <View style={styles.toggleBar}>
        <TouchableOpacity
          style={[styles.toggleBtn, viewMode === 'board' ? styles.toggleActive : null]}
          onPress={() => setViewMode('board')}
          activeOpacity={0.7}
        >
          <Text style={[styles.toggleText, viewMode === 'board' ? styles.toggleTextActive : null]}>
            {t('deals.board')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, viewMode === 'list' ? styles.toggleActive : null]}
          onPress={() => setViewMode('list')}
          activeOpacity={0.7}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  circle1: { position: 'absolute', width: 350, height: 350, borderRadius: 175, backgroundColor: 'rgba(6,95,70,0.04)', top: -80, right: -100 },
  circle2: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(6,95,70,0.03)', bottom: 100, left: -80 },
  circle3: { position: 'absolute', width: 200, height: 200, borderRadius: 100, backgroundColor: 'rgba(6,95,70,0.03)', top: '40%', right: -60 },
  toggleBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#FAF6F3',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  toggleBtn: {
    paddingHorizontal: 20,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#FAF6F3',
  },
  toggleActive: { backgroundColor: '#C45A10' },
  toggleText: { fontSize: 14, fontWeight: '600', color: '#B07868' },
  toggleTextActive: { color: '#FFFFFF' },
  content: { flex: 1 },
});

const listStyles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingBottom: 24 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { fontSize: 14, color: '#ef4444', textAlign: 'center', marginBottom: 12 },
  retryButton: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#C45A10', borderRadius: 12 },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 15, color: '#CFADA3' },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
    marginTop: 8,
  },
  stageHeaderText: { fontSize: 13, fontWeight: '700', color: '#383432', textTransform: 'uppercase', letterSpacing: 0.5 },
  stageCount: { fontSize: 12, color: '#CFADA3', fontWeight: '600' },
  dealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#FAF6F3',
  },
  dealMain: { flex: 1, marginRight: 12 },
  dealTitle: { fontSize: 15, fontWeight: '500', color: '#383432', marginBottom: 2 },
  dealContact: { fontSize: 13, color: '#CFADA3' },
  dealValue: { fontSize: 14, fontWeight: '600', color: '#C45A10' },
});
