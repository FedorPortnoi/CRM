import React, { useMemo, useState } from 'react';
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
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

type CreateCalendarEventResponse = {
  data: { id: string };
};

type ErrorResponse = {
  error?: { message?: string };
};

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
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function NewCalendarEventScreen(): JSX.Element {
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
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const startDateTime = buildLocalDate(startDate.trim(), startTime.trim());
  const endDateTime = buildLocalDate(endDate.trim(), endTime.trim());

  const preview =
    startDateTime && endDateTime
      ? `${formatPreview(startDateTime)} - ${formatPreview(endDateTime)}`
      : null;

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

    setIsSubmitting(true);
    setApiError(null);

    const body: {
      title: string;
      start_time: string;
      end_time: string;
      location?: string;
      description?: string;
      reminder_minutes: number;
      send_invite: boolean;
    } = {
      title: title.trim(),
      start_time: validDates.start.toISOString(),
      end_time: validDates.end.toISOString(),
      reminder_minutes: 30,
      send_invite: false,
      ...(location.trim() !== '' ? { location: location.trim() } : {}),
      ...(notes.trim() !== '' ? { description: notes.trim() } : {}),
    };

    try {
      const result = await sendOrQueueMutation({
        url: `${API_URL}/calendar`,
        method: 'POST',
        token: token ?? '',
        body,
      });

      if (result.queued) {
        router.replace('/calendar');
        return;
      }

      const res = result.response;

      if (res.status === 201) {
        const parsed = (await res.json()) as CreateCalendarEventResponse;
        router.replace({
          pathname: '/calendar/[id]',
          params: { id: parsed.data.id },
        });
      } else {
        const parsed = (await res.json()) as ErrorResponse;
        setApiError(parsed.error?.message ?? 'Failed to create event');
      }
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'New Event', headerShown: true }} />
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
          <Text style={styles.label}>Title *</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={(value) => {
              setTitle(value);
              setFieldErrors((prev) => ({ ...prev, title: undefined }));
            }}
            placeholder="Client meeting"
            placeholderTextColor="#6b7280"
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
              placeholderTextColor="#6b7280"
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
              placeholderTextColor="#6b7280"
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
              placeholderTextColor="#6b7280"
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
              placeholderTextColor="#6b7280"
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
          <Text style={styles.label}>Location</Text>
          <TextInput
            style={styles.input}
            value={location}
            onChangeText={setLocation}
            placeholder="Office, phone, or video link"
            placeholderTextColor="#6b7280"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Notes</Text>
          <TextInput
            style={styles.notesInput}
            value={notes}
            onChangeText={setNotes}
            placeholder="Prep notes or agenda"
            placeholderTextColor="#6b7280"
            multiline
            numberOfLines={5}
            textAlignVertical="top"
          />
        </View>

        <TouchableOpacity
          style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
          onPress={() => {
            void handleSubmit();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitButtonText}>Create Event</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0fdf8',
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
    color: '#111827',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#e5e7eb',
    borderRadius: 12,
    borderWidth: 1,
    color: '#111827',
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  notesInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#e5e7eb',
    borderRadius: 12,
    borderWidth: 1,
    color: '#111827',
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
    backgroundColor: '#ecfdf5',
    borderRadius: 12,
    padding: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  previewLabel: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  previewText: {
    color: '#111827',
    fontSize: 14,
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: '#10b981',
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
