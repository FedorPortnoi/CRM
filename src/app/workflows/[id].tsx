import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
}  from 'react-native';
import type { DimensionValue } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../theme';
import { API_URL } from '../../utils/api';

interface WorkflowRun {
  id: string;
  status: 'success' | 'failed';
  error_message: string | null;
  created_at: string;
}

interface ActionItem {
  type: 'create_task' | 'add_contact_note' | 'update_deal_stage';
  title?: string;
  due_in_days?: number;
  body?: string;
  stage_id?: string;
}

interface WorkflowCondition {
  field: string;
  operator?: string;
  value?: unknown;
}

type ConditionsValue = WorkflowCondition[] | { all: WorkflowCondition[] } | null;

interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  conditions: ConditionsValue;
  actions: ActionItem[];
  status: 'active' | 'paused' | 'archived';
  created_at: string;
  runs: WorkflowRun[];
}

interface WorkflowApiResponse {
  data: WorkflowDetail;
  meta: Record<string, unknown>;
}

interface SkeletonBoxProps {
  width: DimensionValue;
  height: number;
  color: string;
  borderRadius?: number;
  marginBottom?: number;
}

function SkeletonBox({ width, height, color, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: color, borderRadius, marginBottom }} />;
}

const TRIGGER_KEY_MAP: Record<string, string> = {
  contact_created: 'trigger_contact_created',
  deal_stage_changed: 'trigger_deal_stage_changed',
  task_completed: 'trigger_task_completed',
  deal_won: 'trigger_deal_won',
  deal_created: 'trigger_deal_created',
  task_created: 'trigger_task_created',
  deal_stale: 'trigger_deal_stale',
};

function getConditionRows(conditions: ConditionsValue): WorkflowCondition[] {
  if (conditions === null) return [];
  if (Array.isArray(conditions)) return conditions;
  return conditions.all;
}

function getStatusColor(status: WorkflowDetail['status'], colors: ThemeColors): string {
  if (status === 'active') return colors.orange;
  if (status === 'paused') return colors.amber;
  return colors.textMuted;
}

