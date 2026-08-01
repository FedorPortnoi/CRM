// Funnel-stage settings — owner/admin only.
//
// Backend: /api/v1/deals/pipelines, /deals/stages{,/library,/reorder}. See src/hooks/usePipelines.ts.
// i18n:    pipelines.* (+ common.*, errors.*)
//
// The screen owns four decisions the server would otherwise answer with a bare 409:
//   1. Reorder is optimistic (the hook patches the cache), because a drag that snaps back for
//      the length of a round trip reads as a failed drag.
//   2. Deleting a stage that still holds deals is not an error — the 409 is the question
//      «куда перенести», and MoveDealsSheet is the retry with ?move_to=.
//   3. Exactly one stage is the won stage. Selecting another performs an atomic hand-over;
//      clearing the current one without a replacement is refused locally and by the server.
//   4. Archived stages are listed apart from live ones: they still exist for historical deals
//      but must not be draggable into the middle of a working funnel.
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';
import { useUserStore } from '../../store/userStore';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import {
  PipelineApiError,
  PipelineStage,
  STAGE_ERROR_CODES,
  StageLibraryItem,
  UpdateStageInput,
  archivedStages,
  dealCountFromError,
  moveInArray,
  stageHoldingFlag,
  useCreateStage,
  useDeleteStage,
  usePipelineList,
  useReorderStages,
  useStageLibrary,
  useUpdateStage,
  visibleStages,
} from '../../hooks/usePipelines';
import { StageRow } from '../../components/pipelines/StageRow';
import { StageEditorModal, type StageFormValues } from '../../components/pipelines/StageEditorModal';
import { StageLibrarySheet } from '../../components/pipelines/StageLibrarySheet';
import { MoveDealsSheet } from '../../components/pipelines/MoveDealsSheet';

/**
 * Refusal code → i18n key. STAGE_HAS_DEALS is deliberately absent: it never reaches
 * `messageFor`, because it opens the picker instead of printing anything.
 */
const ERROR_COPY_KEYS: Record<string, string> = {
  [STAGE_ERROR_CODES.lastInPipeline]: 'pipelines.errorLastStage',
  [STAGE_ERROR_CODES.wonRequired]: 'pipelines.errorWonRequired',
  [STAGE_ERROR_CODES.hasOpenDeals]: 'pipelines.errorHasOpenDeals',
  [STAGE_ERROR_CODES.moveTargetInvalid]: 'pipelines.errorMoveTargetInvalid',
  [STAGE_ERROR_CODES.moveTargetSame]: 'pipelines.errorMoveTargetSame',
};

