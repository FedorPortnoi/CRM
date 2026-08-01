import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
import { ThemeColors } from '../../theme';

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

      <TouchableOpacity
        style={styles.card}
        onPress={() => setPickerOpen(true)}
        accessibilityRole="button"
      >
        <View>
          <Text style={styles.label}>{t('reminders.timezone')}</Text>
          <Text style={styles.value}>{timezoneLabel(selected, i18n.language)}</Text>
        </View>
        <Text style={styles.chevron}>{'>'}</Text>
      </TouchableOpacity>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {user?.timezone === selected ? (
        <Text style={styles.saved}>{t('settings.timezoneSaved')}</Text>
      ) : null}

      <TouchableOpacity
        style={[styles.save, saving || user?.timezone === selected ? styles.disabled : null]}
        onPress={() => void save()}
        disabled={saving || user?.timezone === selected}
      >
        {saving ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.saveText}>{t('common.save')}</Text>
        )}
      </TouchableOpacity>

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
  container: { flex: 1, backgroundColor: c.bg, padding: 20 },
  intro: { color: c.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 18 },
  card: {
    backgroundColor: c.bgPanel,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: { color: c.textMuted, fontSize: 12, marginBottom: 6 },
  value: { color: c.text1, fontSize: 16, fontWeight: '600' },
  chevron: { color: c.textMuted, fontSize: 20 },
  error: { color: c.red, fontSize: 13, marginTop: 12 },
  saved: { color: c.orange, fontSize: 13, marginTop: 12 },
  save: {
    backgroundColor: c.orange,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: 20,
  },
  disabled: { opacity: 0.5 },
  saveText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
