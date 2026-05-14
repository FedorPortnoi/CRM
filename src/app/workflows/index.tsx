import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type WorkflowItem = {
  id: string;
  name: string;
  trigger: string;
  status: string;
};

export default function WorkflowsScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkflows = useCallback(async (): Promise<void> => {
    if (!token) return;
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`${API_URL}/workflows`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Workflows failed with status ${response.status}`);
      const body = await response.json() as { data: WorkflowItem[] };
      setItems(body.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load workflows');
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchWorkflows();
  }, [fetchWorkflows]);

  if (isLoading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <TouchableOpacity style={styles.retry} onPress={() => { void fetchWorkflows(); }}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>Workflows</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => router.push('/workflows/new' as never)} accessibilityRole="button">
          <Plus size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
        ListEmptyComponent={<Text style={styles.emptyText}>No workflows</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.iconBox}><WorkflowIcon size={20} color="#1A73E8" /></View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowMeta}>{item.trigger.replace(/_/g, ' ')} · {item.status}</Text>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F8FA' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: { padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 26, fontWeight: '700', color: '#111827' },
  addButton: { width: 40, height: 40, borderRadius: 8, backgroundColor: '#1A73E8', alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyList: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#6B7280', fontSize: 16 },
  row: { minHeight: 72, backgroundColor: '#FFFFFF', borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB', padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 42, height: 42, borderRadius: 8, backgroundColor: '#E8F0FE', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  rowMeta: { marginTop: 4, color: '#6B7280' },
  error: { color: '#C5221F', marginBottom: 12 },
  retry: { paddingHorizontal: 16, height: 40, borderRadius: 8, backgroundColor: '#1A73E8', justifyContent: 'center' },
  retryText: { color: '#FFFFFF', fontWeight: '700' },
});
