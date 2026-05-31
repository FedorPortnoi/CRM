import React, { useState } from 'react';
import {
  ScrollView,
  Modal,
  TextInput,
  TouchableOpacity,
  Text,
  View,
  ActivityIndicator,
  FlatList,
  StyleSheet,
  ListRenderItemInfo,
} from 'react-native';
import { router, Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

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

export default function NewWorkflowScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
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

  const createWorkflow = async (): Promise<void> => {
    if (!token) return;
    try {
      setIsSaving(true); setApiError('');
      const reqBody: { name: string; trigger: TriggerValue; actions: ActionItem[]; conditions?: ConditionItem[] } = {
        name, trigger, actions,
        conditions: conditions.length > 0 ? conditions : undefined,
      };
      const response = await fetch(`${API_URL}/workflows`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      if (response.status === 201) {
        const json = (await response.json()) as { data: { id: string } };
        router.replace({ pathname: '/workflows/[id]', params: { id: json.data.id } } as never);
      } else {
        const errJson = (await response.json()) as { error?: { message?: string } };
        setApiError(errJson.error?.message ?? `Error ${response.status}`);
      }
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setIsSaving(false);
    }
  };

  const renderTrigger = ({ item }: ListRenderItemInfo<TriggerValue>): JSX.Element => (
    <TouchableOpacity key={item} style={[styles.triggerRow, trigger === item && styles.triggerRowSelected]} onPress={() => setTrigger(item)}>
      <Text style={styles.triggerText}>{t(`workflows.${TRIGGER_KEY_MAP[item]}`)}</Text>
    </TouchableOpacity>
  );

  const renderCondition = ({ item, index }: ListRenderItemInfo<ConditionItem>): JSX.Element => (
    <View style={styles.itemRow}>
      <Text style={styles.itemText}>{item.field} {item.operator} {item.value}</Text>
      <TouchableOpacity onPress={() => removeCondition(index)}><Text style={styles.deleteBtn}>X</Text></TouchableOpacity>
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
      <TouchableOpacity onPress={() => removeAction(index)}><Text style={styles.deleteBtn}>X</Text></TouchableOpacity>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: t('workflows.new') }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {step === 1 && (
          <View>
            <Text style={styles.label}>{t('workflows.name')}</Text>
            <TextInput style={styles.input} value={name}
              onChangeText={(v) => { setName(v); if (v.trim()) setNameError(''); }}
              placeholder={t('workflows.name')} />
            {nameError ? <Text style={styles.error}>{nameError}</Text> : null}
            <Text style={styles.label}>{t('workflows.trigger')}</Text>
            <FlatList data={TRIGGERS} renderItem={renderTrigger} keyExtractor={(item) => item} scrollEnabled={false} />
            <TouchableOpacity style={styles.primaryBtn} onPress={goToStep2}>
              <Text style={styles.primaryBtnText}>{t('workflows.next')}</Text>
            </TouchableOpacity>
          </View>
        )}
        {step === 2 && (
          <View>
            <Text style={styles.stepIndicator}>2 / 3</Text>
            <Text style={styles.label}>{t('workflows.conditions')}</Text>
            <FlatList data={conditions} renderItem={renderCondition} keyExtractor={(_, i) => String(i)} scrollEnabled={false} />
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setCondModal(true)}>
              <Text style={styles.secondaryBtnText}>{t('workflows.addCondition')}</Text>
            </TouchableOpacity>
            <View style={styles.rowBtns}>
              <TouchableOpacity style={styles.skipBtn} onPress={() => setStep(3)}>
                <Text style={styles.skipBtnText}>{t('workflows.skip')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep(3)}>
                <Text style={styles.primaryBtnText}>{t('workflows.next')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {step === 3 && (
          <View>
            <Text style={styles.stepIndicator}>3 / 3</Text>
            <Text style={styles.label}>{t('workflows.actionsSection')}</Text>
            <FlatList data={actions} renderItem={renderAction} keyExtractor={(_, i) => String(i)} scrollEnabled={false} />
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setActModal(true)}>
              <Text style={styles.secondaryBtnText}>{t('workflows.addAction')}</Text>
            </TouchableOpacity>
            {apiError ? <Text style={styles.error}>{apiError}</Text> : null}
            <TouchableOpacity
              style={[styles.primaryBtn, (actions.length === 0 || isSaving) && styles.btnDisabled]}
              disabled={actions.length === 0 || isSaving}
              onPress={() => { void createWorkflow(); }}
            >
              {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryBtnText}>{t('workflows.create')}</Text>}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <Modal visible={condModal} transparent animationType="slide">
        <View style={styles.modalOverlay}><View style={styles.modalBox}>
          <Text style={styles.modalTitle}>{t('workflows.addCondition')}</Text>
          <Text style={styles.label}>{t('workflows.conditionField')}</Text>
          <TextInput style={styles.input} value={condField} onChangeText={setCondField} placeholder={t('workflows.conditionField')} />
          <Text style={styles.label}>{t('workflows.conditionOperator')}</Text>
          <FlatList data={OPERATORS} renderItem={({ item }: ListRenderItemInfo<string>) => (
            <TouchableOpacity style={[styles.pickerRow, condOperator === item && styles.pickerRowSelected]} onPress={() => setCondOperator(item)}>
              <Text>{item}</Text></TouchableOpacity>)} keyExtractor={(item) => item} scrollEnabled={false} />
          <Text style={styles.label}>{t('workflows.conditionValue')}</Text>
          <TextInput style={styles.input} value={condValue} onChangeText={setCondValue} placeholder={t('workflows.conditionValue')} />
          <View style={styles.rowBtns}>
            <TouchableOpacity style={styles.skipBtn} onPress={() => setCondModal(false)}>
              <Text style={styles.skipBtnText}>{t('common.cancel')}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={addCondition}>
              <Text style={styles.primaryBtnText}>{t('workflows.addCondition')}</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={actModal} transparent animationType="slide">
        <View style={styles.modalOverlay}><View style={styles.modalBox}>
          <Text style={styles.modalTitle}>{t('workflows.addAction')}</Text>
          <Text style={styles.label}>{t('workflows.actionType')}</Text>
          <FlatList data={ACTION_TYPES} renderItem={({ item }: ListRenderItemInfo<ActionItem['type']>) => (
            <TouchableOpacity style={[styles.pickerRow, actType === item && styles.pickerRowSelected]} onPress={() => setActType(item)}>
              <Text>{item}</Text></TouchableOpacity>)} keyExtractor={(item) => item} scrollEnabled={false} />
          {actType === 'create_task' && (
            <View>
              <Text style={styles.label}>{t('workflows.taskTitle')}</Text>
              <TextInput style={styles.input} value={actTitle} onChangeText={setActTitle} placeholder={t('workflows.taskTitle')} />
              <Text style={styles.label}>{t('workflows.taskDueDays')}</Text>
              <TextInput style={styles.input} value={actDueDays} onChangeText={setActDueDays} keyboardType="numeric" placeholder={t('workflows.taskDueDays')} />
            </View>)}
          {actType === 'add_contact_note' && (
            <View>
              <Text style={styles.label}>{t('workflows.noteBody')}</Text>
              <TextInput style={styles.input} value={actBody} onChangeText={setActBody} placeholder={t('workflows.noteBody')} />
            </View>)}
          {actType === 'update_deal_stage' && (
            <View>
              <Text style={styles.label}>{t('workflows.stageId')}</Text>
              <TextInput style={styles.input} value={actStageId} onChangeText={setActStageId} placeholder={t('workflows.stageId')} />
            </View>)}
          <View style={styles.rowBtns}>
            <TouchableOpacity style={styles.skipBtn} onPress={() => setActModal(false)}>
              <Text style={styles.skipBtnText}>{t('common.cancel')}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={addAction}>
              <Text style={styles.primaryBtnText}>{t('workflows.addAction')}</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  content: { padding: 16 },
  label: { marginTop: 12, marginBottom: 6, color: '#383432', fontWeight: '700' },
  input: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: '#E8DDD6', backgroundColor: '#FFFFFF', paddingHorizontal: 12, color: '#383432' },
  error: { color: '#C5221F', marginTop: 4 },
  stepIndicator: { fontSize: 14, color: '#B07868', marginBottom: 4 },
  triggerRow: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: '#E8DDD6', backgroundColor: '#FFFFFF', justifyContent: 'center', paddingHorizontal: 12, marginBottom: 8 },
  triggerRowSelected: { borderColor: '#C4704F', backgroundColor: '#FEF0E8' },
  triggerText: { color: '#383432' },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#E8DDD6' },
  itemText: { flex: 1, color: '#383432' },
  deleteBtn: { color: '#C5221F', paddingHorizontal: 8 },
  primaryBtn: { flex: 1, height: 48, borderRadius: 12, backgroundColor: '#C4704F', alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
  secondaryBtn: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: '#C4704F', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  secondaryBtnText: { color: '#C4704F', fontWeight: '700' },
  skipBtn: { flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: '#E8DDD6', alignItems: 'center', justifyContent: 'center', marginTop: 16, marginRight: 8 },
  skipBtnText: { color: '#383432', fontWeight: '600' },
  rowBtns: { flexDirection: 'row', gap: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalBox: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '80%' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#383432', marginBottom: 8 },
  pickerRow: { height: 44, borderRadius: 12, borderWidth: 1, borderColor: '#E8DDD6', justifyContent: 'center', paddingHorizontal: 12, marginBottom: 6 },
  pickerRowSelected: { borderColor: '#C4704F', backgroundColor: '#FEF0E8' },
});
