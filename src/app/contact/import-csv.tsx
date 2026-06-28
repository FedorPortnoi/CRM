import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Upload } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

type CsvRow = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  source?: string;
  notes?: string;
  type?: 'lead' | 'customer' | 'partner' | 'other';
};

const sample = `first_name,last_name,company,email,phone
Sarah,Chen,Northwind,sarah@example.com,+15551234567`;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  return lines.slice(1).flatMap((line) => {
    const values = parseCsvLine(line);
    const record = headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = values[index] ?? '';
      return acc;
    }, {});

    const firstName = record.first_name || record.firstname || record.name;
    if (!firstName.trim()) return [];

    const type = ['lead', 'customer', 'partner', 'other'].includes(record.type)
      ? record.type as CsvRow['type']
      : undefined;

    return [{
      first_name: firstName.trim(),
      last_name: record.last_name || record.lastname || undefined,
      company: record.company || undefined,
      email: record.email || undefined,
      phone: record.phone || undefined,
      mobile: record.mobile || undefined,
      source: record.source || 'mobile_csv',
      notes: record.notes || undefined,
      type,
    }];
  });
}

export default function ImportCsvScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const [csvText, setCsvText] = useState(sample);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => parseCsv(csvText), [csvText]);

  const submit = async (): Promise<void> => {
    if (!token || rows.length === 0) return;
    try {
      setIsImporting(true);
      setError(null);
      const result = await sendOrQueueMutation({
        url: `${API_URL}/contacts/import-csv`,
        method: 'POST',
        token,
        body: rows,
      });

      if (result.queued) {
        Alert.alert('Импорт в очереди', 'Контакты будут импортированы при наличии соединения.', [
          { text: 'OK', onPress: () => router.replace('/(tabs)/contacts') },
        ]);
        return;
      }

      if (!result.response.ok) {
        const body = await result.response.json() as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `Import failed with status ${result.response.status}`);
      }

      const body = await result.response.json() as { data: { imported_count: number } };
      Alert.alert('Импорт завершён', `Импортировано контактов: ${body.data.imported_count}.`, [
        { text: 'OK', onPress: () => router.replace('/(tabs)/contacts') },
      ]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка импорта');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>CSV-импорт</Text>
        <TextInput
          value={csvText}
          onChangeText={setCsvText}
          style={styles.input}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />
        <View style={styles.preview}>
          <Text style={styles.previewText}>{rows.length} корректных строк</Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.button, (rows.length === 0 || isImporting) && styles.buttonDisabled]}
          disabled={rows.length === 0 || isImporting}
          onPress={() => { void submit(); }}
          accessibilityRole="button"
        >
          {isImporting ? <ActivityIndicator color="#FFFFFF" /> : <Upload size={20} color="#FFFFFF" />}
          <Text style={styles.buttonText}>Импортировать</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0E0E0D' },
  container: { flex: 1 },
  content: { padding: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#E8E0D4', marginBottom: 12 },
  input: {
    minHeight: 260,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(232,224,212,0.12)',
    backgroundColor: '#1A1A18',
    padding: 12,
    fontSize: 14,
    color: '#E8E0D4',
  },
  preview: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#1A1A18',
    borderWidth: 1,
    borderColor: 'rgba(232,224,212,0.08)',
  },
  previewText: { color: '#E8E0D4', fontWeight: '600' },
  error: { color: '#C5221F', marginTop: 12 },
  button: {
    height: 52,
    borderRadius: 12,
    backgroundColor: '#CC785C',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
