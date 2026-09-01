import { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control } from '../../theme';
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
  const styles = useMemo(() => makeStyles(colors), [colors]);

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
            activeOpacity={0.7}
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
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minWidth: 44,
    height: control.sm,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    backgroundColor: c.neutralSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: c.accent },
  chipText: { ...type.label, color: c.textMuted },
  chipTextSelected: { color: c.onAccent },
});
