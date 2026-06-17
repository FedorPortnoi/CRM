import React, { useState, useCallback, useEffect } from 'react';
import { StyleSheet, ScrollView, View, Text, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import AttachmentsSection from '../../components/AttachmentsSection';
import { cancelTaskDueReminder, scheduleTaskDueReminder } from '../../utils/notifications';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import { formatMarketDate } from '../../market/profile';
import { labelKeyForRule } from '../../utils/recurrence';

interface TaskAssignee {
  id: string;
  name: string;
}
interface TaskContact {
  id: string;
  first_name: string;
  last_name: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  created_at: string;
}

function taskActionLabel(action: string): string {
  const map: Record<string, string> = {
    created: 'Создана',
    updated: 'Обновлена',
    completed: 'Завершена',
  };
  return map[action] ?? action;
}

function taskActionColor(action: string): { bg: string; text: string } {
  if (action === 'created') return { bg: '#FEF0E8', text: '#C45A10' };
  if (action === 'completed') return { bg: '#dcfce7', text: '#16a34a' };
  return { bg: '#FAF6F3', text: '#383432' };
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  due_date: string | null;
  is_recurring: boolean;
  recurrence_rule: string | null;
  assignee: TaskAssignee;
  contact: TaskContact | null;
}

function formatDate(dateStr: string): string {
  return formatMarketDate(dateStr, {
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
  if (priority === 'urgent') return '#ef4444';
  if (priority === 'high') return '#E8A000';
  if (priority === 'medium') return '#C4704F';
  return '#CFADA3';
}

function statusBadgeColor(status: string): string {
  if (status === 'done') return '#C4704F';
  if (status === 'in_progress') return '#C4704F';
  if (status === 'pending') return '#E8A000';
  return '#CFADA3';
}

function formatRecurrence(isRecurring: boolean, rule: string | null, t: (key: string) => string): string {
  if (!isRecurring || !rule) return t('tasks.recurrenceNone');
  const labelKey = labelKeyForRule(rule);
  return labelKey ? t(labelKey) : rule;
}

const PRIORITY_LABEL_KEYS: Record<string, string> = {
  low: 'tasks.priorityLow',
  medium: 'tasks.priorityMedium',
  high: 'tasks.priorityHigh',
  urgent: 'tasks.priorityUrgent',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'tasks.statusPending',
  in_progress: 'tasks.statusInProgress',
  done: 'tasks.statusDone',
  cancelled: 'tasks.statusCancelled',
};

function formatPriority(priority: string, t: (key: string) => string): string {
  const key = PRIORITY_LABEL_KEYS[priority];
  return key ? t(key) : priority;
}

function formatStatus(status: string, t: (key: string) => string): string {
  const key = STATUS_LABEL_KEYS[status];
  return key ? t(key) : status.replace('_', ' ');
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
        backgroundColor: '#FEF0E8',
        borderRadius,
        marginBottom,
      }}
    />
  );
}

