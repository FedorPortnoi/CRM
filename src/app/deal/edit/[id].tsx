import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  StyleSheet,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { usePipelinesStore } from '../../../store/pipelinesStore';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';
import { useContactSearch } from '../../../hooks/useContactSearch';
import { useCreateMutation } from '../../../hooks/useCreateMutation';
import { useTheme } from '../../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, control, tabular } from '../../../theme';
import { Screen, Card, Button, EmptyState, Skeleton, SkeletonText } from '../../../components/ui';
import { displayDateToIso, isoToDisplayDate, maskDateInput } from '../../../utils/dateInput';

interface PipelineStage {
  id: string;
  name: string;
  position: number;
  pipeline_id: string;
}

interface Pipeline {
  id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStage[];
}

interface ContactPreview {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
}

interface Deal {
  id: string;
  title: string;
  value: number | string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  contact_id: string | null;
  contact: ContactPreview | null;
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
  next_action: string | null;
  next_action_due: string | null;
}

interface DealApiResponse {
  data: Deal;
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

type DealForm = {
  title: string;
  value: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string;
  next_action: string;
  next_action_due: string;
};

type DealPatch = {
  title?: string;
  value?: number | null;
  pipeline_id?: string;
  stage_id?: string;
  contact_id?: string;
  next_action?: string | null;
  next_action_due?: string | null;
};

function contactDisplayName(contact: ContactPreview): string {
  return `${contact.first_name}${contact.last_name ? ' ' + contact.last_name : ''}`;
}

function formatContactResult(contact: ContactPreview): string {
  const name = contactDisplayName(contact);
  return contact.company ? `${name} - ${contact.company}` : name;
}

function dateInputValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : isoToDisplayDate(date.toISOString().slice(0, 10));
}

function formFromDeal(deal: Deal): DealForm {
  const numericValue = deal.value === null ? '' : String(deal.value);
  return {
    title: deal.title,
    value: numericValue,
    pipeline_id: deal.pipeline_id ?? deal.pipeline?.id ?? '',
    stage_id: deal.stage_id ?? deal.stage?.id ?? '',
    contact_id: deal.contact_id ?? deal.contact?.id ?? '',
    next_action: deal.next_action ?? '',
    next_action_due: dateInputValue(deal.next_action_due),
  };
}

function buildPatch(current: DealForm, original: DealForm): DealPatch {
  const patch: DealPatch = {};
  if (current.title.trim() !== original.title.trim()) {
    patch.title = current.title.trim();
  }
  const currentValue = current.value.trim();
  const originalValue = original.value.trim();
  if (currentValue === '' && originalValue !== '') {
    patch.value = null;
  } else if (currentValue !== '' && currentValue !== originalValue) {
    patch.value = Number(currentValue);
  }
  if (current.pipeline_id !== original.pipeline_id) {
    patch.pipeline_id = current.pipeline_id;
  }
  if (current.stage_id !== original.stage_id) {
    patch.stage_id = current.stage_id;
  }
  if (current.contact_id !== '' && current.contact_id !== original.contact_id) {
    patch.contact_id = current.contact_id;
  }
  if (current.next_action.trim() !== original.next_action.trim()) {
    patch.next_action = current.next_action.trim() || null;
  }
  if (current.next_action_due.trim() !== original.next_action_due.trim()) {
    const typed = current.next_action_due.trim();
    patch.next_action_due = typed ? displayDateToIso(typed) ?? typed : null;
  }
  return patch;
}

