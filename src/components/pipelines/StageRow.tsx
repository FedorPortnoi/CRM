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
import { ThemeColors, spacing, radius, type, tabular } from '../../theme';
import { PipelineStage, stageDealCount } from '../../hooks/usePipelines';
import { formatDealCount } from './dealCount';
import { Badge } from '../ui';

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
            activeOpacity={0.7}
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
          {stage.is_won_stage ? <Badge variant="accent" label={t('pipelines.wonBadge')} /> : null}
          {stage.is_lost_stage ? <Badge variant="danger" label={t('pipelines.lostBadge')} /> : null}
          {dealCount !== null ? (
            <View style={styles.countChip}>
              <Text style={[styles.countText, tabular]}>{formatDealCount(dealCount, i18n.language, t)}</Text>
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
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('pipelines.moveUpA11y')}
          >
            <ChevronUp size={18} color={isFirst ? colors.textFaint : colors.text1} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, (isLast || busy) && styles.iconBtnDisabled]}
            onPress={onMoveDown}
            disabled={isLast || busy}
            activeOpacity={0.7}
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
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Pencil size={14} color={colors.text1} />
            <Text style={styles.textBtnLabel}>{t('pipelines.edit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.textBtn, styles.deleteBtn, busy && styles.iconBtnDisabled]}
            onPress={onDelete}
            disabled={busy}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Trash2 size={14} color={colors.danger} />
            <Text style={[styles.textBtnLabel, { color: colors.danger }]}>{t('pipelines.delete')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  row: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  rowActive: { borderColor: c.accent, opacity: 0.95 },
  mainLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  grip: { paddingVertical: spacing.xs, paddingHorizontal: spacing.xs },
  swatch: { width: 12, height: 12, borderRadius: radius.sm },
  info: { flex: 1 },
  name: { ...type.label, color: c.text1 },
  meta: { fontSize: 12, color: c.amber, marginTop: spacing.xs },
  badges: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  countChip: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: c.skeleton,
  },
  countText: { ...type.micro, color: c.amber },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  actionsSpacer: { flex: 1 },
  iconBtn: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  iconBtnDisabled: { opacity: 0.4 },
  textBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deleteBtn: { borderColor: c.danger },
  textBtnLabel: { ...type.caption, color: c.text1 },
});
