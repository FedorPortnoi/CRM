import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
}  from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, tabular } from '../../theme';
import { Card, Badge, EmptyState, Skeleton, Button } from '../../components/ui';
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

function getStatusVariant(status: WorkflowDetail['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
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
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Stack.Screen options={{ title: '' }} />
        <Card style={styles.card}>
          <Skeleton width={'60%'} height={22} style={styles.skeletonLine} />
          <Skeleton width={'40%'} height={16} style={styles.skeletonLine} />
          <Skeleton width={'30%'} height={24} rounded={radius.lg} />
        </Card>
        <Card style={styles.card}>
          <Skeleton width={'30%'} height={12} style={styles.skeletonLine} />
          <Skeleton width={'80%'} height={14} style={styles.skeletonLine} />
          <Skeleton width={'70%'} height={14} />
        </Card>
        <Card style={styles.card}>
          <Skeleton width={'30%'} height={12} style={styles.skeletonLine} />
          <Skeleton width={'60%'} height={14} />
        </Card>
      </ScrollView>
    );
  }

  if (error !== null || workflow === null) {
    return (
      <View style={styles.errorContainer}>
        <Stack.Screen options={{ title: '' }} />
        <EmptyState
          title={error ?? t('workflows.notFound')}
          actionLabel={t('common.retry')}
          onAction={() => fetchWorkflow(false)}
        />
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
        contentContainerStyle={styles.scrollContent}
        refreshControl={(
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.bgPanel}
          />
        )}
      >
        <Card style={styles.card}>
          <Text style={styles.workflowName}>{workflow.name}</Text>
          <Text style={styles.triggerText}>{triggerLabel}</Text>
          <View style={styles.badgeRow}>
            <Badge
              variant={getStatusVariant(workflow.status)}
              label={
                workflow.status === 'active'
                  ? t('workflows.enabled')
                  : workflow.status === 'paused'
                  ? t('workflows.disabled')
                  : t('workflows.archived')
              }
            />
          </View>
          {workflow.description !== null && (
            <Text style={styles.descriptionText}>{workflow.description}</Text>
          )}
        </Card>
        {workflow.conditions !== null && conditionRows.length > 0 && (
          <Card style={styles.card}>
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
          </Card>
        )}

        <Card style={styles.card}>
          <Text style={styles.sectionLabel}>{t('workflows.actionsSection').toUpperCase()}</Text>
          {workflow.actions.map((action, idx) => (
            <View key={idx} style={styles.actionRow}>
              <Text style={styles.actionIndex}>{String(idx + 1)}.</Text>
              <Text style={styles.actionText}>{getActionLabel(action, t)}</Text>
            </View>
          ))}
        </Card>

        <Card style={styles.card}>
          <Text style={styles.sectionLabel}>{t('workflows.executions').toUpperCase()}</Text>
          {workflow.runs.length === 0 ? (
            <Text style={styles.emptyText}>{t('workflows.noExecutions')}</Text>
          ) : (
            workflow.runs.map((run) => (
              <View key={run.id} style={styles.runRow}>
                <Text style={styles.runDate}>{new Date(run.created_at).toLocaleDateString('ru-RU')}</Text>
                <Badge
                  variant={run.status === 'success' ? 'success' : 'danger'}
                  label={run.status === 'success' ? t('workflows.executionSuccess') : t('workflows.executionFailed')}
                />
                {run.error_message !== null && (
                  <Text style={styles.runError}>{run.error_message}</Text>
                )}
              </View>
            ))
          )}
        </Card>
      </ScrollView>

      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        {actionError !== null && (
          <Text style={styles.actionError}>{actionError}</Text>
        )}
        <View style={styles.bottomButtons}>
          {workflow.status !== 'archived' && (
            <Button
              title={workflow.status === 'active' ? t('workflows.pause') : t('workflows.enable')}
              onPress={handleToggle}
              loading={isActionLoading}
              disabled={isActionLoading}
              variant='primary'
              style={styles.bottomButton}
            />
          )}
          <Button
            title={t('workflows.editShort')}
            onPress={() => router.push(('/workflows/edit/' + id) as never)}
            disabled={isActionLoading}
            variant='secondary'
            style={styles.bottomButton}
          />
          <Button
            title={t('workflows.delete')}
            onPress={handleDelete}
            disabled={isActionLoading}
            variant='danger'
            style={styles.bottomButton}
          />
        </View>
      </View>
    </View>
  );
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  outerContainer: { flex: 1, backgroundColor: c.bg },
  container: { flex: 1, backgroundColor: c.bg },
  scrollContent: { paddingTop: spacing.lg, paddingBottom: spacing.xxl },
  card: { marginHorizontal: spacing.lg, marginBottom: spacing.lg },
  skeletonLine: { marginBottom: spacing.sm },
  errorContainer: { flex: 1, backgroundColor: c.bg },
  workflowName: { ...type.title, color: c.text1, marginBottom: spacing.xs },
  triggerText: { ...type.body, color: c.amber, marginBottom: spacing.sm },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  descriptionText: { ...type.label, color: c.amber, marginTop: spacing.xs },
  sectionLabel: { ...type.micro, color: c.amber, letterSpacing: 0.5, marginBottom: spacing.sm },
  conditionRow: { paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: c.border },
  conditionText: { ...type.body, color: c.text1 },
  actionRow: {
    flexDirection: 'row',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: spacing.xs,
  },
  actionIndex: { ...type.body, fontWeight: '600', color: c.amber, minWidth: 20 },
  actionText: { ...type.body, color: c.text1, flex: 1 },
  emptyText: { ...type.body, color: c.textMuted, fontStyle: 'italic' },
  runRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.xs, alignItems: 'flex-start' },
  runDate: { ...type.label, color: c.amber, marginBottom: spacing.xs, ...tabular },
  runError: { ...type.caption, color: c.danger, marginTop: spacing.xs },
  bottomBar: {
    backgroundColor: c.bgPanel,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  actionError: { color: c.danger, ...type.label, textAlign: 'center', marginBottom: spacing.sm },
  bottomButtons: { flexDirection: 'row', gap: spacing.sm },
  bottomButton: { flex: 1 },
  headerEditButton: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  headerEditText: { color: c.accent, ...type.heading },
});
