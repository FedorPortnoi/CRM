import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { WEEKDAYS_ISO } from '../../hooks/useTaskReminders';
import { weekdayLabel, type Translate } from './format';

interface Props {
  /** ISO weekday numbers, 1 = Mon .. 7 = Sun. */
  value: number[];
  onChange: (next: number[]) => void;
}

/** Seven toggles, Monday first — the week as it is read in Russia. */
export default function WeekdayChips({ value, onChange }: Props): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const toggle = (iso: number): void => {
    const next = value.includes(iso) ? value.filter((day) => day !== iso) : [...value, iso];
    onChange(next.sort((a, b) => a - b));
  };

  return (
    <View style={styles.row}>
      {WEEKDAYS_ISO.map((iso) => {
        const selected = value.includes(iso);
        return (
          <TouchableOpacity
            key={iso}
            style={[styles.chip, selected ? styles.chipSelected : null]}
            onPress={() => toggle(iso)}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
              {weekdayLabel(iso, t as Translate)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minWidth: 44,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: c.bgPanel,
    alignItems: 'center',
  },
  chipSelected: { borderColor: c.orange, backgroundColor: 'rgba(204,120,92,0.08)' },
  chipText: { color: c.text1, fontSize: 14, fontWeight: '500' },
  chipTextSelected: { color: c.orange, fontWeight: '600' },
});
