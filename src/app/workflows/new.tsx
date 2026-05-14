import React, { useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Save } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type Trigger = 'contact_created' | 'deal_stage_changed' | 'task_completed';

const triggers: Trigger[] = ['contact_created', 'deal_stage_changed', 'task_completed'];

export default function NewWorkflowScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const [name, setName] = useState('Follow up automatically');
  const [trigger, setTrigger] = useState<Trigger>('contact_created');
  const [taskTitle, setTaskTitle] = useState('Follow up with {{first_name}}');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (!token) return;
    try {
      setIsSaving(true);
      setError(null);
      const response = await fetch(`${API_URL}/workflows`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          trigger,
          actions: [{ type: 'create_task', title: taskTitle, due_in_days: 1 }],
          status: 'active',
        }),
      });

      if (!response.ok) {
        const body = await response.json() as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `Save failed with status ${response.status}`);
      }

      router.replace('/workflows' as never);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save workflow');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>New workflow</Text>
        <Text style={styles.label}>Name</Text>
        <TextInput value={name} onChangeText={setName} style={styles.input} />
        <Text style={styles.label}>Trigger</Text>
        <View style={styles.segment}>
          {triggers.map((item) => (
            <TouchableOpacity
              key={item}
              style={[styles.segmentItem, trigger === item && styles.segmentItemActive]}
              onPress={() => setTrigger(item)}
            >
              <Text style={[styles.segmentText, trigger === item && styles.segmentTextActive]}>
                {item.replace(/_/g, ' ')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.label}>Task title</Text>
        <TextInput value={taskTitle} onChangeText={setTaskTitle} style={styles.input} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.button, (!name.trim() || !taskTitle.trim() || isSaving) && styles.buttonDisabled]}
          disabled={!name.trim() || !taskTitle.trim() || isSaving}
          onPress={() => { void save(); }}
          accessibilityRole="button"
        >
          {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Save size={20} color="#FFFFFF" />}
          <Text style={styles.buttonText}>Save workflow</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F8FA' },
  container: { flex: 1, padding: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#111827', marginBottom: 18 },
  label: { marginTop: 12, marginBottom: 6, color: '#374151', fontWeight: '700' },
  input: { height: 48, borderRadius: 8, borderWidth: 1, borderColor: '#D1D5DB', backgroundColor: '#FFFFFF', paddingHorizontal: 12, color: '#111827' },
  segment: { gap: 8 },
  segmentItem: { minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: '#D1D5DB', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  segmentItemActive: { borderColor: '#1A73E8', backgroundColor: '#E8F0FE' },
  segmentText: { color: '#374151', fontWeight: '600' },
  segmentTextActive: { color: '#1A73E8' },
  error: { color: '#C5221F', marginTop: 12 },
  button: { height: 52, borderRadius: 8, backgroundColor: '#1A73E8', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 20 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
