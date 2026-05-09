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
      return '#34A853';
    case 'in_progress':
      return '#1A73E8';
    case 'pending':
      return '#E8A000';
    default:
      return '#9B9B9B';
  }
}

export default function TasksScreen(): JSX.Element {
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
      setError(e instanceof Error ? e.message : 'Failed to load tasks');
    } finally {
      setIsLoading(false);
    }
  }, [token]);

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
                {item.status.replace('_', ' ')}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  }, []);

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
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const displayTasks = activeTab === 'today' ? todayTasks : allTasks;

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'today' && styles.tabActive]}
          onPress={() => setActiveTab('today')}
        >
          <Text
            style={[styles.tabText, activeTab === 'today' && styles.tabTextActive]}
          >
            Today
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'all' && styles.tabActive]}
          onPress={() => setActiveTab('all')}
        >
          <Text
            style={[styles.tabText, activeTab === 'all' && styles.tabTextActive]}
          >
            All
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
            colors={['#1A73E8']}
            tintColor="#1A73E8"
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {activeTab === 'today' ? 'No tasks due today' : 'No tasks'}
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
    backgroundColor: '#F5F5F5',
  },
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    padding: 12,
    paddingTop: 16,
  },
  skeletonRow: {
    height: 64,
    backgroundColor: '#E8E8E8',
    borderRadius: 8,
    marginBottom: 8,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#F5F5F5',
  },
  errorText: {
    color: '#D93025',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1A73E8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
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
    borderBottomColor: '#E0E0E0',
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#1A73E8',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B6B6B',
  },
  tabTextActive: {
    color: '#1A73E8',
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
    color: '#9B9B9B',
  },
  row: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 8,
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
    color: '#1A1A1A',
    marginBottom: 6,
  },
  rowTitleOverdue: {
    color: '#D93025',
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowDate: {
    fontSize: 12,
    color: '#6B6B6B',
  },
  rowDateOverdue: {
    color: '#D93025',
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
