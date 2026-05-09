import React, { useState, useCallback, useEffect } from 'react';
import { StyleSheet, ScrollView, View, Text, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { cancelTaskDueReminder, scheduleTaskDueReminder } from '../../utils/notifications';

interface TaskAssignee {
  id: string;
  name: string;
}
interface TaskContact {
  id: string;
  first_name: string;
  last_name: string | null;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  due_date: string | null;
  assignee: TaskAssignee;
  contact: TaskContact | null;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function isOverdue(due_date: string | null, status: string): boolean {
  if (!due_date) return false;
  if (status === 'done' || status === 'cancelled') return false;
  return new Date(due_date) < new Date();
}

function priorityBadgeColor(priority: string): string {
  if (priority === 'urgent') return '#D93025';
  if (priority === 'high') return '#E8A000';
  if (priority === 'medium') return '#1A73E8';
  return '#9B9B9B';
}

function statusBadgeColor(status: string): string {
  if (status === 'done') return '#34A853';
  if (status === 'in_progress') return '#1A73E8';
  if (status === 'pending') return '#E8A000';
  return '#9B9B9B';
}

interface SkeletonBoxProps {
  width: number;
  height: number;
  borderRadius?: number;
  marginBottom?: number;
}

function SkeletonBox({ width, height, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return (
    <View
      style={{
        width,
        height,
        backgroundColor: '#E8E8E8',
        borderRadius,
        marginBottom,
      }}
    />
  );
}

export default function TaskDetailScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [task, setTask] = useState<Task | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchTask = useCallback(
    async (refreshing: boolean): Promise<void> => {
      if (refreshing) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      try {
        const res = await fetch(API_URL + '/tasks/' + id, {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) {
          const body = (await res.json()) as {
            error: { code: string; message: string };
          };
          setFetchError(body.error.message);
        } else {
          const body = (await res.json()) as { data: Task };
          setTask(body.data);
          setFetchError(null);
        }
      } catch {
        setFetchError('Failed to load task');
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [id, token],
  );

  useEffect(() => {
    fetchTask(false);
  }, [fetchTask]);
  const onRefresh = useCallback((): void => {
    fetchTask(true);
  }, [fetchTask]);

  async function handleComplete(): Promise<void> {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(API_URL + '/tasks/' + id + '/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) {
        const body = (await res.json()) as {
          error: { code: string; message: string };
        };
        setActionError(body.error.message);
      } else {
        const body = (await res.json()) as { data: Task };
        try {
          if (body.data.status === 'done') {
            await cancelTaskDueReminder(id);
          } else if (body.data.due_date) {
            await scheduleTaskDueReminder(id, body.data.title, body.data.due_date);
          }
        } catch {
          // The server action succeeded; reminder cleanup is best-effort.
        }
        router.back();
      }
    } catch {
      setActionError('Action failed. Please try again.');
    } finally {
      setIsActionLoading(false);
    }
  }

  async function handleCancel(): Promise<void> {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const res = await fetch(API_URL + '/tasks/' + id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) {
        const body = (await res.json()) as {
          error: { code: string; message: string };
        };
        setActionError(body.error.message);
      } else {
        try {
          await cancelTaskDueReminder(id);
        } catch {
          // The server action succeeded; reminder cleanup is best-effort.
        }
        router.back();
      }
    } catch {
      setActionError('Action failed. Please try again.');
    } finally {
      setIsActionLoading(false);
    }
  }

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Task' }} />
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <SkeletonBox width={240} height={20} marginBottom={12} />
            <SkeletonBox width={160} height={13} marginBottom={14} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SkeletonBox width={72} height={22} borderRadius={4} />
              <SkeletonBox width={72} height={22} borderRadius={4} />
            </View>
          </View>
          <View style={[styles.card, { marginTop: 16 }]}>
            {([0, 1] as const).map((i) => (
              <View key={i} style={[styles.detailRow, i > 0 ? { marginTop: 12 } : {}]}>
                <SkeletonBox width={64} height={12} />
                <SkeletonBox width={150} height={12} />
              </View>
            ))}
          </View>
          <View style={[styles.card, { marginTop: 16 }]}>
            <SkeletonBox width={48} height={12} marginBottom={10} />
            <SkeletonBox width={220} height={12} marginBottom={6} />
            <SkeletonBox width={180} height={12} />
          </View>
        </ScrollView>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Task' }} />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{fetchError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchTask(false)}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  if (!task) return <></>;

  const contactName = task.contact
    ? task.contact.last_name
      ? task.contact.first_name + ' ' + task.contact.last_name
      : task.contact.first_name
    : null;

  const dueDateOverdue = isOverdue(task.due_date, task.status);
  const showCompleteButton = task.status !== 'cancelled';
  const showCancelButton = task.status !== 'done' && task.status !== 'cancelled';
  const completeLabel = task.status === 'done' ? 'Mark Incomplete' : 'Mark Complete';
  const hasActions = showCompleteButton || showCancelButton;

  return (
    <>
      <Stack.Screen
        options={{
          title: task.title,
          headerBackTitle: 'Tasks',
          headerRight: () => (
            <TouchableOpacity
              style={styles.headerEditButton}
              onPress={() => router.push({ pathname: '/task/edit/[id]', params: { id } })}
              activeOpacity={0.7}
            >
              <Text style={styles.headerEditText}>Edit</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.card}>
          <Text style={styles.taskTitle}>{task.title}</Text>
          {task.due_date ? (
            <Text style={[styles.dueDate, dueDateOverdue ? styles.dueDateOverdue : null]}>Due {formatDate(task.due_date)}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <View style={[styles.badge, { backgroundColor: priorityBadgeColor(task.priority) }]}>
              <Text style={styles.badgeText}>{task.priority}</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: statusBadgeColor(task.status) }]}>
              <Text style={styles.badgeText}>{task.status.replace('_', ' ')}</Text>
            </View>
          </View>
        </View>

        {task.status === 'cancelled' ? (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledText}>This task has been cancelled</Text>
          </View>
        ) : null}

        <View style={[styles.card, { marginTop: 16 }]}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Assigned</Text>
            <Text style={styles.detailValue}>{task.assignee.name}</Text>
          </View>
          <View style={[styles.detailRow, { marginTop: 12 }]}>
            <Text style={styles.detailLabel}>Contact</Text>
            {task.contact !== null && contactName !== null ? (
              <TouchableOpacity
                onPress={() =>
                  router.push({
                    pathname: '/contact/[id]',
                    params: { id: task.contact!.id },
                  })
                }
                activeOpacity={0.7}
              >
                <Text style={styles.linkText}>{contactName}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.detailValue}>None</Text>
            )}
          </View>
        </View>

        <View style={[styles.card, { marginTop: 16 }]}>
          <Text style={styles.sectionLabel}>Notes</Text>
          <Text style={task.description ? styles.notesText : styles.emptyText}>{task.description ?? 'No notes'}</Text>
        </View>

        {hasActions ? (
          <View style={[styles.card, { marginTop: 16 }]}>
            {actionError ? <Text style={[styles.errorText, { marginBottom: 12 }]}>{actionError}</Text> : null}
            {showCompleteButton ? (
              <TouchableOpacity
                style={[styles.button, styles.buttonPrimary, isActionLoading ? styles.buttonDisabled : null]}
                onPress={handleComplete}
                disabled={isActionLoading}
                activeOpacity={0.7}
              >
                {isActionLoading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.buttonText}>{completeLabel}</Text>
                )}
              </TouchableOpacity>
            ) : null}
            {showCancelButton ? (
              <TouchableOpacity
                style={[
                  styles.button,
                  styles.buttonDestructive,
                  showCompleteButton ? { marginTop: 10 } : null,
                  isActionLoading ? styles.buttonDisabled : null,
                ]}
                onPress={handleCancel}
                disabled={isActionLoading}
                activeOpacity={0.7}
              >
                <Text style={styles.buttonText}>Cancel Task</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  taskTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1A1A1A',
    marginBottom: 6,
  },
  dueDate: { fontSize: 13, color: '#6B6B6B' },
  dueDateOverdue: { color: '#D93025', fontWeight: '500' },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  cancelledBanner: {
    marginTop: 12,
    backgroundColor: '#FEE8E6',
    borderRadius: 8,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#D93025',
  },
  cancelledText: { fontSize: 13, color: '#D93025', fontWeight: '500' },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailLabel: { fontSize: 13, color: '#9B9B9B', width: 72 },
  detailValue: { fontSize: 13, color: '#1A1A1A', flex: 1, textAlign: 'right' },
  linkText: {
    fontSize: 13,
    color: '#1A73E8',
    fontWeight: '500',
    textAlign: 'right',
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9B9B9B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  notesText: { fontSize: 14, color: '#1A1A1A', lineHeight: 20 },
  emptyText: { fontSize: 14, color: '#9B9B9B' },
  button: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: '#1A73E8' },
  buttonDestructive: { backgroundColor: '#D93025' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#D93025',
    textAlign: 'center',
    marginBottom: 8,
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1A73E8',
    borderRadius: 6,
  },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  headerEditButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerEditText: {
    color: '#1A73E8',
    fontSize: 16,
    fontWeight: '600',
  },
});
