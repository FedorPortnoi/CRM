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
import { ThemeColors } from '../../theme';
import { StageLibraryItem } from '../../hooks/usePipelines';

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
      <TouchableOpacity
        key={item.key}
        style={[styles.card, item.already_added && styles.cardDisabled]}
        onPress={() => onPick(item)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
      >
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
          <ActivityIndicator size="small" color={colors.orange} />
        ) : item.already_added ? null : (
          <Plus size={18} color={colors.orange} />
        )}
      </TouchableOpacity>
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
            <ActivityIndicator style={{ marginTop: 32 }} color={colors.orange} />
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
          <TouchableOpacity
            style={styles.customBtn}
            onPress={onCustom}
            disabled={pendingKey !== null}
            accessibilityRole="button"
          >
            <Text style={styles.customBtnText}>{t('pipelines.customStageButton')}</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>{t('pipelines.customStageHint')}</Text>
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
  body: { padding: 20, paddingBottom: 48 },
  intro: { fontSize: 13, color: c.amber, lineHeight: 19, marginBottom: 8 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  cardDisabled: { opacity: 0.5 },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  cardText: { flex: 1 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '600', color: c.text1 },
  cardProbability: { fontSize: 12, color: c.amber, fontWeight: '600' },
  cardRationale: { fontSize: 12, color: c.textMuted, marginTop: 3, lineHeight: 17 },
  cardAdded: { fontSize: 11, color: c.orange, marginTop: 4, fontWeight: '600' },
  showAllBtn: { alignItems: 'center', paddingVertical: 14, marginTop: 6 },
  showAllText: { fontSize: 14, color: c.orange, fontWeight: '600' },
  empty: { fontSize: 13, color: c.textMuted, marginTop: 20, lineHeight: 19 },
  error: { fontSize: 13, color: c.red, marginTop: 20, lineHeight: 19 },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 20 },
  customBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.borderStrong,
    padding: 14,
    alignItems: 'center',
  },
  customBtnText: { color: c.text1, fontWeight: '600', fontSize: 15 },
  hint: { fontSize: 12, color: c.textMuted, marginTop: 8, lineHeight: 16, textAlign: 'center' },
});
