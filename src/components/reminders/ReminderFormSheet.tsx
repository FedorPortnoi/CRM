// The full-screen editor for ONE reminder: how often, at what time, in which zone, and
// how long it stays worth reminding about.
//
// It edits a local copy and only hands it back on «Готово», so backing out of the sheet
// leaves the caller's list untouched.

import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Modal,
  StyleSheet,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Calendar } from 'react-native-calendars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import {
  EDITABLE_REMINDER_FREQUENCIES,
  WEEKDAYS_MON_TO_FRI,
  getDeviceTimezone,
  localFireInstant,
  normalizeTimeOfDay,
  todayDateString,
  type ReminderDraft,
  type ReminderFrequency,
} from '../../hooks/useTaskReminders';
import { describeReminder, formatDayMonth, frequencyLabel, type Translate } from './format';
import { timezoneLabel } from './timezones';
import TimeOfDayPicker from './TimeOfDayPicker';
import TimezonePicker from './TimezonePicker';
import WeekdayChips from './WeekdayChips';

interface CalendarDay {
  dateString: string;
}

interface Props {
  visible: boolean;
  /** The reminder being edited. A new one is just a draft with `id === null`. */
  draft: ReminderDraft | null;
  onSave: (draft: ReminderDraft) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
}

export default function ReminderFormSheet({
  visible,
  draft,
  onSave,
  onDelete,
  onClose,
}: Props): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const translate = t as Translate;
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();

  const [local, setLocal] = useState<ReminderDraft | null>(draft);
  const [showTimePicker, setShowTimePicker] = useState<boolean>(false);
  const [showTimezonePicker, setShowTimezonePicker] = useState<boolean>(false);
  const [showStartCalendar, setShowStartCalendar] = useState<boolean>(false);
  const [showExpiryCalendar, setShowExpiryCalendar] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed every time the sheet opens; the caller's draft is the source of truth. The
  // copy is dropped on close so reopening on a DIFFERENT reminder cannot flash the
  // previous one for a frame before the effect catches up.
  useEffect(() => {
    if (visible) {
      setLocal(draft);
      setError(null);
      setShowTimePicker(false);
      setShowTimezonePicker(false);
      setShowStartCalendar(false);
      setShowExpiryCalendar(false);
    } else {
      setLocal(null);
    }
  }, [visible, draft]);

  if (!visible || !local) return null;

  const patch = (changes: Partial<ReminderDraft>): void => {
    setLocal((prev) => (prev === null ? prev : { ...prev, ...changes }));
    setError(null);
  };

  const selectFrequency = (frequency: ReminderFrequency): void => {
    // Switching to «по дням недели» with nothing chosen would be an empty schedule, so
    // it starts on the working week — the answer nine users in ten would pick anyway.
    if (frequency === 'weekly' && local.days_of_week.length === 0) {
      patch({ frequency, days_of_week: [...WEEKDAYS_MON_TO_FRI] });
      return;
    }
    patch({ frequency });
  };

  const handleSave = (): void => {
    if (local.frequency === 'weekly' && local.days_of_week.length === 0) {
      setError(translate('reminders.weekdaysRequired'));
      return;
    }
    if (local.expires_on !== null && local.expires_on <= local.starts_on) {
      setError(translate('reminders.expiresAtMustBeAfterStart'));
      return;
    }
    if (local.frequency === 'once') {
      const instant = localFireInstant(local);
      if (instant === null || new Date(instant) <= new Date()) {
        setError(translate('reminders.pastWarning'));
        return;
      }
    }
    onSave({ ...local, time_of_day: normalizeTimeOfDay(local.time_of_day) });
  };

  const deviceTimezone = getDeviceTimezone();
  const timezoneMismatch = deviceTimezone !== null && deviceTimezone !== local.timezone;

  const fireInstant = localFireInstant(local);
  const isInThePast = fireInstant !== null && new Date(fireInstant) <= new Date();

  const startLabelKey = local.frequency === 'once' ? 'reminders.onceDate' : 'reminders.startDate';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.headerCancel}>{t('common.cancel')}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {local.id === null ? t('reminders.newTitle') : t('reminders.editTitle')}
        </Text>
        <TouchableOpacity onPress={handleSave}>
          <Text style={styles.headerDone}>{t('common.done')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        {error !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{error}</Text>
          </View>
        ) : null}

        {/* Summary — the sentence the user is actually building. */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryText}>{describeReminder(local, translate)}</Text>
          <Text style={styles.summaryZone}>{timezoneLabel(local.timezone, i18n.language)}</Text>
        </View>

        {/* Frequency */}
        <Text style={styles.label}>{t('reminders.frequency')}</Text>
        <View style={styles.segmented}>
          {EDITABLE_REMINDER_FREQUENCIES.map((frequency) => {
            const selected = local.frequency === frequency;
            return (
              <TouchableOpacity
                key={frequency}
                style={[styles.segment, selected ? styles.segmentSelected : null]}
                onPress={() => selectFrequency(frequency)}
                activeOpacity={0.75}
              >
                <Text style={[styles.segmentText, selected ? styles.segmentTextSelected : null]}>
                  {frequencyLabel(frequency, translate)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* A custom RRULE is never offered — only surfaced when a reminder already has one,
            because this UI cannot rebuild an arbitrary rule without silently narrowing it. */}
        {local.frequency === 'custom' ? (
          <View style={styles.customCard}>
            <Text style={styles.customTitle}>{t('reminders.frequencyCustom')}</Text>
            {local.rrule ? <Text style={styles.customRule}>{local.rrule}</Text> : null}
            <Text style={styles.customHint}>{t('reminders.frequencyCustomHint')}</Text>
          </View>
        ) : null}

        {/* Weekday chips */}
        {local.frequency === 'weekly' ? (
          <>
            <Text style={styles.label}>{t('reminders.weekdays')}</Text>
            <WeekdayChips
              value={local.days_of_week}
              onChange={(days) => patch({ days_of_week: days })}
            />
            {local.days_of_week.length === 0 ? (
              <Text style={styles.fieldError}>{t('reminders.weekdaysRequired')}</Text>
            ) : null}
          </>
        ) : null}

        {/* Time of day */}
        <Text style={styles.label}>{t('reminders.timeOfDay')}</Text>
        <TouchableOpacity
          style={styles.dropdownField}
          onPress={() => setShowTimePicker(true)}
          activeOpacity={0.75}
        >
          <Text style={styles.timeValue}>{normalizeTimeOfDay(local.time_of_day)}</Text>
          <Text style={styles.dropdownChevron}>{'⌄'}</Text>
        </TouchableOpacity>
        {isInThePast ? <Text style={styles.warningText}>{t('reminders.pastWarning')}</Text> : null}

        {/* Start / single date */}
        <Text style={styles.label}>{t(startLabelKey)}</Text>
        <TouchableOpacity
          style={styles.dropdownField}
          onPress={() => setShowStartCalendar(true)}
          activeOpacity={0.75}
        >
          <Text style={styles.inputText}>{formatDayMonth(local.starts_on)}</Text>
          <Text style={styles.dropdownChevron}>{'⌄'}</Text>
        </TouchableOpacity>

        {/* Expiry — only meaningful for a schedule that repeats. */}
        {local.frequency !== 'once' ? (
          <>
            <Text style={styles.label}>{t('reminders.expiresAt')}</Text>
            <TouchableOpacity
              style={styles.dropdownField}
              onPress={() => setShowExpiryCalendar(true)}
              activeOpacity={0.75}
            >
              <Text style={local.expires_on ? styles.inputText : styles.placeholderText}>
                {local.expires_on ? formatDayMonth(local.expires_on) : t('reminders.expiresAtNever')}
              </Text>
              <Text style={styles.dropdownChevron}>{'⌄'}</Text>
            </TouchableOpacity>
            {local.expires_on ? (
              <TouchableOpacity onPress={() => patch({ expires_on: null })}>
                <Text style={styles.clearLink}>{t('reminders.expiresAtClear')}</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.hint}>{t('reminders.expiresAtHint')}</Text>
          </>
        ) : null}

        {/* Timezone — the field that decides when the phone actually buzzes. */}
        <Text style={styles.label}>{t('reminders.timezone')}</Text>
        <TouchableOpacity
          style={styles.dropdownField}
          onPress={() => setShowTimezonePicker(true)}
          activeOpacity={0.75}
        >
          <Text style={styles.inputText}>{timezoneLabel(local.timezone, i18n.language)}</Text>
          <Text style={styles.dropdownChevron}>{'⌄'}</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>{t('reminders.timezoneHint')}</Text>
        {timezoneMismatch && deviceTimezone !== null ? (
          <View style={styles.mismatchCard}>
            <Text style={styles.mismatchText}>
              {t('reminders.timezoneDeviceMismatch', {
                zone: timezoneLabel(deviceTimezone, i18n.language),
                selected: timezoneLabel(local.timezone, i18n.language),
              })}
            </Text>
            <TouchableOpacity onPress={() => patch({ timezone: deviceTimezone })}>
              <Text style={styles.mismatchAction}>{t('reminders.timezoneUseDevice')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {onDelete !== null ? (
          <TouchableOpacity style={styles.deleteButton} onPress={onDelete} activeOpacity={0.75}>
            <Text style={styles.deleteButtonText}>{t('reminders.delete')}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      <TimeOfDayPicker
        visible={showTimePicker}
        value={local.time_of_day}
        onChange={(next) => patch({ time_of_day: next })}
        onClose={() => setShowTimePicker(false)}
      />

      <TimezonePicker
        visible={showTimezonePicker}
        value={local.timezone}
        onChange={(next) => patch({ timezone: next })}
        onClose={() => setShowTimezonePicker(false)}
      />

      <Modal
        animationType="slide"
        visible={showStartCalendar}
        onRequestClose={() => setShowStartCalendar(false)}
      >
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <Text style={styles.modalTitle}>{t(startLabelKey)}</Text>
          <TouchableOpacity onPress={() => setShowStartCalendar(false)}>
            <Text style={styles.headerDone}>{t('common.done')}</Text>
          </TouchableOpacity>
        </View>
        <Calendar
          firstDay={1}
          onDayPress={(day: CalendarDay) => {
            // An expiry that now sits before the start would be an empty schedule.
            const expires =
              local.expires_on !== null && local.expires_on <= day.dateString
                ? null
                : local.expires_on;
            patch({ starts_on: day.dateString, expires_on: expires });
            setShowStartCalendar(false);
          }}
          markedDates={
            {
              [local.starts_on]: { selected: true, selectedColor: colors.orange },
            } as Record<string, { selected?: boolean; selectedColor?: string }>
          }
        />
      </Modal>

      <Modal
        animationType="slide"
        visible={showExpiryCalendar}
        onRequestClose={() => setShowExpiryCalendar(false)}
      >
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <Text style={styles.modalTitle}>{t('reminders.expiresAtSelect')}</Text>
          <TouchableOpacity onPress={() => setShowExpiryCalendar(false)}>
            <Text style={styles.headerDone}>{t('common.done')}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.calendarHintBar}>
          <Text style={styles.calendarHintText}>{t('reminders.expiresAtHint')}</Text>
        </View>
        <Calendar
          firstDay={1}
          minDate={local.starts_on > todayDateString() ? local.starts_on : todayDateString()}
          onDayPress={(day: CalendarDay) => {
            if (day.dateString <= local.starts_on) {
              setError(translate('reminders.expiresAtMustBeAfterStart'));
              setShowExpiryCalendar(false);
              return;
            }
            patch({ expires_on: day.dateString });
            setShowExpiryCalendar(false);
          }}
          markedDates={
            (local.expires_on
              ? { [local.expires_on]: { selected: true, selectedColor: colors.orange } }
              : {}) as Record<string, { selected?: boolean; selectedColor?: string }>
          }
        />
      </Modal>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: c.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerTitle: { fontSize: 16, fontWeight: '600', color: c.text1 },
  headerCancel: { fontSize: 16, color: c.textMuted },
  headerDone: { fontSize: 16, color: c.orange, fontWeight: '600' },
  body: { flex: 1, backgroundColor: c.bg },
  bodyContent: { padding: 16 },
  errorBanner: {
    backgroundColor: 'rgba(204,82,71,0.12)',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  errorBannerText: { color: c.red },
  summaryCard: {
    backgroundColor: c.bgPanel,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    padding: 14,
  },
  summaryText: { fontSize: 15, fontWeight: '600', color: c.text1, lineHeight: 21 },
  summaryZone: { fontSize: 12, color: c.textMuted, marginTop: 4 },
  label: { fontSize: 14, fontWeight: '600', color: c.text1, marginBottom: 6, marginTop: 20 },
  hint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginTop: 6 },
  warningText: { fontSize: 12, color: c.red, marginTop: 6 },
  fieldError: { color: c.red, fontSize: 12, marginTop: 6 },
  clearLink: { color: c.orange, fontSize: 12, marginTop: 6 },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segment: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: c.bgPanel,
  },
  segmentSelected: { borderColor: c.orange, backgroundColor: 'rgba(204,120,92,0.08)' },
  segmentText: { color: c.text1, fontSize: 14, fontWeight: '500' },
  segmentTextSelected: { color: c.orange, fontWeight: '600' },
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
  inputText: { color: c.text1, fontSize: 16 },
  placeholderText: { color: c.amber, fontSize: 16 },
  timeValue: { color: c.text1, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  customCard: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: c.bgPanel,
  },
  customTitle: { fontSize: 14, fontWeight: '600', color: c.text1 },
  customRule: { fontSize: 12, color: c.amber, marginTop: 4 },
  customHint: { fontSize: 12, color: c.textMuted, marginTop: 6, lineHeight: 17 },
  mismatchCard: {
    marginTop: 10,
    borderRadius: 12,
    padding: 12,
    backgroundColor: 'rgba(204,120,92,0.08)',
  },
  mismatchText: { fontSize: 13, color: c.text1, lineHeight: 19 },
  mismatchAction: { fontSize: 13, color: c.orange, fontWeight: '600', marginTop: 8 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    backgroundColor: c.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: c.text1 },
  calendarHintBar: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.bg },
  calendarHintText: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  deleteButton: {
    marginTop: 32,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.red,
  },
  deleteButtonText: { color: c.red, fontSize: 15, fontWeight: '600' },
});
