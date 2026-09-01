import React, { useMemo, useState, useEffect } from 'react';
import {
  ScrollView,
  Modal,
  TextInput,
  TouchableOpacity,
  Text,
  View,
  FlatList,
  StyleSheet,
  ListRenderItemInfo,
} from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { useTheme } from '../../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../../theme';
import { Button, SkeletonText, EmptyState } from '../../../components/ui';

type TriggerValue =
  | 'contact_created'
  | 'deal_stage_changed'
  | 'task_completed'
  | 'deal_won'
  | 'deal_created'
  | 'task_created'
  | 'deal_stale';

interface ConditionItem {
  field: string;
  operator: string;
  value: string;
}

interface ActionItem {
  type: 'create_task' | 'add_contact_note' | 'update_deal_stage';
  title?: string;
  due_in_days?: number;
  body?: string;
  stage_id?: string;
}

type RawConditions = ConditionItem[] | { all: ConditionItem[] } | null;

interface WorkflowForEdit {
  id: string;
  name: string;
  trigger: string;
  conditions: RawConditions;
  actions: ActionItem[];
}

const TRIGGERS: TriggerValue[] = [
  'contact_created',
  'deal_stage_changed',
  'task_completed',
  'deal_won',
  'deal_created',
  'task_created',
  'deal_stale',
];

const TRIGGER_KEY_MAP: Record<TriggerValue, string> = {
  contact_created: 'trigger_contact_created',
  deal_stage_changed: 'trigger_deal_stage_changed',
  task_completed: 'trigger_task_completed',
  deal_won: 'trigger_deal_won',
  deal_created: 'trigger_deal_created',
  task_created: 'trigger_task_created',
  deal_stale: 'trigger_deal_stale',
};

const OPERATORS = ['equals', 'not_equals', 'contains', 'exists'];
const ACTION_TYPES: ActionItem['type'][] = [
  'create_task',
  'add_contact_note',
  'update_deal_stage',
];

function parseConditions(raw: RawConditions): ConditionItem[] {
  let items: ConditionItem[];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw !== null && raw !== undefined && 'all' in raw) {
    items = raw.all;
  } else {
    return [];
  }
  return items.map((c) => ({
    field: c.field,
    operator: c.operator ?? 'equals',
    value: String(c.value ?? ''),
  }));
}