export default function PipelineSettingsScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const role = useUserStore((s) => s.user?.role);
  const canManage = role === 'owner' || role === 'admin';

  const pipelinesQuery = usePipelineList();
  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data]);

  const [pickedPipelineId, setPickedPipelineId] = useState<string | null>(null);
  // Falls back to the default funnel until the operator picks one, and survives the picked
  // funnel being deleted elsewhere.
  const pipeline = useMemo(() => {
    const picked = pipelines.find((p) => p.id === pickedPipelineId);
    return picked ?? pipelines.find((p) => p.is_default) ?? pipelines[0] ?? null;
  }, [pipelines, pickedPipelineId]);

  const stages = useMemo(() => visibleStages(pipeline), [pipeline]);
  const archived = useMemo(() => archivedStages(pipeline), [pipeline]);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorStage, setEditorStage] = useState<PipelineStage | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [pendingTemplateKey, setPendingTemplateKey] = useState<string | null>(null);
  // Set only by a STAGE_HAS_DEALS refusal — the stage whose deals need a new home, and how
  // many of them the server counted.
  const [moveTarget, setMoveTarget] = useState<PipelineStage | null>(null);
  const [moveDealCount, setMoveDealCount] = useState<number | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const libraryQuery = useStageLibrary(pipeline?.id ?? null, libraryOpen && canManage);
  const createStage = useCreateStage();
  const updateStage = useUpdateStage();
  const deleteStage = useDeleteStage();
  const reorderStages = useReorderStages();

  const busy =
    createStage.isPending ||
    updateStage.isPending ||
    deleteStage.isPending ||
    reorderStages.isPending;

  /**
   * Copy for a refusal, preferring our own wording keyed off the CODE so the screen still
   * reads correctly under the English locale. The server's `message` is a Russian fallback
   * for codes this build has not been taught — better than a generic shrug, but it would
   * leak Russian into an English UI if it came first, hence the ordering.
   */
  const messageFor = useCallback((error: unknown): string => {
    if (!(error instanceof PipelineApiError)) return t('errors.serverError');

    if (error.status === 401) return t('errors.unauthorized');
    if (error.status === 403) return t('pipelines.forbidden');
    if (error.status === 404) return t('pipelines.stageGone');

    const key = ERROR_COPY_KEYS[error.code ?? ''];
    if (key !== undefined) return t(key);
    if (error.serverMessage !== null) return error.serverMessage;
    return error.status === 409 ? t('pipelines.conflict') : t('errors.serverError');
  }, [t]);

  // ─── Reorder ────────────────────────────────────────────────────────────────

  const commitOrder = useCallback((ordered: PipelineStage[]): void => {
    if (pipeline === null) return;
    reorderStages.mutate(
      { pipeline_id: pipeline.id, ordered_ids: ordered.map((s) => s.id) },
      { onError: (error) => Alert.alert(t('pipelines.reorderFailed'), messageFor(error)) },
    );
  }, [pipeline, reorderStages, messageFor, t]);

  const handleDragEnd = useCallback(({ data, from, to }: { data: PipelineStage[]; from: number; to: number }): void => {
    if (from === to) return;
    commitOrder(data);
  }, [commitOrder]);

  const handleMove = useCallback((index: number, delta: number): void => {
    const next = moveInArray(stages, index, index + delta);
    if (next === stages) return;
    commitOrder(next);
  }, [stages, commitOrder]);

  // ─── Create / edit ──────────────────────────────────────────────────────────

  const openCustomEditor = useCallback((): void => {
    setLibraryOpen(false);
    setEditorStage(null);
    setEditorError(null);
    setEditorOpen(true);
  }, []);

  const openEditEditor = useCallback((stage: PipelineStage): void => {
    setEditorStage(stage);
    setEditorError(null);
    setEditorOpen(true);
  }, []);

  const handlePickTemplate = useCallback((item: StageLibraryItem): void => {
    if (pipeline === null) return;
    setPendingTemplateKey(item.key);
    createStage.mutate(
      { pipeline_id: pipeline.id, template_key: item.key },
      {
        onSuccess: () => {
          setPendingTemplateKey(null);
          setLibraryOpen(false);
        },
        onError: (error) => {
          setPendingTemplateKey(null);
          Alert.alert(t('pipelines.addFailed'), messageFor(error));
        },
      },
    );
  }, [pipeline, createStage, messageFor, t]);

  const handleSubmitEditor = useCallback((values: StageFormValues): void => {
    if (pipeline === null) return;
    setEditorError(null);

    if (editorStage === null) {
      createStage.mutate(
        {
          pipeline_id: pipeline.id,
          name: values.name,
          ...(values.color === null ? {} : { color: values.color }),
          ...(values.probability === null ? {} : { probability: values.probability }),
        },
        {
          onSuccess: () => setEditorOpen(false),
          onError: (error) => setEditorError(messageFor(error)),
        },
      );
      return;
    }

    // Only what actually changed. A PATCH that re-asserts is_won_stage: true on the stage that
    // already holds the flag is the kind of no-op a strict server answers with a 409.
    const before = editorStage;
    const patch: UpdateStageInput = {};
    if (values.name !== before.name) patch.name = values.name;
    if (values.color !== (before.color ?? null)) patch.color = values.color;
    if (values.probability !== (before.probability ?? null)) patch.probability = values.probability;
    if (values.stale_after_days !== (before.stale_after_days ?? null)) {
      patch.stale_after_days = values.stale_after_days;
    }
    if (values.is_won_stage !== before.is_won_stage) patch.is_won_stage = values.is_won_stage;
    if (values.is_lost_stage !== before.is_lost_stage) patch.is_lost_stage = values.is_lost_stage;
    if (values.is_archived !== before.is_archived) patch.is_archived = values.is_archived;

    if (Object.keys(patch).length === 0) {
      setEditorOpen(false);
      return;
    }

    updateStage.mutate(
      { id: before.id, patch },
      {
        onSuccess: () => setEditorOpen(false),
        onError: (error) => setEditorError(messageFor(error)),
      },
    );
  }, [pipeline, editorStage, createStage, updateStage, messageFor]);

  // ─── Delete ─────────────────────────────────────────────────────────────────

  const runDelete = useCallback((stage: PipelineStage, moveTo: string | null): void => {
    deleteStage.mutate(
      { id: stage.id, move_to: moveTo },
      {
        onSuccess: () => {
          setMoveTarget(null);
          setMoveDealCount(null);
          setMoveError(null);
        },
        onError: (error) => {
          const code = error instanceof PipelineApiError ? error.code : null;

          // STAGE_HAS_DEALS — and only this code — means the refusal is a question. The
          // status cannot stand in for it: STAGE_LAST_IN_PIPELINE is also a 409 and is
          // checked FIRST, so a one-stage funnel would otherwise open a picker that has no
          // target to offer.
          if (code === STAGE_ERROR_CODES.hasDeals) {
            setMoveError(null);
            setMoveDealCount(dealCountFromError(error));
            setMoveTarget(stage);
            return;
          }

          // Everything else is a plain refusal, including any code this build does not know.
          // Where it lands depends on whether the picker is already up — an Alert stacked
          // over an open sheet is easy to miss, and the 400s (STAGE_MOVE_TARGET_INVALID,
          // STAGE_MOVE_TARGET_SAME) can only ever arrive from inside it.
          const text = messageFor(error);
          if (moveTo !== null) {
            setMoveError(text);
            return;
          }
          Alert.alert(t('pipelines.deleteFailed'), text);
        },
      },
    );
  }, [deleteStage, messageFor, t]);

  const confirmDelete = useCallback((stage: PipelineStage): void => {
    Alert.alert(
      t('pipelines.deleteTitle'),
      t('pipelines.deleteBody', { stage: stage.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => runDelete(stage, null),
        },
      ],
    );
  }, [runDelete, t]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  const renderStage = useCallback(({ item, getIndex, drag, isActive }: RenderItemParams<PipelineStage>): JSX.Element => {
    const index = getIndex() ?? 0;
    return (
      <StageRow
        stage={item}
        colors={colors}
        isActive={isActive}
        isFirst={index === 0}
        isLast={index === stages.length - 1}
        canManage={canManage}
        busy={busy}
        onDrag={drag}
        onMoveUp={() => handleMove(index, -1)}
        onMoveDown={() => handleMove(index, 1)}
        onEdit={() => openEditEditor(item)}
        onDelete={() => confirmDelete(item)}
      />
    );
  }, [colors, stages.length, canManage, busy, handleMove, openEditEditor, confirmDelete]);

  const header = (
    <View>
      {pipelines.length > 1 ? (
        <View style={styles.pipelineChips}>
          {pipelines.map((p) => {
            const active = p.id === pipeline?.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setPickedPipelineId(p.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                  {p.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
      <Text style={styles.intro}>
        {canManage ? t('pipelines.intro') : t('pipelines.readOnlyNotice')}
      </Text>
      {stages.length === 0 && !pipelinesQuery.isLoading ? (
        <Text style={styles.empty}>{t('pipelines.noStages')}</Text>
      ) : null}
    </View>
  );

  const footer = (
    <View>
      {archived.length > 0 ? (
        <View style={styles.archivedBlock}>
          <Text style={styles.sectionLabel}>{t('pipelines.archivedSection')}</Text>
          <Text style={styles.archivedHint}>{t('pipelines.archivedHint')}</Text>
          {archived.map((stage) => (
            <TouchableOpacity
              key={stage.id}
              style={styles.archivedRow}
              onPress={() => canManage && openEditEditor(stage)}
              disabled={!canManage}
              accessibilityRole="button"
            >
              <View
                style={[styles.archivedSwatch, { backgroundColor: stage.color ?? colors.borderStrong }]}
              />
              <Text style={styles.archivedName} numberOfLines={1}>{stage.name}</Text>
              {canManage ? (
                <Text style={styles.archivedAction}>{t('pipelines.restore')}</Text>
              ) : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{ title: t('pipelines.title'), headerBackTitle: t('settings.title') }}
      />

      {pipelinesQuery.isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.orange} />
      ) : pipelinesQuery.error ? (
        <View style={styles.errorBlock}>
          <Text style={styles.errorText}>{messageFor(pipelinesQuery.error)}</Text>
          <TouchableOpacity
            onPress={() => void pipelinesQuery.refetch()}
            accessibilityRole="button"
          >
            <Text style={styles.retry}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <DraggableFlatList
          data={stages}
          keyExtractor={(item) => item.id}
          renderItem={renderStage}
          onDragEnd={handleDragEnd}
          activationDistance={12}
          containerStyle={styles.listContainer}
          contentContainerStyle={styles.list}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          refreshControl={
            <RefreshControl
              refreshing={pipelinesQuery.isRefetching}
              onRefresh={() => void pipelinesQuery.refetch()}
              tintColor={colors.orange}
            />
          }
        />
      )}

      {canManage && pipeline !== null ? (
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setLibraryOpen(true)}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.addButtonText}>{t('pipelines.addStageButton')}</Text>
        </TouchableOpacity>
      ) : null}

      <StageLibrarySheet
        visible={libraryOpen}
        colors={colors}
        items={libraryQuery.data ?? []}
        isLoading={libraryQuery.isLoading}
        errorText={libraryQuery.error ? messageFor(libraryQuery.error) : null}
        pendingKey={pendingTemplateKey}
        onClose={() => setLibraryOpen(false)}
        onPick={handlePickTemplate}
        onCustom={openCustomEditor}
      />

      <StageEditorModal
        visible={editorOpen}
        colors={colors}
        stage={editorStage}
        wonHeldBy={stageHoldingFlag(pipeline?.stages ?? [], 'is_won_stage', editorStage?.id ?? null)}
        lostHeldBy={stageHoldingFlag(pipeline?.stages ?? [], 'is_lost_stage', editorStage?.id ?? null)}
        submitting={createStage.isPending || updateStage.isPending}
        errorText={editorError}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmitEditor}
      />

      <MoveDealsSheet
        visible={moveTarget !== null}
        colors={colors}
        stage={moveTarget}
        dealCount={moveDealCount}
        targets={stages.filter((s) => s.id !== moveTarget?.id)}
        submitting={deleteStage.isPending}
        errorText={moveError}
        onClose={() => {
          setMoveTarget(null);
          setMoveDealCount(null);
          setMoveError(null);
        }}
        onConfirm={(targetId) => {
          if (moveTarget !== null) runDelete(moveTarget, targetId);
        }}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  listContainer: { flex: 1 },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 90 },
  pipelineChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 6,
    maxWidth: 200,
  },
  chipActive: { backgroundColor: c.orange, borderColor: c.orange },
  chipText: { fontSize: 13, color: c.text1 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  intro: { fontSize: 12, color: c.amber, lineHeight: 17, marginBottom: 14 },
  empty: { fontSize: 13, color: c.textMuted, lineHeight: 19, marginBottom: 14 },
  errorBlock: { marginTop: 40, paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  errorText: { color: c.red, textAlign: 'center' },
  retry: { color: c.orange, fontWeight: '600', fontSize: 14 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  archivedBlock: { marginTop: 24 },
  archivedHint: { fontSize: 12, color: c.textMuted, marginTop: 4, marginBottom: 10, lineHeight: 16 },
  archivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.bgPanel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    opacity: 0.75,
  },
  archivedSwatch: { width: 10, height: 10, borderRadius: 5 },
  archivedName: { flex: 1, fontSize: 14, color: c.text1 },
  archivedAction: { fontSize: 12, color: c.orange, fontWeight: '600' },
  addButton: {
    margin: 16,
    backgroundColor: c.orange,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  addButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
