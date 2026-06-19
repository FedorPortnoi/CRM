import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useCreateMutation } from '../../hooks/useCreateMutation';
import { formatMarketDateTime } from '../../market/profile';

type FieldErrors = {
  title?: string;
  start?: string;
  end?: string;
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function roundedNextHour(): Date {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date;
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

export default function NewCalendarEventScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const defaultStart = useMemo(() => roundedNextHour(), []);
  const defaultEnd = useMemo(() => {
    const date = new Date(defaultStart);
    date.setHours(date.getHours() + 1);
    return date;
  }, [defaultStart]);

  const [title, setTitle] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(toDateInput(defaultStart));
  const [startTime, setStartTime] = useState<string>(toTimeInput(defaultStart));
  const [endDate, setEndDate] = useState<string>(toDateInput(defaultEnd));
  const [endTime, setEndTime] = useState<string>(toTimeInput(defaultEnd));
  const [location, setLocation] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const startDateTime = buildLocalDate(startDate.trim(), startTime.trim());
  const endDateTime = buildLocalDate(endDate.trim(), endTime.trim());

  const preview =
    startDateTime && endDateTime
      ? `${formatPreview(startDateTime)} - ${formatPreview(endDateTime)}`
      : null;

  // Stores the validated { start, end } dates between validate() and buildPayload() calls.
  const validatedDatesRef = useRef<{ start: Date; end: Date } | null>(null);

  const { isSubmitting, apiError, submit } = useCreateMutation<
    {
      title: string;
      start_time: string;
      end_time: string;
      location?: string;
      description?: string;
      reminder_minutes: number;
      send_invite: boolean;
    },
    { id: string }
  >({
    endpoint: `${API_URL}/calendar`,
    token: token ?? '',
    validate: () => {
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

      if (start && end && Object.keys(nextErrors).length === 0) {
        validatedDatesRef.current = { start, end };
        return true;
      }
      validatedDatesRef.current = null;
      return false;
    },
    buildPayload: () => {
      const dates = validatedDatesRef.current!;
      return {
        title: title.trim(),
        start_time: dates.start.toISOString(),
        end_time: dates.end.toISOString(),
        reminder_minutes: 30,
        send_invite: false,
        ...(location.trim() !== '' ? { location: location.trim() } : {}),
        ...(notes.trim() !== '' ? { description: notes.trim() } : {}),
      };
    },
    onSuccess: (data, queued) => {
      if (queued) {
        router.replace('/calendar');
        return;
      }
      router.replace({
        pathname: '/calendar/[id]',
        params: { id: data.id },
      });
    },
    fallbackErrorMessage: t('calendar.failedToCreate'),
  });

  return (
    <>
      <Stack.Screen options={{ title: t('calendar.new'), headerShown: true, headerBackTitle: '' }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {apiError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{apiError}</Text>
          </View>
        ) : null}

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
          <Text style={styles.label}>{t('calendar.locationLabel')}</Text>
          <TextInput
            style={styles.input}
            value={location}
            onChangeText={setLocation}
            placeholder={t('calendar.locationPlaceholder')}
            placeholderTextColor="#B07868"
          />
        </View>

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

        <TouchableOpacity
          style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
          onPress={() => {
            void submit();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitButtonText}>{t('calendar.createEvent')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#ef4444',
    fontSize: 14,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#383432',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E8DDD6',
    borderRadius: 12,
    borderWidth: 1,
    color: '#383432',
    fontSize: 15,
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
    padding: 12,
    marginTop: 4,
    marginBottom: 16,
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
  submitButton: {
    alignItems: 'center',
    backgroundColor: '#C45A10',
    borderRadius: 12,
    justifyContent: 'center',
    marginTop: 12,
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
});
