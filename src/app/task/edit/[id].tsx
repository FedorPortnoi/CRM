import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { scheduleTaskDueReminder } from '../../../utils/notifications';
import { formatMarketDate } from '../../../market/profile';
import { RECURRENCE_OPTIONS, labelKeyForRule, normalizeRule } from '../../../utils/recurrence';
import { useContactSearch } from '../../../hooks/useContactSearch';
import { useCreateMutation } from '../../../hooks/useCreateMutation';

interface TaskContact {
  id: string;
  first_name: string;
  last_name: string | null;
}

interface TaskAssignee {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  reminder_at: string | null;
  is_recurring: boolean;
  recurrence_rule: string | null;
  contact_id?: string | null;
  contact: TaskContact | null;
  assignee: TaskAssignee;
}

interface ContactPreview {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
}

interface CalendarDay {
  dateString: string;
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

interface Assignee {
  id: string;
  name: string;
}

type TaskForm = {
  title: string;
  due_date: string;
  description: string;
  contact_id: string;
  is_recurring: boolean;
  recurrence_rule: string;
  assigned_to: string;
};

type TaskPatch = {
  title?: string;
  due_date?: string | null;
  reminder_at?: string | null;
  description?: string;
  contact_id?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: string;
  assigned_to?: string;
};

function contactDisplayName(contact: { first_name: string; last_name: string | null }): string {
  return `${contact.first_name}${contact.last_name ? ' ' + contact.last_name : ''}`;
}

function formatContactResult(contact: ContactPreview): string {
  const name = contactDisplayName(contact);
  return contact.company ? `${name} - ${contact.company}` : name;
}

function toDateInputValue(dateStr: string | null): string {
  if (!dateStr) return '';

  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(dateStr: string): string {
  return formatMarketDate(`${dateStr}T00:00:00`, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function toForm(task: Task): TaskForm {
  return {
    title: task.title,
    due_date: toDateInputValue(task.due_date),
    description: task.description ?? '',
    contact_id: task.contact_id ?? task.contact?.id ?? '',
    is_recurring: task.is_recurring,
    recurrence_rule: normalizeRule(task.recurrence_rule) ?? '',
    assigned_to: task.assignee.id,
  };
}

function buildPatch(current: TaskForm, original: TaskForm): TaskPatch {
  const patch: TaskPatch = {};
  const currentTitle = current.title.trim();
  const originalTitle = original.title.trim();
  const currentDescription = current.description.trim();
  const originalDescription = original.description.trim();

  if (currentTitle !== originalTitle) {
    patch.title = currentTitle;
  }

  if (currentDescription !== originalDescription) {
    patch.description = currentDescription;
  }

  if (current.due_date !== original.due_date) {
    patch.due_date =
      current.due_date !== '' ? new Date(`${current.due_date}T00:00:00`).toISOString() : null;
  }

  if (current.contact_id !== original.contact_id) {
    patch.contact_id = current.contact_id !== '' ? current.contact_id : null;
  }

  if (current.is_recurring !== original.is_recurring || current.recurrence_rule !== original.recurrence_rule) {
    patch.is_recurring = current.is_recurring;
    if (current.is_recurring && current.recurrence_rule !== '') {
      patch.recurrence_rule = current.recurrence_rule;
    }
  }

  if (current.assigned_to !== original.assigned_to && current.assigned_to !== '') {
    patch.assigned_to = current.assigned_to;
  }

  return patch;
}

export default function EditTaskScreen(): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);
  const user = useUserStore((s) => s.user);

  const [original, setOriginal] = useState<TaskForm | null>(null);
  const [title, setTitle] = useState<string>('');
  const [dueDate, setDueDate] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const {
    query: contactQuery,
    setQuery: setContactQuery,
    results: contactResults,
    clearResults: clearContactSearch,
  } = useContactSearch({ token });
  const [showCalendar, setShowCalendar] = useState<boolean>(false);
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(null);
  const [showRepeatPicker, setShowRepeatPicker] = useState<boolean>(false);
  const [reminderDate, setReminderDate] = useState<string>('');
  const [showReminderCalendar, setShowReminderCalendar] = useState<boolean>(false);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [assigneeName, setAssigneeName] = useState<string>('');
  const [showAssigneePicker, setShowAssigneePicker] = useState<boolean>(false);

  const form = useMemo<TaskForm>(
    () => ({
      title,
      due_date: dueDate,
      description: notes,
      contact_id: selectedContactId,
      is_recurring: recurrenceRule !== null,
      recurrence_rule: recurrenceRule ?? '',
      assigned_to: assigneeId,
    }),
    [assigneeId, dueDate, notes, recurrenceRule, selectedContactId, title],
  );

  const loadTask = useCallback(async (): Promise<void> => {
    if (!token) {
      setLoadError(t('errors.unauthorized'));
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await fetch(`${API_URL}/tasks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const parsedBody = (await response.json()) as ErrorApiResponse;
        setLoadError(parsedBody.error.message);
        return;
      }

      const parsedBody = (await response.json()) as { data: Task };
      const loadedForm = toForm(parsedBody.data);
      setOriginal(loadedForm);
      setTitle(loadedForm.title);
      setDueDate(loadedForm.due_date);
      setNotes(loadedForm.description);
      setSelectedContactId(loadedForm.contact_id);
      setSelectedContactName(parsedBody.data.contact !== null ? contactDisplayName(parsedBody.data.contact) : '');
      setRecurrenceRule(loadedForm.is_recurring && loadedForm.recurrence_rule !== '' ? loadedForm.recurrence_rule : null);
      setAssigneeId(parsedBody.data.assignee.id);
      setAssigneeName(parsedBody.data.assignee.name);
      setReminderDate(toDateInputValue(parsedBody.data.reminder_at ?? null));
      clearContactSearch();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('tasks.failedToLoad'));
    } finally {
      setIsLoading(false);
    }
  }, [id, t, token]);

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  // Load org members so the task can be reassigned to any teammate (or back to self).
  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/tasks/assignees`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((body: { data: Assignee[] }) => setAssignees(body.data ?? []))
      .catch(() => setAssignees([]));
  }, [token]);

  const { isSubmitting, apiError, submit } = useCreateMutation<TaskPatch, Task>({
    endpoint: `${API_URL}/tasks/${id}`,
    method: 'PATCH',
    token: token ?? '',
    validate: () => {
      if (title.trim() === '') {
        setShowTitleError(true);
        return false;
      }
      setShowTitleError(false);
      return true;
    },
    buildPayload: () => {
      const patch = buildPatch(form, original!);
      const originalReminderDate = toDateInputValue(null);
      if (reminderDate !== originalReminderDate) {
        patch.reminder_at = reminderDate !== '' ? new Date(reminderDate + 'T09:00:00').toISOString() : null;
      }
      return patch;
    },
    onSuccess: async (data, queued) => {
      if (!queued && data.due_date) {
        try {
          await scheduleTaskDueReminder(id, data.title, data.due_date, reminderDate || null);
        } catch {
          // The task update succeeded; local reminder updates are best-effort.
        }
      }
      router.back();
    },
    fallbackErrorMessage: t('errors.networkError'),
  });

  const handleSubmit = async (): Promise<void> => {
    if (!original || !token) return;
    const patch = buildPatch(form, original);
    const originalReminderDate = toDateInputValue(null);
    if (reminderDate !== originalReminderDate) {
      patch.reminder_at = reminderDate !== '' ? new Date(reminderDate + 'T09:00:00').toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      router.back();
      return;
    }
    await submit();
  };

  const renderContactItem = ({ item }: ListRenderItemInfo<ContactPreview>): JSX.Element => (
    <TouchableOpacity
      style={styles.contactResultItem}
      onPress={() => {
        setSelectedContactId(item.id);
        setSelectedContactName(contactDisplayName(item));
        clearContactSearch();
      }}
    >
      <Text style={styles.contactResultText}>{formatContactResult(item)}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('tasks.edit') }} />
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {(loadError ?? apiError) !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError ?? apiError}</Text>
            {!isSubmitting && loadError !== null ? (
              <TouchableOpacity
                style={styles.bannerRetry}
                onPress={() => {
                  void loadTask();
                }}
              >
                <Text style={styles.bannerRetryText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#C45A10" />
          </View>
        ) : original !== null ? (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.taskTitle')} *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(text) => {
                  setTitle(text);
                  setShowTitleError(false);
                }}
                placeholder={t('tasks.titlePlaceholder')}
                placeholderTextColor="#B07868"
                autoCapitalize="sentences"
              />
              {showTitleError ? <Text style={styles.fieldError}>{t('tasks.titleRequired')}</Text> : null}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.dueDate')}</Text>
              <TouchableOpacity style={styles.input} onPress={() => setShowCalendar(true)}>
                <Text style={dueDate !== '' ? styles.inputText : styles.placeholderText}>
                  {dueDate !== '' ? formatDate(dueDate) : t('tasks.pickDate')}
                </Text>
              </TouchableOpacity>
              {dueDate !== '' ? (
                <TouchableOpacity onPress={() => setDueDate('')}>
                  <Text style={styles.clearLink}>{t('tasks.clear')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <Modal animationType="slide" visible={showCalendar} onRequestClose={() => setShowCalendar(false)}>
              <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
                <Text style={styles.modalTitle}>{t('tasks.selectDate')}</Text>
                <TouchableOpacity onPress={() => setShowCalendar(false)}>
                  <Text style={styles.modalDone}>{t('tasks.done')}</Text>
                </TouchableOpacity>
              </View>
              <Calendar
                onDayPress={(day: CalendarDay) => {
                  setDueDate(day.dateString);
                  setShowCalendar(false);
                }}
                markedDates={
                  dueDate !== ''
                    ? ({
                        [dueDate]: { selected: true, selectedColor: '#C45A10' },
                      } as Record<string, { selected?: boolean; selectedColor?: string }>)
                    : {}
                }
              />
            </Modal>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.reminderOptional')}</Text>
              <TouchableOpacity style={styles.input} onPress={() => setShowReminderCalendar(true)}>
                <Text style={reminderDate ? styles.inputText : styles.placeholderText}>{reminderDate ? t('tasks.remindOn', { date: formatDate(reminderDate) }) : t('tasks.noReminder')}</Text>
              </TouchableOpacity>
              {reminderDate !== '' && (
                <TouchableOpacity onPress={() => setReminderDate('')}>
                  <Text style={styles.clearLink}>{t('tasks.clear')}</Text>
                </TouchableOpacity>
              )}
              <Modal animationType="slide" visible={showReminderCalendar} onRequestClose={() => setShowReminderCalendar(false)}>
                <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
                  <Text style={styles.modalTitle}>{t('tasks.reminderDate')}</Text>
                  <TouchableOpacity onPress={() => setShowReminderCalendar(false)}>
                    <Text style={styles.modalDone}>{t('tasks.done')}</Text>
                  </TouchableOpacity>
                </View>
                <Calendar
                  onDayPress={(day: CalendarDay) => {
                    setReminderDate(day.dateString);
                    setShowReminderCalendar(false);
                  }}
                  markedDates={
                    reminderDate
                      ? ({ [reminderDate]: { selected: true, selectedColor: '#C45A10' } } as Record<string, { selected?: boolean; selectedColor?: string }>)
                      : {}
                  }
                />
              </Modal>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.repeat')}</Text>
              <TouchableOpacity style={styles.dropdownField} onPress={() => setShowRepeatPicker(true)} activeOpacity={0.75}>
                <Text style={styles.inputText}>{t(labelKeyForRule(recurrenceRule) ?? 'tasks.recurrenceNone')}</Text>
                <Text style={styles.dropdownChevron}>{'⌄'}</Text>
              </TouchableOpacity>
            </View>

            <Modal animationType="slide" transparent visible={showRepeatPicker} onRequestClose={() => setShowRepeatPicker(false)}>
              <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowRepeatPicker(false)}>
                <View style={styles.pickerSheet}>
                  <Text style={styles.pickerTitle}>{t('tasks.selectRepeat')}</Text>
                  {RECURRENCE_OPTIONS.map((option) => {
                    const selected = (recurrenceRule ?? null) === option.rule;
                    return (
                      <TouchableOpacity
                        key={option.labelKey}
                        style={styles.pickerRow}
                        onPress={() => {
                          setRecurrenceRule(option.rule);
                          setShowRepeatPicker(false);
                        }}
                      >
                        <Text style={[styles.pickerRowText, selected ? styles.pickerRowTextSelected : null]}>{t(option.labelKey)}</Text>
                        {selected && <Text style={styles.pickerCheck}>{'✓'}</Text>}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </TouchableOpacity>
            </Modal>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.assignedTo')}</Text>
              <TouchableOpacity style={styles.dropdownField} onPress={() => setShowAssigneePicker(true)} activeOpacity={0.75}>
                <Text style={styles.inputText}>
                  {user && assigneeId === user.id ? t('tasks.assignedToYou', { name: assigneeName || user.name }) : assigneeName}
                </Text>
                <Text style={styles.dropdownChevron}>{'⌄'}</Text>
              </TouchableOpacity>
            </View>

            <Modal animationType="slide" transparent visible={showAssigneePicker} onRequestClose={() => setShowAssigneePicker(false)}>
              <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowAssigneePicker(false)}>
                <View style={styles.pickerSheet}>
                  <Text style={styles.pickerTitle}>{t('tasks.selectAssignee')}</Text>
                  {(assignees.length > 0 ? assignees : [{ id: assigneeId, name: assigneeName }]).map((member) => {
                    const selected = member.id === assigneeId;
                    const display = user && member.id === user.id ? t('tasks.assignedToYou', { name: member.name }) : member.name;
                    return (
                      <TouchableOpacity
                        key={member.id}
                        style={styles.pickerRow}
                        onPress={() => {
                          setAssigneeId(member.id);
                          setAssigneeName(member.name);
                          setShowAssigneePicker(false);
                        }}
                      >
                        <Text style={[styles.pickerRowText, selected ? styles.pickerRowTextSelected : null]}>{display}</Text>
                        {selected && <Text style={styles.pickerCheck}>{'✓'}</Text>}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </TouchableOpacity>
            </Modal>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.notes')}</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder={t('tasks.notesPlaceholder')}
                placeholderTextColor="#B07868"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('tasks.contact')}</Text>
              {selectedContactId !== '' ? (
                <View style={styles.contactChip}>
                  <Text style={styles.contactChipText} numberOfLines={1}>
                    {selectedContactName}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      setSelectedContactId('');
                      setSelectedContactName('');
                      clearContactSearch();
                    }}
                  >
                    <Text style={styles.contactChipRemove}>{t('deals.changeContact')}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <TextInput
                    style={styles.input}
                    value={contactQuery}
                    onChangeText={setContactQuery}
                    placeholder={t('contacts.searchByName')}
                    placeholderTextColor="#B07868"
                  />
                  {contactResults.slice(0, 5).length > 0 ? (
                    <View style={styles.contactResultsContainer}>
                      <FlatList<ContactPreview>
                        data={contactResults.slice(0, 5)}
                        keyExtractor={(item) => item.id}
                        renderItem={renderContactItem}
                        scrollEnabled={false}
                        keyboardShouldPersistTaps="handled"
                      />
                    </View>
                  ) : null}
                </>
              )}
            </View>

            <TouchableOpacity
              style={[styles.submitButton, isSubmitting ? styles.submitButtonDisabled : null]}
              onPress={() => {
                void handleSubmit();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.submitButtonText}>{t('tasks.saveTask')}</Text>
              )}
            </TouchableOpacity>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  scrollView: { flex: 1 },
  content: { padding: 16 },
  loadingContainer: { paddingTop: 48 },
  errorBanner: {
    backgroundColor: '#fef2f2',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  errorBannerText: { color: '#ef4444' },
  bannerRetry: { marginTop: 8, alignSelf: 'flex-start' },
  bannerRetryText: { color: '#C45A10', fontWeight: '600' },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', color: '#383432', marginBottom: 6 },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
    fontSize: 16,
    color: '#383432',
  },
  inputText: { color: '#383432', fontSize: 16 },
  placeholderText: { color: '#B07868', fontSize: 16 },
  clearLink: { color: '#C45A10', fontSize: 12, marginTop: 4 },
  dropdownField: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownChevron: { color: '#B07868', fontSize: 18, marginLeft: 8 },
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  pickerTitle: { fontSize: 16, fontWeight: '600', color: '#383432', marginBottom: 8 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0E8E2',
  },
  pickerRowText: { fontSize: 16, color: '#383432' },
  pickerRowTextSelected: { color: '#C45A10', fontWeight: '600' },
  pickerCheck: { color: '#C45A10', fontSize: 16, fontWeight: '700' },
  segmentedControl: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  segmentButton: {
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  segmentButtonSelected: {
    borderColor: '#C45A10',
    backgroundColor: '#FEF0E8',
  },
  segmentText: { color: '#383432', fontSize: 14, fontWeight: '500' },
  segmentTextSelected: { color: '#C45A10' },
  customRuleInput: { marginTop: 10 },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    height: 100,
    fontSize: 16,
    color: '#383432',
  },
  fieldError: { color: '#ef4444', fontSize: 12, marginTop: 4 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#383432' },
  modalDone: { fontSize: 16, color: '#C45A10', fontWeight: '600' },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  contactChipText: {
    fontSize: 14,
    color: '#383432',
    marginRight: 8,
    flexShrink: 1,
  },
  contactChipRemove: { fontSize: 14, color: '#C45A10', fontWeight: '600' },
  contactResultsContainer: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    marginTop: 4,
  },
  contactResultItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  contactResultText: { fontSize: 15, color: '#383432' },
  submitButton: {
    backgroundColor: '#C45A10',
    borderRadius: 12,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  submitButtonDisabled: { opacity: 0.7 },
  submitButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
