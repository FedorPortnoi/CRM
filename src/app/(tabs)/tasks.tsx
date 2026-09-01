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
import { router, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ListChecks } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { useTaskScopeStore } from '../../store/taskScopeStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Badge, BadgeVariant, EmptyState, Skeleton } from '../../components/ui';

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
  return new Date(due).toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' });
}

/** Status reads through the semantic palette: done is green, not accent. */
function badgeVariant(status: TaskStatus): BadgeVariant {
  switch (status) {
    case 'done':
      return 'success';
    case 'in_progress':
      return 'accent';
    case 'pending':
      return 'warning';
    default:
      return 'neutral';
  }
}

export default function TasksScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
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
      const res = await fetch(`${API_URL}/tasks?per_page=100&scope=${scope}&sort=due_date&order=asc`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Tasks failed: ${res.status}`);
      const json = (await res.json()) as { data: Task[] };
      return json.data.filter((t) => t.status !== 'cancelled');
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
        activeOpacity={0.7}
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
            <Badge
              variant={badgeVariant(item.status)}
              label={
                item.status === 'in_progress'
                  ? t('tasks.inProgress')
                  : item.status === 'done'
                    ? t('tasks.completed')
                    : item.status === 'cancelled'
                      ? t('tasks.cancelled')
                      : t('tasks.pending')
              }
            />
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [t, styles]);

  if (isLoading) {
    return (
      <View style={styles.skeletonContainer}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} height={64} rounded={radius.lg} style={styles.skeletonRow} />
        ))}
      </View>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={48} color={colors.danger} strokeWidth={1.5} />}
        title={error}
        actionLabel={t('common.retry')}
        onAction={handleRetry}
      />
    );
  }

  const displayTasks = activeTab === 'today' ? todayTasks : allTasks;

  return (
    <View style={styles.container}>
      {isManager ? (
        <View style={styles.scopeBar}>
          <TouchableOpacity
            style={[styles.scopePill, scope === 'direct' && styles.scopePillActive]}
            onPress={() => void setScope('direct')}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === 'direct' }}
            activeOpacity={0.7}
          >
            <Text style={[styles.scopeText, scope === 'direct' && styles.scopeTextActive]}>
              {t('tasks.scopeDirect')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.scopePill, scope === 'subtree' && styles.scopePillActive]}
            onPress={() => void setScope('subtree')}
            accessibilityRole="button"
            accessibilityState={{ selected: scope === 'subtree' }}
            activeOpacity={0.7}
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
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'today' }}
          activeOpacity={0.7}
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
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'all' }}
          activeOpacity={0.7}
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
            colors={[colors.accent]}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <EmptyState
            icon={<ListChecks size={48} color={colors.skeleton} strokeWidth={1.5} />}
            title={activeTab === 'today' ? t('tasks.noToday') : t('tasks.noTasks')}
          />
        }
        contentContainerStyle={
          displayTasks.length === 0 ? styles.emptyContent : styles.listContent
        }
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  skeletonContainer: {
    flex: 1,
    backgroundColor: c.surface,
    padding: spacing.md,
    paddingTop: spacing.lg,
  },
  skeletonRow: {
    marginBottom: spacing.sm,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.bg,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: c.accent,
  },
  tabText: {
    ...type.body,
    color: c.textMuted,
  },
  tabTextActive: {
    color: c.accent,
    fontWeight: '600',
  },
  scopeBar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  scopePill: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bg,
    alignItems: 'center',
  },
  scopePillActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  scopeText: {
    ...type.label,
    color: c.amber,
  },
  scopeTextActive: {
    color: c.onAccent,
  },
  listContent: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  emptyContent: {
    flexGrow: 1,
  },
  row: {
    backgroundColor: c.surface,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
  },
  rowContent: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowTitle: {
    ...type.heading,
    fontWeight: '600',
    color: c.text1,
    marginBottom: spacing.sm,
  },
  rowTitleOverdue: {
    color: c.danger,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowDate: {
    ...type.caption,
    color: c.amber,
    fontVariant: ['tabular-nums'],
  },
  rowDateOverdue: {
    color: c.danger,
  },
});
