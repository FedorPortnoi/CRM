// The «Добавить этап» sheet: pick a suggested stage, or fall through to a custom name.
//
// `recommended` items lead and the rest sit behind «Показать все», because the library is a
// catalogue of everything the product knows about funnels while the recommendation is what
// this particular funnel is missing. Each entry carries its `rationale` — a stage name alone
// ("Квалификация") does not tell an owner whether they need it.
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus } from 'lucide-react-native';
import { ThemeColors, spacing, radius, type } from '../../theme';
import { StageLibraryItem } from '../../hooks/usePipelines';
import { Card, Button, Skeleton } from '../ui';

type Props = {
  visible: boolean;
  colors: ThemeColors;
  items: StageLibraryItem[];
  isLoading: boolean;
  errorText: string | null;
  /** template_key currently being created, so only that row shows a spinner. */
  pendingKey: string | null;
  onClose: () => void;
  onPick: (item: StageLibraryItem) => void;
  onCustom: () => void;
};

export function StageLibrarySheet({
  visible,
  colors,
  items,
  isLoading,
  errorText,
  pendingKey,
  onClose,
  onPick,
  onCustom,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const [showAll, setShowAll] = useState(false);

  const { recommended, rest } = useMemo(() => {
    const sorted = items.slice().sort((a, b) => a.suggested_position - b.suggested_position);
    return {
      recommended: sorted.filter((i) => i.recommended),
      rest: sorted.filter((i) => !i.recommended),
    };
  }, [items]);

  // With nothing recommended, hiding the rest behind a button would leave the sheet empty.
  const restVisible = showAll || recommended.length === 0;

  const renderItem = (item: StageLibraryItem): JSX.Element => {
    const busy = pendingKey === item.key;
    const disabled = item.already_added || pendingKey !== null;
    return (
      <Card
        key={item.key}
        onPress={disabled ? undefined : () => onPick(item)}
        style={[styles.card, item.already_added && styles.cardDisabled]}
        accessibilityLabel={item.name}
      >
        <View style={styles.cardRow}>
          <View style={[styles.swatch, { backgroundColor: item.color ?? colors.borderStrong }]} />
          <View style={styles.cardText}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>{item.name}</Text>
              {item.probability !== null ? (
                <Text style={styles.cardProbability}>
                  {t('pipelines.probabilityShort', { value: item.probability })}
                </Text>
              ) : null}
            </View>
            <Text style={styles.cardRationale}>{item.rationale}</Text>
            {item.already_added ? (
              <Text style={styles.cardAdded}>{t('pipelines.alreadyAdded')}</Text>
            ) : null}
          </View>
          {busy ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : item.already_added ? null : (
            <Plus size={18} color={colors.accent} />
          )}
        </View>
      </Card>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modal}>
        <View style={[styles.header, { paddingTop: insets.top }]}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={onClose}
              style={styles.backBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
              hitSlop={8}
            >
              <ArrowLeft size={26} color={colors.text1} strokeWidth={2.4} />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>{t('pipelines.addStageTitle')}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.intro}>{t('pipelines.addStageIntro')}</Text>

          {isLoading ? (
            <View style={styles.loadingList}>
              <Skeleton height={68} rounded={radius.lg} />
              <Skeleton height={68} rounded={radius.lg} />
              <Skeleton height={68} rounded={radius.lg} />
            </View>
          ) : errorText !== null ? (
            <Text style={styles.error}>{errorText}</Text>
          ) : (
            <>
              {recommended.length > 0 ? (
                <>
                  <Text style={styles.sectionLabel}>{t('pipelines.recommendedSection')}</Text>
                  {recommended.map(renderItem)}
                </>
              ) : null}

              {rest.length > 0 ? (
                restVisible ? (
                  <>
                    <Text style={styles.sectionLabel}>{t('pipelines.otherSection')}</Text>
                    {rest.map(renderItem)}
                  </>
                ) : (
                  <TouchableOpacity
                    style={styles.showAllBtn}
                    onPress={() => setShowAll(true)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                  >
                    <Text style={styles.showAllText}>
                      {/* `number`, not `count`: i18next treats `count` as the plural
                          selector and would look for showAll_one / showAll_other. */}
                      {t('pipelines.showAll', { number: rest.length })}
                    </Text>
                  </TouchableOpacity>
                )
              ) : null}

              {recommended.length === 0 && rest.length === 0 ? (
                <Text style={styles.empty}>{t('pipelines.libraryEmpty')}</Text>
              ) : null}
            </>
          )}

          <View style={styles.divider} />
          <Button
            title={t('pipelines.customStageButton')}
            onPress={onCustom}
            disabled={pendingKey !== null}
            variant="secondary"
            block
          />
          <Text style={styles.hint}>{t('pipelines.customStageHint')}</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  modal: { flex: 1, backgroundColor: c.bg },
  header: { backgroundColor: c.bgDark, borderBottomWidth: 1, borderBottomColor: c.border },
  // 52pt row / 26px arrow / 18px bold title deliberately repeats NavHeader's geometry
  // (matches StageEditorModal). type.subtitle is 18/bold, so it stays the exact match.
  headerRow: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm },
  backBtn: { padding: spacing.sm },
  headerTitle: { ...type.subtitle, color: c.text1, marginLeft: spacing.xs, flex: 1 },
  body: { padding: spacing.lg, paddingBottom: spacing.xxl + spacing.xl },
  intro: { fontSize: 13, color: c.amber, lineHeight: 19, marginBottom: spacing.sm },
  loadingList: { gap: spacing.sm },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: { marginBottom: spacing.sm },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardDisabled: { opacity: 0.5 },
  swatch: { width: 12, height: 12, borderRadius: radius.sm },
  cardText: { flex: 1 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { fontSize: 14, fontWeight: '600', color: c.text1 },
  cardProbability: { fontSize: 12, color: c.amber, fontWeight: '600' },
  cardRationale: { fontSize: 12, color: c.textMuted, marginTop: spacing.xs, lineHeight: 17 },
  cardAdded: { fontSize: 11, color: c.accent, marginTop: spacing.xs, fontWeight: '600' },
  showAllBtn: { alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.xs },
  showAllText: { fontSize: 14, color: c.accent, fontWeight: '600' },
  empty: { fontSize: 13, color: c.textMuted, marginTop: spacing.xl, lineHeight: 19 },
  error: { fontSize: 13, color: c.danger, marginTop: spacing.xl, lineHeight: 19 },
  divider: { height: 1, backgroundColor: c.border, marginVertical: spacing.xl },
  hint: { fontSize: 12, color: c.textMuted, marginTop: spacing.sm, lineHeight: 16, textAlign: 'center' },
});
