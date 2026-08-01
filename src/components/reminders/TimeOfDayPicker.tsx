// A time-of-day picker built from ScrollViews and TouchableOpacity.
//
// @react-native-community/datetimepicker is NOT a dependency of this app and installing
// one is out of bounds for this change, so the native wheel is replaced with two tappable
// columns plus the four times a CRM reminder is actually set to. The columns behave like a
// wheel — the current value is centred on open — without the native module.

import { useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { joinTimeOfDay, normalizeTimeOfDay, splitTimeOfDay } from '../../hooks/useTaskReminders';

const ROW_HEIGHT = 44;
const LIST_HEIGHT = ROW_HEIGHT * 5;
const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTE_STEP = 5;
const PRESETS = ['09:00', '12:00', '15:00', '18:00'];

interface Props {
  visible: boolean;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}

export default function TimeOfDayPicker({ visible, value, onChange, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();

  const { hour, minute } = splitTimeOfDay(value);
  const hourRef = useRef<ScrollView | null>(null);
  const minuteRef = useRef<ScrollView | null>(null);

  // A minute that is not on the 5-minute grid (a reminder created elsewhere, or by an
  // import) must still be selectable, so it is spliced into the column rather than lost.
  const minutes = useMemo(() => {
    const grid = Array.from({ length: 60 / MINUTE_STEP }, (_, index) => index * MINUTE_STEP);
    return grid.includes(minute) ? grid : [...grid, minute].sort((a, b) => a - b);
  }, [minute]);

  useEffect(() => {
    if (!visible) return;
    // Centre both columns on the current value once the sheet has laid out.
    const timer = setTimeout(() => {
      hourRef.current?.scrollTo({ y: Math.max(0, (hour - 2) * ROW_HEIGHT), animated: false });
      const minuteIndex = minutes.indexOf(minute);
      minuteRef.current?.scrollTo({
        y: Math.max(0, (minuteIndex - 2) * ROW_HEIGHT),
        animated: false,
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [visible, hour, minute, minutes]);

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
            <Text style={styles.title}>{t('reminders.selectTime')}</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.done}>{t('common.done')}</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.preview}>{normalizeTimeOfDay(value)}</Text>

          <View style={styles.columns}>
            <View style={styles.column}>
              <Text style={styles.columnLabel}>{t('reminders.hours')}</Text>
              <ScrollView
                ref={hourRef}
                style={styles.list}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
              >
                {HOURS.map((item) => {
                  const selected = item === hour;
                  return (
                    <TouchableOpacity
                      key={item}
                      style={[styles.row, selected ? styles.rowSelected : null]}
                      onPress={() => onChange(joinTimeOfDay(item, minute))}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.rowText, selected ? styles.rowTextSelected : null]}>
                        {String(item).padStart(2, '0')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            <View style={styles.column}>
              <Text style={styles.columnLabel}>{t('reminders.minutes')}</Text>
              <ScrollView
                ref={minuteRef}
                style={styles.list}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
              >
                {minutes.map((item) => {
                  const selected = item === minute;
                  return (
                    <TouchableOpacity
                      key={item}
                      style={[styles.row, selected ? styles.rowSelected : null]}
                      onPress={() => onChange(joinTimeOfDay(hour, item))}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.rowText, selected ? styles.rowTextSelected : null]}>
                        {String(item).padStart(2, '0')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </View>

          <View style={styles.presets}>
            {PRESETS.map((preset) => {
              const selected = normalizeTimeOfDay(value) === preset;
              return (
                <TouchableOpacity
                  key={preset}
                  style={[styles.presetChip, selected ? styles.presetChipSelected : null]}
                  onPress={() => onChange(preset)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.presetText, selected ? styles.presetTextSelected : null]}>
                    {preset}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
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
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { fontSize: 16, fontWeight: '600', color: c.text1 },
  done: { fontSize: 16, color: c.orange, fontWeight: '600' },
  preview: {
    fontSize: 34,
    fontWeight: '700',
    color: c.orange,
    textAlign: 'center',
    marginVertical: 8,
    fontVariant: ['tabular-nums'],
  },
  columns: { flexDirection: 'row', gap: 12 },
  column: { flex: 1 },
  columnLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
    textAlign: 'center',
  },
  list: {
    height: LIST_HEIGHT,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    backgroundColor: c.inputBg,
  },
  row: { height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  rowSelected: { backgroundColor: 'rgba(204,120,92,0.08)' },
  rowText: { fontSize: 18, color: c.text1, fontVariant: ['tabular-nums'] },
  rowTextSelected: { color: c.orange, fontWeight: '700' },
  presets: { flexDirection: 'row', gap: 8, marginTop: 16, justifyContent: 'center' },
  presetChip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: c.bgPanel,
  },
  presetChipSelected: { borderColor: c.orange, backgroundColor: 'rgba(204,120,92,0.08)' },
  presetText: { fontSize: 14, color: c.text1, fontWeight: '500' },
  presetTextSelected: { color: c.orange, fontWeight: '600' },
});
