import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { formatMarketDate } from '../../../market/profile';
import { RECURRENCE_OPTIONS, labelKeyForRule, normalizeRule } from '../../../utils/recurrence';
import { useContactSearch } from '../../../hooks/useContactSearch';
import { useCreateMutation } from '../../../hooks/useCreateMutation';
import { useTheme } from '../../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control, tabular } from '../../../theme';
import { Screen, Card, Button, EmptyState, SkeletonText } from '../../../components/ui';
import ReminderEditor from '../../../components/reminders/ReminderEditor';
import {
  draftFromReminder,
  draftSignature,
  firstLocalFireInstant,
  syncTaskReminders,
  useTaskReminders,
  type ReminderDraft,
} from '../../../hooks/useTaskReminders';

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

/** Order-independent fingerprint of the whole schedule — drives the "did anything move?" check. */
function remindersSignature(drafts: ReminderDraft[]): string {
  return drafts
    .map((draft) => `${draft.id ?? 'new'}:${draftSignature(draft)}`)
    .sort()
    .join('||');
}

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
  const { colors } = useTheme();
  const styles = makeStyles(colors);
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
  const [reminders, setReminders] = useState<ReminderDraft[]>([]);
  const [originalReminders, setOriginalReminders] = useState<ReminderDraft[]>([]);
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

  const remindersQuery = useTaskReminders(typeof id === 'string' && id !== '' ? id : null);
  const remindersSeededRef = useRef<boolean>(false);

  // Seed the editor ONCE. A background refetch landing mid-edit must not overwrite what
  // the user has typed; the server copy is reconciled by syncTaskReminders() on save.
  useEffect(() => {
    if (remindersSeededRef.current) return;
    if (!remindersQuery.data) return;
    const drafts = remindersQuery.data.map(draftFromReminder);
    remindersSeededRef.current = true;
    setReminders(drafts);
    setOriginalReminders(drafts);
  }, [remindersQuery.data]);

  const remindersChanged = useMemo(
    () => remindersSignature(reminders) !== remindersSignature(originalReminders),
    [reminders, originalReminders],
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
      if (remindersChanged) {
        // Keep the legacy single-instant column in step with the schedule: the earliest
        // one-off reminder, or nothing at all when everything left is repeating.
        patch.reminder_at = firstLocalFireInstant(reminders);
      }
      return patch;
    },
    onSuccess: async (data, queued) => {
      if (!queued && remindersChanged) {
        try {
          await syncTaskReminders({
            taskId: id,
            token: token ?? '',
            original: originalReminders,
            next: reminders,
          });
          setOriginalReminders(reminders);
        } catch {
          // The task itself already saved, so the screen cannot simply refuse to close.
          Alert.alert(t('reminders.title'), t('reminders.saveFailed'));
        }
      }

      router.back();
    },
    fallbackErrorMessage: t('errors.networkError'),
  });

  const handleSubmit = async (): Promise<void> => {
    if (!original || !token) return;
    const patch = buildPatch(form, original);
    if (Object.keys(patch).length === 0 && !remindersChanged) {
      router.back();
      return;
    }
    await submit();
  };

  const renderContactItem = ({ item }: ListRenderItemInfo<ContactPreview>): JSX.Element => (
    <TouchableOpacity
      style={styles.contactResultItem}
      activeOpacity={0.7}
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
    <>
      <Stack.Screen options={{ title: t('tasks.edit') }} />
      <Screen contentContainerStyle={styles.contentPad}>
        {(loadError ?? apiError) !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError ?? apiError}</Text>
            {!isSubmitting && loadError !== null ? (
              <Button
                title={t('common.retry')}
                variant="ghost"
                size="sm"
                onPress={() => { void loadTask(); }}
                style={styles.bannerRetry}
              />
            ) : null}
          </View>
        ) : null}

        {isLoading ? (
          <>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={1} />
            </Card>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={2} lastLineWidth="45%" />
            </Card>
            <Card>
              <SkeletonText lines={3} lastLineWidth="55%" />
            </Card>
          </>
        ) : original !== null ? (
          <>
            <Card style={styles.cardSpacing}>
              <Text style={styles.label}>{t('tasks.taskTitle')} *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(text) => {
                  setTitle(text);
                  setShowTitleError(false);
                }}
                placeholder={t('tasks.titlePlaceholder')}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="sentences"
              />
              {showTitleError ? <Text style={styles.fieldError}>{t('tasks.titleRequired')}</Text> : null}
            </Card>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('tasks.dueDate')}</Text>
                <TouchableOpacity style={styles.input} activeOpacity={0.7} onPress={() => setShowCalendar(true)}>
                  <Text style={[dueDate !== '' ? styles.inputText : styles.placeholderText, styles.tabularText]}>
                    {dueDate !== '' ? formatDate(dueDate) : t('tasks.pickDate')}
                  </Text>
                </TouchableOpacity>
                {dueDate !== '' ? (
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setDueDate('')}>
                    <Text style={styles.clearLink}>{t('tasks.clear')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <View style={styles.fieldGroupLast}>
                <ReminderEditor
                  value={reminders}
                  onChange={setReminders}
                  defaultDate={dueDate}
                  isLoading={remindersQuery.isLoading}
                  loadError={remindersQuery.isError ? t('reminders.loadFailed') : null}
                  onRetry={() => void remindersQuery.refetch()}
                />
              </View>
            </Card>

            <Modal animationType="slide" visible={showCalendar} onRequestClose={() => setShowCalendar(false)}>
              <View style={[styles.modalHeader, { paddingTop: insets.top + spacing.md }]}>
                <Text style={styles.modalTitle}>{t('tasks.selectDate')}</Text>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setShowCalendar(false)}>
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
                  dueDate !== ''
                    ? ({
                        [dueDate]: { selected: true, selectedColor: colors.accent },
                      } as Record<string, { selected?: boolean; selectedColor?: string }>)
                    : {}
                }
              />
            </Modal>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('tasks.repeat')}</Text>
                <TouchableOpacity style={styles.dropdownField} onPress={() => setShowRepeatPicker(true)} activeOpacity={0.7}>
                  <Text style={styles.inputText}>{t(labelKeyForRule(recurrenceRule) ?? 'tasks.recurrenceNone')}</Text>
                  <Text style={styles.dropdownChevron}>{'⌄'}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('tasks.assignedTo')}</Text>
                <TouchableOpacity style={styles.dropdownField} onPress={() => setShowAssigneePicker(true)} activeOpacity={0.7}>
                  <Text style={styles.inputText}>
                    {user && assigneeId === user.id ? t('tasks.assignedToYou', { name: assigneeName || user.name }) : assigneeName}
                  </Text>
                  <Text style={styles.dropdownChevron}>{'⌄'}</Text>
                </TouchableOpacity>
              </View>
            </Card>

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
                        activeOpacity={0.7}
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
                        activeOpacity={0.7}
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

            <Card style={styles.cardSpacing}>
              <Text style={styles.label}>{t('tasks.notes')}</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder={t('tasks.notesPlaceholder')}
                placeholderTextColor={colors.placeholder}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </Card>

            <Card style={styles.cardSpacing}>
              <Text style={styles.label}>{t('tasks.contact')}</Text>
              {selectedContactId !== '' ? (
                <View style={styles.contactChip}>
                  <Text style={styles.contactChipText} numberOfLines={1}>
                    {selectedContactName}
                  </Text>
                  <TouchableOpacity
                    activeOpacity={0.7}
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
                    placeholderTextColor={colors.placeholder}
                  />
                  {contactQuery.trim() !== '' ? (
                    <View style={styles.contactResultsContainer}>
                      <FlatList<ContactPreview>
                        data={contactResults.slice(0, 5)}
                        keyExtractor={(item) => item.id}
                        renderItem={renderContactItem}
                        scrollEnabled={false}
                        keyboardShouldPersistTaps="handled"
                        ListEmptyComponent={
                          <EmptyState
                            title={t('contacts.noSearchResults')}
                            style={styles.contactEmptyState}
                          />
                        }
                      />
                    </View>
                  ) : null}
                </>
              )}
            </Card>

            <Button
              title={t('tasks.saveTask')}
              onPress={() => { void handleSubmit(); }}
              loading={isSubmitting}
              disabled={isSubmitting}
              block
            />
          </>
        ) : null}
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
  errorBanner: {
    backgroundColor: c.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
  },
  errorBannerText: { ...type.body, color: c.danger },
  bannerRetry: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  fieldGroup: { marginBottom: spacing.md },
  fieldGroupLast: { marginBottom: 0 },
  label: { ...type.label, color: c.text1, marginBottom: spacing.xs },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: control.md,
    justifyContent: 'center',
    ...type.body,
    color: c.text1,
  },
  inputText: { ...type.body, color: c.text1 },
  placeholderText: { ...type.body, color: c.placeholder },
  tabularText: { ...tabular },
  clearLink: { ...type.caption, color: c.accent, marginTop: spacing.xs },
  dropdownField: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    minHeight: control.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownChevron: { color: c.textMuted, fontSize: 16, marginLeft: spacing.sm },
  pickerOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  pickerTitle: { ...type.heading, color: c.text1, marginBottom: spacing.sm },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  pickerRowText: { ...type.body, color: c.text1 },
  pickerRowTextSelected: { color: c.accent, fontWeight: '600' },
  pickerCheck: { color: c.accent, fontSize: 16, fontWeight: '700' },
  notesInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    height: 100,
    ...type.body,
    color: c.text1,
  },
  fieldError: { ...type.caption, color: c.danger, marginTop: spacing.xs },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
    backgroundColor: c.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalTitle: { ...type.title, color: c.text1 },
  modalDone: { ...type.body, color: c.accent, fontWeight: '600' },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.bgPanel,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  contactChipText: {
    ...type.body,
    color: c.text1,
    marginRight: spacing.sm,
    flexShrink: 1,
  },
  contactChipRemove: { ...type.body, color: c.accent, fontWeight: '600' },
  contactResultsContainer: {
    backgroundColor: c.bgPanel,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    marginTop: spacing.xs,
  },
  contactResultItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  contactResultText: { ...type.body, color: c.text1 },
  contactEmptyState: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
});