export default function EditDealScreen(): JSX.Element {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);
  const pipelines = usePipelinesStore((s) => s.pipelines) as Pipeline[];
  const pipelinesLoading = usePipelinesStore((s) => s.isLoading);
  const fetchPipelines = usePipelinesStore((s) => s.fetchPipelines);

  const [original, setOriginal] = useState<DealForm | null>(null);
  const [title, setTitle] = useState<string>('');
  const [valueStr, setValueStr] = useState<string>('');
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [selectedStageId, setSelectedStageId] = useState<string>('');
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [nextAction, setNextAction] = useState<string>('');
  const [nextActionDue, setNextActionDue] = useState<string>('');
  const {
    query: contactQuery,
    setQuery: setContactQuery,
    results: contactResults,
    clearResults: clearContactSearch,
  } = useContactSearch({ token });
  const [showPipelineModal, setShowPipelineModal] = useState<boolean>(false);
  const [showStageModal, setShowStageModal] = useState<boolean>(false);
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [showValueError, setShowValueError] = useState<boolean>(false);
  const [showPipelineStageError, setShowPipelineStageError] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    if (pipelines.length === 0) {
      void fetchPipelines();
    }
  }, [fetchPipelines, pipelines.length]);

  useEffect(() => {
    const loadDeal = async (): Promise<void> => {
      if (!token) return;
      setIsLoading(true);
      setLoadError(null);

      try {
        const res = await fetch(`${API_URL}/deals/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const errData = (await res.json()) as ErrorApiResponse;
          setLoadError(errData.error.message);
          return;
        }
        const data = (await res.json()) as DealApiResponse;
        const loaded = formFromDeal(data.data);
        setOriginal(loaded);
        setTitle(loaded.title);
        setValueStr(loaded.value);
        setSelectedPipelineId(loaded.pipeline_id);
        setSelectedStageId(loaded.stage_id);
        setSelectedContactId(loaded.contact_id);
        setSelectedContactName(data.data.contact ? contactDisplayName(data.data.contact) : '');
        setNextAction(loaded.next_action);
        setNextActionDue(loaded.next_action_due);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t('deals.failedToLoad'));
      } finally {
        setIsLoading(false);
      }
    };

    void loadDeal();
  }, [id, token]);

  const filteredStages = useMemo(
    () =>
      pipelines
        .find((p) => p.id === selectedPipelineId)
        ?.stages.slice()
        .sort((a, b) => a.position - b.position) ?? [],
    [pipelines, selectedPipelineId],
  );

  const selectedPipelineName =
    pipelines.find((p) => p.id === selectedPipelineId)?.name ?? t('deals.selectPipelinePlaceholder');
  const selectedStageName =
    filteredStages.find((s) => s.id === selectedStageId)?.name ?? t('deals.selectStagePlaceholder');
  const stagePickerDisabled = selectedPipelineId === '' || filteredStages.length === 0;

  const { isSubmitting, apiError, submit } = useCreateMutation<DealPatch>({
    endpoint: `${API_URL}/deals/${id}`,
    method: 'PATCH',
    token: token ?? '',
    validate: () => {
      let hasError = false;
      const parsedValue = Number(valueStr.trim());
      if (title.trim() === '') {
        setShowTitleError(true);
        hasError = true;
      }
      if (valueStr.trim() !== '' && (!Number.isFinite(parsedValue) || parsedValue <= 0)) {
        setShowValueError(true);
        hasError = true;
      }
      if (selectedPipelineId === '' || selectedStageId === '') {
        setShowPipelineStageError(true);
        hasError = true;
      }
      if (hasError) return false;
      setShowTitleError(false);
      setShowValueError(false);
      setShowPipelineStageError(false);
      return true;
    },
    buildPayload: () => {
      const current: DealForm = {
        title,
        value: valueStr,
        pipeline_id: selectedPipelineId,
        stage_id: selectedStageId,
        contact_id: selectedContactId,
        next_action: nextAction,
        next_action_due: nextActionDue,
      };
      return buildPatch(current, original!);
    },
    onSuccess: (_data, _queued) => {
      router.back();
    },
    fallbackErrorMessage: t('errors.networkError'),
  });

  const handleSubmit = async (): Promise<void> => {
    if (!original || !token) return;
    const current: DealForm = {
      title,
      value: valueStr,
      pipeline_id: selectedPipelineId,
      stage_id: selectedStageId,
      contact_id: selectedContactId,
      next_action: nextAction,
      next_action_due: nextActionDue,
    };
    const patch = buildPatch(current, original);
    if (Object.keys(patch).length === 0) {
      router.back();
      return;
    }
    await submit();
  };

  const renderPipelineItem = ({ item }: ListRenderItemInfo<Pipeline>): JSX.Element => (
    <TouchableOpacity
      style={styles.modalItem}
      activeOpacity={0.7}
      onPress={() => {
        setSelectedPipelineId(item.id);
        setSelectedStageId('');
        setShowPipelineStageError(false);
        setShowPipelineModal(false);
      }}
    >
      <Text
        style={[
          styles.modalItemText,
          item.id === selectedPipelineId && styles.modalItemTextSelected,
        ]}
      >
        {item.name}
      </Text>
    </TouchableOpacity>
  );

  const renderStageItem = ({ item }: ListRenderItemInfo<PipelineStage>): JSX.Element => (
    <TouchableOpacity
      style={styles.modalItem}
      activeOpacity={0.7}
      onPress={() => {
        setSelectedStageId(item.id);
        setShowPipelineStageError(false);
        setShowStageModal(false);
      }}
    >
      <Text
        style={[
          styles.modalItemText,
          item.id === selectedStageId && styles.modalItemTextSelected,
        ]}
      >
        {item.name}
      </Text>
    </TouchableOpacity>
  );

  const renderContactItem = ({ item }: ListRenderItemInfo<ContactPreview>): JSX.Element => (
    <TouchableOpacity
      style={styles.contactResultItem}
      activeOpacity={0.7}
      onPress={() => {
        setSelectedContactId(item.id);
        setSelectedContactName(contactDisplayName(item));
        clearContactSearch();
      }}
    >
      <Text style={styles.contactResultText}>{formatContactResult(item)}</Text>
    </TouchableOpacity>
  );

  return (
    <>
      <Stack.Screen options={{ title: t('deals.edit') }} />
      <Screen contentContainerStyle={styles.contentPad}>
        {(loadError ?? apiError) !== null ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError ?? apiError}</Text>
          </View>
        ) : null}

        {isLoading ? (
          <>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={2} lastLineWidth="55%" />
            </Card>
            <Card style={styles.cardSpacing}>
              <SkeletonText lines={2} lastLineWidth="65%" />
            </Card>
            <Card>
              <SkeletonText lines={3} lastLineWidth="50%" />
            </Card>
          </>
        ) : (
          <>
            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('deals.name')} *</Text>
                <TextInput
                  style={styles.input}
                  value={title}
                  onChangeText={(text) => {
                    setTitle(text);
                    setShowTitleError(false);
                  }}
                  placeholder={t('deals.titlePlaceholder')}
                  placeholderTextColor={colors.placeholder}
                />
                {showTitleError ? <Text style={styles.fieldError}>{t('deals.titleRequired')}</Text> : null}
              </View>

              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('deals.valueUsd')}</Text>
                <TextInput
                  style={[styles.input, styles.tabularInput]}
                  value={valueStr}
                  onChangeText={(text) => {
                    setValueStr(text);
                    setShowValueError(false);
                  }}
                  keyboardType="numeric"
                  placeholder="0.00"
                  placeholderTextColor={colors.placeholder}
                />
                {showValueError ? <Text style={styles.fieldError}>{t('deals.valuePositiveRequired')}</Text> : null}
              </View>
            </Card>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('deals.pipeline')} *</Text>
                <TouchableOpacity
                  style={styles.pickerButton}
                  activeOpacity={0.7}
                  onPress={() => setShowPipelineModal(true)}
                >
                  {pipelinesLoading ? (
                    <Skeleton width={140} height={16} />
                  ) : (
                    <Text style={styles.pickerButtonText}>{selectedPipelineName}</Text>
                  )}
                </TouchableOpacity>
              </View>

              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('deals.stage')} *</Text>
                <TouchableOpacity
                  style={[styles.pickerButton, stagePickerDisabled && styles.pickerButtonDisabled]}
                  activeOpacity={0.7}
                  onPress={() => {
                    if (!stagePickerDisabled) setShowStageModal(true);
                  }}
                  disabled={stagePickerDisabled}
                >
                  <Text style={styles.pickerButtonText}>{selectedStageName}</Text>
                </TouchableOpacity>
                {showPipelineStageError ? (
                  <Text style={styles.fieldError}>{t('deals.pipelineStageRequired')}</Text>
                ) : null}
              </View>
            </Card>

            <Modal
              visible={showPipelineModal}
              animationType="slide"
              transparent={false}
              onRequestClose={() => setShowPipelineModal(false)}
            >
              <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{t('deals.selectPipeline')}</Text>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setShowPipelineModal(false)}>
                    <Text style={styles.modalClose}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                </View>
                <FlatList<Pipeline>
                  data={pipelines}
                  keyExtractor={(item) => item.id}
                  renderItem={renderPipelineItem}
                />
              </View>
            </Modal>

            <Modal
              visible={showStageModal}
              animationType="slide"
              transparent={false}
              onRequestClose={() => setShowStageModal(false)}
            >
              <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{t('deals.selectStage')}</Text>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setShowStageModal(false)}>
                    <Text style={styles.modalClose}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                </View>
                <FlatList<PipelineStage>
                  data={filteredStages}
                  keyExtractor={(item) => item.id}
                  renderItem={renderStageItem}
                />
              </View>
            </Modal>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>{t('deals.nextAction')}</Text>
                <TextInput
                  style={styles.input}
                  value={nextAction}
                  onChangeText={setNextAction}
                  placeholder={t('deals.nextActionPlaceholder')}
                  placeholderTextColor={colors.placeholder}
                />
              </View>

              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('tasks.dueDateOptional')}</Text>
                <TextInput
                  style={[styles.input, styles.tabularInput]}
                  value={nextActionDue}
                  onChangeText={(v) => setNextActionDue(maskDateInput(v))}
                  placeholder={t('deals.nextActionDuePlaceholder')}
                  placeholderTextColor={colors.placeholder}
                  autoCapitalize="none"
                  keyboardType="number-pad"
                />
              </View>
            </Card>

            <Card style={styles.cardSpacing}>
              <View style={styles.fieldGroupLast}>
                <Text style={styles.label}>{t('deals.contactOptional')}</Text>
                {selectedContactId !== '' ? (
                  <View style={styles.contactChip}>
                    <Text style={styles.contactChipText} numberOfLines={1}>{selectedContactName}</Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => {
                        setSelectedContactId('');
                        setSelectedContactName('');
                        clearContactSearch();
                      }}
                    >
                      <Text style={styles.contactChipRemove}>{t('deals.changeContact')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <TextInput
                      style={styles.input}
                      value={contactQuery}
                      onChangeText={setContactQuery}
                      placeholder={t('deals.searchContactsPlaceholder')}
                      placeholderTextColor={colors.placeholder}
                    />
                    {contactQuery.trim() !== '' ? (
                      <View style={styles.contactResultsContainer}>
                        <FlatList<ContactPreview>
                          data={contactResults.slice(0, 5)}
                          keyExtractor={(item) => item.id}
                          renderItem={renderContactItem}
                          scrollEnabled={false}
                          ListEmptyComponent={
                            <EmptyState
                              title={t('contacts.noSearchResults')}
                              style={styles.contactEmptyState}
                            />
                          }
                        />
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            </Card>

            <Button
              title={t('common.save')}
              onPress={() => { void handleSubmit(); }}
              loading={isSubmitting}
              disabled={isSubmitting}
              block
            />
          </>
        )}
      </Screen>
    </>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  contentPad: {
    paddingTop: spacing.lg,
  },
  cardSpacing: {
    marginBottom: spacing.lg,
  },
  errorBanner: {
    backgroundColor: c.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
  },
  errorBannerText: { ...type.body, color: c.danger },
  fieldGroup: { marginBottom: spacing.md },
  fieldGroupLast: { marginBottom: 0 },
  label: { ...type.label, color: c.text1, marginBottom: spacing.xs },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: control.md,
    ...type.body,
    color: c.text1,
  },
  tabularInput: { ...tabular },
  fieldError: { ...type.caption, color: c.danger, marginTop: spacing.xs },
  pickerButton: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    minHeight: control.md,
    justifyContent: 'center',
  },
  pickerButtonDisabled: {
    opacity: 0.5,
  },
  pickerButtonText: { ...type.body, color: c.text1 },
  modalContainer: {
    flex: 1,
    backgroundColor: c.bg,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalTitle: { ...type.subtitle, color: c.text1 },
  modalClose: { ...type.body, color: c.accent, fontWeight: '600', paddingHorizontal: spacing.sm },
  modalItem: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalItemText: { ...type.body, color: c.text1 },
  modalItemTextSelected: { color: c.accent, fontWeight: '600' },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  contactChipText: { ...type.body, color: c.text1, marginRight: spacing.sm, flexShrink: 1 },
  contactChipRemove: { ...type.body, color: c.accent, fontWeight: '600' },
  contactResultsContainer: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    marginTop: spacing.xs,
  },
  contactResultItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  contactResultText: { ...type.body, color: c.text1 },
  contactEmptyState: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
});
