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
import { usePipelinesStore } from '../store/pipelinesStore';
import { formatMoney } from '../market/profile';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors } from '../theme';

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

  const defaultPipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];

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
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.orange} />
      </View>
    );
  }

  if (dealsError || pipelinesError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: colors.text1 }}>{dealsError ?? pipelinesError}</Text>
      </View>
    );
  }

  if (stagesWithDeals.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
        <Text style={{ fontSize: 15, color: colors.textMuted, textAlign: 'center', lineHeight: 22 }}>
          {t('deals.noPipeline')}
        </Text>
      </View>
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
    padding: 8,
  },
  stageColumn: {
    width: STAGE_WIDTH,
    margin: 8,
    backgroundColor: 'rgba(204,120,92,0.08)',
    borderRadius: 12,
    padding: 8,
  },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  stageName: {
    flex: 1,
    fontWeight: '700',
    fontSize: 15,
    color: c.text1,
    marginRight: 8,
  },
  stageCount: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  stageDeals: {
    paddingBottom: 12,
  },
  dealCardDragWrapper: {
    marginVertical: 6,
    marginHorizontal: 4,
  },
  dealCardDragging: {
    zIndex: 10,
    elevation: 4,
  },
  dealCard: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  dealTitle: {
    fontWeight: '600',
    fontSize: 14,
    marginBottom: 4,
    color: c.text1,
  },
  warningBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  overdueBadge: {
    backgroundColor: 'rgba(204,82,71,0.12)',
  },
  todayBadge: {
    backgroundColor: 'rgba(204,120,92,0.08)',
  },
  warningBadgeText: {
    fontSize: 10,
  },
  overdueText: {
    color: c.red,
  },
  todayText: {
    color: c.amber,
  },
  dealValue: {
    marginBottom: 4,
    color: c.orange,
    fontWeight: '600',
    fontSize: 13,
  },
  dealContact: {
    color: c.amber,
    fontSize: 12,
  },
  nextActionText: {
    color: c.text1,
    fontSize: 12,
    marginBottom: 4,
  },
});

export default KanbanBoard;
