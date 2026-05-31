import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { scheduleTaskDueReminder } from '../../../utils/notifications';
import { sendOrQueueMutation } from '../../../utils/offlineMutation';
import { formatMarketDate } from '../../../market/profile';

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

type TaskForm = {
  title: string;
  due_date: string;
  description: string;
  contact_id: string;
  is_recurring: boolean;
  recurrence_rule: string;
};

type TaskPatch = {
  title?: string;
  due_date?: string | null;
  reminder_at?: string | null;
  description?: string;
  contact_id?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: string;
};

type RecurrencePreset = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom';

const RECURRENCE_OPTIONS: Array<{ value: RecurrencePreset; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom', label: 'Custom' },
];

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

function recurrenceRuleFromInput(preset: RecurrencePreset, customRule: string): string | null {
  if (preset === 'none') return null;
  if (preset === 'custom') {
    const trimmedRule = customRule.trim();
    return trimmedRule !== '' ? trimmedRule : null;
  }
  return preset;
}

function recurrencePresetFromRule(isRecurring: boolean, rule: string | null): RecurrencePreset {
  if (!isRecurring || !rule) return 'none';
  if (rule === 'daily' || rule === 'weekly' || rule === 'monthly') return rule;
  return 'custom';
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
    recurrence_rule: task.recurrence_rule ?? '',
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
    patch.recurrence_rule = current.is_recurring ? current.recurrence_rule : '';
  }

  return patch;
}

