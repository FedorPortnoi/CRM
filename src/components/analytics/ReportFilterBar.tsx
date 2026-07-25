// Date-range / scope / pipeline control shared by every report tab.
//
// The custom range is typed as ISO dates (YYYY-MM-DD) rather than opened in a native picker:
// the app has no date-picker dependency, and the backend accepts exactly this shape.
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
import { ThemeColors } from '../../theme';

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

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
    setDraftFrom(filters.date_from ?? '');
    setDraftTo(filters.date_to ?? '');
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
      date_from: draftFrom.trim() === '' ? null : draftFrom.trim(),
      date_to: draftTo.trim() === '' ? null : draftTo.trim(),
    });
    setRangeModalVisible(false);
  }, [draftFrom, draftTo, filters, onChange]);

  const resetRange = useCallback((): void => {
    onChange({ ...filters, period: DEFAULT_REPORT_PERIOD, date_from: null, date_to: null });
    setRangeModalVisible(false);
  }, [filters, onChange]);

  const fromValid = draftFrom.trim() === '' || isValidIsoDate(draftFrom.trim());
  const toValid = draftTo.trim() === '' || isValidIsoDate(draftTo.trim());
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
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {t(PERIOD_LABEL_KEYS[period])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {rangeLabel ? (
        <TouchableOpacity onPress={openRangeModal} accessibilityRole="button">
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
              onChangeText={setDraftFrom}
              placeholder={t('reports.dateHint')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              keyboardType="numbers-and-punctuation"
            />

            <Text style={styles.inputLabel}>{t('reports.dateTo')}</Text>
            <TextInput
              style={[styles.input, !toValid && styles.inputInvalid]}
              value={draftTo}
              onChangeText={setDraftTo}
              placeholder={t('reports.dateHint')}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              keyboardType="numbers-and-punctuation"
            />

            <Text style={styles.modalHint}>{t('reports.dateHint')}</Text>

            <TouchableOpacity
              style={[styles.primaryButton, !canApply && styles.primaryButtonDisabled]}
              onPress={applyRange}
              disabled={!canApply}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>{t('reports.apply')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={resetRange} accessibilityRole="button">
              <Text style={styles.secondaryButtonText}>{t('reports.reset')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setRangeModalVisible(false)}
              accessibilityRole="button"
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
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.amber,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 10,
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 16,
  },
  chip: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    paddingHorizontal: 14,
    paddingVertical: 7,
    maxWidth: 180,
  },
  chipActive: {
    backgroundColor: c.orange,
    borderColor: c.orange,
  },
  chipText: {
    fontSize: 13,
    color: c.text1,
  },
  chipTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  rangeLabel: {
    fontSize: 12,
    color: c.amber,
    marginTop: 10,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: c.overlay,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 16,
    padding: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: c.text1,
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text1,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: c.inputBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.inputBorder,
    padding: 12,
    fontSize: 15,
    color: c.text1,
  },
  inputInvalid: {
    borderColor: c.red,
  },
  modalHint: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 10,
  },
  primaryButton: {
    marginTop: 20,
    backgroundColor: c.orange,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    marginTop: 10,
    alignItems: 'center',
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: c.orange,
    fontSize: 15,
    fontWeight: '600',
  },
  cancelText: {
    color: c.amber,
    fontSize: 15,
  },
});
