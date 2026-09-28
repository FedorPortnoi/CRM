// Date-range / scope / pipeline control shared by every report tab.
//
// The custom range is typed rather than opened in a native picker (the app has no date-picker
// dependency). People type ДД.ММ.ГГГГ; the filters and the backend keep ISO YYYY-MM-DD.
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  StyleSheet,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_REPORT_PERIOD,
  REPORT_PERIODS,
  type ReportFilters,
  type ReportPeriod,
  type ReportScope,
} from '../../hooks/useReports';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { Button } from '../ui';
import { displayDateToIso, isoToDisplayDate, maskDateInput } from '../../utils/dateInput';

const PERIOD_LABEL_KEYS: Record<ReportPeriod, string> = {
  '7d': 'reports.period7d',
  '30d': 'reports.period30d',
  '90d': 'reports.period90d',
  month: 'reports.periodMonth',
  quarter: 'reports.periodQuarter',
  year: 'reports.periodYear',
  custom: 'reports.periodCustom',
};

const SCOPE_LABEL_KEYS: Record<ReportScope, string> = {
  direct: 'reports.scopeDirect',
  subtree: 'reports.scopeSubtree',
};

export type PipelineOption = { id: string; name: string };

interface ReportFilterBarProps {
  filters: ReportFilters;
  onChange: (next: ReportFilters) => void;
  pipelines: PipelineOption[];
  /** Owners and admins always see the whole org, so the scope toggle is hidden for them. */
  showScope: boolean;
  /** Resolved range returned by the backend, already formatted. */
  rangeLabel: string | null;
}

export default function ReportFilterBar({
  filters,
  onChange,
  pipelines,
  showScope,
  rangeLabel,
}: ReportFilterBarProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const [rangeModalVisible, setRangeModalVisible] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');

  const openRangeModal = useCallback((): void => {
    setDraftFrom(isoToDisplayDate(filters.date_from));
    setDraftTo(isoToDisplayDate(filters.date_to));
    setRangeModalVisible(true);
  }, [filters.date_from, filters.date_to]);

  const selectPeriod = useCallback(
    (period: ReportPeriod): void => {
      if (period === 'custom') {
        openRangeModal();
        return;
      }
      onChange({ ...filters, period, date_from: null, date_to: null });
    },
    [filters, onChange, openRangeModal],
  );

  const applyRange = useCallback((): void => {
    onChange({
      ...filters,
      period: 'custom',
      date_from: displayDateToIso(draftFrom),
      date_to: displayDateToIso(draftTo),
    });
    setRangeModalVisible(false);
  }, [draftFrom, draftTo, filters, onChange]);

  const resetRange = useCallback((): void => {
    onChange({ ...filters, period: DEFAULT_REPORT_PERIOD, date_from: null, date_to: null });
    setRangeModalVisible(false);
  }, [filters, onChange]);

  const fromValid = draftFrom.trim() === '' || displayDateToIso(draftFrom) !== null;
  const toValid = draftTo.trim() === '' || displayDateToIso(draftTo) !== null;
  const canApply = fromValid && toValid && (draftFrom.trim() !== '' || draftTo.trim() !== '');

  return (
    <View style={styles.wrap}>
      <Text style={styles.groupLabel}>{t('reports.period')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {REPORT_PERIODS.map((period) => {
          const active = filters.period === period;
          return (
            <TouchableOpacity
              key={period}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => selectPeriod(period)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {t(PERIOD_LABEL_KEYS[period])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {rangeLabel ? (
        <TouchableOpacity onPress={openRangeModal} accessibilityRole="button" activeOpacity={0.7}>
          <Text style={styles.rangeLabel}>{rangeLabel}</Text>
        </TouchableOpacity>
      ) : null}

      {pipelines.length > 1 ? (
        <>
          <Text style={styles.groupLabel}>{t('reports.pipeline')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <TouchableOpacity
              style={[styles.chip, filters.pipeline_id === null && styles.chipActive]}
              onPress={() => onChange({ ...filters, pipeline_id: null })}
              accessibilityRole="button"
              accessibilityState={{ selected: filters.pipeline_id === null }}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, filters.pipeline_id === null && styles.chipTextActive]}>
                {t('reports.pipelineAll')}
              </Text>
            </TouchableOpacity>
            {pipelines.map((pipeline) => {
              const active = filters.pipeline_id === pipeline.id;
              return (
                <TouchableOpacity
                  key={pipeline.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => onChange({ ...filters, pipeline_id: pipeline.id })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                    {pipeline.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </>
      ) : null}

      {showScope ? (
        <>
          <Text style={styles.groupLabel}>{t('reports.scope')}</Text>
          <View style={styles.chipRow}>
            {(['subtree', 'direct'] as const).map((scope) => {
              const active = filters.scope === scope;
              return (
                <TouchableOpacity
                  key={scope}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => onChange({ ...filters, scope })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {t(SCOPE_LABEL_KEYS[scope])}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      ) : null}

      <Modal
        visible={rangeModalVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setRangeModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('reports.periodCustom')}</Text>

            <Text style={styles.inputLabel}>{t('reports.dateFrom')}</Text>
            <TextInput
              style={[styles.input, !fromValid && styles.inputInvalid]}
              value={draftFrom}
              onChangeText={(v) => setDraftFrom(maskDateInput(v))}
              placeholder={t('reports.dateHint')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              keyboardType="number-pad"
            />

            <Text style={styles.inputLabel}>{t('reports.dateTo')}</Text>
            <TextInput
              style={[styles.input, !toValid && styles.inputInvalid]}
              value={draftTo}
              onChangeText={(v) => setDraftTo(maskDateInput(v))}
              placeholder={t('reports.dateHint')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              keyboardType="number-pad"
            />

            <Text style={styles.modalHint}>{t('reports.dateHint')}</Text>

            <Button
              title={t('reports.apply')}
              onPress={applyRange}
              disabled={!canApply}
              block
              style={styles.primaryButton}
            />

            <Button
              title={t('reports.reset')}
              variant="ghost"
              onPress={resetRange}
              block
              style={styles.secondaryButton}
            />

            <TouchableOpacity
              style={styles.cancelRow}
              onPress={() => setRangeModalVisible(false)}
              accessibilityRole="button"
              activeOpacity={0.7}
            >
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  groupLabel: {
    ...type.micro,
    color: c.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  chip: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
    maxWidth: 180,
  },
  chipActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  chipText: {
    ...type.label,
    color: c.text1,
  },
  chipTextActive: {
    color: c.onAccent,
    fontWeight: '600',
  },
  rangeLabel: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.sm,
    fontVariant: ['tabular-nums'],
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: c.overlay,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderRadius: radius.xl,
    padding: spacing.xl,
  },
  modalTitle: {
    ...type.title,
    color: c.text1,
    marginBottom: spacing.md,
  },
  inputLabel: {
    ...type.label,
    color: c.text1,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: c.inputBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    padding: spacing.md,
    ...type.body,
    color: c.text1,
  },
  inputInvalid: {
    borderColor: c.danger,
  },
  modalHint: {
    ...type.caption,
    color: c.textMuted,
    marginTop: spacing.sm,
  },
  primaryButton: {
    marginTop: spacing.xl,
  },
  secondaryButton: {
    marginTop: spacing.sm,
  },
  cancelRow: {
    marginTop: spacing.sm,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  cancelText: {
    color: c.textMuted,
    ...type.body,
  },
});
