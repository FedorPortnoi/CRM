import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ListRenderItemInfo,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { useTaskScopeStore } from '../../store/taskScopeStore';
import { API_URL } from '../../utils/api';

type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

type Task = {
  id: string;
  title: string;
  due_date: string | null;
  status: TaskStatus;
};

type Tab = 'today' | 'all';

function isOverdue(task: Task): boolean {
  if (!task.due_date || task.status === 'done') return false;
  return new Date(task.due_date).getTime() < Date.now();
}

function sortByDueAsc(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
  });
}

function formatDue(due: string | null): string {
  if (!due) return '';
  return new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function badgeColor(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return '#C45A10';
    case 'in_progress':
      return '#f59e0b';
    case 'pending':
      return '#E8A000';
    default:
      return '#CFADA3';
  }
}

export default function TasksScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const role = useUserStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('today');

  useFocusEffect(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['tasks-today'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks-all'] });
    }, [queryClient]),
  );

  const scope = useTaskScopeStore((s) => s.scope);
  const setScope = useTaskScopeStore((s) => s.setScope);
  const hydrateScope = useTaskScopeStore((s) => s.hydrate);
  useEffect(() => {
    void hydrateScope();
  }, [hydrateScope]);

  // Depth toggle is for managers only. Owner/admin already see the whole org
  // (the server ignores scope for them), and a leaf member has no reports — so
  // we show it only when the scope-aware assignee list contains people besides
  // the user themselves.
  const { data: assignees = [] } = useQuery({
    queryKey: ['task-assignees', token],
    queryFn: async (): Promise<Array<{ id: string }>> => {
      const res = await fetch(`${API_URL}/tasks/assignees`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      const json = (await res.json()) as { data: Array<{ id: string }> };
      return json.data;
    },
    enabled: !!token,
  });
  const isManager = role !== 'owner' && role !== 'admin' && assignees.length > 1;

  const { data: todayTasks = [], isLoading: todayLoading, error: todayError, refetch: refetchToday } = useQuery({
    queryKey: ['tasks-today', token, scope],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/tasks/today?scope=${scope}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Tasks/today failed: ${res.status}`);
      const json = (await res.json()) as { data: Task[] };
      return sortByDueAsc(json.data);
    },
    enabled: !!token,
  });

  const { data: allTasks = [], isLoading: allLoading, error: allError, refetch: refetchAll } = useQuery({
    queryKey: ['tasks-all', token, scope],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/tasks?per_page=100&scope=${scope}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Tasks failed: ${res.status}`);
      const json = (await res.json()) as { data: Task[] };
      return sortByDueAsc(json.data.filter((t) => t.status !== 'cancelled'));
    },
    enabled: !!token,
  });

  const isLoading = todayLoading || allLoading;
  const error = todayError?.message ?? allError?.message ?? null;

  const handleRetry = useCallback((): void => {
    void refetchToday();
    void refetchAll();
  }, [refetchToday, refetchAll]);

  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void Promise.all([refetchToday(), refetchAll()]).finally(() => setIsRefreshing(false));
  }, [refetchToday, refetchAll]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<Task>): JSX.Element => {
    const overdue = isOverdue(item);
    const dueDateStr = formatDue(item.due_date);
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() =>
          router.push({ pathname: '/task/[id]', params: { id: item.id } })
        }
        accessibilityRole="button"
      >
        <View style={styles.rowContent}>
          <Text style={[styles.rowTitle, overdue && styles.rowTitleOverdue]}>
            {item.title}
          </Text>
          <View style={styles.rowMeta}>
            {dueDateStr ? (
              <Text style={[styles.rowDate, overdue && styles.rowDateOverdue]}>
                {dueDateStr}
              </Text>
            ) : null}
            <View
              style={[styles.badge, { backgroundColor: badgeColor(item.status) }]}
            >
              <Text style={styles.badgeText}>
                {item.status === 'in_progress'
                  ? t('tasks.inProgress')
                  : item.status === 'done'
                    ? t('tasks.completed')
                    : item.status === 'cancelled'
                      ? t('tasks.cancelled')
                      : t('tasks.pending')}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [t]);

  if (isLoading) {
    return (
      <View style={styles.skeletonContainer}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} style={styles.skeletonRow} />
        ))}
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const displayTasks = activeTab === 'today' ? todayTasks : allTasks;

  return (
    <View style={styles.container}>
      <View style={styles.circle1} pointerEvents="none" />
      <View style={styles.circle2} pointerEvents="none" />
      <View style={styles.circle3} pointerEvents="none" />
      {isManager ? (
        <View style={styles.scopeBar}>
          <TouchableOpacity
            style={[styles.scopePill, scope === 'direct' && styles.scopePillActive]}
            onPress={() => void setScope('direct')}
            accessibilityRole="button"
          >
            <Text style={[styles.scopeText, scope === 'direct' && styles.scopeTextActive]}>
              {t('tasks.scopeDirect')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scopePill, scope === 'subtree' && styles.scopePillActive]}
            onPress={() => void setScope('subtree')}
            accessibilityRole="button"
          >
            <Text style={[styles.scopeText, scope === 'subtree' && styles.scopeTextActive]}>
              {t('tasks.scopeSubtree')}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'today' && styles.tabActive]}
          onPress={() => setActiveTab('today')}
        >
          <Text
            style={[styles.tabText, activeTab === 'today' && styles.tabTextActive]}
          >
            {t('tasks.today')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'all' && styles.tabActive]}
          onPress={() => setActiveTab('all')}
        >
          <Text
            style={[styles.tabText, activeTab === 'all' && styles.tabTextActive]}
          >
            {t('tasks.all')}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={displayTasks}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            colors={['#C45A10']}
            tintColor="#C45A10"
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {activeTab === 'today' ? t('tasks.noToday') : t('tasks.noTasks')}
            </Text>
          </View>
        }
        contentContainerStyle={
          displayTasks.length === 0 ? styles.emptyContent : styles.listContent
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  circle1: {
    position: 'absolute',
    width: 350,
    height: 350,
    borderRadius: 175,
    backgroundColor: 'rgba(6,95,70,0.04)',
    top: -80,
    right: -100,
  },
  circle2: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(6,95,70,0.03)',
    bottom: 100,
    left: -80,
  },
  circle3: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(6,95,70,0.03)',
    top: '40%',
    right: -60,
  },
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 12,
    paddingTop: 16,
  },
  skeletonRow: {
    height: 64,
    backgroundColor: '#FAF6F3',
    borderRadius: 12,
    marginBottom: 8,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#C45A10',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#FAF6F3',
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#C45A10',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#CFADA3',
  },
  tabTextActive: {
    color: '#C45A10',
    fontWeight: '600',
  },
  scopeBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 2,
  },
  scopePill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#EADFD9',
    backgroundColor: '#FAF6F3',
    alignItems: 'center',
  },
  scopePillActive: {
    backgroundColor: '#C45A10',
    borderColor: '#C45A10',
  },
  scopeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#B07868',
  },
  scopeTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  emptyContent: {
    flexGrow: 1,
  },
  emptyContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 14,
    color: '#CFADA3',
  },
  row: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  rowContent: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#383432',
    marginBottom: 6,
  },
  rowTitleOverdue: {
    color: '#ef4444',
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowDate: {
    fontSize: 12,
    color: '#B07868',
  },
  rowDateOverdue: {
    color: '#ef4444',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
