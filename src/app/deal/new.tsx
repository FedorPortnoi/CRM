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
import { router } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { usePipelinesStore } from '../../store/pipelinesStore';
import { API_URL } from '../../utils/api';

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

interface DealApiResponse {
  data: { id: string };
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

export default function NewDealScreen(): JSX.Element {
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
  const [showPipelineModal, setShowPipelineModal] = useState<boolean>(false);
  const [showStageModal, setShowStageModal] = useState<boolean>(false);
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [showPipelineStageError, setShowPipelineStageError] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (pipelines.length === 0) {
      void fetchPipelines();
    }
  }, []);

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

  const handleSubmit = async (): Promise<void> => {
    let hasError = false;
    if (title.trim() === '') {
      setShowTitleError(true);
      hasError = true;
    }
    if (selectedPipelineId === '' || selectedStageId === '') {
      setShowPipelineStageError(true);
      hasError = true;
    }
    if (hasError) return;

    setIsSubmitting(true);
    setApiError(null);
    setShowTitleError(false);
    setShowPipelineStageError(false);

    const body: {
      title: string;
      pipeline_id: string;
      stage_id: string;
      contact_id?: string;
      value?: number;
    } = {
      title: title.trim(),
      pipeline_id: selectedPipelineId,
      stage_id: selectedStageId,
      ...(selectedContactId ? { contact_id: selectedContactId } : {}),
      ...(valueStr.trim() !== '' && !isNaN(parseFloat(valueStr))
        ? { value: parseFloat(valueStr) }
        : {}),
    };

    try {
      const res = await fetch(`${API_URL}/deals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 201) {
        const data = (await res.json()) as DealApiResponse;
        router.replace({ pathname: '/deal/[id]', params: { id: data.data.id } });
      } else {
        const errData = (await res.json()) as ErrorApiResponse;
        setApiError(errData?.error?.message ?? 'Failed to create deal');
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {apiError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{apiError}</Text>
        </View>
      )}

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
        onChangeText={setValueStr}
        keyboardType="numeric"
        placeholder="0.00"
        placeholderTextColor="#6B6B6B"
      />

      <Text style={styles.label}>Pipeline *</Text>
      <TouchableOpacity style={styles.pickerButton} onPress={() => setShowPipelineModal(true)}>
        {isLoading ? (
          <ActivityIndicator color="#1A73E8" />
        ) : (
          <Text style={styles.pickerButtonText}>
            {selectedPipelineId
              ? pipelines.find((p) => p.id === selectedPipelineId)?.name ?? 'Select pipeline...'
              : 'Select pipeline...'}
          </Text>
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

      <Text style={styles.label}>Stage *</Text>
      <TouchableOpacity
        style={[styles.pickerButton, stagePickerDisabled && styles.pickerButtonDisabled]}
        onPress={() => {
          if (!stagePickerDisabled) setShowStageModal(true);
        }}
        disabled={stagePickerDisabled}
      >
        <Text style={styles.pickerButtonText}>
          {selectedStageId
            ? filteredStages.find((s) => s.id === selectedStageId)?.name ?? 'Select stage...'
            : 'Select stage...'}
        </Text>
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

      <Text style={styles.label}>Contact (optional)</Text>
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
        onPress={() => void handleSubmit()}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.submitButtonText}>Create Deal</Text>
        )}
      </TouchableOpacity>
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
    fontSize: 18,
    color: '#6B6B6B',
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
    color: '#6B6B6B',
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
