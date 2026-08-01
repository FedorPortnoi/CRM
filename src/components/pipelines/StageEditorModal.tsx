// Add-a-custom-stage / edit-a-stage form for src/app/settings/pipelines.tsx.
//
// Create mode shows only what POST /deals/stages accepts (name, colour, probability). The
// won/lost flags, the stale threshold and archiving arrive through PATCH, so they appear
// once the stage exists rather than as fields that would be silently dropped on save.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check } from 'lucide-react-native';
import { ThemeColors } from '../../theme';
import {
  MAX_STAGE_NAME_LENGTH,
  MAX_STALE_AFTER_DAYS,
  PipelineStage,
  STAGE_COLOR_PRESETS,
} from '../../hooks/usePipelines';

export type StageFormValues = {
  name: string;
  color: string | null;
  probability: number | null;
  stale_after_days: number | null;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  is_archived: boolean;
};

type Props = {
  visible: boolean;
  colors: ThemeColors;
  /** null → create a custom stage; otherwise edit this one. */
  stage: PipelineStage | null;
  /** The stage that already carries the won flag, if any other stage does. */
  wonHeldBy: PipelineStage | null;
  lostHeldBy: PipelineStage | null;
  submitting: boolean;
  /** Refusal text from the last failed save, rendered above the button. */
  errorText: string | null;
  onClose: () => void;
  onSubmit: (values: StageFormValues) => void;
};

