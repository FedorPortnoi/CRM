import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import KanbanBoard from '../../screens/KanbanBoard';
import { useDealsStore } from '../../store/dealsStore';
import { usePipelinesStore } from '../../store/pipelinesStore';

type ViewMode = 'board' | 'list';

type Deal = {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost' | 'archived';
  pipeline_id: string | null;
  stage_id: string | null;
  contact: { id: string; first_name: string; last_name: string };
  stage: { id: string; name: string; position: number } | null;
};

type PipelineStage = {
  id: string;
  name: string;
  position: number;
};

type DealRow = { type: 'header'; stageId: string; stageName: string; count: number } | { type: 'deal'; deal: Deal };

function formatValue(value: number | null): string {
  if (value === null) return '—';
  return '$' + value.toLocaleString('en-US');
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
  }, []);

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
        <ActivityIndicator size="large" color="#10b981" />
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
          colors={['#10b981']}
          tintColor="#10b981"
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
        const contactName = deal.contact.first_name + ' ' + deal.contact.last_name;
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
            <Text style={listStyles.dealValue}>{formatValue(deal.value)}</Text>
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
  container: { flex: 1, backgroundColor: '#f0fdf8' },
  toggleBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  toggleBtn: {
    paddingHorizontal: 20,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
  },
  toggleActive: { backgroundColor: '#10b981' },
  toggleText: { fontSize: 14, fontWeight: '600', color: '#6b7280' },
  toggleTextActive: { color: '#FFFFFF' },
  content: { flex: 1 },
});

const listStyles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { paddingBottom: 24 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { fontSize: 14, color: '#ef4444', textAlign: 'center', marginBottom: 12 },
  retryButton: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#10b981', borderRadius: 12 },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 15, color: '#9ca3af' },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#f0fdf8',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginTop: 8,
  },
  stageHeaderText: { fontSize: 13, fontWeight: '700', color: '#111827', textTransform: 'uppercase', letterSpacing: 0.5 },
  stageCount: { fontSize: 12, color: '#9ca3af', fontWeight: '600' },
  dealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  dealMain: { flex: 1, marginRight: 12 },
  dealTitle: { fontSize: 15, fontWeight: '500', color: '#111827', marginBottom: 2 },
  dealContact: { fontSize: 13, color: '#9ca3af' },
  dealValue: { fontSize: 14, fontWeight: '600', color: '#10b981' },
});
