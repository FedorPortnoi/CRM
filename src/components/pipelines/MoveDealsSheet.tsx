// The answer to a 409 from DELETE /deals/stages/:id.
//
// The refusal is the point: a stage holding deals cannot just disappear, so the delete is
// retried with ?move_to=<uuid> once the operator has said where those deals belong. This is
// a transparent overlay rather than a full-screen modal — the funnel stays visible behind it,
// which is what makes "куда перенести" answerable.
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { ThemeColors } from '../../theme';
import { PipelineStage } from '../../hooks/usePipelines';
import { formatDealCount } from './dealCount';

type Props = {
  visible: boolean;
  colors: ThemeColors;
  /** The stage being deleted. Null while the sheet is closed. */
  stage: PipelineStage | null;
  /**
   * How many deals are actually in the way, from `details.deal_count` on the
   * STAGE_HAS_DEALS refusal. Null only if the server omitted it.
   */
  dealCount: number | null;
  /** Every other live stage in the funnel — where the deals could go. */
  targets: PipelineStage[];
  submitting: boolean;
  errorText: string | null;
  onClose: () => void;
  onConfirm: (targetId: string) => void;
};

export function MoveDealsSheet({
  visible,
  colors,
  stage,
  dealCount,
  targets,
  submitting,
  errorText,
  onClose,
  onConfirm,
}: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const styles = makeStyles(colors);
  const [selected, setSelected] = useState<string | null>(null);

  // «На этапе «Переговоры» — 2 сделки» beats a bare "this stage still has deals": the number
  // is what tells the operator whether this is a shrug or a decision.
  const body = dealCount === null
    ? t('pipelines.moveDealsBody', { stage: stage?.name ?? '' })
    : t('pipelines.moveDealsBodyCount', {
        stage: stage?.name ?? '',
        deals: formatDealCount(dealCount, i18n.language, t),
      });

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{t('pipelines.moveDealsTitle')}</Text>
          <Text style={styles.subtitle}>{body}</Text>

          {targets.length === 0 ? (
            <Text style={styles.error}>{t('pipelines.moveDealsNoTarget')}</Text>
          ) : (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {targets.map((target) => (
                <TouchableOpacity
                  key={target.id}
                  style={[styles.option, selected === target.id && styles.optionSelected]}
                  onPress={() => setSelected(target.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selected === target.id }}
                >
                  <View
                    style={[styles.swatch, { backgroundColor: target.color ?? colors.borderStrong }]}
                  />
                  <Text
                    style={[styles.optionText, selected === target.id && styles.optionTextSelected]}
                    numberOfLines={1}
                  >
                    {target.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {errorText !== null ? <Text style={styles.error}>{errorText}</Text> : null}

          <TouchableOpacity
            style={[
              styles.confirmBtn,
              (selected === null || submitting) && styles.confirmBtnDisabled,
            ]}
            onPress={() => {
              if (selected !== null) onConfirm(selected);
            }}
            disabled={selected === null || submitting}
            accessibilityRole="button"
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.confirmBtnText}>{t('pipelines.moveDealsConfirm')}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose} accessibilityRole="button">
            <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: 24 },
  card: { backgroundColor: c.bgPanel, borderRadius: 16, padding: 24 },
  title: { fontSize: 20, fontWeight: '700', color: c.text1, marginBottom: 8 },
  subtitle: { fontSize: 14, color: c.amber, marginBottom: 16, lineHeight: 20 },
  list: { maxHeight: 260 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  optionSelected: { borderColor: c.orange, backgroundColor: c.orange },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  optionText: { flex: 1, fontSize: 15, color: c.text1 },
  optionTextSelected: { color: '#FFFFFF', fontWeight: '600' },
  error: { fontSize: 13, color: c.red, marginTop: 12, lineHeight: 18 },
  confirmBtn: {
    marginTop: 16,
    backgroundColor: c.red,
    borderRadius: 10,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnDisabled: { opacity: 0.5 },
  confirmBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  cancelBtn: { marginTop: 10, alignItems: 'center', padding: 12 },
  cancelBtnText: { color: c.amber, fontSize: 15 },
});