export default function EditWorkflowScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [trigger, setTrigger] = useState<TriggerValue>('contact_created');
  const [conditions, setConditions] = useState<ConditionItem[]>([]);
  const [condModal, setCondModal] = useState(false);
  const [condField, setCondField] = useState('');
  const [condOperator, setCondOperator] = useState(OPERATORS[0]);
  const [condValue, setCondValue] = useState('');
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [actModal, setActModal] = useState(false);
  const [actType, setActType] = useState<ActionItem['type']>('create_task');
  const [actTitle, setActTitle] = useState('');
  const [actDueDays, setActDueDays] = useState('');
  const [actBody, setActBody] = useState('');
  const [actStageId, setActStageId] = useState('');
  const [apiError, setApiError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchWorkflow = (): void => {
    if (!token || !id) return;
    setLoading(true);
    setLoadError('');
    fetch(API_URL + '/workflows/' + id, {
      headers: { Authorization: 'Bearer ' + token },
    })
      .then((res) => {
        if (!res.ok) {
          return res.json().then((j: { error?: { message?: string } }) => {
            throw new Error(j.error?.message ?? 'Error ' + String(res.status));
          });
        }
        return res.json() as Promise<{ data: WorkflowForEdit }>;
      })
      .then(({ data }) => {
        setName(data.name);
        setTrigger(data.trigger as TriggerValue);
        setConditions(parseConditions(data.conditions));
        setActions(data.actions ?? []);
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : 'Unknown error');
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchWorkflow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const goToStep2 = (): void => {
    if (!name.trim()) { setNameError('Name is required'); return; }
    setNameError('');
    setStep(2);
  };

  const addCondition = (): void => {
    setConditions((prev) => [...prev, { field: condField, operator: condOperator, value: condValue }]);
    setCondField(''); setCondOperator(OPERATORS[0]); setCondValue('');
    setCondModal(false);
  };

  const removeCondition = (i: number): void => {
    setConditions((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addAction = (): void => {
    const item: ActionItem = { type: actType };
    if (actType === 'create_task') {
      if (actTitle) item.title = actTitle;
      if (actDueDays) item.due_in_days = parseInt(actDueDays, 10);
    } else if (actType === 'add_contact_note') {
      if (actBody) item.body = actBody;
    } else if (actType === 'update_deal_stage') {
      if (actStageId) item.stage_id = actStageId;
    }
    setActions((prev) => [...prev, item]);
    setActTitle(''); setActDueDays(''); setActBody(''); setActStageId('');
    setActType('create_task');
    setActModal(false);
  };

  const removeAction = (i: number): void => {
    setActions((prev) => prev.filter((_, idx) => idx !== i));
  };

  const saveWorkflow = (): void => {
    if (!token || !id) return;
    setIsSaving(true);
    setApiError('');
    const reqBody: {
      name: string;
      trigger: TriggerValue;
      actions: ActionItem[];
      conditions?: ConditionItem[];
    } = {
      name,
      trigger,
      actions,
      conditions: conditions.length > 0 ? conditions : undefined,
    };
    fetch(API_URL + '/workflows/' + id, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    })
      .then((res) => {
        if (res.ok) {
          router.back();
        } else {
          return res.json().then((j: { error?: { message?: string } }) => {
            setApiError(j.error?.message ?? 'Error ' + String(res.status));
          });
        }
      })
      .catch((e: unknown) => {
        setApiError(e instanceof Error ? e.message : 'Unknown error');
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const renderTrigger = ({ item }: ListRenderItemInfo<TriggerValue>): JSX.Element => (
    <TouchableOpacity
      key={item}
      style={[styles.triggerRow, trigger === item && styles.triggerRowSelected]}
      onPress={() => setTrigger(item)}
      activeOpacity={0.7}
    >
      <Text style={styles.triggerText}>{t('workflows.' + TRIGGER_KEY_MAP[item])}</Text>
    </TouchableOpacity>
  );

  const renderCondition = ({ item, index }: ListRenderItemInfo<ConditionItem>): JSX.Element => (
    <View style={styles.itemRow}>
      <Text style={styles.itemText}>{item.field} {item.operator} {item.value}</Text>
      <TouchableOpacity onPress={() => removeCondition(index)} activeOpacity={0.7}>
        <Text style={styles.deleteBtn}>X</Text>
      </TouchableOpacity>
    </View>
  );

  const actionPrimaryValue = (a: ActionItem): string => {
    if (a.type === 'create_task') return a.title ?? '';
    if (a.type === 'add_contact_note') return a.body ?? '';
    if (a.type === 'update_deal_stage') return a.stage_id ?? '';
    return '';
  };

  const renderAction = ({ item, index }: ListRenderItemInfo<ActionItem>): JSX.Element => (
    <View style={styles.itemRow}>
      <Text style={styles.itemText}>{item.type} {actionPrimaryValue(item)}</Text>
      <TouchableOpacity onPress={() => removeAction(index)} activeOpacity={0.7}>
        <Text style={styles.deleteBtn}>X</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: t('workflows.edit') }} />
        <View style={styles.content}>
          <SkeletonText lines={4} />
        </View>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Stack.Screen options={{ title: t('workflows.edit') }} />
        <View style={styles.centered}>
          <Text style={styles.error}>{loadError}</Text>
          <Button title={t('common.retry')} onPress={fetchWorkflow} style={styles.retryBtn} />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t('workflows.edit') }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {step === 1 && (
          <View>
            <Text style={styles.label}>{t('workflows.name')}</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={(v) => { setName(v); if (v.trim()) setNameError(''); }}
              placeholder={t('workflows.name')}
              placeholderTextColor={colors.placeholder}
            />
            {nameError ? <Text style={styles.error}>{nameError}</Text> : null}
            <Text style={styles.label}>{t('workflows.trigger')}</Text>
            <FlatList
              data={TRIGGERS}
              renderItem={renderTrigger}
              keyExtractor={(item) => item}
              scrollEnabled={false}
            />
            <Button title={t('workflows.next')} onPress={goToStep2} block style={styles.primaryBtn} />
          </View>
        )}
        {step === 2 && (
          <View>
            <Text style={styles.stepIndicator}>2 / 3</Text>
            <Text style={styles.label}>{t('workflows.conditions')}</Text>
            <FlatList
              data={conditions}
              renderItem={renderCondition}
              keyExtractor={(_, i) => String(i)}
              scrollEnabled={false}
              ListEmptyComponent={<EmptyState title={t('workflows.noConditions')} style={styles.listEmpty} />}
            />
            <Button
              title={t('workflows.addCondition')}
              onPress={() => setCondModal(true)}
              variant="secondary"
              block
              style={styles.secondaryBtn}
            />
            <View style={styles.rowBtns}>
              <Button title={t('workflows.skip')} onPress={() => setStep(3)} variant="secondary" style={styles.rowBtn} />
              <Button title={t('workflows.next')} onPress={() => setStep(3)} style={styles.rowBtn} />
            </View>
          </View>
        )}
        {step === 3 && (
          <View>
            <Text style={styles.stepIndicator}>3 / 3</Text>
            <Text style={styles.label}>{t('workflows.actionsSection')}</Text>
            <FlatList
              data={actions}
              renderItem={renderAction}
              keyExtractor={(_, i) => String(i)}
              scrollEnabled={false}
              ListEmptyComponent={<EmptyState title={t('workflows.noActions')} style={styles.listEmpty} />}
            />
            <Button
              title={t('workflows.addAction')}
              onPress={() => setActModal(true)}
              variant="secondary"
              block
              style={styles.secondaryBtn}
            />
            {apiError ? <Text style={styles.error}>{apiError}</Text> : null}
            <Button
              title={t('workflows.save')}
              onPress={saveWorkflow}
              disabled={actions.length === 0 || isSaving}
              loading={isSaving}
              block
              style={styles.primaryBtn}
            />
          </View>
        )}
      </ScrollView>

      <Modal visible={condModal} transparent animationType='slide'>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('workflows.addCondition')}</Text>
            <Text style={styles.label}>{t('workflows.conditionField')}</Text>
            <TextInput
              style={styles.input}
              value={condField}
              onChangeText={setCondField}
              placeholder={t('workflows.conditionField')}
              placeholderTextColor={colors.placeholder}
            />
            <Text style={styles.label}>{t('workflows.conditionOperator')}</Text>
            <FlatList
              data={OPERATORS}
              renderItem={({ item }: ListRenderItemInfo<string>) => (
                <TouchableOpacity
                  style={[styles.pickerRow, condOperator === item && styles.pickerRowSelected]}
                  onPress={() => setCondOperator(item)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pickerText}>{item}</Text>
                </TouchableOpacity>
              )}
              keyExtractor={(item) => item}
              scrollEnabled={false}
            />
            <Text style={styles.label}>{t('workflows.conditionValue')}</Text>
            <TextInput
              style={styles.input}
              value={condValue}
              onChangeText={setCondValue}
              placeholder={t('workflows.conditionValue')}
              placeholderTextColor={colors.placeholder}
            />
            <View style={styles.rowBtns}>
              <Button title={t('common.cancel')} onPress={() => setCondModal(false)} variant="secondary" style={styles.rowBtn} />
              <Button title={t('workflows.addCondition')} onPress={addCondition} style={styles.rowBtn} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={actModal} transparent animationType='slide'>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('workflows.addAction')}</Text>
            <Text style={styles.label}>{t('workflows.actionType')}</Text>
            <FlatList
              data={ACTION_TYPES}
              renderItem={({ item }: ListRenderItemInfo<ActionItem['type']>) => (
                <TouchableOpacity
                  style={[styles.pickerRow, actType === item && styles.pickerRowSelected]}
                  onPress={() => setActType(item)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pickerText}>{item}</Text>
                </TouchableOpacity>
              )}
              keyExtractor={(item) => item}
              scrollEnabled={false}
            />
            {actType === 'create_task' && (
              <View>
                <Text style={styles.label}>{t('workflows.taskTitle')}</Text>
                <TextInput style={styles.input} value={actTitle} onChangeText={setActTitle} placeholder={t('workflows.taskTitle')} placeholderTextColor={colors.placeholder} />
                <Text style={styles.label}>{t('workflows.taskDueDays')}</Text>
                <TextInput style={styles.input} value={actDueDays} onChangeText={setActDueDays} keyboardType='numeric' placeholder={t('workflows.taskDueDays')} placeholderTextColor={colors.placeholder} />
              </View>
            )}
            {actType === 'add_contact_note' && (
              <View>
                <Text style={styles.label}>{t('workflows.noteBody')}</Text>
                <TextInput style={styles.input} value={actBody} onChangeText={setActBody} placeholder={t('workflows.noteBody')} placeholderTextColor={colors.placeholder} />
              </View>
            )}
            {actType === 'update_deal_stage' && (
              <View>
                <Text style={styles.label}>{t('workflows.stageId')}</Text>
                <TextInput style={styles.input} value={actStageId} onChangeText={setActStageId} placeholder={t('workflows.stageId')} placeholderTextColor={colors.placeholder} />
              </View>
            )}
            <View style={styles.rowBtns}>
              <Button title={t('common.cancel')} onPress={() => setActModal(false)} variant="secondary" style={styles.rowBtn} />
              <Button title={t('workflows.addAction')} onPress={addAction} style={styles.rowBtn} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  container: { flex: 1, backgroundColor: c.bg },
  content: { padding: spacing.lg },
  label: { ...type.label, marginTop: spacing.md, marginBottom: spacing.xs, color: c.text1 },
  input: { height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.surface, paddingHorizontal: spacing.md, color: c.text1, ...type.body },
  error: { color: c.danger, marginTop: spacing.xs },
  stepIndicator: { ...type.body, color: c.amber, marginBottom: spacing.xs },
  triggerRow: { minHeight: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, justifyContent: 'center', paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  triggerRowSelected: { borderColor: c.accent, backgroundColor: c.accentSoft },
  triggerText: { ...type.body, color: c.text1 },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderBottomWidth: 1, borderBottomColor: c.border },
  itemText: { flex: 1, ...type.body, color: c.text1 },
  deleteBtn: { color: c.danger, paddingHorizontal: spacing.sm },
  retryBtn: { marginTop: spacing.lg, alignSelf: 'center' },
  primaryBtn: { marginTop: spacing.lg },
  secondaryBtn: { marginTop: spacing.md },
  rowBtns: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  rowBtn: { flex: 1 },
  modalOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  listEmpty: { paddingVertical: spacing.lg },
  modalBox: { backgroundColor: c.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg, maxHeight: '80%' },
  modalTitle: { ...type.subtitle, color: c.text1, marginBottom: spacing.sm },
  pickerRow: { height: 44, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, justifyContent: 'center', paddingHorizontal: spacing.md, marginBottom: spacing.xs },
  pickerRowSelected: { borderColor: c.accent, backgroundColor: c.accentSoft },
  pickerText: { ...type.body, color: c.text1 },
});
