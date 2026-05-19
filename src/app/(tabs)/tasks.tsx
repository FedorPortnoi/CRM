import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ListRenderItemInfo,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
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
      return '#065f46';
    case 'in_progress':
      return '#f59e0b';
    case 'pending':
      return '#E8A000';
    default:
      return '#9ca3af';
  }
}

export default function TasksScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [todayTasks, setTodayTasks] = useState<Task[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('today');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const fetchTasks = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      setError(null);
      const [todayRes, allRes] = await Promise.all([
        fetch(`${API_URL}/tasks/today`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/tasks?per_page=100`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!todayRes.ok) throw new Error(`Tasks/today failed: ${todayRes.status}`);
      if (!allRes.ok) throw new Error(`Tasks failed: ${allRes.status}`);

      const todayJson = (await todayRes.json()) as { data: Task[] };
      const allJson = (await allRes.json()) as { data: Task[] };

      setTodayTasks(sortByDueAsc(todayJson.data));
      setAllTasks(
        sortByDueAsc(allJson.data.filter((t) => t.status !== 'cancelled')),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setIsLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const handleRetry = useCallback((): void => {
    setIsLoading(true);
    void fetchTasks();
  }, [fetchTasks]);

  const handleRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void fetchTasks().finally(() => setIsRefreshing(false));
  }, [fetchTasks]);

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
            colors={['#065f46']}
            tintColor="#065f46"
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
    backgroundColor: '#f3f4f6',
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
    backgroundColor: '#065f46',
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
    borderBottomColor: '#f3f4f6',
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#065f46',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#9ca3af',
  },
  tabTextActive: {
    color: '#065f46',
    fontWeight: '600',
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
    color: '#9ca3af',
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
    color: '#111827',
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
    color: '#6b7280',
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