function getActionLabel(action: ActionItem, t: TFunction): string {
  if (action.type === 'create_task') {
    if (typeof action.due_in_days === 'number') {
      return t('workflows.actionCreateTaskWithDeadline', {
        title: action.title ?? '',
        days: action.due_in_days,
      });
    }
    return t('workflows.actionCreateTask', { title: action.title ?? '' });
  }
  if (action.type === 'add_contact_note') {
    return t('workflows.actionAddNote', { body: action.body ?? '' });
  }
  return t('workflows.actionMoveStage', { stageId: action.stage_id ?? '' });
}
export default function WorkflowDetailScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchWorkflow = useCallback(
    (silent: boolean): void => {
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      fetch(API_URL + '/workflows/' + id, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      })
        .then((res) => {
          if (!res.ok) throw new Error(t('workflows.failedToLoad'));
          return res.json() as Promise<WorkflowApiResponse>;
        })
        .then((json) => {
          setWorkflow(json.data);
          setIsLoading(false);
          setIsRefreshing(false);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : t('errors.unknown'));
          setIsLoading(false);
          setIsRefreshing(false);
        });
    },
    [id, t, token],
  );

  useEffect(() => {
    fetchWorkflow(false);
  }, [fetchWorkflow]);

  const onRefresh = (): void => {
    setIsRefreshing(true);
    fetchWorkflow(true);
  };

  const handleToggle = (): void => {
    if (!workflow || isActionLoading) return;
    if (workflow.status === 'archived') return;
    const newStatus: 'active' | 'paused' = workflow.status === 'active' ? 'paused' : 'active';
    setIsActionLoading(true);
    setActionError(null);
    fetch(API_URL + '/workflows/' + id, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: newStatus }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(t('workflows.failedToUpdate'));
        setWorkflow((prev) => (prev ? { ...prev, status: newStatus } : prev));
        setIsActionLoading(false);
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : t('errors.unknown'));
        setIsActionLoading(false);
      });
  };

  const handleDelete = (): void => {
    Alert.alert(
      t('workflows.delete'),
      t('workflows.deleteConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('workflows.delete'),
          style: 'destructive',
          onPress: (): void => {
            setIsActionLoading(true);
            setActionError(null);
            fetch(API_URL + '/workflows/' + id, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer ' + token },
            })
              .then((res) => {
                if (!res.ok) throw new Error(t('workflows.failedToDelete'));
                router.replace('/workflows' as never);
              })
              .catch((err: unknown) => {
                setActionError(err instanceof Error ? err.message : t('errors.unknown'));
                setIsActionLoading(false);
              });
          },
        },
      ],
    );
  };
  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingTop: 16, paddingBottom: 32 }}>
        <Stack.Screen options={{ title: '' }} />
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'60%'} height={22} color={colors.skeleton} marginBottom={12} />
          <SkeletonBox width={'40%'} height={16} color={colors.skeleton} marginBottom={10} />
          <SkeletonBox width={'30%'} height={24} color={colors.skeleton} borderRadius={12} />
        </View>
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'30%'} height={12} color={colors.skeleton} marginBottom={10} />
          <SkeletonBox width={'80%'} height={14} color={colors.skeleton} marginBottom={8} />
          <SkeletonBox width={'70%'} height={14} color={colors.skeleton} />
        </View>
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'30%'} height={12} color={colors.skeleton} marginBottom={10} />
          <SkeletonBox width={'60%'} height={14} color={colors.skeleton} />
        </View>
      </ScrollView>
    );
  }

  if (error !== null || workflow === null) {
    return (
      <View style={styles.errorContainer}>
        <Stack.Screen options={{ title: '' }} />
        <Text style={styles.errorText}>{error ?? t('workflows.notFound')}</Text>
        <TouchableOpacity onPress={() => fetchWorkflow(false)}>
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const conditionRows = getConditionRows(workflow.conditions);
  const triggerLabel = t('workflows.' + (TRIGGER_KEY_MAP[workflow.trigger] ?? workflow.trigger));

  return (
    <View style={styles.outerContainer}>
      <Stack.Screen
        options={{
          title: workflow.name,
          headerRight: () => (
            <TouchableOpacity
              style={styles.headerEditButton}
              onPress={() => router.push(('/workflows/edit/' + id) as never)}
              activeOpacity={0.7}
            >
              <Text style={styles.headerEditText}>{t('workflows.edit')}</Text>
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 32 }}
        refreshControl={(
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={colors.orange}
            colors={[colors.orange]}
            progressBackgroundColor={colors.bgPanel}
          />
        )}
      >
        <View style={styles.card}>
          <Text style={styles.workflowName}>{workflow.name}</Text>
          <Text style={styles.triggerText}>{triggerLabel}</Text>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, { backgroundColor: getStatusColor(workflow.status, colors) }]}>
              <Text
                style={[
                  styles.badgeText,
                  workflow.status === 'archived' ? styles.archivedBadgeText : null,
                ]}
              >
                {workflow.status === 'active'
                  ? t('workflows.enabled')
                  : workflow.status === 'paused'
                  ? t('workflows.disabled')
                  : t('workflows.archived')}
              </Text>
            </View>
          </View>
          {workflow.description !== null && (
            <Text style={styles.descriptionText}>{workflow.description}</Text>
          )}
        </View>
        {workflow.conditions !== null && conditionRows.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>{t('workflows.conditions').toUpperCase()}</Text>
            {conditionRows.map((cond, idx) => (
              <View key={idx} style={styles.conditionRow}>
                <Text style={styles.conditionText}>
                  {cond.field}
                  {cond.operator != null ? ' ' + cond.operator : ''}
                  {cond.value !== undefined ? ' ' + String(cond.value ?? '') : ''}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{t('workflows.actionsSection').toUpperCase()}</Text>
          {workflow.actions.map((action, idx) => (
            <View key={idx} style={styles.actionRow}>
              <Text style={styles.actionIndex}>{String(idx + 1)}.</Text>
              <Text style={styles.actionText}>{getActionLabel(action, t)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{t('workflows.executions').toUpperCase()}</Text>
          {workflow.runs.length === 0 ? (
            <Text style={styles.emptyText}>{t('workflows.noExecutions')}</Text>
          ) : (
            workflow.runs.map((run) => (
              <View key={run.id} style={styles.runRow}>
                <Text style={styles.runDate}>{new Date(run.created_at).toLocaleDateString('ru-RU')}</Text>
                <View
                  style={[
                    styles.runBadge,
                    run.status === 'success' ? styles.runBadgeSuccess : styles.runBadgeFailed,
                  ]}
                >
                  <Text style={styles.runBadgeText}>
                    {run.status === 'success'
                      ? t('workflows.executionSuccess')
                      : t('workflows.executionFailed')}
                  </Text>
                </View>
                {run.error_message !== null && (
                  <Text style={styles.runError}>{run.error_message}</Text>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        {actionError !== null && (
          <Text style={styles.actionError}>{actionError}</Text>
        )}
        <View style={styles.bottomButtons}>
          {workflow.status !== 'archived' && (
            <TouchableOpacity
              style={[
                styles.bottomButton,
                workflow.status === 'active' ? styles.pauseButton : styles.enableButton,
                isActionLoading ? styles.buttonDisabled : null,
              ]}
              onPress={handleToggle}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.bottomButtonText}>
                  {workflow.status === 'active' ? t('workflows.pause') : t('workflows.enable')}
                </Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.bottomButton,
              styles.editButton,
              isActionLoading ? styles.buttonDisabled : null,
            ]}
            onPress={() => router.push(('/workflows/edit/' + id) as never)}
            disabled={isActionLoading}
          >
            <Text style={styles.bottomButtonText}>{t('workflows.editShort')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.bottomButton,
              styles.deleteButton,
              isActionLoading ? styles.buttonDisabled : null,
            ]}
            onPress={handleDelete}
            disabled={isActionLoading}
          >
            <Text style={styles.bottomButtonText}>{t('workflows.delete')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  outerContainer: { flex: 1, backgroundColor: c.bg },
  container: { flex: 1, backgroundColor: c.bg },
  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    shadowColor: c.bgDark,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  skeletonCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    height: 120,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.bg,
    padding: 24,
  },
  errorText: { fontSize: 15, color: c.red, textAlign: 'center', marginBottom: 16 },
  retryText: { fontSize: 15, color: c.orange, fontWeight: '600' },
  workflowName: { fontSize: 22, fontWeight: '700', color: c.text1, marginBottom: 6 },
  triggerText: { fontSize: 14, color: c.amber, marginBottom: 10 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { color: c.bg, fontSize: 12, fontWeight: '600' },
  archivedBadgeText: { color: c.text1 },
  descriptionText: { fontSize: 13, color: c.amber, marginTop: 4 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: c.amber, letterSpacing: 0.5, marginBottom: 10 },
  conditionRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border },
  conditionText: { fontSize: 14, color: c.text1 },
  actionRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: 6,
  },
  actionIndex: { fontSize: 14, fontWeight: '600', color: c.amber, minWidth: 20 },
  actionText: { fontSize: 14, color: c.text1, flex: 1 },
  emptyText: { fontSize: 14, color: c.textMuted, fontStyle: 'italic' },
  runRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border, gap: 4 },
  runDate: { fontSize: 13, color: c.amber, marginBottom: 4 },
  runBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  runBadgeSuccess: { backgroundColor: c.orange },
  runBadgeFailed: { backgroundColor: c.red },
  runBadgeText: { color: c.bg, fontSize: 11, fontWeight: '600' },
  runError: { fontSize: 12, color: c.red, marginTop: 2 },
  bottomBar: {
    backgroundColor: c.bgPanel,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  actionError: { color: c.red, fontSize: 13, textAlign: 'center', marginBottom: 8 },
  bottomButtons: { flexDirection: 'row', gap: 8 },
  bottomButton: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  pauseButton: { backgroundColor: c.amber },
  enableButton: { backgroundColor: c.orange },
  editButton: { backgroundColor: c.orange },
  deleteButton: { backgroundColor: c.red },
  bottomButtonText: { color: c.bg, fontSize: 14, fontWeight: '600' },
  buttonDisabled: { opacity: 0.6 },
  headerEditButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerEditText: { color: c.orange, fontSize: 16, fontWeight: '600' },
});
