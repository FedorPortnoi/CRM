import { View, Text, TouchableOpacity, ScrollView, Modal, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { getDeviceTimezone } from '../../hooks/useTaskReminders';
import { timezoneLabel, timezoneOptionsFor } from './timezones';

interface Props {
  visible: boolean;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}

export default function TimezonePicker({ visible, value, onChange, onClose }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();

  const device = getDeviceTimezone();
  const options = timezoneOptionsFor(value);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 24) }]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{t('reminders.timezoneSelect')}</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.done}>{t('common.done')}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>{t('reminders.timezoneHint')}</Text>

          <ScrollView style={styles.list} nestedScrollEnabled>
            {options.map((id) => {
              const selected = id === value;
              return (
                <TouchableOpacity
                  key={id}
                  style={styles.row}
                  onPress={() => {
                    onChange(id);
                    onClose();
                  }}
                  activeOpacity={0.7}
                >
                  <View style={styles.rowLabels}>
                    <Text style={[styles.rowText, selected ? styles.rowTextSelected : null]}>
                      {timezoneLabel(id, i18n.language)}
                    </Text>
                    {id === device ? (
                      <Text style={styles.rowBadge}>{t('reminders.timezoneDevice')}</Text>
                    ) : null}
                  </View>
                  {selected ? <Text style={styles.check}>{'✓'}</Text> : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: { fontSize: 16, fontWeight: '600', color: c.text1 },
  done: { fontSize: 16, color: c.orange, fontWeight: '600' },
  hint: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginBottom: 8 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  rowLabels: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowText: { fontSize: 16, color: c.text1 },
  rowTextSelected: { color: c.orange, fontWeight: '600' },
  rowBadge: {
    fontSize: 11,
    color: c.amber,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  check: { color: c.orange, fontSize: 16, fontWeight: '700' },
});
