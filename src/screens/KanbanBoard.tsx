import React, { useCallback, useMemo, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  View,
  Text,
  ScrollView,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
  Animated,
  PanResponder,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useDealsStore } from '../store/dealsStore';
import { usePipelinesStore, selectActivePipeline } from '../store/pipelinesStore';
import { formatMoney } from '../market/profile';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type, tabular } from '../theme';
import { EmptyState } from '../components/ui';

type DealStatus = 'open' | 'won' | 'lost' | 'archived';

type Deal = {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: DealStatus;
  pipeline_id: string | null;
  stage_id: string | null;
  expected_close: string | null;
  contact_id: string | null;
  contact: { id: string; first_name: string; last_name: string } | null;
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
  assigned_to: string | null;
  created_by: string | null;
  next_action: string | null;
  next_action_due: string | null;
  stage_entered_at: string | null;
  created_at: string;
  updated_at: string;
};

type PipelineStage = {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color: string | null;
  is_won_stage: boolean;
  is_lost_stage: boolean;
  created_at: string;
  updated_at: string;
};

type StageWithDeals = {
  stage: PipelineStage;
  stageDeals: Deal[];
};

const STAGE_WIDTH = 280;
const DRAG_STAGE_THRESHOLD = 72;

type DealCardProps = {
  deal: Deal;
  stageIndex: number;
  stages: PipelineStage[];
  onMoveStage: (deal: Deal, stage: PipelineStage) => void;
  onLongPress: (deal: Deal) => void;
};

