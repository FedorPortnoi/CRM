import { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Modal, StyleSheet } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Calendar } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { scheduleTaskDueReminder } from '../../utils/notifications';
import { formatMarketDate } from '../../market/profile';
import { useCreateMutation } from '../../hooks/useCreateMutation';
import { RECURRENCE_OPTIONS, labelKeyForRule } from '../../utils/recurrence';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

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

interface CalendarDay {
  dateString: string;
}

interface SuggestedContact {
  id: string;
  first_name: string;
  last_name: string | null;
}

function contactDisplayName(c: { first_name: string; last_name: string | null }): string {
  return `${c.first_name}${c.last_name ? ' ' + c.last_name : ''}`;
}

export default function NewTaskScreen(): JSX.Element | null {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const token = useUserStore((s) => s.token);
  const user = useUserStore((s) => s.user);

  // Pre-fill from contact/deal entry-point
  const { contact_id: prefillContactId, contact_name: prefillContactName } =
    useLocalSearchParams<{ contact_id?: string; contact_name?: string }>();

  const [title, setTitle] = useState<string>('');
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [dueDate, setDueDate] = useState<string>('');
  const [showCalendar, setShowCalendar] = useState<boolean>(false);
  const [selectedContactId, setSelectedContactId] = useState<string>(
    typeof prefillContactId === 'string' ? prefillContactId : '',
  );
  const [selectedContactName, setSelectedContactName] = useState<string>(
    typeof prefillContactName === 'string' ? prefillContactName : '',
  );
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(null);
  const [showRepeatPicker, setShowRepeatPicker] = useState<boolean>(false);
  const [reminderDate, setReminderDate] = useState<string>('');
  const [showReminderCalendar, setShowReminderCalendar] = useState<boolean>(false);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [assigneeName, setAssigneeName] = useState<string>('');
  const [showAssigneePicker, setShowAssigneePicker] = useState<boolean>(false);

  // @mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<ContactPreview[]>([]);
  const [mentionStartIndex, setMentionStartIndex] = useState<number>(0);

  // AI suggestion state
  const [suggestionContact, setSuggestionContact] = useState<SuggestedContact | null>(null);
  const [showSuggestionModal, setShowSuggestionModal] = useState<boolean>(false);

  // Debounced contact search for the contact field
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

  // Debounced contact search for @mention
  useEffect(() => {
    if (mentionQuery === null || mentionQuery.length === 0) {
      setMentionResults([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`${API_URL}/contacts?q=${encodeURIComponent(mentionQuery)}&per_page=5`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((body: { data: ContactPreview[] }) => setMentionResults(body.data ?? []))
        .catch(() => setMentionResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [mentionQuery, token]);

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

  // Holds an optional contact-id override set just before calling submit()
  const pendingContactIdRef = useRef<string | null>(null);

  const { isSubmitting, apiError, submit } = useCreateMutation<
    {
      title: string;
      assigned_to: string;
      is_recurring: boolean;
      recurrence_rule?: string;
      due_date?: string;
      reminder_at?: string;
      contact_id?: string;
    },
    { id: string }
  >({
    endpoint: `${API_URL}/tasks`,
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
      const finalContactId = pendingContactIdRef.current ?? selectedContactId;
      return {
        title: title.trim(),
        assigned_to: assigneeId || (user?.id ?? ''),
        is_recurring: recurrenceRule !== null,
        ...(recurrenceRule !== null ? { recurrence_rule: recurrenceRule } : {}),
        ...(dueDate !== '' ? { due_date: new Date(dueDate + 'T00:00:00').toISOString() } : {}),
        ...(reminderDate !== '' ? { reminder_at: new Date(reminderDate + 'T09:00:00').toISOString() } : {}),
        ...(finalContactId !== '' ? { contact_id: finalContactId } : {}),
      };
    },
    onSuccess: async (data, queued) => {
      pendingContactIdRef.current = null;
      if (queued) {
        router.replace('/(tabs)/tasks');
        return;
      }
      const taskId = data.id;
      if (dueDate !== '') {
        try {
          await scheduleTaskDueReminder(taskId, title.trim(), dueDate, reminderDate || null);
        } catch {
          // Task creation should still succeed if local reminders are unavailable.
        }
      }
      router.replace({ pathname: '/task/[id]', params: { id: taskId } });
    },
    fallbackErrorMessage: t('tasks.failedToCreate'),
  });

  if (!token || !user) return null;

  const formatDate = (dateStr: string): string => {
    return formatMarketDate(dateStr + 'T00:00:00', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleTitleChange = (text: string): void => {
    setTitle(text);
    setShowTitleError(false);

    const match = text.match(/(?:^|[\s])(\S{2,})$/);
    if (match) {
      const query = match[1];
      setMentionQuery(query);
      setMentionStartIndex(text.length - query.length);
    } else {
      setMentionQuery(null);
      setMentionResults([]);
    }
  };

  const handleMentionSelect = (contact: ContactPreview): void => {
    const name = contactDisplayName(contact);
    const before = title.substring(0, mentionStartIndex);
    const after = title.substring(mentionStartIndex + (mentionQuery?.length ?? 0));
    setTitle(before + name + after);
    setSelectedContactId(contact.id);
    setSelectedContactName(name);
    setMentionQuery(null);
    setMentionResults([]);
    setContactResults([]);
  };

  const doSubmit = (overrideContactId?: string): void => {
    pendingContactIdRef.current = overrideContactId ?? null;
    void submit();
  };

  const handleSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setShowTitleError(true);
      return;
    }

    if (!selectedContactId && title.trim().length > 3) {
      try {
        const res = await fetch(`${API_URL}/tasks/suggest-contact`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim() }),
        });
        if (res.ok) {
          const json = (await res.json()) as { data: { contact: SuggestedContact | null } };
          if (json.data.contact) {
            setSuggestionContact(json.data.contact);
            setShowSuggestionModal(true);
            return;
          }
        }
      } catch {
        // AI unavailable — proceed without suggestion
      }
    }

    doSubmit();
  };

  return (
    <>
      <Stack.Screen options={{ title: t('tasks.new') }} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      {/* AI contact suggestion modal */}
      <Modal visible={showSuggestionModal} transparent animationType="fade">
        <View style={styles.suggestionOverlay}>
          <View style={styles.suggestionCard}>
            <Text style={styles.suggestionTitle}>{t('tasks.suggestContactTitle')}</Text>
            <Text style={styles.suggestionBody}>
              {t('tasks.suggestContactBody', {
                name: suggestionContact ? contactDisplayName(suggestionContact) : '',
              })}
            </Text>
            <View style={styles.suggestionButtons}>
              <TouchableOpacity
                style={styles.suggestionBtnPrimary}
                onPress={() => {
                  const id = suggestionContact?.id;
                  setShowSuggestionModal(false);
                  if (id && suggestionContact) {
                    setSelectedContactId(id);
                    setSelectedContactName(contactDisplayName(suggestionContact));
                  }
                  void doSubmit(id);
                }}
              >
                <Text style={styles.suggestionBtnTextPrimary}>{t('tasks.suggestContactLink')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.suggestionBtnSecondary}
                onPress={() => {
                  setShowSuggestionModal(false);
                  void doSubmit();
                }}
              >
                <Text style={styles.suggestionBtnTextSecondary}>{t('tasks.suggestContactSkip')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {apiError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{apiError}</Text>
        </View>
      )}

      <Text style={styles.label}>{t('tasks.taskTitle')} *</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={handleTitleChange}
        placeholder={t('tasks.titlePlaceholder')}
        placeholderTextColor={colors.placeholder}
      />
      {showTitleError && <Text style={styles.fieldError}>{t('tasks.titleRequired')}</Text>}

      {/* @mention dropdown */}
      {mentionResults.length > 0 && (
        <View style={styles.mentionDropdown}>
          {mentionResults.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={styles.mentionRow}
              onPress={() => handleMentionSelect(c)}
            >
              <Text style={styles.mentionName}>{contactDisplayName(c)}</Text>
              {c.company ? <Text style={styles.mentionCompany}>{c.company}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      )}

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
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <Text style={styles.modalTitle}>{t('tasks.selectDate')}</Text>
          <TouchableOpacity onPress={() => setShowCalendar(false)}>
            <Text style={styles.modalDone}>{t('tasks.done')}</Text>
          </TouchableOpacity>
        </View>
        <Calendar
          firstDay={1}
          onDayPress={(day: CalendarDay) => {
            setDueDate(day.dateString);
            setShowCalendar(false);
          }}
          markedDates={
            dueDate
              ? ({ [dueDate]: { selected: true, selectedColor: colors.orange } } as Record<string, { selected?: boolean; selectedColor?: string }>)
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
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <Text style={styles.modalTitle}>{t('tasks.reminderDate')}</Text>
          <TouchableOpacity onPress={() => setShowReminderCalendar(false)}>
            <Text style={styles.modalDone}>{t('tasks.done')}</Text>
          </TouchableOpacity>
        </View>
        <Calendar
          firstDay={1}
          onDayPress={(day: CalendarDay) => {
            setReminderDate(day.dateString);
            setShowReminderCalendar(false);
          }}
          markedDates={
            reminderDate
              ? ({ [reminderDate]: { selected: true, selectedColor: colors.orange } } as Record<string, { selected?: boolean; selectedColor?: string }>)
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
          placeholderTextColor={colors.placeholder}
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
                setSelectedContactName(contactDisplayName(c));
                setContactQuery('');
                setContactResults([]);
              }}
            >
              <Text style={styles.dropdownText}>
                {`${contactDisplayName(c)}${c.company ? ' · ' + c.company : ''}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
        onPress={() => { void handleSubmit(); }}
        disabled={isSubmitting}
      >
        {isSubmitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.submitText}>{t('tasks.createTask')}</Text>}
      </TouchableOpacity>
    </ScrollView>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { padding: 16, backgroundColor: c.bg, flexGrow: 1 },
  errorBanner: { backgroundColor: 'rgba(204,82,71,0.12)', padding: 12, borderRadius: 12, marginBottom: 16 },
  errorBannerText: { color: c.red },
  label: { fontSize: 14, fontWeight: '600', color: c.text1, marginBottom: 6, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 12,
    padding: 12,
    minHeight: 44,
    backgroundColor: c.inputBg,
    justifyContent: 'center',
  },
  dropdownField: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
    backgroundColor: c.inputBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownChevron: { color: c.amber, fontSize: 18, marginLeft: 8 },
  pickerOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  pickerTitle: { fontSize: 16, fontWeight: '600', color: c.text1, marginBottom: 8 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  pickerRowText: { fontSize: 16, color: c.text1 },
  pickerRowTextSelected: { color: c.orange, fontWeight: '600' },
  pickerCheck: { color: c.orange, fontSize: 16, fontWeight: '700' },
  inputText: { color: c.text1, fontSize: 16 },
  placeholderText: { color: c.amber, fontSize: 16 },
  fieldError: { color: c.red, fontSize: 12, marginTop: 4 },
  clearLink: { color: c.orange, fontSize: 12, marginTop: 4 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: c.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: c.text1 },
  modalDone: { fontSize: 16, color: c.orange, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(204,120,92,0.08)',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  chipText: { color: c.orange, fontSize: 14, marginRight: 8 },
  chipRemove: { color: c.orange, fontSize: 14, fontWeight: '600' },
  dropdown: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    marginTop: 4,
    elevation: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  dropdownRow: { padding: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  dropdownText: { color: c.text1, fontSize: 14 },
  mentionDropdown: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    marginTop: 4,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: c.border,
    elevation: 4,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  mentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  mentionName: { fontSize: 14, fontWeight: '600', color: c.text1 },
  mentionCompany: { fontSize: 12, color: c.amber },
  suggestionOverlay: {
    flex: 1,
    backgroundColor: c.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  suggestionCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  suggestionTitle: { fontSize: 17, fontWeight: '700', color: c.text1, marginBottom: 8 },
  suggestionBody: { fontSize: 14, color: c.textMuted, lineHeight: 20, marginBottom: 20 },
  suggestionButtons: { flexDirection: 'row', gap: 10 },
  suggestionBtnPrimary: {
    flex: 1,
    backgroundColor: c.orange,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  suggestionBtnTextPrimary: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  suggestionBtnSecondary: {
    flex: 1,
    backgroundColor: c.wheat,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  suggestionBtnTextSecondary: { color: c.textMuted, fontSize: 15, fontWeight: '600' },
  submitButton: {
    backgroundColor: c.orange,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
