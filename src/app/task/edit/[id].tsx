import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { scheduleTaskDueReminder } from '../../../utils/notifications';
import { sendOrQueueMutation } from '../../../utils/offlineMutation';

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
};

type TaskPatch = {
  title?: string;
  due_date?: string;
  description?: string;
  contact_id?: string;
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
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString('en-US', {
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

  if (current.due_date !== '' && current.due_date !== original.due_date) {
    patch.due_date = new Date(`${current.due_date}T00:00:00`).toISOString();
  }

  if (current.contact_id !== '' && current.contact_id !== original.contact_id) {
    patch.contact_id = current.contact_id;
  }

  return patch;
}

export default function EditTaskScreen(): JSX.Element {
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

  const form = useMemo<TaskForm>(
    () => ({
      title,
      due_date: dueDate,
      description: notes,
      contact_id: selectedContactId,
    }),
    [dueDate, notes, selectedContactId, title],
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
            await scheduleTaskDueReminder(id, parsedBody.data.title, parsedBody.data.due_date);
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
      setApiError(err instanceof Error ? err.message : 'Network error');
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
            <ActivityIndicator size="large" color="#10b981" />
          </View>
        ) : original !== null ? (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Task Title *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(text) => {
                  setTitle(text);
                  setShowTitleError(false);
                }}
                placeholder="Enter task title"
                placeholderTextColor="#6b7280"
                autoCapitalize="sentences"
              />
              {showTitleError ? <Text style={styles.fieldError}>Title is required</Text> : null}
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
                        [dueDate]: { selected: true, selectedColor: '#10b981' },
                      } as Record<string, { selected?: boolean; selectedColor?: string }>)
                    : {}
                }
              />
            </Modal>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Notes</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder="Add notes"
                placeholderTextColor="#6b7280"
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
                    placeholder="Search contacts by name..."
                    placeholderTextColor="#6b7280"
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
                <Text style={styles.submitButtonText}>Save Changes</Text>
              )}
            </TouchableOpacity>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0fdf8' },
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
  bannerRetryText: { color: '#10b981', fontWeight: '600' },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', color: '#111827', marginBottom: 6 },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
    fontSize: 16,
    color: '#111827',
  },
  inputText: { color: '#111827', fontSize: 16 },
  placeholderText: { color: '#6b7280', fontSize: 16 },
  clearLink: { color: '#10b981', fontSize: 12, marginTop: 4 },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    height: 100,
    fontSize: 16,
    color: '#111827',
  },
  fieldError: { color: '#ef4444', fontSize: 12, marginTop: 4 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#111827' },
  modalDone: { fontSize: 16, color: '#10b981', fontWeight: '600' },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  contactChipText: {
    fontSize: 14,
    color: '#111827',
    marginRight: 8,
    flexShrink: 1,
  },
  contactChipRemove: { fontSize: 14, color: '#10b981', fontWeight: '600' },
  contactResultsContainer: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    marginTop: 4,
  },
  contactResultItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  contactResultText: { fontSize: 15, color: '#111827' },
  submitButton: {
    backgroundColor: '#10b981',
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
