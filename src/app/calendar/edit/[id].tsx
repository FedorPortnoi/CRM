import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
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
import { useTheme } from '../../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control, tabular } from '../../../theme';
import { Screen, Card, Button, EmptyState, SkeletonText } from '../../../components/ui';
import { displayDateToIso, maskDateInput } from '../../../utils/dateInput';

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

  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function toTimeInputValue(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildLocalDate(displayDate: string, timeValue: string): Date | null {
  const dateValue = displayDateToIso(displayDate);
  if (!dateValue) return null;
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
  const { colors } = useTheme();
  const styles = makeStyles(colors);
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

  const loadEvent = useCallback(async (): Promise<void> => {
    if (!token) {
      setLoadError(t('errors.unauthorized'));
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
        setLoadError(parsedBody.error?.message ?? t('errors.networkError'));
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
      setLoadError(err instanceof Error ? err.message : t('errors.networkError'));
    } finally {
      setIsLoading(false);
    }
  }, [id, t, token, clearContactSearch]);

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
      nextErrors.start = t('calendar.dateFormatHint');
    }

    if (!end) {
      nextErrors.end = t('calendar.dateFormatHint');
    } else if (start && end <= start) {
      nextErrors.end = t('calendar.endAfterStart');
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
      <Stack.Screen options={{ title: t('calendar.edit') }} />
      <Screen contentContainerStyle={styles.contentPad}>
        {(loadError ?? apiError) !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError ?? apiError}</Text>
          </View>
        ) : null}

        {isLoading ? (
          <>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={1} />
            </Card>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={2} lastLineWidth="60%" />
            </Card>
            <Card>
              <SkeletonText lines={3} lastLineWidth="50%" />
            </Card>
          </>
        ) : original !== null ? (
          <>
            <Card style={styles.cardSpacing}>
              <Text style={styles.label}>{t('calendar.titleLabel')} *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(value) => {
                  setTitle(value);
                  setFieldErrors((prev) => ({ ...prev, title: undefined }));
                }}
                placeholder={t('calendar.titlePlaceholder')}
                placeholderTextColor={colors.placeholder}
                autoCapitalize="sentences"
              />
              {fieldErrors.title ? <Text style={styles.fieldError}>{fieldErrors.title}</Text> : null}
            </Card>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <View style={styles.row}>
                  <View style={styles.rowField}>
                    <Text style={styles.label}>{t('calendar.startDate')} *</Text>
                    <TextInput
                      style={[styles.input, styles.tabularInput]}
                      value={startDate}
                      onChangeText={(value) => {
                        setStartDate(maskDateInput(value));
                        setFieldErrors((prev) => ({ ...prev, start: undefined }));
                      }}
                      placeholder={t('common.datePlaceholder')}
                      placeholderTextColor={colors.placeholder}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={styles.timeField}>
                    <Text style={styles.label}>{t('calendar.time')} *</Text>
                    <TextInput
                      style={[styles.input, styles.tabularInput]}
                      value={startTime}
                      onChangeText={(value) => {
                        setStartTime(value);
                        setFieldErrors((prev) => ({ ...prev, start: undefined }));
                      }}
                      placeholder="HH:mm"
                      placeholderTextColor={colors.placeholder}
                      keyboardType="numbers-and-punctuation"
                    />
                  </View>
                </View>
                {fieldErrors.start ? <Text style={styles.fieldError}>{fieldErrors.start}</Text> : null}
              </View>

              <View style={styles.fieldGroupLast}>
                <View style={styles.row}>
                  <View style={styles.rowField}>
                    <Text style={styles.label}>{t('calendar.endDate')} *</Text>
                    <TextInput
                      style={[styles.input, styles.tabularInput]}
                      value={endDate}
                      onChangeText={(value) => {
                        setEndDate(maskDateInput(value));
                        setFieldErrors((prev) => ({ ...prev, end: undefined }));
                      }}
                      placeholder={t('common.datePlaceholder')}
                      placeholderTextColor={colors.placeholder}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={styles.timeField}>
                    <Text style={styles.label}>{t('calendar.time')} *</Text>
                    <TextInput
                      style={[styles.input, styles.tabularInput]}
                      value={endTime}
                      onChangeText={(value) => {
                        setEndTime(value);
                        setFieldErrors((prev) => ({ ...prev, end: undefined }));
                      }}
                      placeholder="HH:mm"
                      placeholderTextColor={colors.placeholder}
                      keyboardType="numbers-and-punctuation"
                    />
                  </View>
                </View>
                {fieldErrors.end ? <Text style={styles.fieldError}>{fieldErrors.end}</Text> : null}
              </View>

              {preview ? (
                <View style={styles.previewBox}>
                  <Text style={styles.previewLabel}>{t('calendar.scheduled')}</Text>
                  <Text style={[styles.previewText, styles.tabularInput]}>{preview}</Text>
                </View>
              ) : null}
            </Card>

            <Card style={styles.cardSpacing}>
              <Text style={styles.label}>{t('calendar.notesLabel')}</Text>
              <TextInput
                style={styles.notesInput}
                value={notes}
                onChangeText={setNotes}
                placeholder={t('calendar.notesPlaceholder')}
                placeholderTextColor={colors.placeholder}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />
            </Card>

            <Card style={styles.cardSpacing}>
              <Text style={styles.label}>{t('calendar.contactLabel')}</Text>
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
              title={t('common.save')}
              onPress={handleSubmit}
              loading={isSubmitting}
              disabled={isSubmitting}
              block
            />
          </>
        ) : (
          <EmptyState
            title={loadError ?? t('errors.networkError')}
            actionLabel={t('common.retry')}
            onAction={() => { void loadEvent(); }}
          />
        )}
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
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  errorBannerText: { ...type.body, color: c.danger },
  fieldGroup: { marginBottom: spacing.md },
  fieldGroupLast: { marginBottom: 0 },
  label: {
    ...type.label,
    color: c.text1,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: c.inputBg,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    borderWidth: 1,
    color: c.text1,
    ...type.body,
    justifyContent: 'center',
    minHeight: control.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tabularInput: { ...tabular },
  notesInput: {
    backgroundColor: c.inputBg,
    borderColor: c.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    color: c.text1,
    ...type.body,
    height: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  rowField: {
    flex: 1,
  },
  timeField: {
    width: 108,
  },
  fieldError: {
    ...type.caption,
    color: c.danger,
    marginTop: spacing.xs,
  },
  previewBox: {
    backgroundColor: c.accentSoft,
    borderRadius: radius.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  previewLabel: {
    ...type.micro,
    color: c.accent,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  previewText: {
    ...type.body,
    color: c.text1,
  },
  contactChip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: c.bgPanel,
    borderColor: c.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contactChipText: {
    ...type.body,
    color: c.text1,
    flexShrink: 1,
    marginRight: spacing.sm,
  },
  contactChipRemove: { ...type.body, color: c.accent, fontWeight: '600' },
  contactResultsContainer: {
    backgroundColor: c.bgPanel,
    borderColor: c.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: spacing.xs,
  },
  contactResultItem: {
    borderBottomColor: c.border,
    borderBottomWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  contactResultText: { ...type.body, color: c.text1 },
  contactEmptyState: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
});
