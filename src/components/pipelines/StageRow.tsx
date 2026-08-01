// One stage in the funnel list on src/app/settings/pipelines.tsx.
//
// Two ways to reorder deliberately coexist. Long-press on the grip starts a real drag, which
// is the fast path; the ↑/↓ buttons are the one that always works — they need no gesture, no
// reanimated worklet and no sighted precision, and they are the only reorder an operator with
// a screen reader can perform.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, GripVertical, Pencil, Trash2 } from 'lucide-react-native';
import { ThemeColors } from '../../theme';
import { PipelineStage, stageDealCount } from '../../hooks/usePipelines';
import { formatDealCount } from './dealCount';

type Props = {
  stage: PipelineStage;
  colors: ThemeColors;
  /** True while this row is the one being dragged. */
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  canManage: boolean;
  /** Disables every control while a write is in flight, so two edits cannot race. */
  busy: boolean;
  onDrag: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

export function StageRow({
  stage,
  colors,
  isActive,
  isFirst,
  isLast,
  canManage,
  busy,
  onDrag,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const styles = makeStyles(colors);
  const swatch = stage.color ?? colors.borderStrong;
  const dealCount = stageDealCount(stage);

  // Probability and the stale threshold are the two settings an operator forgets they set,
  // so the row states them instead of hiding them behind the editor.
  const meta: string[] = [];
  if (stage.probability !== null) meta.push(t('pipelines.probabilityShort', { value: stage.probability }));
  if (stage.stale_after_days !== null) {
    meta.push(t('pipelines.staleShort', { days: stage.stale_after_days }));
  }

  return (
    <View style={[styles.row, isActive && styles.rowActive]}>
      <View style={styles.mainLine}>
        {canManage ? (
          <TouchableOpacity
            onLongPress={onDrag}
            delayLongPress={150}
            disabled={busy}
            style={styles.grip}
            accessibilityRole="button"
            accessibilityLabel={t('pipelines.dragHandleA11y')}
            hitSlop={6}
          >
            <GripVertical size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}

        <View style={[styles.swatch, { backgroundColor: swatch }]} />

        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{stage.name}</Text>
          {meta.length > 0 ? <Text style={styles.meta}>{meta.join(' · ')}</Text> : null}
        </View>

        <View style={styles.badges}>
          {stage.is_won_stage ? (
            <View style={[styles.badge, { backgroundColor: colors.orange + '22' }]}>
              <Text style={[styles.badgeText, { color: colors.orange }]}>{t('pipelines.wonBadge')}</Text>
            </View>
          ) : null}
          {stage.is_lost_stage ? (
            <View style={[styles.badge, { backgroundColor: colors.red + '22' }]}>
              <Text style={[styles.badgeText, { color: colors.red }]}>{t('pipelines.lostBadge')}</Text>
            </View>
          ) : null}
          {dealCount !== null ? (
            <View style={styles.countChip}>
              <Text style={styles.countText}>{formatDealCount(dealCount, i18n.language, t)}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {canManage ? (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.iconBtn, (isFirst || busy) && styles.iconBtnDisabled]}
            onPress={onMoveUp}
            disabled={isFirst || busy}
            accessibilityRole="button"
            accessibilityLabel={t('pipelines.moveUpA11y')}
          >
            <ChevronUp size={18} color={isFirst ? colors.textFaint : colors.text1} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, (isLast || busy) && styles.iconBtnDisabled]}
            onPress={onMoveDown}
            disabled={isLast || busy}
            accessibilityRole="button"
            accessibilityLabel={t('pipelines.moveDownA11y')}
          >
            <ChevronDown size={18} color={isLast ? colors.textFaint : colors.text1} />
          </TouchableOpacity>

          <View style={styles.actionsSpacer} />

          <TouchableOpacity
            style={[styles.textBtn, busy && styles.iconBtnDisabled]}
            onPress={onEdit}
            disabled={busy}
            accessibilityRole="button"
          >
            <Pencil size={14} color={colors.text1} />
            <Text style={styles.textBtnLabel}>{t('pipelines.edit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.textBtn, styles.deleteBtn, busy && styles.iconBtnDisabled]}
            onPress={onDelete}
            disabled={busy}
            accessibilityRole="button"
          >
            <Trash2 size={14} color={colors.red} />
            <Text style={[styles.textBtnLabel, { color: colors.red }]}>{t('pipelines.delete')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  row: {
    backgroundColor: c.bgPanel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  rowActive: { borderColor: c.orange, opacity: 0.95 },
  mainLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grip: { paddingVertical: 4, paddingHorizontal: 2 },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600', color: c.text1 },
  meta: { fontSize: 12, color: c.amber, marginTop: 2 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  countChip: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: c.skeleton,
  },
  countText: { fontSize: 11, color: c.amber, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  actionsSpacer: { flex: 1 },
  iconBtn: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  iconBtnDisabled: { opacity: 0.4 },
  textBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  deleteBtn: { borderColor: 'rgba(204,82,71,0.25)' },
  textBtnLabel: { fontSize: 12, color: c.text1, fontWeight: '600' },
});
