import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, FlatList, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Upload } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

interface WaContact { name: string; phone?: string; message_count: number }
type Phase = 'pick' | 'preview' | 'loading' | 'done';

function parseWhatsApp(text: string): WaContact[] {
  const map = new Map<string, WaContact>();
  const re = /(?:\[\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s[\d:]+\s?(?:AM|PM)?\]|\d{1,2}[./]\d{1,2}[./]\d{2,4},\s[\d:]+)\s[-–]\s(.+?):\s(.+)/;

  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    const phoneMatch = name.match(/\+[\d\s\-()]{7,20}/);
    const phone = phoneMatch?.[0].replace(/\s/g, '');
    const existing = map.get(name);
    if (existing) { existing.message_count++; }
    else { map.set(name, { name, phone, message_count: 1 }); }
  }

  return Array.from(map.values()).sort((a, b) => b.message_count - a.message_count);
}

export default function WhatsAppImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [phase, setPhase] = useState<Phase>('pick');
  const [contacts, setContacts] = useState<WaContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState(0);
  const [error, setError] = useState('');

  const pickFile = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/plain', '*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const parsed = parseWhatsApp(content);
      if (parsed.length === 0) { setError('Собеседники не найдены — проверьте файл'); return; }
      setContacts(parsed);
      setSelected(new Set(parsed.map((c) => c.name)));
      setPhase('preview');
    } catch { setError('Не удалось прочитать файл'); }
  };

  const toggle = (name: string) => setSelected((p) => { const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const doImport = async () => {
    const toImport = contacts.filter((c) => selected.has(c.name));
    if (!toImport.length) return;
    setPhase('loading');
    try {
      const res = await fetch(`${API_URL}/import/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
        body: JSON.stringify({ contacts: toImport }),
      });
      const json = await res.json() as { data?: { imported: number }; error?: { message: string } };
      if (!res.ok) { setError(json.error?.message ?? 'Ошибка'); setPhase('preview'); return; }
      setImported(json.data!.imported);
      setPhase('done');
    } catch { setError('Нет соединения'); setPhase('preview'); }
  };

  if (phase === 'loading') {
    return <View style={styles.center}><ActivityIndicator size="large" color="#25D366" /></View>;
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={[styles.doneEmoji, { color: '#25D366' }]}>✓</Text>
        <Text style={styles.doneTitle}>{imported} контактов добавлено</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#25D366' }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'pick') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>WhatsApp</Text>
        <Text style={styles.sub}>{'Чат → ⋮ → Ещё → Экспорт чата → Без медиа\nСохраните .txt и выберите его ниже'}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#25D366', flexDirection: 'row', gap: 8 }]} onPress={() => void pickFile()}>
          <Upload size={18} color="#fff" strokeWidth={2.5} />
          <Text style={styles.btnText}>Выбрать файл</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // preview
  const selCount = selected.size;
  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        <Text style={styles.barTitle}>{contacts.length} собеседников</Text>
        <TouchableOpacity onPress={() => setSelected(selCount === contacts.length ? new Set() : new Set(contacts.map((c) => c.name)))}>
          <Text style={styles.selAll}>{selCount === contacts.length ? 'Снять всё' : 'Выбрать всё'}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(c) => c.name}
        renderItem={({ item }: ListRenderItemInfo<WaContact>) => {
          const on = selected.has(item.name);
          return (
            <TouchableOpacity style={[styles.row, on && styles.rowOn]} onPress={() => toggle(item.name)}>
              <View style={[styles.check, on && styles.checkOn]}>{on && <Text style={styles.checkMark}>✓</Text>}</View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                {item.phone && <Text style={styles.rowSub}>{item.phone}</Text>}
              </View>
              <Text style={styles.count}>{item.message_count} сообщ.</Text>
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      />

      {error ? <Text style={[styles.error, { textAlign: 'center', padding: 8 }]}>{error}</Text> : null}

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#25D366', flex: 1 }, !selCount && styles.btnOff]}
          onPress={() => void doImport()} disabled={!selCount}>
          <Text style={styles.btnText}>Импортировать ({selCount})</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#FAF6F3', gap: 14 },
  title: { fontSize: 26, fontWeight: '800', color: '#383432' },
  sub: { fontSize: 14, color: '#B07868', lineHeight: 21, textAlign: 'center' },
  btn: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  btnOff: { opacity: 0.45 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#ef4444', fontSize: 13 },
  doneEmoji: { fontSize: 52, fontWeight: '700' },
  doneTitle: { fontSize: 20, fontWeight: '800', color: '#383432' },
  bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F5EDE8' },
  barTitle: { fontSize: 14, fontWeight: '600', color: '#383432' },
  selAll: { fontSize: 13, color: '#25D366', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: '#F5EDE8' },
  rowOn: { borderColor: '#25D366' },
  check: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#25D366', alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: '#25D366' },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowName: { fontSize: 15, fontWeight: '600', color: '#383432' },
  rowSub: { fontSize: 12, color: '#B07868', marginTop: 2 },
  count: { fontSize: 11, color: '#CFADA3' },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: 32, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#F5EDE8' },
});