/** Empty stays null — the server treats null as "no threshold", 0 as "stale immediately". */
function parseOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function StageEditorModal({
  visible,
  colors,
  stage,
  wonHeldBy,
  lostHeldBy,
  submitting,
  errorText,
  onClose,
  onSubmit,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const isEdit = stage !== null;

  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [probability, setProbability] = useState('');
  const [staleDays, setStaleDays] = useState('');
  const [isWon, setIsWon] = useState(false);
  const [isLost, setIsLost] = useState(false);
  const [isArchived, setIsArchived] = useState(false);

  // Reseeded from the stage each time the sheet opens, so reopening after a cancel does not
  // resurrect the abandoned edit.
  useEffect(() => {
    if (!visible) return;
    setName(stage?.name ?? '');
    setColor(stage?.color ?? null);
    setProbability(stage?.probability === null || stage === null ? '' : String(stage.probability));
    setStaleDays(
      stage?.stale_after_days === null || stage === null ? '' : String(stage.stale_after_days),
    );
    setIsWon(stage?.is_won_stage ?? false);
    setIsLost(stage?.is_lost_stage ?? false);
    setIsArchived(stage?.is_archived ?? false);
  }, [visible, stage]);

  const toggleWon = useCallback((next: boolean): void => {
    // Turning another stage on performs an atomic hand-over on the server. Turning the
    // current one off would leave reports with no successful outcome, so direct the
    // operator to select the replacement instead.
    if (!next && stage?.is_won_stage) {
      Alert.alert(
        t('pipelines.wonRequiredTitle'),
        t('pipelines.wonRequiredBody'),
      );
      return;
    }
    setIsWon(next);
    // Won and lost are mutually exclusive on one stage; letting both stand would make the
    // funnel's outcome undefined.
    if (next) setIsLost(false);
  }, [stage?.is_won_stage, t]);

  const toggleLost = useCallback((next: boolean): void => {
    if (next && lostHeldBy !== null) {
      Alert.alert(
        t('pipelines.lostTakenTitle'),
        t('pipelines.lostTakenBody', { stage: lostHeldBy.name }),
      );
      return;
    }
    setIsLost(next);
    if (next) setIsWon(false);
  }, [lostHeldBy, t]);

  const trimmedName = name.trim();
  const probabilityValue = parseOptionalInt(probability);
  const staleValue = parseOptionalInt(staleDays);

  const probabilityInvalid =
    probabilityValue !== null && (probabilityValue < 0 || probabilityValue > 100);
  const staleInvalid = staleValue !== null && (staleValue < 1 || staleValue > MAX_STALE_AFTER_DAYS);
  const nameInvalid = trimmedName.length === 0 || trimmedName.length > MAX_STAGE_NAME_LENGTH;
  const canSubmit = !nameInvalid && !probabilityInvalid && !staleInvalid && !submitting;

  const handleSubmit = useCallback((): void => {
    onSubmit({
      name: trimmedName,
      color,
      probability: probabilityValue,
      stale_after_days: staleValue,
      is_won_stage: isWon,
      is_lost_stage: isLost,
      is_archived: isArchived,
    });
  }, [onSubmit, trimmedName, color, probabilityValue, staleValue, isWon, isLost, isArchived]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modal}>
        {/* A full-screen Modal covers the navigator and takes the global NavHeader — and with
            it the only back arrow — off screen. This repeats NavHeader's geometry (52pt row,
            26px arrow, 18/700 title) and wires it to the modal instead, matching
            settings/team.tsx. */}
        <View style={[styles.header, { paddingTop: insets.top }]}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={onClose}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
              hitSlop={8}
            >
              <ArrowLeft size={26} color={colors.text1} strokeWidth={2.4} />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {isEdit ? t('pipelines.editStageTitle') : t('pipelines.customStageTitle')}
            </Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>{t('pipelines.nameLabel')}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={t('pipelines.namePlaceholder')}
            placeholderTextColor={colors.placeholder}
            maxLength={MAX_STAGE_NAME_LENGTH}
            autoCapitalize="sentences"
          />
          <Text style={styles.hint}>{t('pipelines.nameHint')}</Text>

          <Text style={styles.label}>{t('pipelines.colorLabel')}</Text>
          <View style={styles.palette}>
            {STAGE_COLOR_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset}
                style={[
                  styles.swatch,
                  { backgroundColor: preset },
                  color === preset && styles.swatchSelected,
                ]}
                onPress={() => setColor(preset)}
                accessibilityRole="radio"
                accessibilityState={{ selected: color === preset }}
                accessibilityLabel={t('pipelines.colorSwatchA11y', { color: preset })}
              >
                {color === preset ? <Check size={16} color="#FFFFFF" strokeWidth={3} /> : null}
              </TouchableOpacity>
            ))}
          </View>
          {color !== null ? (
            <TouchableOpacity onPress={() => setColor(null)} accessibilityRole="button">
              <Text style={styles.linkBtn}>{t('pipelines.colorClear')}</Text>
            </TouchableOpacity>
          ) : null}

          <Text style={styles.label}>{t('pipelines.probabilityLabel')}</Text>
          <TextInput
            style={[styles.input, probabilityInvalid && styles.inputInvalid]}
            value={probability}
            onChangeText={setProbability}
            placeholder={t('pipelines.probabilityPlaceholder')}
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            maxLength={3}
          />
          <Text style={probabilityInvalid ? styles.errorHint : styles.hint}>
            {probabilityInvalid ? t('pipelines.probabilityInvalid') : t('pipelines.probabilityHint')}
          </Text>

          <Text style={styles.label}>{t('pipelines.staleLabel')}</Text>
          <TextInput
            style={[styles.input, staleInvalid && styles.inputInvalid]}
            value={staleDays}
            onChangeText={setStaleDays}
            placeholder={t('pipelines.stalePlaceholder')}
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            maxLength={3}
          />
          <Text style={staleInvalid ? styles.errorHint : styles.hint}>
            {staleInvalid ? t('pipelines.staleInvalid') : t('pipelines.staleHint')}
          </Text>

          <Text style={styles.label}>{t('pipelines.outcomeLabel')}</Text>
          <View style={styles.toggleCard}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <Text style={styles.toggleTitle}>{t('pipelines.wonToggle')}</Text>
                <Text style={styles.toggleHint}>
                  {wonHeldBy !== null
                    ? t('pipelines.wonTransferInline', { stage: wonHeldBy.name })
                    : t('pipelines.wonToggleHint')}
                </Text>
              </View>
              <Switch
                value={isWon}
                onValueChange={toggleWon}
                trackColor={{ false: colors.skeleton, true: colors.orange }}
                thumbColor="#FFFFFF"
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <Text style={styles.toggleTitle}>{t('pipelines.lostToggle')}</Text>
                <Text style={styles.toggleHint}>
                  {lostHeldBy !== null
                    ? t('pipelines.lostTakenInline', { stage: lostHeldBy.name })
                    : t('pipelines.lostToggleHint')}
                </Text>
              </View>
              <Switch
                value={isLost}
                onValueChange={toggleLost}
                trackColor={{ false: colors.skeleton, true: colors.red }}
                thumbColor="#FFFFFF"
              />
            </View>
            {/* Archiving is PATCH-only on the server, and archiving a stage at the moment of
                creating it would be a contradiction anyway. */}
            {isEdit ? (
              <>
                <View style={styles.divider} />
                <View style={styles.toggleRow}>
                  <View style={styles.toggleText}>
                    <Text style={styles.toggleTitle}>{t('pipelines.archiveToggle')}</Text>
                    <Text style={styles.toggleHint}>{t('pipelines.archiveToggleHint')}</Text>
                  </View>
                  <Switch
                    value={isArchived}
                    onValueChange={setIsArchived}
                    trackColor={{ false: colors.skeleton, true: colors.amber }}
                    thumbColor="#FFFFFF"
                  />
                </View>
              </>
            ) : null}
          </View>

          {errorText !== null ? <Text style={styles.errorBanner}>{errorText}</Text> : null}

          <TouchableOpacity
            style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>
              {submitting ? t('pipelines.saving') : t('common.save')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose} accessibilityRole="button">
            <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  modal: { flex: 1, backgroundColor: c.bg },
  header: { backgroundColor: c.bgDark, borderBottomWidth: 1, borderBottomColor: c.border },
  headerRow: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  backBtn: { padding: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.text1, marginLeft: 4, flex: 1 },
  body: { padding: 24, paddingBottom: 48 },
  label: { fontSize: 13, fontWeight: '600', color: c.text1, marginBottom: 6, marginTop: 16 },
  input: {
    backgroundColor: c.inputBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.inputBorder,
    padding: 12,
    fontSize: 15,
    color: c.text1,
  },
  inputInvalid: { borderColor: c.red },
  hint: { fontSize: 12, color: c.textMuted, marginTop: 6, lineHeight: 16 },
  errorHint: { fontSize: 12, color: c.red, marginTop: 6, lineHeight: 16 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchSelected: { borderColor: c.text1 },
  linkBtn: { fontSize: 13, color: c.orange, fontWeight: '600', marginTop: 10 },
  toggleCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toggleText: { flex: 1 },
  toggleTitle: { fontSize: 15, color: c.text1, fontWeight: '500' },
  toggleHint: { fontSize: 12, color: c.textMuted, marginTop: 2, lineHeight: 16 },
  divider: { height: 1, backgroundColor: c.border },
  errorBanner: { fontSize: 13, color: c.red, marginTop: 20, lineHeight: 18 },
  primaryBtn: {
    marginTop: 24,
    backgroundColor: c.orange,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  cancelBtn: { marginTop: 12, alignItems: 'center', padding: 12 },
  cancelBtnText: { color: c.amber, fontSize: 15 },
});
