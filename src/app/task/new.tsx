import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { Calendar } from 'react-native-calendars';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

interface ContactPreview {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
}

interface TaskApiResponse {
  data: { id: string };
}

interface CalendarDay {
  dateString: string;
}

interface ErrorApiResponse {
  error: { code: string; message: string };
}

export default function NewTaskScreen(): JSX.Element | null {
  const token = useUserStore((s) => s.token);
  const user = useUserStore((s) => s.user);

  const [title, setTitle] = useState<string>('');
  const [showTitleError, setShowTitleError] = useState<boolean>(false);
  const [dueDate, setDueDate] = useState<string>('');
  const [showCalendar, setShowCalendar] = useState<boolean>(false);
  const [contactQuery, setContactQuery] = useState<string>('');
  const [contactResults, setContactResults] = useState<ContactPreview[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (contactQuery.trim().length >= 2) {
        fetch(
          `${API_URL}/contacts?q=${encodeURIComponent(contactQuery.trim())}&per_page=8`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
          .then((r) => r.json())
          .then((body: { data: ContactPreview[] }) => setContactResults(body.data))
          .catch(() => setContactResults([]));
      } else {
        setContactResults([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [contactQuery, token]);

  if (!token || !user) return null;

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const handleSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setShowTitleError(true);
      return;
    }
    setIsSubmitting(true);
    const body = {
      title: title.trim(),
      assigned_to: user.id,
      ...(dueDate !== '' ? { due_date: new Date(dueDate + 'T00:00:00').toISOString() } : {}),
      ...(selectedContactId !== '' ? { contact_id: selectedContactId } : {}),
    };
    try {
      const res = await fetch(`${API_URL}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const parsed = await res.json();
      if (res.status === 201) {
        router.replace({
          pathname: '/task/[id]',
          params: { id: (parsed as TaskApiResponse).data.id },
        });
      } else {
        setApiError((parsed as ErrorApiResponse)?.error?.message ?? 'Failed to create task');
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {apiError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{apiError}</Text>
        </View>
      )}

      <Text style={styles.label}>Task Title *</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={(t) => {
          setTitle(t);
          setShowTitleError(false);
        }}
        placeholder="Enter task title"
        placeholderTextColor="#6B6B6B"
      />
      {showTitleError && <Text style={styles.fieldError}>Title is required</Text>}

      <Text style={styles.label}>Due Date (optional)</Text>
      <TouchableOpacity style={styles.input} onPress={() => setShowCalendar(true)}>
        <Text style={dueDate ? styles.inputText : styles.placeholderText}>
          {dueDate ? formatDate(dueDate) : 'Pick a date'}
        </Text>
      </TouchableOpacity>
      {dueDate !== '' && (
        <TouchableOpacity onPress={() => setDueDate('')}>
          <Text style={styles.clearLink}>Clear</Text>
        </TouchableOpacity>
      )}

      <Modal animationType="slide" visible={showCalendar} onRequestClose={() => setShowCalendar(false)}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Date</Text>
          <TouchableOpacity onPress={() => setShowCalendar(false)}>
            <Text style={styles.modalDone}>Done</Text>
          </TouchableOpacity>
        </View>
        <Calendar
          onDayPress={(day: CalendarDay) => {
            setDueDate(day.dateString);
            setShowCalendar(false);
          }}
          markedDates={
            dueDate
              ? ({ [dueDate]: { selected: true, selectedColor: '#1A73E8' } } as Record<
                  string,
                  { selected?: boolean; selectedColor?: string }
                >)
              : {}
          }
        />
      </Modal>

      <Text style={styles.label}>Assigned To</Text>
      <View style={styles.disabledInput}>
        <Text style={styles.inputText}>{user.name}</Text>
      </View>

      <Text style={styles.label}>Contact (optional)</Text>
      {selectedContactId !== '' ? (
        <View style={styles.chip}>
          <Text style={styles.chipText}>{selectedContactName}</Text>
          <TouchableOpacity
            onPress={() => {
              setSelectedContactId('');
              setSelectedContactName('');
              setContactQuery('');
              setContactResults([]);
            }}
          >
            <Text style={styles.chipRemove}>&#x2715;</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TextInput
          style={styles.input}
          value={contactQuery}
          onChangeText={setContactQuery}
          placeholder="Search contacts by name..."
          placeholderTextColor="#6B6B6B"
        />
      )}
      {contactResults.length > 0 && selectedContactId === '' && (
        <View style={styles.dropdown}>
          {contactResults.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={styles.dropdownRow}
              onPress={() => {
                setSelectedContactId(c.id);
                setSelectedContactName(
                  `${c.first_name}${c.last_name ? ' ' + c.last_name : ''}`,
                );
                setContactQuery('');
                setContactResults([]);
              }}
            >
              <Text style={styles.dropdownText}>
                {`${c.first_name}${c.last_name ? ' ' + c.last_name : ''}${c.company ? ' · ' + c.company : ''}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
        onPress={() => { void handleSubmit(); }}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.submitText}>Create Task</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#F5F5F5', flexGrow: 1 },
  errorBanner: { backgroundColor: '#FFEBEE', padding: 12, borderRadius: 8, marginBottom: 16 },
  errorBannerText: { color: '#D93025' },
  label: { fontSize: 14, fontWeight: '600', color: '#1A1A1A', marginBottom: 6, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
  },
  inputText: { color: '#1A1A1A', fontSize: 16 },
  placeholderText: { color: '#6B6B6B', fontSize: 16 },
  fieldError: { color: '#D93025', fontSize: 12, marginTop: 4 },
  clearLink: { color: '#1A73E8', fontSize: 12, marginTop: 4 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#1A1A1A' },
  modalDone: { fontSize: 16, color: '#1A73E8', fontWeight: '600' },
  disabledInput: {
    backgroundColor: '#F5F5F5',
    borderColor: '#E0E0E0',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F0FE',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  chipText: { color: '#1A73E8', fontSize: 14, marginRight: 8 },
  chipRemove: { color: '#1A73E8', fontSize: 14, fontWeight: '600' },
  dropdown: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    marginTop: 4,
    elevation: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  dropdownRow: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#E0E0E0' },
  dropdownText: { color: '#1A1A1A', fontSize: 14 },
  submitButton: {
    backgroundColor: '#1A73E8',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
