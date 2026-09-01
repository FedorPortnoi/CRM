import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import TimezonePicker from '../../components/reminders/TimezonePicker';
import { timezoneLabel } from '../../components/reminders/timezones';
import {
  DEFAULT_REMINDER_TIMEZONE,
  getDeviceTimezone,
} from '../../hooks/useTaskReminders';
import { useTheme } from '../../hooks/useTheme';
import { useUserStore } from '../../store/userStore';
import { ThemeColors, spacing } from '../../theme';
import { Button, Card } from '../../components/ui';

export default function TimezoneSettingsScreen(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const user = useUserStore((state) => state.user);
  const setTimezone = useUserStore((state) => state.setTimezone);
  const initial = user?.timezone ?? getDeviceTimezone() ?? DEFAULT_REMINDER_TIMEZONE;
  const [selected, setSelected] = useState(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.timezone) setSelected(user.timezone);
  }, [user?.timezone]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await setTimezone(selected);
    } catch {
      setError(t('settings.timezoneSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('settings.timezoneTitle') }} />
      <Text style={styles.intro}>{t('settings.timezoneDescription')}</Text>

      <Card onPress={() => setPickerOpen(true)} style={styles.card} accessibilityLabel={t('reminders.timezone')}>
        <View style={styles.cardRow}>
          <View>
            <Text style={styles.label}>{t('reminders.timezone')}</Text>
            <Text style={styles.value}>{timezoneLabel(selected, i18n.language)}</Text>
          </View>
          <Text style={styles.chevron}>{'>'}</Text>
        </View>
      </Card>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {user?.timezone === selected ? (
        <Text style={styles.saved}>{t('settings.timezoneSaved')}</Text>
      ) : null}

      <Button
        title={t('common.save')}
        onPress={() => void save()}
        disabled={saving || user?.timezone === selected}
        loading={saving}
        block
        style={styles.save}
      />

      <TimezonePicker
        visible={pickerOpen}
        value={selected}
        onChange={setSelected}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg, padding: spacing.lg },
  intro: { color: c.textMuted, fontSize: 14, lineHeight: 20, marginBottom: spacing.lg },
  card: { padding: spacing.lg },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: c.textMuted, fontSize: 12, marginBottom: spacing.sm },
  value: { color: c.text1, fontSize: 16, fontWeight: '600' },
  chevron: { color: c.textMuted, fontSize: 20 },
  error: { color: c.danger, fontSize: 13, marginTop: spacing.md },
  saved: { color: c.orange, fontSize: 13, marginTop: spacing.md },
  save: { marginTop: spacing.xl },
});
