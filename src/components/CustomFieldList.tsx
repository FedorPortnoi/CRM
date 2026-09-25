import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, type } from '../theme';
import { formatMarketDate } from '../market/profile';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

/** One custom-field value as a person reads it. Exported for tests. */
export function formatCustomFieldValue(value: unknown, yes: string, no: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => formatCustomFieldValue(v, yes, no)).filter((v): v is string => !!v);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'boolean') return value ? yes : no;
  if (typeof value === 'string' && ISO_DATE.test(value)) return formatMarketDate(value);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  // A structured value (an amoCRM catalog element) has no readable form here.
  return null;
}

/**
 * The free-form `custom_fields` of a deal or contact as label/value rows. Those
 * fields come from imports (amoCRM, Bitrix24, CSV) and until now were stored but
 * never shown anywhere in the app.
 */
export function CustomFieldList({ fields }: { fields: Record<string, unknown> | null | undefined }): JSX.Element | null {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  if (!fields || typeof fields !== 'object') return null;

  const rows = Object.entries(fields)
    .map(([label, value]) => [label, formatCustomFieldValue(value, t('common.yes'), t('common.no'))] as const)
    .filter((row): row is readonly [string, string] => row[1] !== null);
  if (rows.length === 0) return null;

  return (
    <View>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value} selectable>{value}</Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    label: { ...type.caption, color: c.textMuted },
    value: { ...type.body, color: c.text1 },
  });
