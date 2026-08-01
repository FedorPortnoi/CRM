// The reusable «Напоминания» block for the task forms.
//
// Deliberately CONTROLLED and offline: it owns no network calls, only a list of drafts.
// The new-task screen has no task id to POST against until the task exists, and the edit
// screen wants its reminders saved by the same button as the rest of the form — a
// component that wrote to the server on every tap could serve neither.
//
// Persistence is syncTaskReminders() in hooks/useTaskReminders.ts, called by the screens.

import { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import {
  MAX_REMINDERS_PER_TASK,
  newReminderDraft,
  useDefaultReminderTimezone,
  type ReminderDraft,
} from '../../hooks/useTaskReminders';
import { describeReminder, type Translate } from './format';
import { timezoneLabel } from './timezones';
import ReminderFormSheet from './ReminderFormSheet';

interface Props {
  value: ReminderDraft[];
  onChange: (next: ReminderDraft[]) => void;
  /** Seed date for a new reminder — the task's due date when it has one. */
  defaultDate?: string;
  isLoading?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
}

export default function ReminderEditor({
  value,
  onChange,
  defaultDate,
  isLoading = false,
  loadError = null,
  onRetry,
}: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const translate = t as Translate;
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const defaultTimezone = useDefaultReminderTimezone();

  const [editing, setEditing] = useState<ReminderDraft | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState<boolean>(false);

  const openNew = (): void => {
    // New reminders inherit the zone already in use on this task so a task cannot end up
    // with two reminders quietly running on two different clocks.
    const timezone = value[0]?.timezone ?? defaultTimezone;
    setEditing(newReminderDraft({ timezone, startsOn: defaultDate }));
    setIsSheetOpen(true);
  };

  const openExisting = (draft: ReminderDraft): void => {
    setEditing(draft);
    setIsSheetOpen(true);
  };

  const closeSheet = (): void => {
    setIsSheetOpen(false);
    setEditing(null);
  };

  const handleSave = (draft: ReminderDraft): void => {
    const exists = value.some((item) => item.key === draft.key);
    onChange(exists ? value.map((item) => (item.key === draft.key ? draft : item)) : [...value, draft]);
    closeSheet();
  };

  const removeDraft = (key: string): void => {
    onChange(value.filter((item) => item.key !== key));
    closeSheet();
  };

  const confirmDelete = (draft: ReminderDraft): void => {
    Alert.alert(t('reminders.deleteConfirmTitle'), t('reminders.deleteConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('reminders.delete'),
        style: 'destructive',
        onPress: () => removeDraft(draft.key),
      },
    ]);
  };

  const atLimit = value.length >= MAX_REMINDERS_PER_TASK;

  return (
    <View style={styles.section}>
      <Text style={styles.label}>{t('reminders.title')}</Text>
      <Text style={styles.hint}>{t('reminders.sectionHint')}</Text>

      {loadError !== null ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{loadError}</Text>
          {onRetry ? (
            <TouchableOpacity onPress={onRetry}>
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.orange} />
        </View>
      ) : value.length === 0 ? (
        <Text style={styles.emptyText}>{t('reminders.none')}</Text>
      ) : (
        value.map((draft) => (
          <TouchableOpacity
            key={draft.key}
            style={styles.row}
            onPress={() => openExisting(draft)}
            activeOpacity={0.75}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowSummary}>{describeReminder(draft, translate)}</Text>
              <Text style={styles.rowZone}>{timezoneLabel(draft.timezone, i18n.language)}</Text>
            </View>
            <TouchableOpacity
              style={styles.rowDelete}
              onPress={() => confirmDelete(draft)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.rowDeleteText}>&#x2715;</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))
      )}

      <TouchableOpacity
        style={[styles.addButton, atLimit ? styles.addButtonDisabled : null]}
        onPress={openNew}
        disabled={atLimit || isLoading}
        activeOpacity={0.75}
      >
        <Text style={styles.addButtonText}>
          {value.length === 0 ? t('reminders.addFirst') : t('reminders.add')}
        </Text>
      </TouchableOpacity>
      {/* `max`, not `count` — `count` would send i18next hunting for plural key variants. */}
      {atLimit ? (
        <Text style={styles.hint}>
          {t('reminders.limitReached', { max: MAX_REMINDERS_PER_TASK })}
        </Text>
      ) : null}

      <ReminderFormSheet
        visible={isSheetOpen}
        draft={editing}
        onSave={handleSave}
        onDelete={
          editing !== null && value.some((item) => item.key === editing.key)
            ? () => confirmDelete(editing)
            : null
        }
        onClose={closeSheet}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  section: { marginTop: 16 },
  label: { fontSize: 14, fontWeight: '600', color: c.text1, marginBottom: 4 },
  hint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginBottom: 8 },
  emptyText: { fontSize: 14, color: c.textMuted, paddingVertical: 6 },
  loadingRow: { paddingVertical: 12, alignItems: 'flex-start' },
  errorBanner: {
    backgroundColor: 'rgba(204,82,71,0.12)',
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  errorBannerText: { color: c.red, fontSize: 13 },
  retryText: { color: c.orange, fontWeight: '600', marginTop: 8, fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    backgroundColor: c.bgPanel,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
  },
  rowMain: { flex: 1, paddingRight: 8 },
  rowSummary: { fontSize: 15, color: c.text1, fontWeight: '500', lineHeight: 21 },
  rowZone: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  rowDelete: { paddingHorizontal: 4, paddingVertical: 2 },
  rowDeleteText: { color: c.amber, fontSize: 15, fontWeight: '600' },
  addButton: {
    borderWidth: 1,
    borderColor: c.orange,
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  addButtonDisabled: { opacity: 0.4 },
  addButtonText: { color: c.orange, fontSize: 15, fontWeight: '600' },
});
