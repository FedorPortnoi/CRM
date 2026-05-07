import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { router } from 'expo-router';
import { useDealsStore } from '../store/dealsStore';
import { usePipelinesStore } from '../store/pipelinesStore';

type DealStatus = 'open' | 'won' | 'lost' | 'archived';

type Deal = {
  id: string;
  title: string;
  value: number | null;
  currency: string | null;
  status: DealStatus;
  pipeline_id: string | null;
  stage_id: string | null;
  contact_id: string;
  contact: { id: string; first_name: string; last_name: string };
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
  assigned_to: string | null;
  created_by: string | null;
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

const KanbanBoard: React.FC = () => {
  const deals = useDealsStore((s) => s.deals) as Deal[];
  const dealsLoading = useDealsStore((s) => s.isLoading);
  const dealsError = useDealsStore((s) => s.error);
  const fetchDeals = useDealsStore((s) => s.fetchDeals);
  const moveDeal = useDealsStore((s) => s.moveDeal);

  const pipelines = usePipelinesStore((s) => s.pipelines);
  const pipelinesLoading = usePipelinesStore((s) => s.isLoading);
  const pipelinesError = usePipelinesStore((s) => s.error);
  const fetchPipelines = usePipelinesStore((s) => s.fetchPipelines);

  const [localDeals, setLocalDeals] = useState<Deal[]>(deals);

  useEffect(() => {
    void Promise.all([fetchDeals(), fetchPipelines()]);
  }, []);

  useEffect(() => {
    setLocalDeals(deals);
  }, [deals]);

  const defaultPipeline = pipelines.find((p) => p.is_default) ?? pipelines[0];

  const stages: PipelineStage[] = useMemo(() => {
    if (!defaultPipeline) return [];
    return defaultPipeline.stages.slice().sort((a, b) => a.position - b.position);
  }, [defaultPipeline]);

  const stagesWithDeals: StageWithDeals[] = useMemo(
    () =>
      stages.map((stage) => ({
        stage,
        stageDeals: localDeals.filter(
          (d) => d.status === 'open' && d.stage_id === stage.id,
        ),
      })),
    [stages, localDeals],
  );

  const handleLongPress = (deal: Deal, allStages: PipelineStage[]): void => {
    const otherStages = allStages.filter((s) => s.id !== deal.stage_id);
    Alert.alert('Move Deal', deal.title, [
      ...otherStages.map((s) => ({
        text: s.name,
        onPress: () => void moveDeal(deal.id, s.id),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const renderDealCard =
    (stageId: string, allStages: PipelineStage[]) =>
    ({ item, isActive }: RenderItemParams<Deal>) => (
      <ScaleDecorator>
        <TouchableOpacity
          onPress={() => router.push({ pathname: '/deal/[id]', params: { id: item.id } })}
          onLongPress={() => handleLongPress(item, allStages)}
          disabled={isActive}
          style={{
            backgroundColor: '#fff',
            borderRadius: 8,
            padding: 12,
            marginVertical: 6,
            marginHorizontal: 4,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.1,
            shadowRadius: 2,
            elevation: 2,
          }}
        >
          <Text style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 4 }}>
            {item.title}
          </Text>
          <Text style={{ marginBottom: 4 }}>
            {item.value != null
              ? '$' + item.value.toLocaleString('en-US')
              : '--'}
          </Text>
          <Text style={{ color: '#888' }}>
            {item.contact.first_name + ' ' + item.contact.last_name}
          </Text>
        </TouchableOpacity>
      </ScaleDecorator>
    );

  if (dealsLoading || pipelinesLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (dealsError || pipelinesError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>{dealsError ?? pipelinesError}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 8 }}
    >
      {stagesWithDeals.map(({ stage, stageDeals }) => (
        <View
          key={stage.id}
          style={{
            width: 280,
            margin: 8,
            backgroundColor: '#f5f5f5',
            borderRadius: 12,
            padding: 8,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
              paddingHorizontal: 4,
            }}
          >
            <Text style={{ fontWeight: 'bold', fontSize: 15 }}>
              {stage.name}
            </Text>
            <Text style={{ color: '#666', fontSize: 13 }}>
              {stageDeals.length}
            </Text>
          </View>
          <DraggableFlatList<Deal>
            data={stageDeals}
            keyExtractor={(item) => item.id}
            onDragEnd={({ data }: { data: Deal[] }) =>
              setLocalDeals((prev) => {
                const otherDeals = prev.filter(
                  (d) => d.stage_id !== stage.id,
                );
                return [...otherDeals, ...data];
              })
            }
            renderItem={renderDealCard(stage.id, stages)}
          />
        </View>
      ))}
    </ScrollView>
  );
};

export default KanbanBoard;
