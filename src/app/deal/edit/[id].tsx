import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ListRenderItemInfo,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { usePipelinesStore } from '../../../store/pipelinesStore';
import { useUserStore } from '../../../store/userStore';
import { API_URL } from '../../../utils/api';

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
  contact_id: string;
  contact: ContactPreview;
  pipeline: { id: string; name: string } | null;
  stage: { id: string; name: string; position: number } | null;
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
};

type DealPatch = {
  title?: string;
  value?: number | null;
  pipeline_id?: string;
  stage_id?: string;
  contact_id?: string;
};

function contactDisplayName(contact: ContactPreview): string {
  return `${contact.first_name}${contact.last_name ? ' ' + contact.last_name : ''}`;
}

function formatContactResult(contact: ContactPreview): string {
  const name = contactDisplayName(contact);
  return contact.company ? `${name} - ${contact.company}` : name;
}

function formFromDeal(deal: Deal): DealForm {
  const numericValue = deal.value === null ? '' : String(deal.value);
  return {
    title: deal.title,
    value: numericValue,
    pipeline_id: deal.pipeline_id ?? deal.pipeline?.id ?? '',
    stage_id: deal.stage_id ?? deal.stage?.id ?? '',
    contact_id: deal.contact_id ?? deal.contact.id,
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
  return patch;
}

export default function EditDealScreen(): JSX.Element {
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
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [showPipelineModal, setShowPipelineModal] = useState<boolean>(false);
  const [showStageModal, setShowStageModal] = useState<boolean>(false);
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [showValueError, setShowValueError] = useState<boolean>(false);
  const [showPipelineStageError, setShowPipelineStageError] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (pipelines.length === 0) {
      void fetchPipelines();
    }
  }, [fetchPipelines, pipelines.length]);

  useEffect(() => {
    const loadDeal = async (): Promise<void> => {
      if (!token) return;
      setIsLoading(true);
      setApiError(null);

      try {
        const res = await fetch(`${API_URL}/deals/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const errData = (await res.json()) as ErrorApiResponse;
          setApiError(errData.error.message);
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
        setSelectedContactName(contactDisplayName(data.data.contact));
      } catch (err) {
        setApiError(err instanceof Error ? err.message : 'Failed to load deal');
      } finally {
        setIsLoading(false);
      }
    };

    void loadDeal();
  }, [id, token]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (contactQuery.trim().length >= 2) {
        try {
          const res = await fetch(
            `${API_URL}/contacts?q=${encodeURIComponent(contactQuery.trim())}&per_page=8`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!res.ok) {
            setContactResults([]);
            return;
          }
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

  const filteredStages = useMemo(
    () =>
      pipelines
        .find((p) => p.id === selectedPipelineId)
        ?.stages.slice()
        .sort((a, b) => a.position - b.position) ?? [],
    [pipelines, selectedPipelineId],
  );

  const selectedPipelineName =
    pipelines.find((p) => p.id === selectedPipelineId)?.name ?? 'Select pipeline...';
  const selectedStageName =
    filteredStages.find((s) => s.id === selectedStageId)?.name ?? 'Select stage...';
  const stagePickerDisabled = selectedPipelineId === '' || filteredStages.length === 0;

  const handleSubmit = async (): Promise<void> => {
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
    if (hasError || original === null || !token) return;

    setShowTitleError(false);
    setShowValueError(false);
    setShowPipelineStageError(false);
    setApiError(null);
    setIsSubmitting(true);

    const current: DealForm = {
      title,
      value: valueStr,
      pipeline_id: selectedPipelineId,
      stage_id: selectedStageId,
      contact_id: selectedContactId,
    };
    const patch = buildPatch(current, original);

    if (Object.keys(patch).length === 0) {
      setIsSubmitting(false);
      router.back();
      return;
    }

    try {
      const res = await fetch(`${API_URL}/deals/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(patch),
      });

      if (res.ok) {
        router.back();
      } else {
        const errData = (await res.json()) as ErrorApiResponse;
        setApiError(errData.error.message);
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderPipelineItem = ({ item }: ListRenderItemInfo<Pipeline>): JSX.Element => (
    <TouchableOpacity
      style={styles.modalItem}
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
      onPress={() => {
        setSelectedContactId(item.id);
        setSelectedContactName(contactDisplayName(item));
        setContactQuery('');
        setContactResults([]);
      }}
    >
      <Text style={styles.contactResultText}>{formatContactResult(item)}</Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Edit Deal' }} />
      {apiError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{apiError}</Text>
        </View>
      )}

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#1A73E8" size="large" />
        </View>
      ) : (
        <>
          <Text style={styles.label}>Deal Title *</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={(text) => {
              setTitle(text);
              setShowTitleError(false);
            }}
            placeholder="Enter deal title"
            placeholderTextColor="#6B6B6B"
          />
          {showTitleError && <Text style={styles.fieldError}>Title is required</Text>}

          <Text style={styles.label}>Value ($)</Text>
          <TextInput
            style={styles.input}
            value={valueStr}
            onChangeText={(text) => {
              setValueStr(text);
              setShowValueError(false);
            }}
            keyboardType="numeric"
            placeholder="0.00"
            placeholderTextColor="#6B6B6B"
          />
          {showValueError && <Text style={styles.fieldError}>Value must be positive</Text>}

          <Text style={styles.label}>Pipeline *</Text>
          <TouchableOpacity style={styles.pickerButton} onPress={() => setShowPipelineModal(true)}>
            {pipelinesLoading ? (
              <ActivityIndicator color="#1A73E8" />
            ) : (
              <Text style={styles.pickerButtonText}>{selectedPipelineName}</Text>
            )}
          </TouchableOpacity>

          <Modal
            visible={showPipelineModal}
            animationType="slide"
            transparent={false}
            onRequestClose={() => setShowPipelineModal(false)}
          >
            <View style={styles.modalContainer}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Select Pipeline</Text>
                <TouchableOpacity onPress={() => setShowPipelineModal(false)}>
                  <Text style={styles.modalClose}>Close</Text>
                </TouchableOpacity>
              </View>
              <FlatList<Pipeline>
                data={pipelines}
                keyExtractor={(item) => item.id}
                renderItem={renderPipelineItem}
              />
            </View>
          </Modal>

          <Text style={styles.label}>Stage *</Text>
          <TouchableOpacity
            style={[styles.pickerButton, stagePickerDisabled && styles.pickerButtonDisabled]}
            onPress={() => {
              if (!stagePickerDisabled) setShowStageModal(true);
            }}
            disabled={stagePickerDisabled}
          >
            <Text style={styles.pickerButtonText}>{selectedStageName}</Text>
          </TouchableOpacity>
          {showPipelineStageError && (
            <Text style={styles.fieldError}>Pipeline and stage are required</Text>
          )}

          <Modal
            visible={showStageModal}
            animationType="slide"
            transparent={false}
            onRequestClose={() => setShowStageModal(false)}
          >
            <View style={styles.modalContainer}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Select Stage</Text>
                <TouchableOpacity onPress={() => setShowStageModal(false)}>
                  <Text style={styles.modalClose}>Close</Text>
                </TouchableOpacity>
              </View>
              <FlatList<PipelineStage>
                data={filteredStages}
                keyExtractor={(item) => item.id}
                renderItem={renderStageItem}
              />
            </View>
          </Modal>

          <Text style={styles.label}>Contact</Text>
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
                <Text style={styles.contactChipRemove}>Change</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TextInput
                style={styles.input}
                value={contactQuery}
                onChangeText={setContactQuery}
                placeholder="Search contacts by name..."
                placeholderTextColor="#6B6B6B"
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

          <TouchableOpacity
            style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
            onPress={() => { void handleSubmit(); }}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.submitButtonText}>Save Changes</Text>
            )}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  content: {
    padding: 16,
  },
  loadingContainer: {
    paddingTop: 48,
  },
  errorBanner: {
    backgroundColor: '#FFEBEE',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#D93025',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1A1A1A',
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#1A1A1A',
  },
  fieldError: {
    color: '#D93025',
    fontSize: 13,
    marginTop: 4,
  },
  pickerButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  pickerButtonDisabled: {
    opacity: 0.5,
  },
  pickerButtonText: {
    fontSize: 16,
    color: '#1A1A1A',
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
    borderBottomColor: '#E0E0E0',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  modalClose: {
    fontSize: 14,
    color: '#1A73E8',
    fontWeight: '600',
    paddingHorizontal: 8,
  },
  modalItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  modalItemText: {
    fontSize: 16,
    color: '#1A1A1A',
  },
  modalItemTextSelected: {
    color: '#1A73E8',
    fontWeight: '600',
  },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  contactChipText: {
    fontSize: 14,
    color: '#1A1A1A',
    marginRight: 8,
  },
  contactChipRemove: {
    fontSize: 14,
    color: '#1A73E8',
    fontWeight: '600',
  },
  contactResultsContainer: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    marginTop: 4,
  },
  contactResultItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  contactResultText: {
    fontSize: 15,
    color: '#1A1A1A',
  },
  submitButton: {
    backgroundColor: '#1A73E8',
    borderRadius: 8,
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