export default function TaskDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [task, setTask] = useState<Task | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

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
        setFetchError(t('tasks.failedToLoad'));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [id, t, token],
  );

  const fetchAuditLog = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    try {
      const res = await fetch(`${API_URL}/activities?entity_type=task&entity_id=${id}`, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { data: AuditEntry[] };
      setAuditLog(body.data);
    } catch { /* silent */ }
  }, [id, token]);

  useEffect(() => {
    void fetchTask(false);
    void fetchAuditLog();
  }, [fetchTask, fetchAuditLog]);
  const onRefresh = useCallback((): void => {
    void fetchTask(true);
    void fetchAuditLog();
  }, [fetchTask, fetchAuditLog]);

  async function handleComplete(): Promise<void> {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const result = await sendOrQueueMutation({
        url: API_URL + '/tasks/' + id + '/complete',
        method: 'POST',
        token: token ?? '',
      });
      if (result.queued) {
        await cancelTaskDueReminder(id);
        router.back();
        return;
      }
      const res = result.response;
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
      setActionError(t('tasks.actionFailed'));
    } finally {
      setIsActionLoading(false);
    }
  }

  async function handleCancel(): Promise<void> {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const result = await sendOrQueueMutation({
        url: API_URL + '/tasks/' + id,
        method: 'DELETE',
        token: token ?? '',
      });
      if (result.queued) {
        await cancelTaskDueReminder(id);
        router.back();
        return;
      }
      const res = result.response;
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
      setActionError(t('tasks.actionFailed'));
    } finally {
      setIsActionLoading(false);
    }
  }

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: t('tasks.task') }} />
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
        <Stack.Screen options={{ title: t('tasks.task') }} />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{fetchError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchTask(false)}>
            <Text style={styles.retryText}>{t('common.retry')}</Text>
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
  const completeLabel = task.status === 'done' ? t('tasks.markIncomplete') : t('tasks.markComplete');
  const hasActions = showCompleteButton || showCancelButton;

  return (
    <>
      <Stack.Screen
        options={{
          title: task.title,
          headerRight: () => (
            <TouchableOpacity
              style={styles.headerEditButton}
              onPress={() => router.push({ pathname: '/task/edit/[id]', params: { id } })}
              activeOpacity={0.7}
            >
              <Text style={styles.headerEditText}>{t('common.edit')}</Text>
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
            <Text style={[styles.dueDate, dueDateOverdue ? styles.dueDateOverdue : null]}>{t('tasks.dueOn', { date: formatDate(task.due_date) })}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <View style={[styles.badge, { backgroundColor: priorityBadgeColor(task.priority) }]}>
              <Text style={styles.badgeText}>{formatPriority(task.priority, t)}</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: statusBadgeColor(task.status) }]}>
              <Text style={styles.badgeText}>{formatStatus(task.status, t)}</Text>
            </View>
          </View>
        </View>

        {task.status === 'cancelled' ? (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledText}>{t('tasks.cancelledBanner')}</Text>
          </View>
        ) : null}

        <View style={[styles.card, { marginTop: 16 }]}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('tasks.assigned')}</Text>
            <Text style={styles.detailValue}>{task.assignee.name}</Text>
          </View>
          <View style={[styles.detailRow, { marginTop: 12 }]}>
            <Text style={styles.detailLabel}>{t('tasks.contact')}</Text>
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
              <Text style={styles.detailValue}>{t('tasks.none')}</Text>
            )}
          </View>
          <View style={[styles.detailRow, { marginTop: 12 }]}>
            <Text style={styles.detailLabel}>{t('tasks.repeat')}</Text>
            <Text style={task.is_recurring ? styles.recurrenceValue : styles.detailValue}>
              {formatRecurrence(task.is_recurring, task.recurrence_rule, t)}
            </Text>
          </View>
        </View>

        <View style={[styles.card, { marginTop: 16 }]}>
          <Text style={styles.sectionLabel}>{t('tasks.notes')}</Text>
          <Text style={task.description ? styles.notesText : styles.emptyText}>{task.description ?? t('tasks.noNotes')}</Text>
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
                <Text style={styles.buttonText}>{t('tasks.cancelTask')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        {/* Activity log */}
        <View style={styles.auditSection}>
          <Text style={styles.auditSectionTitle}>{t('contacts.activityLog')}</Text>
          {auditLog.length === 0 ? (
            <Text style={styles.auditEmpty}>{t('contacts.noActivity')}</Text>
          ) : (
            auditLog.map((entry) => {
              const colors = taskActionColor(entry.action);
              return (
                <View key={entry.id} style={styles.auditRow}>
                  <View style={[styles.auditBadge, { backgroundColor: colors.bg }]}>
                    <Text style={[styles.auditBadgeText, { color: colors.text }]}>{taskActionLabel(entry.action)}</Text>
                  </View>
                  <Text style={styles.auditDate}>{new Date(entry.created_at).toLocaleDateString('ru-RU')}</Text>
                </View>
              );
            })
          )}
        </View>

        <AttachmentsSection entityType="task" entityId={id as string} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FEF0E8' },
  content: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
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
    color: '#383432',
    marginBottom: 6,
  },
  dueDate: { fontSize: 13, color: '#B07868' },
  dueDateOverdue: { color: '#ef4444', fontWeight: '500' },
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
  },
  cancelledBanner: {
    marginTop: 12,
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#ef4444',
  },
  cancelledText: { fontSize: 13, color: '#ef4444', fontWeight: '500' },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailLabel: { fontSize: 13, color: '#CFADA3', width: 100 },
  detailValue: { fontSize: 13, color: '#383432', flex: 1, textAlign: 'right' },
  recurrenceValue: { fontSize: 13, color: '#C45A10', flex: 1, textAlign: 'right', fontWeight: '600' },
  linkText: {
    fontSize: 13,
    color: '#C4704F',
    fontWeight: '500',
    textAlign: 'right',
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#CFADA3',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  notesText: { fontSize: 14, color: '#383432', lineHeight: 20 },
  emptyText: { fontSize: 14, color: '#CFADA3' },
  button: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: '#C4704F' },
  buttonDestructive: { backgroundColor: '#ef4444' },
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
    color: '#ef4444',
    textAlign: 'center',
    marginBottom: 8,
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#C4704F',
    borderRadius: 6,
  },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  auditSection: {
    marginTop: 16,
  },
  auditSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#B07868',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  auditEmpty: {
    fontSize: 13,
    color: '#CFADA3',
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#FAF6F3',
  },
  auditBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  auditBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  auditDate: {
    fontSize: 12,
    color: '#CFADA3',
  },
  headerEditButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerEditText: {
    color: '#C4704F',
    fontSize: 16,
    fontWeight: '600',
  },
});
