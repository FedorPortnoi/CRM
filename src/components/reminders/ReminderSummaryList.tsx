// Read-only «Напоминания» card for the task detail screen.
//
// Self-contained on purpose: the detail screen already juggles four fetches, and the
// schedule is a detail of the task rather than something that screen edits.

import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { draftFromReminder, useTaskReminders } from '../../hooks/useTaskReminders';
import { describeReminder, type Translate } from './format';
import { timezoneLabel } from './timezones';

interface Props {
  taskId: string;
}

export default function ReminderSummaryList({ taskId }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const translate = t as Translate;
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const { data, isLoading, isError, refetch } = useTaskReminders(taskId);
  const drafts = (data ?? []).map(draftFromReminder);

  return (
    <View style={styles.card}>
      <Text style={styles.sectionLabel}>{t('reminders.title')}</Text>

      {isLoading ? (
        <ActivityIndicator size="small" color={colors.orange} />
      ) : isError ? (
        <View>
          <Text style={styles.errorText}>{t('reminders.loadFailed')}</Text>
          <TouchableOpacity onPress={() => void refetch()}>
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : drafts.length === 0 ? (
        <Text style={styles.emptyText}>{t('reminders.none')}</Text>
      ) : (
        drafts.map((draft, index) => (
          <View key={draft.key} style={[styles.row, index > 0 ? styles.rowSpaced : null]}>
            <Text style={styles.summary}>{describeReminder(draft, translate)}</Text>
            <Text style={styles.zone}>{timezoneLabel(draft.timezone, i18n.language)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {},
  rowSpaced: { marginTop: 10, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 },
  summary: { fontSize: 14, color: c.text1, lineHeight: 20 },
  zone: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  emptyText: { fontSize: 14, color: c.textMuted },
  errorText: { fontSize: 13, color: c.red },
  retryText: { fontSize: 13, color: c.orange, fontWeight: '600', marginTop: 6 },
});
