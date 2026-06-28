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
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
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
  borderRadius?: number;
  marginBottom?: number;
}

function SkeletonBox({ width, height, borderRadius = 4, marginBottom = 0 }: SkeletonBoxProps): JSX.Element {
  return <View style={{ width, height, backgroundColor: 'rgba(204,120,92,0.08)', borderRadius, marginBottom }} />;
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

function getStatusColor(status: WorkflowDetail['status']): string {
  if (status === 'active') return '#CC785C';
  if (status === 'paused') return '#F9AB00';
  return 'rgba(232,224,212,0.35)';
}

function getActionLabel(action: ActionItem): string {
  if (action.type === 'create_task') {
    return 'Create task: ' + (action.title ?? '') + ' · ' + String(action.due_in_days ?? 0) + 'd';
  }
  if (action.type === 'add_contact_note') {
    return 'Add note: ' + (action.body ?? '');
  }
  return 'Move to stage: ' + (action.stage_id ?? '');
}
export default function WorkflowDetailScreen(): JSX.Element {
  const { t } = useTranslation();
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
          if (!res.ok) throw new Error('Не удалось загрузить автоматизацию: ' + String(res.status));
          return res.json() as Promise<WorkflowApiResponse>;
        })
        .then((json) => {
          setWorkflow(json.data);
          setIsLoading(false);
          setIsRefreshing(false);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Что-то пошло не так');
          setIsLoading(false);
          setIsRefreshing(false);
        });
    },
    [id, token],
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
        if (!res.ok) throw new Error('Не удалось обновить автоматизацию: ' + String(res.status));
        setWorkflow((prev) => (prev ? { ...prev, status: newStatus } : prev));
        setIsActionLoading(false);
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Что-то пошло не так');
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
                if (!res.ok) throw new Error('Не удалось удалить автоматизацию: ' + String(res.status));
                router.replace('/workflows' as never);
              })
              .catch((err: unknown) => {
                setActionError(err instanceof Error ? err.message : 'Что-то пошло не так');
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
          <SkeletonBox width={'60%'} height={22} marginBottom={12} />
          <SkeletonBox width={'40%'} height={16} marginBottom={10} />
          <SkeletonBox width={'30%'} height={24} borderRadius={12} />
        </View>
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'30%'} height={12} marginBottom={10} />
          <SkeletonBox width={'80%'} height={14} marginBottom={8} />
          <SkeletonBox width={'70%'} height={14} />
        </View>
        <View style={styles.skeletonCard}>
          <SkeletonBox width={'30%'} height={12} marginBottom={10} />
          <SkeletonBox width={'60%'} height={14} />
        </View>
      </ScrollView>
    );
  }

  if (error !== null || workflow === null) {
    return (
      <View style={styles.errorContainer}>
        <Stack.Screen options={{ title: '' }} />
        <Text style={styles.errorText}>{error ?? 'Workflow not found'}</Text>
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
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.card}>
          <Text style={styles.workflowName}>{workflow.name}</Text>
          <Text style={styles.triggerText}>{triggerLabel}</Text>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, { backgroundColor: getStatusColor(workflow.status) }]}>
              <Text style={styles.badgeText}>
                {workflow.status === 'active'
                  ? t('workflows.enabled')
                  : workflow.status === 'paused'
                  ? t('workflows.disabled')
                  : workflow.status}
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
              <Text style={styles.actionText}>{getActionLabel(action)}</Text>
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
                    { backgroundColor: run.status === 'success' ? '#CC785C' : '#C5221F' },
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

      <View style={styles.bottomBar}>
        {actionError !== null && (
          <Text style={styles.actionError}>{actionError}</Text>
        )}
        <View style={styles.bottomButtons}>
          {workflow.status !== 'archived' && (
            <TouchableOpacity
              style={[
                styles.bottomButton,
                { backgroundColor: workflow.status === 'active' ? '#F9AB00' : '#CC785C' },
                isActionLoading ? styles.buttonDisabled : null,
              ]}
              onPress={handleToggle}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <ActivityIndicator color={'#fff'} />
              ) : (
                <Text style={styles.bottomButtonText}>
                  {workflow.status === 'active' ? 'Pause' : 'Enable'}
                </Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.bottomButton,
              { backgroundColor: '#CC785C' },
              isActionLoading ? styles.buttonDisabled : null,
            ]}
            onPress={() => router.push(('/workflows/edit/' + id) as never)}
            disabled={isActionLoading}
          >
            <Text style={styles.bottomButtonText}>{t('workflows.edit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.bottomButton,
              { backgroundColor: '#C5221F' },
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
const styles = StyleSheet.create({
  outerContainer: { flex: 1, backgroundColor: 'rgba(204,120,92,0.08)' },
  container: { flex: 1, backgroundColor: 'rgba(204,120,92,0.08)' },
  card: {
    backgroundColor: '#1A1A18',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  skeletonCard: {
    backgroundColor: '#1A1A18',
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
    backgroundColor: 'rgba(204,120,92,0.08)',
    padding: 24,
  },
  errorText: { fontSize: 15, color: '#C5221F', textAlign: 'center', marginBottom: 16 },
  retryText: { fontSize: 15, color: '#CC785C', fontWeight: '600' },
  workflowName: { fontSize: 22, fontWeight: '700', color: '#E8E0D4', marginBottom: 6 },
  triggerText: { fontSize: 14, color: '#D4A27F', marginBottom: 10 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  descriptionText: { fontSize: 13, color: '#D4A27F', marginTop: 4 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#D4A27F', letterSpacing: 0.5, marginBottom: 10 },
  conditionRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#0E0E0D' },
  conditionText: { fontSize: 14, color: '#E8E0D4' },
  actionRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#0E0E0D',
    gap: 6,
  },
  actionIndex: { fontSize: 14, fontWeight: '600', color: '#D4A27F', minWidth: 20 },
  actionText: { fontSize: 14, color: '#E8E0D4', flex: 1 },
  emptyText: { fontSize: 14, color: 'rgba(232,224,212,0.35)', fontStyle: 'italic' },
  runRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#0E0E0D', gap: 4 },
  runDate: { fontSize: 13, color: '#D4A27F', marginBottom: 4 },
  runBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  runBadgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  runError: { fontSize: 12, color: '#C5221F', marginTop: 2 },
  bottomBar: { backgroundColor: '#1A1A18', borderTopWidth: 1, borderTopColor: 'rgba(232,224,212,0.08)', padding: 16 },
  actionError: { color: '#C5221F', fontSize: 13, textAlign: 'center', marginBottom: 8 },
  bottomButtons: { flexDirection: 'row', gap: 8 },
  bottomButton: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  bottomButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  buttonDisabled: { opacity: 0.6 },
  headerEditButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerEditText: { color: '#CC785C', fontSize: 16, fontWeight: '600' },
});
