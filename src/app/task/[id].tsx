import { useState, useCallback, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import AttachmentsSection from '../../components/AttachmentsSection';
import ReminderSummaryList from '../../components/reminders/ReminderSummaryList';
import { cancelTaskDueReminder } from '../../utils/notifications';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import { formatMarketDate } from '../../market/profile';
import { labelKeyForRule } from '../../utils/recurrence';
import { useAuditLog } from '../../hooks/useAuditLog';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Screen, Card, Button, Badge, EmptyState, Skeleton, SkeletonText } from '../../components/ui';
import type { BadgeVariant } from '../../components/ui';

interface TaskAssignee {
  id: string;
  name: string;
}
interface TaskContact {
  id: string;
  first_name: string;
  last_name: string | null;
}

function taskActionLabel(action: string): string {
  const map: Record<string, string> = {
    created: 'Создана',
    updated: 'Обновлена',
    completed: 'Завершена',
  };
  return map[action] ?? action;
}

function taskActionVariant(action: string): BadgeVariant {
  if (action === 'created') return 'accent';
  if (action === 'completed') return 'success';
  return 'neutral';
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

function priorityVariant(priority: string): BadgeVariant {
  if (priority === 'urgent') return 'danger';
  if (priority === 'high') return 'warning';
  if (priority === 'medium') return 'accent';
  return 'neutral';
}

function statusVariant(status: string): BadgeVariant {
  if (status === 'done') return 'success';
  if (status === 'in_progress') return 'accent';
  if (status === 'pending') return 'warning';
  return 'neutral';
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

export default function TaskDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [task, setTask] = useState<Task | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: auditLog = [] } = useAuditLog('task', id);

  const fetchTask = useCallback(
    async (refreshing: boolean, signal?: AbortSignal): Promise<void> => {
      if (refreshing) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      try {
        const res = await fetch(API_URL + '/tasks/' + id, {
          headers: { Authorization: 'Bearer ' + token },
          signal,
        });
        if (signal?.aborted) return;
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
      } catch (e: unknown) {
        if ((e as Error)?.name === 'AbortError') return;
        setFetchError(t('tasks.failedToLoad'));
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [id, t, token],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchTask(false, controller.signal);
    return () => controller.abort();
  }, [fetchTask]);

  const onRefresh = useCallback((): void => { void fetchTask(true); }, [fetchTask]);

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
        <Screen contentContainerStyle={styles.contentPad}>
          <Card style={styles.cardSpacing}>
            <Skeleton width="70%" height={22} style={styles.skeletonGapMd} />
            <Skeleton width="45%" height={16} style={styles.skeletonGapMd} />
            <View style={styles.badgeRow}>
              <Skeleton width={72} height={24} rounded={radius.pill} />
              <Skeleton width={72} height={24} rounded={radius.pill} />
            </View>
          </Card>
          <Card style={styles.cardSpacing}>
            <SkeletonText lines={2} lastLineWidth="60%" />
          </Card>
          <Card>
            <SkeletonText lines={3} lastLineWidth="50%" />
          </Card>
        </Screen>
      </>
    );
  }

  if (fetchError) {
    return (
      <>
        <Stack.Screen options={{ title: t('tasks.task') }} />
        <View style={styles.errorContainer}>
          <EmptyState
            icon={<AlertCircle size={32} color={colors.danger} strokeWidth={2} />}
            title={fetchError}
            actionLabel={t('common.retry')}
            onAction={() => fetchTask(false)}
          />
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
      <Screen
        refreshing={isRefreshing}
        onRefresh={onRefresh}
        contentContainerStyle={styles.contentPad}
      >
        <Card style={styles.cardSpacing}>
          <Text style={styles.taskTitle}>{task.title}</Text>
          {task.due_date ? (
            <Text style={[styles.dueDate, styles.tabular, dueDateOverdue ? styles.dueDateOverdue : null]}>{t('tasks.dueOn', { date: formatDate(task.due_date) })}</Text>
          ) : null}
          <View style={styles.badgeRow}>
            <Badge label={formatPriority(task.priority, t)} variant={priorityVariant(task.priority)} />
            <Badge label={formatStatus(task.status, t)} variant={statusVariant(task.status)} />
          </View>
        </Card>

        {task.status === 'cancelled' ? (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledText}>{t('tasks.cancelledBanner')}</Text>
          </View>
        ) : null}

        <Card style={styles.cardSpacing}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('tasks.assigned')}</Text>
            <Text style={styles.detailValue}>{task.assignee.name}</Text>
          </View>
          <View style={[styles.detailRow, styles.detailRowSpaced]}>
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
          <View style={[styles.detailRow, styles.detailRowSpaced]}>
            <Text style={styles.detailLabel}>{t('tasks.repeat')}</Text>
            <Text style={task.is_recurring ? styles.recurrenceValue : styles.detailValue}>
              {formatRecurrence(task.is_recurring, task.recurrence_rule, t)}
            </Text>
          </View>
        </Card>

        {/* The schedule behind the task — when it reminds, how often, and until when. */}
        <ReminderSummaryList taskId={id as string} />

        <Card style={styles.cardSpacing}>
          <Text style={styles.sectionLabel}>{t('tasks.notes')}</Text>
          <Text style={task.description ? styles.notesText : styles.emptyText}>{task.description ?? t('tasks.noNotes')}</Text>
        </Card>

        {hasActions ? (
          <Card style={styles.cardSpacing}>
            {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
            <View style={styles.actionStack}>
              {showCompleteButton ? (
                <Button
                  title={completeLabel}
                  onPress={() => { handleComplete().catch(() => undefined); }}
                  loading={isActionLoading}
                  disabled={isActionLoading}
                  block
                />
              ) : null}
              {showCancelButton ? (
                <Button
                  title={t('tasks.cancelTask')}
                  onPress={() => { handleCancel().catch(() => undefined); }}
                  loading={isActionLoading}
                  disabled={isActionLoading}
                  variant="danger"
                  block
                />
              ) : null}
            </View>
          </Card>
        ) : null}

        {/* Activity log */}
        <Card>
          <Text style={styles.sectionLabel}>{t('contacts.activityLog')}</Text>
          {auditLog.length === 0 ? (
            <EmptyState title={t('contacts.noActivity')} style={styles.auditEmpty} />
          ) : (
            auditLog.map((entry) => (
              <View key={entry.id} style={styles.auditRow}>
                <Badge label={taskActionLabel(entry.action)} variant={taskActionVariant(entry.action)} />
                <Text style={[styles.auditDate, styles.tabular]}>{new Date(entry.created_at).toLocaleDateString('ru-RU')}</Text>
              </View>
            ))
          )}
        </Card>

        <AttachmentsSection entityType="task" entityId={id as string} />
      </Screen>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  contentPad: {
    paddingTop: spacing.lg,
  },
  cardSpacing: {
    marginBottom: spacing.lg,
  },
  skeletonGapMd: {
    marginBottom: spacing.sm,
  },
  taskTitle: {
    ...type.title,
    color: c.text1,
    marginBottom: spacing.sm,
  },
  dueDate: { ...type.body, color: c.textMuted },
  dueDateOverdue: { color: c.danger, fontWeight: '600' },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  cancelledBanner: {
    marginBottom: spacing.lg,
    backgroundColor: c.dangerSoft,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: c.danger,
  },
  cancelledText: { ...type.body, color: c.danger, fontWeight: '600' },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailRowSpaced: { marginTop: spacing.md },
  detailLabel: { ...type.body, color: c.textMuted, width: 100 },
  detailValue: { ...type.body, color: c.text1, flex: 1, textAlign: 'right' },
  recurrenceValue: { ...type.body, color: c.accent, flex: 1, textAlign: 'right', fontWeight: '600' },
  linkText: {
    ...type.body,
    color: c.accent,
    fontWeight: '600',
    textAlign: 'right',
  },
  sectionLabel: {
    ...type.micro,
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  notesText: { ...type.body, color: c.text1, lineHeight: 20 },
  emptyText: { ...type.body, color: c.textMuted },
  actionStack: { gap: spacing.sm },
  actionError: {
    ...type.caption,
    color: c.danger,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: c.bg,
  },
  auditEmpty: {
    paddingVertical: spacing.md,
    paddingHorizontal: 0,
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  auditDate: {
    ...type.caption,
    color: c.textMuted,
  },
  headerEditButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  headerEditText: {
    color: c.accent,
    ...type.heading,
  },
});
