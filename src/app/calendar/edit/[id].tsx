import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';

type CalendarContact = {
  id: string;
  first_name: string;
  last_name: string | null;
};

type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  contact_id?: string | null;
  contact: CalendarContact | null;
};

type ContactPreview = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
};

type ErrorApiResponse = {
  error?: { code?: string; message?: string };
};

type CalendarForm = {
  title: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  description: string;
  contact_id: string;
};

type CalendarPatch = {
  title?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
  contact_id?: string;
};

type FieldErrors = {
  title?: string;
  start?: string;
  end?: string;
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function contactDisplayName(contact: { first_name: string; last_name: string | null }): string {
  return `${contact.first_name}${contact.last_name ? ' ' + contact.last_name : ''}`;
}

function formatContactResult(contact: ContactPreview): string {
  const name = contactDisplayName(contact);
  return contact.company ? `${name} - ${contact.company}` : name;
}

function toDateInputValue(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInputValue(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildLocalDate(dateValue: string, timeValue: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  if (!/^\d{2}:\d{2}$/.test(timeValue)) return null;

  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }

  return date;
}

function formatPreview(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function toForm(event: CalendarEvent): CalendarForm {
  return {
    title: event.title,
    start_date: toDateInputValue(event.start_time),
    start_time: toTimeInputValue(event.start_time),
    end_date: toDateInputValue(event.end_time),
    end_time: toTimeInputValue(event.end_time),
    description: event.description ?? '',
    contact_id: event.contact_id ?? event.contact?.id ?? '',
  };
}

function buildPatch(
  current: CalendarForm,
  original: CalendarForm,
  validDates: { start: Date; end: Date },
): CalendarPatch {
  const patch: CalendarPatch = {};
  const currentTitle = current.title.trim();
  const originalTitle = original.title.trim();
  const currentDescription = current.description.trim();
  const originalDescription = original.description.trim();

  if (currentTitle !== originalTitle) {
    patch.title = currentTitle;
  }

  if (
    current.start_date !== original.start_date ||
    current.start_time !== original.start_time
  ) {
    patch.start_time = validDates.start.toISOString();
  }

  if (current.end_date !== original.end_date || current.end_time !== original.end_time) {
    patch.end_time = validDates.end.toISOString();
  }

  if (currentDescription !== originalDescription) {
    patch.description = currentDescription;
  }

  if (current.contact_id !== '' && current.contact_id !== original.contact_id) {
    patch.contact_id = current.contact_id;
  }

  return patch;
}

export default function EditCalendarEventScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);

  const [original, setOriginal] = useState<CalendarForm | null>(null);
  const [title, setTitle] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [startTime, setStartTime] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [endTime, setEndTime] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const form = useMemo<CalendarForm>(
    () => ({
      title,
      start_date: startDate,
      start_time: startTime,
      end_date: endDate,
      end_time: endTime,
      description: notes,
      contact_id: selectedContactId,
    }),
    [endDate, endTime, notes, selectedContactId, startDate, startTime, title],
  );

  const startDateTime = buildLocalDate(startDate.trim(), startTime.trim());
  const endDateTime = buildLocalDate(endDate.trim(), endTime.trim());
  const preview =
    startDateTime && endDateTime
      ? `${formatPreview(startDateTime)} - ${formatPreview(endDateTime)}`
      : null;
  const visibleContactResults = contactResults.slice(0, 5);

  const loadEvent = useCallback(async (): Promise<void> => {
    if (!token) {
      setApiError('Not authenticated');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setApiError(null);

    try {
      const response = await fetch(`${API_URL}/calendar/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const parsedBody = (await response.json()) as ErrorApiResponse;
        setApiError(parsedBody.error?.message ?? 'Failed to load event');
        return;
      }

      const parsedBody = (await response.json()) as { data: CalendarEvent };
      const loadedForm = toForm(parsedBody.data);
      setOriginal(loadedForm);
      setTitle(loadedForm.title);
      setStartDate(loadedForm.start_date);
      setStartTime(loadedForm.start_time);
      setEndDate(loadedForm.end_date);
      setEndTime(loadedForm.end_time);
      setNotes(loadedForm.description);
      setSelectedContactId(loadedForm.contact_id);
      setSelectedContactName(
        parsedBody.data.contact !== null ? contactDisplayName(parsedBody.data.contact) : '',
      );
      setContactQuery('');
      setContactResults([]);
      setFieldErrors({});
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to load event');
    } finally {
      setIsLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    void loadEvent();
  }, [loadEvent]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const query = contactQuery.trim();

      if (!token || query.length < 2) {
        setContactResults([]);
        return;
      }

      try {
        const response = await fetch(
          `${API_URL}/contacts?q=${encodeURIComponent(query)}&per_page=8`,
          { headers: { Authorization: `Bearer ${token}` } },
        );

        if (!response.ok) {
          setContactResults([]);
          return;
        }

        const parsedBody = (await response.json()) as { data: ContactPreview[] };
        setContactResults(parsedBody.data);
      } catch {
        setContactResults([]);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [contactQuery, token]);

  function validate(): { start: Date; end: Date } | null {
    const nextErrors: FieldErrors = {};
    const trimmedTitle = title.trim();
    const start = buildLocalDate(startDate.trim(), startTime.trim());
    const end = buildLocalDate(endDate.trim(), endTime.trim());

    if (trimmedTitle === '') {
      nextErrors.title = 'Title is required';
    }

    if (!start) {
      nextErrors.start = 'Use YYYY-MM-DD and HH:mm';
    }

    if (!end) {
      nextErrors.end = 'Use YYYY-MM-DD and HH:mm';
    } else if (start && end <= start) {
      nextErrors.end = 'End must be after start';
    }

    setFieldErrors(nextErrors);
    return start && end && Object.keys(nextErrors).length === 0 ? { start, end } : null;
  }

  async function handleSubmit(): Promise<void> {
    const validDates = validate();
    if (!validDates || isSubmitting) return;
    if (!original || !token) return;

    setApiError(null);
    setIsSubmitting(true);

    const patch = buildPatch(form, original, validDates);
    if (Object.keys(patch).length === 0) {
      setIsSubmitting(false);
      router.back();
      return;
    }

    try {
      const response = await fetch(`${API_URL}/calendar/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(patch),
      });

      if (response.ok) {
        router.back();
      } else {
        const parsedBody = (await response.json()) as ErrorApiResponse;
        setApiError(parsedBody.error?.message ?? 'Failed to update event');
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  }

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
      <Stack.Screen options={{ title: 'Edit Event', headerShown: true }} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {apiError !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{apiError}</Text>
          </View>
        ) : null}

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color="#1A73E8" size="large" />
          </View>
        ) : original !== null ? (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Title *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(value) => {
                  setTitle(value);
                  setFieldErrors((prev) => ({ ...prev, title: undefined }));
                }}
                placeholder="Client meeting"
                placeholderTextColor="#6B6B6B"
                autoCapitalize="sentences"
              />
              {fieldErrors.title ? <Text style={styles.fieldError}>{fieldErrors.title}</Text> : null}
            </View>

            <View style={styles.row}>
              <View style={styles.rowField}>
                <Text style={styles.label}>Start Date *</Text>
                <TextInput
                  style={styles.input}
                  value={startDate}
                  onChangeText={(value) => {
                    setStartDate(value);
                    setFieldErrors((prev) => ({ ...prev, start: undefined }));
                  }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#6B6B6B"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.label}>Time *</Text>
                <TextInput
                  style={styles.input}
                  value={startTime}
                  onChangeText={(value) => {
                    setStartTime(value);
                    setFieldErrors((prev) => ({ ...prev, start: undefined }));
                  }}
                  placeholder="HH:mm"
                  placeholderTextColor="#6B6B6B"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
            {fieldErrors.start ? <Text style={styles.fieldError}>{fieldErrors.start}</Text> : null}

            <View style={styles.row}>
              <View style={styles.rowField}>
                <Text style={styles.label}>End Date *</Text>
                <TextInput
                  style={styles.input}
                  value={endDate}
                  onChangeText={(value) => {
                    setEndDate(value);
                    setFieldErrors((prev) => ({ ...prev, end: undefined }));
                  }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#6B6B6B"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.label}>Time *</Text>
                <TextInput
                  style={styles.input}
                  value={endTime}
                  onChangeText={(value) => {
                    setEndTime(value);
                    setFieldErrors((prev) => ({ ...prev, end: undefined }));
                  }}
                  placeholder="HH:mm"
                  placeholderTextColor="#6B6B6B"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
            {fieldErrors.end ? <Text style={styles.fieldError}>{fieldErrors.end}</Text> : null}

            {preview ? (
              <View style={styles.previewBox}>
                <Text style={styles.previewLabel}>Scheduled</Text>
                <Text style={styles.previewText}>{preview}</Text>
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Notes</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder="Prep notes or agenda"
                placeholderTextColor="#6B6B6B"
                multiline
                numberOfLines={5}
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
                    placeholderTextColor="#6B6B6B"
                  />
                  {visibleContactResults.length > 0 ? (
                    <View style={styles.contactResultsContainer}>
                      <FlatList<ContactPreview>
                        data={visibleContactResults}
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
              accessibilityRole="button"
            >
              {isSubmitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitButtonText}>Save Changes</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              void loadEvent();
            }}
            accessibilityRole="button"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#F5F5F5',
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  loadingContainer: {
    paddingTop: 48,
  },
  errorBanner: {
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    marginBottom: 16,
    padding: 12,
  },
  errorBannerText: {
    color: '#D93025',
    fontSize: 14,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    color: '#1A1A1A',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E0E0E0',
    borderRadius: 8,
    borderWidth: 1,
    color: '#1A1A1A',
    fontSize: 15,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E0E0E0',
    borderRadius: 8,
    borderWidth: 1,
    color: '#1A1A1A',
    fontSize: 15,
    height: 112,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6,
  },
  rowField: {
    flex: 1,
  },
  timeField: {
    width: 108,
  },
  fieldError: {
    color: '#D93025',
    fontSize: 12,
    marginBottom: 10,
    marginTop: -2,
  },
  previewBox: {
    backgroundColor: '#E8F0FE',
    borderRadius: 8,
    marginBottom: 16,
    marginTop: 4,
    padding: 12,
  },
  previewLabel: {
    color: '#1A73E8',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  previewText: {
    color: '#1A1A1A',
    fontSize: 14,
  },
  contactChip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderColor: '#E0E0E0',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  contactChipText: {
    color: '#1A1A1A',
    flexShrink: 1,
    fontSize: 14,
    marginRight: 8,
  },
  contactChipRemove: {
    color: '#1A73E8',
    fontSize: 14,
    fontWeight: '600',
  },
  contactResultsContainer: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E0E0E0',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  contactResultItem: {
    borderBottomColor: '#E0E0E0',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  contactResultText: {
    color: '#1A1A1A',
    fontSize: 15,
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: '#1A73E8',
    borderRadius: 8,
    justifyContent: 'center',
    marginBottom: 32,
    marginTop: 24,
    minHeight: 48,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#1A73E8',
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
