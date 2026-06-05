import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, FlatList, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { MessageSquare, Upload, CheckCircle, Users } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

interface WaContact { name: string; phone?: string; message_count: number }
type Phase = 'pick' | 'preview' | 'importing' | 'done';

// Парсит экспорт WhatsApp (.txt) и возвращает уникальных собеседников
function parseWhatsApp(text: string, myName?: string): WaContact[] {
  const map = new Map<string, WaContact>();

  // iOS: [DD.MM.YYYY, HH:MM:SS] Name: message
  // Android: DD.MM.YYYY, HH:MM - Name: message
  const lineRe = /(?:\[\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s[\d:]+\s?(?:AM|PM)?\]|\d{1,2}[./]\d{1,2}[./]\d{2,4},\s[\d:]+)\s[-–]\s(.+?):\s(.+)/;

  for (const line of text.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || name === myName || name.toLowerCase().includes('system')) continue;

    // Try to extract phone from name (some exports use phone numbers as name)
    const phoneMatch = name.match(/\+[\d\s\-()]{7,20}/);
    const phone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : undefined;

    const existing = map.get(name);
    if (existing) {
      existing.message_count++;
    } else {
      map.set(name, { name, phone, message_count: 1 });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.message_count - a.message_count);
}

export default function WhatsAppImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [phase, setPhase] = useState<Phase>('pick');
  const [contacts, setContacts] = useState<WaContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState('');

  const pickFile = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/plain', '*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;

      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const parsed = parseWhatsApp(content);

      if (parsed.length === 0) {
        setError('Собеседники не найдены. Убедитесь, что это экспорт WhatsApp (.txt)');
        return;
      }

      setContacts(parsed);
      setSelected(new Set(parsed.map((c) => c.name)));
      setPhase('preview');
    } catch { setError('Не удалось прочитать файл'); }
  };

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const importSelected = async () => {
    const toImport = contacts.filter((c) => selected.has(c.name));
    if (toImport.length === 0) return;
    setPhase('importing');

    try {
      const res = await fetch(`${API_URL}/import/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
        body: JSON.stringify({ contacts: toImport }),
      });
      const json = await res.json() as { data?: { imported: number }; error?: { message: string } };
      if (!res.ok) { setError(json.error?.message ?? 'Ошибка'); setPhase('preview'); return; }
      setResult(json.data!);
      setPhase('done');
    } catch { setError('Нет соединения'); setPhase('preview'); }
  };

  if (phase === 'importing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#25D366" />
        <Text style={styles.loadingText}>Импортируем контакты...</Text>
      </View>
    );
  }

  if (phase === 'done' && result) {
    return (
      <View style={styles.center}>
        <CheckCircle size={52} color="#25D366" strokeWidth={1.5} />
        <Text style={styles.doneTitle}>Готово!</Text>
        <Text style={styles.doneSub}>Добавлено {result.imported} контактов</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#25D366' }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'pick') {
    return (
      <View style={styles.center}>
        <View style={[styles.iconCircle, { backgroundColor: '#25D366' }]}>
          <MessageSquare size={30} color="#fff" strokeWidth={2} />
        </View>
        <Text style={styles.title}>Импорт из WhatsApp</Text>
        <Text style={styles.instructions}>
          {'1. Откройте чат в WhatsApp\n2. Меню (⋮) → Ещё → Экспорт чата → Без медиафайлов\n3. Сохраните .txt файл\n4. Нажмите кнопку ниже'}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#25D366' }]} onPress={() => void pickFile()}>
          <Upload size={18} color="#fff" strokeWidth={2.5} style={{ marginRight: 8 }} />
          <Text style={styles.btnText}>Выбрать файл экспорта</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // preview
  const selCount = selected.size;
  return (
    <View style={styles.container}>
      <View style={styles.previewHeader}>
        <Users size={16} color="#25D366" />
        <Text style={styles.previewTitle}>Найдено {contacts.length} собеседников</Text>
        <TouchableOpacity onPress={() => {
          if (selCount === contacts.length) setSelected(new Set());
          else setSelected(new Set(contacts.map((c) => c.name)));
        }}>
          <Text style={styles.selAll}>{selCount === contacts.length ? 'Снять всё' : 'Выбрать всё'}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(c) => c.name}
        renderItem={({ item }: ListRenderItemInfo<WaContact>) => {
          const isSelected = selected.has(item.name);
          return (
            <TouchableOpacity style={[styles.row, isSelected && styles.rowSelected]} onPress={() => toggle(item.name)}>
              <View style={[styles.check, isSelected && styles.checkSelected]}>
                {isSelected && <Text style={styles.checkMark}>✓</Text>}
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowName}>{item.name}</Text>
                {item.phone && <Text style={styles.rowSub}>{item.phone}</Text>}
              </View>
              <Text style={styles.msgCount}>{item.message_count} сообщ.</Text>
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      />

      <View style={styles.bar}>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#25D366', flex: 1 }, selCount === 0 && styles.btnDisabled]}
          onPress={() => void importSelected()} disabled={selCount === 0}>
          <Text style={styles.btnText}>Импортировать ({selCount})</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#FAF6F3', gap: 12 },
  iconCircle: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: '#383432', textAlign: 'center' },
  instructions: { fontSize: 14, color: '#6B5B55', lineHeight: 22, textAlign: 'left', backgroundColor: '#fff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#F5EDE8', width: '100%' },
  btn: { flexDirection: 'row', height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#ef4444', fontSize: 13, textAlign: 'center' },
  loadingText: { marginTop: 16, fontSize: 16, fontWeight: '600', color: '#383432' },
  doneTitle: { fontSize: 24, fontWeight: '800', color: '#383432' },
  doneSub: { fontSize: 15, color: '#B07868' },
  previewHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F5EDE8' },
  previewTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: '#383432' },
  selAll: { fontSize: 13, color: '#25D366', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: '#F5EDE8' },
  rowSelected: { borderColor: '#25D366', backgroundColor: '#F0FFF4' },
  check: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#25D366', alignItems: 'center', justifyContent: 'center' },
  checkSelected: { backgroundColor: '#25D366' },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600', color: '#383432' },
  rowSub: { fontSize: 12, color: '#B07868', marginTop: 2 },
  msgCount: { fontSize: 11, color: '#CFADA3' },
  bar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#F5EDE8', paddingBottom: 32 },
});
