import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  FlatList,
  StyleSheet,
  ListRenderItemInfo,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { usePipelinesStore } from '../../store/pipelinesStore';
import { API_URL } from '../../utils/api';
import { useCreateMutation } from '../../hooks/useCreateMutation';

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

export default function NewDealScreen(): JSX.Element {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const token = useUserStore((s) => s.token);
  const { pipelines, isLoading, fetchPipelines } = usePipelinesStore() as {
    pipelines: Pipeline[];
    isLoading: boolean;
    fetchPipelines: () => Promise<void>;
  };

  const [title, setTitle] = useState<string>('');
  const [valueStr, setValueStr] = useState<string>('');
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [selectedStageId, setSelectedStageId] = useState<string>('');
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [nextAction, setNextAction] = useState<string>('');
  const [nextActionDue, setNextActionDue] = useState<string>('');
  const [showPipelineModal, setShowPipelineModal] = useState<boolean>(false);
  const [showStageModal, setShowStageModal] = useState<boolean>(false);
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [showPipelineStageError, setShowPipelineStageError] = useState<boolean>(false);

  useEffect(() => {
    if (pipelines.length === 0) {
      void fetchPipelines();
    }
  }, [fetchPipelines, pipelines.length]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (contactQuery.trim().length >= 2) {
        try {
          const res = await fetch(
            `${API_URL}/contacts?q=${encodeURIComponent(contactQuery.trim())}&per_page=8`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const json = (await res.json()) as { data: ContactPreview[] };
          setContactResults(json.data);
        } catch {
          setContactResults([]);
        }
      } else {
        setContactResults([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [contactQuery, token]);

  const filteredStages =
    pipelines
      .find((p) => p.id === selectedPipelineId)
      ?.stages.slice()
      .sort((a, b) => a.position - b.position) ?? [];

  const { isSubmitting, apiError, submit } = useCreateMutation<
    {
      title: string;
      pipeline_id: string;
      stage_id: string;
      contact_id?: string;
      value?: number;
      next_action?: string;
      next_action_due?: string;
    },
    { id: string }
  >({
    endpoint: `${API_URL}/deals`,
    token: token ?? '',
    validate: () => {
      let hasError = false;
      if (title.trim() === '') {
        setShowTitleError(true);
        hasError = true;
      } else {
        setShowTitleError(false);
      }
      if (selectedPipelineId === '' || selectedStageId === '') {
        setShowPipelineStageError(true);
        hasError = true;
      } else {
        setShowPipelineStageError(false);
      }
      return !hasError;
    },
    buildPayload: () => ({
      title: title.trim(),
      pipeline_id: selectedPipelineId,
      stage_id: selectedStageId,
      ...(selectedContactId ? { contact_id: selectedContactId } : {}),
      ...(valueStr.trim() !== '' && !isNaN(parseFloat(valueStr))
        ? { value: parseFloat(valueStr) }
        : {}),
      ...(nextAction.trim() !== '' ? { next_action: nextAction.trim() } : {}),
      ...(nextActionDue.trim() !== '' ? { next_action_due: nextActionDue.trim() } : {}),
    }),
    onSuccess: (data, queued) => {
      if (queued) {
        router.replace('/(tabs)/kanban');
        return;
      }
      router.replace({ pathname: '/deal/[id]', params: { id: data.id } });
    },
    fallbackErrorMessage: t('deals.failedToCreate'),
  });

  const renderPipelineItem = ({ item }: ListRenderItemInfo<Pipeline>) => (
    <TouchableOpacity
      style={styles.modalItem}
      onPress={() => {
        setSelectedPipelineId(item.id);
        setSelectedStageId('');
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

  const renderStageItem = ({ item }: ListRenderItemInfo<PipelineStage>) => (
    <TouchableOpacity
      style={styles.modalItem}
      onPress={() => {
        setSelectedStageId(item.id);
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

  const renderContactItem = ({ item }: ListRenderItemInfo<ContactPreview>) => (
    <TouchableOpacity
      style={styles.contactResultItem}
      onPress={() => {
        setSelectedContactId(item.id);
        setSelectedContactName(
          `${item.first_name}${item.last_name ? ' ' + item.last_name : ''}`
        );
        setContactQuery('');
        setContactResults([]);
      }}
    >
      <Text style={styles.contactResultText}>
        {`${item.first_name}${item.last_name ? ' ' + item.last_name : ''}${item.company ? ' · ' + item.company : ''}`}
      </Text>
    </TouchableOpacity>
  );

  const stagePickerDisabled = selectedPipelineId === '' || filteredStages.length === 0;

  return (
    <>
      <Stack.Screen options={{ title: t('deals.new') }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {apiError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{apiError}</Text>
        </View>
      )}

      <Text style={styles.label}>{t('deals.name')} *</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={(text) => {
          setTitle(text);
          setShowTitleError(false);
        }}
        placeholder={t('deals.titlePlaceholder')}
        placeholderTextColor="#B07868"
      />
      {showTitleError && <Text style={styles.fieldError}>{t('deals.titleRequired')}</Text>}

      <Text style={styles.label}>{t('deals.valueUsd')}</Text>
      <TextInput
        style={styles.input}
        value={valueStr}
        onChangeText={setValueStr}
        keyboardType="numeric"
        placeholder="0.00"
        placeholderTextColor="#B07868"
      />

      <Text style={styles.label}>{t('deals.pipeline')} *</Text>
      <TouchableOpacity style={styles.pickerButton} onPress={() => setShowPipelineModal(true)}>
        {isLoading ? (
          <ActivityIndicator color="#C45A10" />
        ) : (
          <Text style={styles.pickerButtonText}>
            {selectedPipelineId
              ? pipelines.find((p) => p.id === selectedPipelineId)?.name ?? t('deals.selectPipelinePlaceholder')
              : t('deals.selectPipelinePlaceholder')}
          </Text>
        )}
      </TouchableOpacity>

      <Modal
        visible={showPipelineModal}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowPipelineModal(false)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('deals.selectPipeline')}</Text>
            <TouchableOpacity onPress={() => setShowPipelineModal(false)}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList<Pipeline>
            data={pipelines}
            keyExtractor={(item) => item.id}
            renderItem={renderPipelineItem}
          />
        </View>
      </Modal>

      <Text style={styles.label}>{t('deals.stage')} *</Text>
      <TouchableOpacity
        style={[styles.pickerButton, stagePickerDisabled && styles.pickerButtonDisabled]}
        onPress={() => {
          if (!stagePickerDisabled) setShowStageModal(true);
        }}
        disabled={stagePickerDisabled}
      >
        <Text style={styles.pickerButtonText}>
          {selectedStageId
            ? filteredStages.find((s) => s.id === selectedStageId)?.name ?? t('deals.selectStagePlaceholder')
            : t('deals.selectStagePlaceholder')}
        </Text>
      </TouchableOpacity>
      {showPipelineStageError && (
        <Text style={styles.fieldError}>{t('deals.pipelineStageRequired')}</Text>
      )}

      <Modal
        visible={showStageModal}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowStageModal(false)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('deals.selectStage')}</Text>
            <TouchableOpacity onPress={() => setShowStageModal(false)}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList<PipelineStage>
            data={filteredStages}
            keyExtractor={(item) => item.id}
            renderItem={renderStageItem}
          />
        </View>
      </Modal>

      <Text style={styles.label}>{t('deals.contactOptional')}</Text>
      {selectedContactId !== '' ? (
        <View style={styles.contactChip}>
          <Text style={styles.contactChipText}>{selectedContactName}</Text>
          <TouchableOpacity
            onPress={() => {
              setSelectedContactId('');
              setSelectedContactName('');
              setContactQuery('');
              setContactResults([]);
            }}
          >
            <Text style={styles.contactChipRemove}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <TextInput
            style={styles.input}
            value={contactQuery}
            onChangeText={setContactQuery}
            placeholder={t('deals.searchContactsPlaceholder')}
            placeholderTextColor="#B07868"
          />
          {contactResults.slice(0, 5).length > 0 && (
            <View style={styles.contactResultsContainer}>
              <FlatList<ContactPreview>
                data={contactResults.slice(0, 5)}
                keyExtractor={(item) => item.id}
                renderItem={renderContactItem}
                scrollEnabled={false}
              />
            </View>
          )}
        </>
      )}

      <Text style={styles.label}>{t('deals.nextAction')}</Text>
      <TextInput
        style={styles.input}
        value={nextAction}
        onChangeText={setNextAction}
        placeholder={t('deals.nextActionPlaceholder')}
        placeholderTextColor="#B07868"
      />

      <Text style={styles.label}>{t('tasks.dueDateOptional')}</Text>
      <TextInput
        style={styles.input}
        value={nextActionDue}
        onChangeText={setNextActionDue}
        placeholder={t('deals.nextActionDuePlaceholder')}
        placeholderTextColor="#B07868"
        autoCapitalize="none"
      />

      <TouchableOpacity
        style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
        onPress={() => void submit()}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.submitButtonText}>{t('deals.createDeal')}</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  content: {
    padding: 16,
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#ef4444',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#383432',
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#383432',
  },
  fieldError: {
    color: '#ef4444',
    fontSize: 13,
    marginTop: 4,
  },
  pickerButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  pickerButtonDisabled: {
    opacity: 0.5,
  },
  pickerButtonText: {
    fontSize: 16,
    color: '#383432',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#383432',
  },
  modalClose: {
    fontSize: 18,
    color: '#B07868',
    paddingHorizontal: 8,
  },
  modalItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  modalItemText: {
    fontSize: 16,
    color: '#383432',
  },
  modalItemTextSelected: {
    color: '#C45A10',
    fontWeight: '600',
  },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  contactChipText: {
    fontSize: 14,
    color: '#383432',
    marginRight: 8,
  },
  contactChipRemove: {
    fontSize: 14,
    color: '#B07868',
  },
  contactResultsContainer: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E8DDD6',
    borderRadius: 12,
    marginTop: 4,
  },
  contactResultItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  contactResultText: {
    fontSize: 15,
    color: '#383432',
  },
  submitButton: {
    backgroundColor: '#C45A10',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 32,
    marginBottom: 16,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