export default function EditTaskScreen(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [original, setOriginal] = useState<TaskForm | null>(null);
  const [title, setTitle] = useState<string>('');
  const [dueDate, setDueDate] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [showCalendar, setShowCalendar] = useState<boolean>(false);
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [recurrencePreset, setRecurrencePreset] = useState<RecurrencePreset>('none');
  const [customRecurrenceRule, setCustomRecurrenceRule] = useState<string>('');
  const [reminderDate, setReminderDate] = useState<string>('');
  const [showReminderCalendar, setShowReminderCalendar] = useState<boolean>(false);

  const form = useMemo<TaskForm>(
    () => {
      const recurrenceRule = recurrenceRuleFromInput(recurrencePreset, customRecurrenceRule);
      return {
        title,
        due_date: dueDate,
        description: notes,
        contact_id: selectedContactId,
        is_recurring: recurrenceRule !== null,
        recurrence_rule: recurrenceRule ?? '',
      };
    },
    [customRecurrenceRule, dueDate, notes, recurrencePreset, selectedContactId, title],
  );

  const loadTask = useCallback(async (): Promise<void> => {
    if (!token) {
      setApiError('Not authenticated');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setApiError(null);

    try {
      const response = await fetch(`${API_URL}/tasks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const parsedBody = (await response.json()) as ErrorApiResponse;
        setApiError(parsedBody.error.message);
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
      const loadedPreset = recurrencePresetFromRule(loadedForm.is_recurring, loadedForm.recurrence_rule);
      setRecurrencePreset(loadedPreset);
      setCustomRecurrenceRule(loadedPreset === 'custom' ? loadedForm.recurrence_rule : '');
      setReminderDate(toDateInputValue(parsedBody.data.reminder_at ?? null));
      setContactQuery('');
      setContactResults([]);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      setIsLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!token || contactQuery.trim().length < 2) {
        setContactResults([]);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/contacts?q=${encodeURIComponent(contactQuery.trim())}&per_page=8`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          setContactResults([]);
          return;
        }

        const parsedBody = (await response.json()) as {
          data: ContactPreview[];
        };
        setContactResults(parsedBody.data);
      } catch {
        setContactResults([]);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [contactQuery, token]);

  const handleSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setShowTitleError(true);
      return;
    }

    if (!original || !token) return;

    setShowTitleError(false);
    setApiError(null);
    setIsSubmitting(true);

    const patch = buildPatch(form, original);
    const originalReminderDate = toDateInputValue(null); // reminder not in form, track separately
    if (reminderDate !== originalReminderDate) {
      patch.reminder_at = reminderDate !== '' ? new Date(reminderDate + 'T09:00:00').toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      setIsSubmitting(false);
      router.back();
      return;
    }

    try {
      const result = await sendOrQueueMutation({
        url: `${API_URL}/tasks/${id}`,
        method: 'PATCH',
        token,
        body: patch,
      });

      if (result.queued) {
        router.back();
        return;
      }

      const response = result.response;

      if (response.ok) {
        const parsedBody = (await response.json()) as { data: Task };
        if (parsedBody.data.due_date) {
          try {
            await scheduleTaskDueReminder(id, parsedBody.data.title, parsedBody.data.due_date, reminderDate || null);
          } catch {
            // The task update succeeded; local reminder updates are best-effort.
          }
        }
        router.back();
      } else {
        const parsedBody = (await response.json()) as ErrorApiResponse;
        setApiError(parsedBody.error.message);
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : t('errors.networkError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderContactItem = ({ item }: ListRenderItemInfo<ContactPreview>): JSX.Element => (
    <TouchableOpacity
      style={styles.contactResultItem}
      onPress={() => {
        setSelectedContactId(item.id);
        setSelectedContactName(contactDisplayName(item));
        setContactQuery('');
        setContactResults([]);
      }}
    >
      <Text style={styles.contactResultText}>{formatContactResult(item)}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Edit Task' }} />
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {apiError !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{apiError}</Text>
            {!isSubmitting ? (
              <TouchableOpacity
                style={styles.bannerRetry}
                onPress={() => {
                  void loadTask();
                }}
              >
                <Text style={styles.bannerRetryText}>Retry</Text>
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
              <Text style={styles.label}>Due Date</Text>
              <TouchableOpacity style={styles.input} onPress={() => setShowCalendar(true)}>
                <Text style={dueDate !== '' ? styles.inputText : styles.placeholderText}>
                  {dueDate !== '' ? formatDate(dueDate) : 'Pick a date'}
                </Text>
              </TouchableOpacity>
              {dueDate !== '' ? (
                <TouchableOpacity onPress={() => setDueDate('')}>
                  <Text style={styles.clearLink}>Clear</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <Modal animationType="slide" visible={showCalendar} onRequestClose={() => setShowCalendar(false)}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Select Date</Text>
                <TouchableOpacity onPress={() => setShowCalendar(false)}>
                  <Text style={styles.modalDone}>Done</Text>
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
              <Text style={styles.label}>Reminder (optional)</Text>
              <TouchableOpacity style={styles.input} onPress={() => setShowReminderCalendar(true)}>
                <Text style={reminderDate ? styles.inputText : styles.placeholderText}>{reminderDate ? `Remind on ${formatDate(reminderDate)}` : 'No reminder'}</Text>
              </TouchableOpacity>
              {reminderDate !== '' && (
                <TouchableOpacity onPress={() => setReminderDate('')}>
                  <Text style={styles.clearLink}>Clear</Text>
                </TouchableOpacity>
              )}
              <Modal animationType="slide" visible={showReminderCalendar} onRequestClose={() => setShowReminderCalendar(false)}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Reminder Date</Text>
                  <TouchableOpacity onPress={() => setShowReminderCalendar(false)}>
                    <Text style={styles.modalDone}>Done</Text>
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
              <Text style={styles.label}>Repeat</Text>
              <View style={styles.segmentedControl}>
                {RECURRENCE_OPTIONS.map((option) => {
                  const selected = recurrencePreset === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.segmentButton, selected ? styles.segmentButtonSelected : null]}
                      onPress={() => setRecurrencePreset(option.value)}
                      activeOpacity={0.75}
                    >
                      <Text style={[styles.segmentText, selected ? styles.segmentTextSelected : null]}>{option.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {recurrencePreset === 'custom' ? (
                <TextInput
                  style={[styles.input, styles.customRuleInput]}
                  value={customRecurrenceRule}
                  onChangeText={setCustomRecurrenceRule}
                  placeholder="Every 2 weeks, weekdays, first Monday..."
                  placeholderTextColor="#B07868"
                  autoCapitalize="sentences"
                />
              ) : null}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Notes</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder="Add notes"
                placeholderTextColor="#B07868"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Contact</Text>
              {selectedContactId !== '' ? (
                <View style={styles.contactChip}>
                  <Text style={styles.contactChipText} numberOfLines={1}>
                    {selectedContactName}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      setSelectedContactId('');
                      setSelectedContactName('');
                      setContactQuery('');
                      setContactResults([]);
                    }}
                  >
                    <Text style={styles.contactChipRemove}>Change</Text>
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