function DealCard({
  deal,
  stageIndex,
  stages,
  onMoveStage,
  onLongPress,
}: DealCardProps): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const translateX = useRef(new Animated.Value(0)).current;
  const [isDragging, setIsDragging] = React.useState(false);

  const resetPosition = useCallback((): void => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
    }).start(() => setIsDragging(false));
  }, [translateX]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          Math.abs(gestureState.dx) > 12 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          setIsDragging(true);
          translateX.setOffset(0);
          translateX.setValue(0);
        },
        onPanResponderMove: (_event, gestureState) => {
          translateX.setValue(gestureState.dx);
        },
        onPanResponderRelease: (_event, gestureState) => {
          const rawDelta = Math.trunc(gestureState.dx / STAGE_WIDTH);
          const stageDelta =
            rawDelta !== 0
              ? rawDelta
              : Math.abs(gestureState.dx) >= DRAG_STAGE_THRESHOLD
                ? Math.sign(gestureState.dx)
                : 0;
          const targetIndex = Math.max(
            0,
            Math.min(stages.length - 1, stageIndex + stageDelta),
          );

          resetPosition();

          if (targetIndex !== stageIndex) {
            onMoveStage(deal, stages[targetIndex]);
          }
        },
        onPanResponderTerminate: resetPosition,
      }),
    [deal, onMoveStage, resetPosition, stageIndex, stages, translateX],
  );

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.dealCardDragWrapper,
        isDragging ? styles.dealCardDragging : null,
        { transform: [{ translateX }] },
      ]}
    >
      <TouchableOpacity
        onPress={() => router.push({ pathname: '/deal/[id]', params: { id: deal.id } })}
        onLongPress={() => onLongPress(deal)}
        disabled={isDragging}
        style={styles.dealCard}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        <Text style={styles.dealTitle}>
          {deal.title}
        </Text>
        {deal.next_action_due && (() => {
          const due = new Date(deal.next_action_due);
          const now = new Date();
          const isOverdue = due < now;
          const isToday = due.toDateString() === now.toDateString();
          if (!isOverdue && !isToday) return null;
          return (
            <View style={[
              styles.warningBadge,
              isOverdue ? styles.overdueBadge : styles.todayBadge,
            ]}>
              <Text style={[
                styles.warningBadgeText,
                isOverdue ? styles.overdueText : styles.todayText,
              ]}>
                {deal.next_action ?? t('deals.nextAction')} - {isOverdue ? t('deals.overdue') : t('deals.today')}
              </Text>
            </View>
          );
        })()}
        {deal.next_action && !deal.next_action_due ? (
          <Text style={styles.nextActionText} numberOfLines={2}>
            {deal.next_action}
          </Text>
        ) : null}
        {deal.stage_entered_at && (() => {
          const daysInStage = Math.floor(
            (Date.now() - new Date(deal.stage_entered_at).getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysInStage < 14) return null;
          return (
            <View style={[styles.warningBadge, styles.todayBadge]}>
              <Text style={[styles.warningBadgeText, styles.todayText]}>
                {t('deals.staleDays', { count: daysInStage })}
              </Text>
            </View>
          );
        })()}
        <Text style={styles.dealValue}>
          {deal.value != null
            ? formatMoney(deal.value, deal.currency, { empty: '--' })
            : '--'}
        </Text>
        {deal.contact != null && (
          <Text style={styles.dealContact}>
            {deal.contact.first_name + (deal.contact.last_name ? ' ' + deal.contact.last_name : '')}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const KanbanBoard: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const deals = useDealsStore((s) => s.deals) as Deal[];
  const dealsLoading = useDealsStore((s) => s.isLoading);
  const dealsError = useDealsStore((s) => s.error);
  const fetchDeals = useDealsStore((s) => s.fetchDeals);
  const moveDeal = useDealsStore((s) => s.moveDeal);

  const pipelines = usePipelinesStore((s) => s.pipelines);
  const pipelinesLoading = usePipelinesStore((s) => s.isLoading);
  const pipelinesError = usePipelinesStore((s) => s.error);
  const fetchPipelines = usePipelinesStore((s) => s.fetchPipelines);

  useFocusEffect(
    useCallback(() => {
      void fetchPipelines().then(() => fetchDeals());
    }, [fetchDeals, fetchPipelines]),
  );

  const selectedPipelineId = usePipelinesStore((s) => s.selectedPipelineId);
  const defaultPipeline = selectActivePipeline({ pipelines, selectedPipelineId });

  const stages: PipelineStage[] = useMemo(() => {
    if (!defaultPipeline) return [];
    return defaultPipeline.stages.slice().sort((a, b) => a.position - b.position);
  }, [defaultPipeline]);

  const stagesWithDeals: StageWithDeals[] = useMemo(
    () =>
      stages.map((stage) => ({
        stage,
        stageDeals: deals.filter(
          (d) => d.status === 'open' && d.stage_id === stage.id,
        ),
      })),
    [stages, deals],
  );

  const handleMoveStage = useCallback(
    (deal: Deal, stage: PipelineStage): void => {
      void moveDeal(deal.id, stage.id);
    },
    [moveDeal],
  );

  const handleLongPress = useCallback((deal: Deal): void => {
    const otherStages = stages.filter((s) => s.id !== deal.stage_id);
    Alert.alert(t('deals.moveDeal'), deal.title, [
      ...otherStages.map((s) => ({
        text: s.name,
        onPress: () => void moveDeal(deal.id, s.id),
      })),
      { text: t('common.cancel'), style: 'cancel' as const },
    ]);
  }, [moveDeal, stages, t]);

  if (dealsLoading || pipelinesLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (dealsError || pipelinesError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.stateText}>{dealsError ?? pipelinesError}</Text>
      </View>
    );
  }

  if (stagesWithDeals.length === 0) {
    return (
      <EmptyState title={t('deals.noPipeline')} />
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.board}
      contentContainerStyle={styles.boardContent}
    >
      {stagesWithDeals.map(({ stage, stageDeals }, stageIndex) => (
        <View
          key={stage.id}
          style={styles.stageColumn}
        >
          <View style={styles.stageHeader}>
            <Text style={styles.stageName}>
              {stage.name}
            </Text>
            <Text style={styles.stageCount}>
              {stageDeals.length}
            </Text>
          </View>
          <ScrollView
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
            contentContainerStyle={styles.stageDeals}
          >
            {stageDeals.map((deal) => (
              <DealCard
                key={deal.id}
                deal={deal}
                stageIndex={stageIndex}
                stages={stages}
                onMoveStage={handleMoveStage}
                onLongPress={handleLongPress}
              />
            ))}
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );
};

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  board: {
    flex: 1,
  },
  boardContent: {
    padding: spacing.sm,
  },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  stateText: { ...type.body, color: c.text1 },
  stageColumn: {
    width: STAGE_WIDTH,
    margin: spacing.sm,
    backgroundColor: c.accentSoft,
    borderRadius: radius.lg,
    padding: spacing.sm,
  },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  stageName: {
    flex: 1,
    ...type.heading,
    color: c.text1,
    marginRight: spacing.sm,
  },
  stageCount: {
    ...type.label,
    ...tabular,
    color: c.textMuted,
  },
  stageDeals: {
    paddingBottom: spacing.md,
  },
  dealCardDragWrapper: {
    marginVertical: spacing.sm,
    marginHorizontal: spacing.xs,
  },
  dealCardDragging: {
    zIndex: 10,
    elevation: 4,
  },
  dealCard: {
    backgroundColor: c.bgPanel,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.bgDark,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  dealTitle: {
    ...type.body,
    marginBottom: spacing.xs,
    color: c.text1,
  },
  warningBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  overdueBadge: {
    backgroundColor: c.dangerSoft,
  },
  todayBadge: {
    backgroundColor: c.accentSoft,
  },
  warningBadgeText: {
    ...type.micro,
  },
  overdueText: {
    color: c.danger,
  },
  todayText: {
    color: c.warning,
  },
  dealValue: {
    ...type.label,
    ...tabular,
    marginBottom: spacing.xs,
    color: c.accent,
  },
  dealContact: {
    ...type.caption,
    color: c.textMuted,
  },
  nextActionText: {
    ...type.caption,
    color: c.text1,
    marginBottom: spacing.xs,
  },
});

export default KanbanBoard;
