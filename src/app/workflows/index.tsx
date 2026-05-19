import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
}  from 'react-native';
import type { DimensionValue } from 'react-native';
import { router } from 'expo-router';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

interface WorkflowItem {
  id: string;
  name: string;
  trigger: string;
  status: string;
  actions: unknown[];
  _count: { runs: number };
}

interface WorkflowsApiResponse {
  data: WorkflowItem[];
  meta: { total: number };
}

interface SkeletonBoxProps {
  width: DimensionValue;
  height: number;
  borderRadius?: number;
  marginBottom?: number;
}

function SkeletonBox({ width, height, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: '#d1fae5', borderRadius, marginBottom }} />;
}

const TRIGGER_KEY_MAP: Record<string, string> = {
  contact_created: 'trigger_contact_created',
  deal_stage_changed: 'trigger_deal_stage_changed',
  task_completed: 'trigger_task_completed',
  deal_won: 'trigger_deal_won',
  deal_created: 'trigger_deal_created',
  task_created: 'trigger_task_created',
};

export default function WorkflowsScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkflows = useCallback(
    (silent: boolean): void => {
      if (!token) return;
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      fetch(API_URL + '/workflows', {
        headers: { Authorization: 'Bearer ' + token },
      })
        .then((res) => {
          if (!res.ok) throw new Error('Workflows failed with status ' + res.status);
          return res.json() as Promise<WorkflowsApiResponse>;
        })
        .then((body) => {
          setItems(body.data);
          setIsLoading(false);
          setIsRefreshing(false);
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : t('errors.networkError'));
          setIsLoading(false);
          setIsRefreshing(false);
        });
    },
    [token, t],
  );

  useEffect(() => {
    fetchWorkflows(false);
  }, [fetchWorkflows]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    fetchWorkflows(true);
  }, [fetchWorkflows]);

  const handleToggle = useCallback(
    (item: WorkflowItem, newValue: boolean): void => {
      if (!token) return;
      const newStatus = newValue ? 'active' : 'paused';
      setItems((prev) =>
        prev.map((w) => (w.id === item.id ? { ...w, status: newStatus } : w)),
      );
      fetch(API_URL + '/workflows/' + item.id, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('PATCH failed: ' + res.status);
        })
        .catch(() => {
          setItems((prev) =>
            prev.map((w) => (w.id === item.id ? { ...w, status: item.status } : w)),
          );
        });
    },
    [token],
  );

  const getTriggerLabel = useCallback(
    (trigger: string): string => {
      const key = TRIGGER_KEY_MAP[trigger];
      if (key) return t('workflows.' + key);
      return trigger.replace(/_/g, ' ');
    },
    [t],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <SkeletonBox width={140} height={28} borderRadius={6} />
          <SkeletonBox width={40} height={40} borderRadius={8} />
        </View>
        <View style={styles.list}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonRow}>
              <SkeletonBox width={42} height={42} borderRadius={8} marginBottom={0} />
              <View style={styles.skeletonBody}>
                <SkeletonBox width='70%' height={16} borderRadius={4} marginBottom={8} />
                <SkeletonBox width='50%' height={13} borderRadius={4} />
              </View>
              <SkeletonBox width={51} height={31} borderRadius={16} />
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('workflows.title')}</Text>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => { router.push('/workflows/new' as never); }}
            accessibilityRole='button'
          >
            <Plus size={20} color='#FFFFFF' />
          </TouchableOpacity>
        </View>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => { fetchWorkflows(false); }}>
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('workflows.title')}</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => { router.push('/workflows/new' as never); }}
          accessibilityRole='button'
        >
          <Plus size={20} color='#FFFFFF' />
        </TouchableOpacity>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={<Text style={styles.emptyText}>{t('workflows.empty')}</Text>}
        renderItem={({ item }) => {
          const actionCount = Array.isArray(item.actions) ? item.actions.length : 0;
          const isEnabled = item.status === 'active';
          return (
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <WorkflowIcon size={20} color='#10b981' />
              </View>
              <TouchableOpacity
                style={styles.rowBody}
                onPress={() => { router.push(('/workflows/' + item.id) as never); }}
                activeOpacity={0.7}
              >
                <Text style={styles.rowTitle}>{item.name}</Text>
                <Text style={styles.rowMeta}>{getTriggerLabel(item.trigger)}</Text>
              </TouchableOpacity>
              <View style={styles.rowRight}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{actionCount}</Text>
                </View>
                <Switch
                  value={isEnabled}
                  onValueChange={(val) => { handleToggle(item, val); }}
                  trackColor={{ false: '#D1D5DB', true: '#93C5FD' }}
                  thumbColor={isEnabled ? '#10b981' : '#9CA3AF'}
                />
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F8FA' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: {
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 26, fontWeight: '700', color: '#111827' },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyList: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: '#6B7280', fontSize: 16, textAlign: 'center' },
  row: {
    minHeight: 72,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  skeletonRow: {
    minHeight: 72,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  skeletonBody: { flex: 1, marginHorizontal: 12 },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#ecfdf5',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  rowMeta: { marginTop: 4, color: '#6B7280', fontSize: 13 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 8 },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ecfdf5',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: 12, fontWeight: '700', color: '#10b981' },
  errorText: { color: '#C5221F', marginBottom: 12, textAlign: 'center' },
  retryButton: {
    paddingHorizontal: 16,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#10b981',
    justifyContent: 'center',
  },
  retryText: { color: '#FFFFFF', fontWeight: '700' },
});
