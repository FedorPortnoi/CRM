import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { formatMarketDateTime } from '../../../market/profile';
import { useContactSearch } from '../../../hooks/useContactSearch';
import { useCreateMutation } from '../../../hooks/useCreateMutation';

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
  contact_id?: string | null;
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
  return formatMarketDateTime(date, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    weekday: 'short',
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

  if (current.contact_id !== original.contact_id) {
    patch.contact_id = current.contact_id !== '' ? current.contact_id : null;
  }

  return patch;
}

export default function EditCalendarEventScreen(): JSX.Element {
  const { t } = useTranslation();
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
  const {
    query: contactQuery,
    setQuery: setContactQuery,
    results: contactResults,
    clearResults: clearContactSearch,
  } = useContactSearch({ token });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

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
      setLoadError('Not authenticated');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await fetch(`${API_URL}/calendar/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const parsedBody = (await response.json()) as ErrorApiResponse;
        setLoadError(parsedBody.error?.message ?? 'Не удалось загрузить событие');
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
      clearContactSearch();
      setFieldErrors({});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось загрузить событие');
    } finally {
      setIsLoading(false);
    }
  }, [id, token, clearContactSearch]);

  useEffect(() => {
    void loadEvent();
  }, [loadEvent]);

  function validate(): { start: Date; end: Date } | null {
    const nextErrors: FieldErrors = {};
    const trimmedTitle = title.trim();
    const start = buildLocalDate(startDate.trim(), startTime.trim());
    const end = buildLocalDate(endDate.trim(), endTime.trim());

    if (trimmedTitle === '') {
      nextErrors.title = t('calendar.titleRequired');
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

  const validatedDatesRef = useRef<{ start: Date; end: Date } | null>(null);

  const { isSubmitting, apiError, submit } = useCreateMutation<CalendarPatch, CalendarEvent>({
    endpoint: `${API_URL}/calendar/${id}`,
    method: 'PATCH',
    token: token ?? '',
    validate: () => {
      const result = validate();
      validatedDatesRef.current = result;
      return result !== null;
    },
    buildPayload: () => buildPatch(form, original!, validatedDatesRef.current!),
    onSuccess: () => { router.back(); },
    fallbackErrorMessage: t('errors.networkError'),
  });

  function handleSubmit(): void {
    if (!original) return;
    const validDates = validate();
    if (!validDates) return;
    if (Object.keys(buildPatch(form, original, validDates)).length === 0) {
      router.back();
      return;
    }
    void submit();
  }

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
      <Stack.Screen options={{ title: 'Edit Event', headerShown: true }} />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {(loadError ?? apiError) !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError ?? apiError}</Text>
          </View>
        ) : null}

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color="#C45A10" size="large" />
          </View>
        ) : original !== null ? (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('calendar.titleLabel')} *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(value) => {
                  setTitle(value);
                  setFieldErrors((prev) => ({ ...prev, title: undefined }));
                }}
                placeholder={t('calendar.titlePlaceholder')}
                placeholderTextColor="#B07868"
                autoCapitalize="sentences"
              />
              {fieldErrors.title ? <Text style={styles.fieldError}>{fieldErrors.title}</Text> : null}
            </View>

            <View style={styles.row}>
              <View style={styles.rowField}>
                <Text style={styles.label}>{t('calendar.startDate')} *</Text>
                <TextInput
                  style={styles.input}
                  value={startDate}
                  onChangeText={(value) => {
                    setStartDate(value);
                    setFieldErrors((prev) => ({ ...prev, start: undefined }));
                  }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#B07868"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.label}>{t('calendar.time')} *</Text>
                <TextInput
                  style={styles.input}
                  value={startTime}
                  onChangeText={(value) => {
                    setStartTime(value);
                    setFieldErrors((prev) => ({ ...prev, start: undefined }));
                  }}
                  placeholder="HH:mm"
                  placeholderTextColor="#B07868"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
            {fieldErrors.start ? <Text style={styles.fieldError}>{fieldErrors.start}</Text> : null}

            <View style={styles.row}>
              <View style={styles.rowField}>
                <Text style={styles.label}>{t('calendar.endDate')} *</Text>
                <TextInput
                  style={styles.input}
                  value={endDate}
                  onChangeText={(value) => {
                    setEndDate(value);
                    setFieldErrors((prev) => ({ ...prev, end: undefined }));
                  }}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#B07868"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.label}>{t('calendar.time')} *</Text>
                <TextInput
                  style={styles.input}
                  value={endTime}
                  onChangeText={(value) => {
                    setEndTime(value);
                    setFieldErrors((prev) => ({ ...prev, end: undefined }));
                  }}
                  placeholder="HH:mm"
                  placeholderTextColor="#B07868"
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
            {fieldErrors.end ? <Text style={styles.fieldError}>{fieldErrors.end}</Text> : null}

            {preview ? (
              <View style={styles.previewBox}>
                <Text style={styles.previewLabel}>{t('calendar.scheduled')}</Text>
                <Text style={styles.previewText}>{preview}</Text>
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('calendar.notesLabel')}</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder={t('calendar.notesPlaceholder')}
                placeholderTextColor="#B07868"
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{t('calendar.contactLabel')}</Text>
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
                    <Text style={styles.contactChipRemove}>{t('calendar.changeContact')}</Text>
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
              onPress={handleSubmit}
              disabled={isSubmitting}
              accessibilityRole="button"
            >
              {isSubmitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitButtonText}>{t('common.save')}</Text>
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
            <Text style={styles.retryButtonText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
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
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    marginBottom: 16,
    padding: 12,
  },
  errorBannerText: {
    color: '#ef4444',
    fontSize: 14,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    color: '#383432',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E8DDD6',
    borderRadius: 12,
    borderWidth: 1,
    color: '#383432',
    fontSize: 15,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E8DDD6',
    borderRadius: 12,
    borderWidth: 1,
    color: '#383432',
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
    color: '#ef4444',
    fontSize: 12,
    marginBottom: 10,
    marginTop: -2,
  },
  previewBox: {
    backgroundColor: '#FEF0E8',
    borderRadius: 12,
    marginBottom: 16,
    marginTop: 4,
    padding: 12,
  },
  previewLabel: {
    color: '#C45A10',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  previewText: {
    color: '#383432',
    fontSize: 14,
  },
  contactChip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderColor: '#E8DDD6',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  contactChipText: {
    color: '#383432',
    flexShrink: 1,
    fontSize: 14,
    marginRight: 8,
  },
  contactChipRemove: {
    color: '#C45A10',
    fontSize: 14,
    fontWeight: '600',
  },
  contactResultsContainer: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E8DDD6',
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 4,
  },
  contactResultItem: {
    borderBottomColor: '#E8DDD6',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  contactResultText: {
    color: '#383432',
    fontSize: 15,
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: '#C45A10',
    borderRadius: 12,
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
    backgroundColor: '#C45A10',
    borderRadius: 12,
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
