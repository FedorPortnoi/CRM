import { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Modal, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Calendar } from 'react-native-calendars';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { scheduleTaskDueReminder } from '../../utils/notifications';
import { sendOrQueueMutation } from '../../utils/offlineMutation';
import { formatMarketDate } from '../../market/profile';
import { RECURRENCE_OPTIONS, labelKeyForRule } from '../../utils/recurrence';

interface ContactPreview {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
}

interface Assignee {
  id: string;
  name: string;
}

interface TaskApiResponse {
  data: { id: string };
}

interface CalendarDay {
  dateString: string;
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

export default function NewTaskScreen(): JSX.Element | null {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const user = useUserStore((s) => s.user);

  const [title, setTitle] = useState<string>('');
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [dueDate, setDueDate] = useState<string>('');
  const [showCalendar, setShowCalendar] = useState<boolean>(false);
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(null);
  const [showRepeatPicker, setShowRepeatPicker] = useState<boolean>(false);
  const [reminderDate, setReminderDate] = useState<string>('');
  const [showReminderCalendar, setShowReminderCalendar] = useState<boolean>(false);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [assigneeName, setAssigneeName] = useState<string>('');
  const [showAssigneePicker, setShowAssigneePicker] = useState<boolean>(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (contactQuery.trim().length >= 2) {
        fetch(`${API_URL}/contacts?q=${encodeURIComponent(contactQuery.trim())}&per_page=8`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.json())
          .then((body: { data: ContactPreview[] }) => setContactResults(body.data))
          .catch(() => setContactResults([]));
      } else {
        setContactResults([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [contactQuery, token]);

  // Default the assignee to the current user, then load the org's members so the
  // task can be reassigned to a teammate if needed.
  useEffect(() => {
    if (!user) return;
    setAssigneeId((prev) => (prev === '' ? user.id : prev));
    setAssigneeName((prev) => (prev === '' ? user.name : prev));

    fetch(`${API_URL}/tasks/assignees`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((body: { data: Assignee[] }) => setAssignees(body.data ?? []))
      .catch(() => setAssignees([]));
  }, [token, user]);

  if (!token || !user) return null;

  const formatDate = (dateStr: string): string => {
    return formatMarketDate(dateStr + 'T00:00:00', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setShowTitleError(true);
      return;
    }
    setIsSubmitting(true);
    const body = {
      title: title.trim(),
      assigned_to: assigneeId || user.id,
      is_recurring: recurrenceRule !== null,
      recurrence_rule: recurrenceRule ?? '',
      ...(dueDate !== '' ? { due_date: new Date(dueDate + 'T00:00:00').toISOString() } : {}),
      ...(reminderDate !== '' ? { reminder_at: new Date(reminderDate + 'T09:00:00').toISOString() } : {}),
      ...(selectedContactId !== '' ? { contact_id: selectedContactId } : {}),
    };
    try {
      const result = await sendOrQueueMutation({
        url: `${API_URL}/tasks`,
        method: 'POST',
        token,
        body,
      });

      if (result.queued) {
        router.replace('/(tabs)/tasks');
        return;
      }

      const res = result.response;
      const parsed = await res.json();
      if (res.status === 201) {
        const taskId = (parsed as TaskApiResponse).data.id;
        if (dueDate !== '') {
          try {
            await scheduleTaskDueReminder(taskId, title.trim(), dueDate, reminderDate || null);
          } catch {
            // Task creation should still succeed if local reminders are unavailable.
          }
        }
        router.replace({
          pathname: '/task/[id]',
          params: { id: taskId },
        });
      } else {
        setApiError((parsed as ErrorApiResponse)?.error?.message ?? t('tasks.failedToCreate'));
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : t('errors.networkError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {apiError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{apiError}</Text>
        </View>
      )}

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
      />
      {showTitleError && <Text style={styles.fieldError}>{t('tasks.titleRequired')}</Text>}

      <Text style={styles.label}>{t('tasks.dueDateOptional')}</Text>
      <TouchableOpacity style={styles.input} onPress={() => setShowCalendar(true)}>
        <Text style={dueDate ? styles.inputText : styles.placeholderText}>{dueDate ? formatDate(dueDate) : t('tasks.pickDate')}</Text>
      </TouchableOpacity>
      {dueDate !== '' && (
        <TouchableOpacity onPress={() => setDueDate('')}>
          <Text style={styles.clearLink}>{t('tasks.clear')}</Text>
        </TouchableOpacity>
      )}

      <Modal animationType="slide" visible={showCalendar} onRequestClose={() => setShowCalendar(false)}>
        <View style={styles.modalHeader}>
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
            dueDate
              ? ({
                  [dueDate]: { selected: true, selectedColor: '#C45A10' },
                } as Record<string, { selected?: boolean; selectedColor?: string }>)
              : {}
          }
        />
      </Modal>

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
        <View style={styles.modalHeader}>
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

      <Text style={styles.label}>{t('tasks.repeat')}</Text>
      <TouchableOpacity style={styles.dropdownField} onPress={() => setShowRepeatPicker(true)} activeOpacity={0.75}>
        <Text style={styles.inputText}>{t(labelKeyForRule(recurrenceRule) ?? 'tasks.recurrenceNone')}</Text>
        <Text style={styles.dropdownChevron}>{'⌄'}</Text>
      </TouchableOpacity>

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

      <Text style={styles.label}>{t('tasks.assignedTo')}</Text>
      <TouchableOpacity style={styles.dropdownField} onPress={() => setShowAssigneePicker(true)} activeOpacity={0.75}>
        <Text style={styles.inputText}>
          {assigneeId === user.id ? t('tasks.assignedToYou', { name: assigneeName || user.name }) : assigneeName}
        </Text>
        <Text style={styles.dropdownChevron}>{'⌄'}</Text>
      </TouchableOpacity>

      <Modal animationType="slide" transparent visible={showAssigneePicker} onRequestClose={() => setShowAssigneePicker(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowAssigneePicker(false)}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>{t('tasks.selectAssignee')}</Text>
            {(assignees.length > 0 ? assignees : [{ id: user.id, name: user.name }]).map((member) => {
              const selected = member.id === assigneeId;
              const display = member.id === user.id ? t('tasks.assignedToYou', { name: member.name }) : member.name;
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

      <Text style={styles.label}>{t('tasks.contactOptional')}</Text>
      {selectedContactId !== '' ? (
        <View style={styles.chip}>
          <Text style={styles.chipText}>{selectedContactName}</Text>
          <TouchableOpacity
            onPress={() => {
              setSelectedContactId('');
              setSelectedContactName('');
              setContactQuery('');
              setContactResults([]);
            }}
          >
            <Text style={styles.chipRemove}>&#x2715;</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TextInput
          style={styles.input}
          value={contactQuery}
          onChangeText={setContactQuery}
          placeholder={t('contacts.searchByName')}
          placeholderTextColor="#B07868"
        />
      )}
      {contactResults.length > 0 && selectedContactId === '' && (
        <View style={styles.dropdown}>
          {contactResults.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={styles.dropdownRow}
              onPress={() => {
                setSelectedContactId(c.id);
                setSelectedContactName(`${c.first_name}${c.last_name ? ' ' + c.last_name : ''}`);
                setContactQuery('');
                setContactResults([]);
              }}
            >
              <Text style={styles.dropdownText}>
                {`${c.first_name}${c.last_name ? ' ' + c.last_name : ''}${c.company ? ' · ' + c.company : ''}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
        onPress={() => {
          void handleSubmit();
        }}
        disabled={isSubmitting}
      >
        {isSubmitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.submitText}>{t('tasks.createTask')}</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#ffffff', flexGrow: 1 },
  errorBanner: {
    backgroundColor: '#fef2f2',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  errorBannerText: { color: '#ef4444' },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#383432',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    padding: 12,
    minHeight: 44,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
  },
  dropdownField: {
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownChevron: { color: '#B07868', fontSize: 18, marginLeft: 8 },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
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
  inputText: { color: '#383432', fontSize: 16 },
  placeholderText: { color: '#B07868', fontSize: 16 },
  fieldError: { color: '#ef4444', fontSize: 12, marginTop: 4 },
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
  disabledInput: {
    backgroundColor: '#ffffff',
    borderColor: '#E8DDD6',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEF0E8',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  chipText: { color: '#C45A10', fontSize: 14, marginRight: 8 },
  chipRemove: { color: '#C45A10', fontSize: 14, fontWeight: '600' },
  dropdown: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginTop: 4,
    elevation: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  dropdownRow: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  dropdownText: { color: '#383432', fontSize: 14 },
  submitButton: {
    backgroundColor: '#C45A10',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
