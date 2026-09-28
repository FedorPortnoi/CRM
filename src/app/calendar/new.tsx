import { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useCreateMutation } from '../../hooks/useCreateMutation';
import { formatMarketDateTime } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control } from '../../theme';
import { Screen, Button } from '../../components/ui';
import { displayDateToIso, maskDateInput } from '../../utils/dateInput';

type FieldErrors = {
  title?: string;
  start?: string;
  end?: string;
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function toDateInput(date: Date): string {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function toTimeInput(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function roundedNextHour(): Date {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date;
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

export default function NewCalendarEventScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
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
        nextErrors.start = t('calendar.dateFormatHint');
      }

      if (!end) {
        nextErrors.end = t('calendar.dateFormatHint');
      } else if (start && end <= start) {
        nextErrors.end = t('calendar.endAfterStart');
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
      <Screen>
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
            placeholderTextColor={colors.placeholder}
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
              style={styles.input}
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

        <View style={styles.row}>
          <View style={styles.rowField}>
            <Text style={styles.label}>{t('calendar.endDate')} *</Text>
            <TextInput
              style={styles.input}
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
              style={styles.input}
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
            placeholderTextColor={colors.placeholder}
          />
        </View>

        <View style={styles.fieldGroup}>
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
        </View>

        <Button
          title={t('calendar.createEvent')}
          onPress={() => { void submit(); }}
          loading={isSubmitting}
          block
          style={styles.submitButton}
        />
      </Screen>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  errorBanner: {
    backgroundColor: c.dangerSoft,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorBannerText: {
    color: c.danger,
    ...type.body,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
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
    minHeight: control.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  notesInput: {
    backgroundColor: c.inputBg,
    borderColor: c.inputBorder,
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
    marginBottom: spacing.sm,
  },
  rowField: {
    flex: 1,
  },
  timeField: {
    width: 108,
  },
  fieldError: {
    color: c.danger,
    ...type.caption,
    marginBottom: spacing.sm,
    marginTop: -2,
  },
  previewBox: {
    backgroundColor: c.accentSoft,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  previewLabel: {
    color: c.accent,
    ...type.caption,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  previewText: {
    color: c.text1,
    ...type.body,
  },
  submitButton: {
    marginTop: spacing.sm,
  },
});
