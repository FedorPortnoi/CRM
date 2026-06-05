import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, FlatList, ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Upload, CheckCircle } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

interface VContact {
  first_name: string;
  last_name?: string;
  phone?: string;
  email?: string;
  company?: string;
}

type Phase = 'pick' | 'preview' | 'importing' | 'done';

function getVCardField(block: string, field: string): string | undefined {
  const re = new RegExp(`^${field}[^:]*:(.+)$`, 'im');
  return block.match(re)?.[1]?.trim() || undefined;
}

function parseVCards(text: string): VContact[] {
  const blocks = text.split(/BEGIN:VCARD/i).slice(1);
  const contacts: VContact[] = [];

  for (const block of blocks) {
    const fn = getVCardField(block, 'FN');
    const n = getVCardField(block, 'N');
    const tel = getVCardField(block, 'TEL');
    const email = getVCardField(block, 'EMAIL');
    const org = getVCardField(block, 'ORG');

    let first = '', last = '';

    if (fn) {
      const parts = fn.split(' ');
      first = parts[0] ?? '';
      last = parts.slice(1).join(' ') || '';
    } else if (n) {
      // N field: Last;First;Middle;Prefix;Suffix
      const nParts = n.split(';');
      last = nParts[0]?.trim() ?? '';
      first = nParts[1]?.trim() ?? '';
    }

    if (!first && !tel) continue;

    contacts.push({
      first_name: first || 'Контакт',
      last_name: last || undefined,
      phone: tel?.replace(/\s/g, '') || undefined,
      email: email || undefined,
      company: org || undefined,
    });
  }

  return contacts;
}

export default function VCardImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [phase, setPhase] = useState<Phase>('pick');
  const [contacts, setContacts] = useState<VContact[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState('');

  const pickFile = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/vcard', 'text/x-vcard', '*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;

      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const parsed = parseVCards(content);

      if (parsed.length === 0) { setError('Контакты не найдены. Убедитесь, что это файл .vcf'); return; }

      setContacts(parsed);
      setSelected(new Set(parsed.map((_, i) => i)));
      setPhase('preview');
    } catch { setError('Не удалось прочитать файл'); }
  };

  const toggle = (i: number) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; });
  };

  const importSelected = async () => {
    const toImport = contacts.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;
    setPhase('importing');

    try {
      const res = await fetch(`${API_URL}/import/vcard`, {
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
        <ActivityIndicator size="large" color="#8B5CF6" />
        <Text style={styles.loadingText}>Импортируем контакты...</Text>
      </View>
    );
  }

  if (phase === 'done' && result) {
    return (
      <View style={styles.center}>
        <CheckCircle size={52} color="#8B5CF6" strokeWidth={1.5} />
        <Text style={styles.doneTitle}>Готово!</Text>
        <Text style={styles.doneSub}>Добавлено {result.imported} контактов</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#8B5CF6' }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'pick') {
    return (
      <View style={styles.center}>
        <View style={[styles.iconCircle, { backgroundColor: '#8B5CF6' }]}>
          <Upload size={30} color="#fff" strokeWidth={2} />
        </View>
        <Text style={styles.title}>Импорт vCard</Text>
        <Text style={styles.sub}>
          Файл .vcf содержит контакты из iPhone, Google, Outlook, Telegram и других приложений
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#8B5CF6' }]} onPress={() => void pickFile()}>
          <Text style={styles.btnText}>Выбрать .vcf файл</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const selCount = selected.size;
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Найдено {contacts.length} контактов</Text>
        <TouchableOpacity onPress={() => {
          if (selCount === contacts.length) setSelected(new Set());
          else setSelected(new Set(contacts.map((_, i) => i)));
        }}>
          <Text style={styles.selAll}>{selCount === contacts.length ? 'Снять всё' : 'Выбрать всё'}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item, index }: ListRenderItemInfo<VContact>) => {
          const isSelected = selected.has(index);
          const name = [item.first_name, item.last_name].filter(Boolean).join(' ');
          return (
            <TouchableOpacity style={[styles.row, isSelected && styles.rowSelected]} onPress={() => toggle(index)}>
              <View style={[styles.check, isSelected && styles.checkSelected]}>
                {isSelected && <Text style={styles.checkMark}>✓</Text>}
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowName}>{name}</Text>
                <Text style={styles.rowSub}>{[item.phone, item.email, item.company].filter(Boolean).join(' · ')}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      />

      <View style={styles.bar}>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: '#8B5CF6', flex: 1 }, selCount === 0 && styles.btnDisabled]}
          onPress={() => void importSelected()} disabled={selCount === 0}
        >
          <Text style={styles.btnText}>Импортировать ({selCount})</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#FAF6F3', gap: 14 },
  iconCircle: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: '#383432', textAlign: 'center' },
  sub: { fontSize: 14, color: '#B07868', textAlign: 'center', lineHeight: 20 },
  btn: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#ef4444', fontSize: 13, textAlign: 'center' },
  loadingText: { marginTop: 16, fontSize: 16, fontWeight: '600', color: '#383432' },
  doneTitle: { fontSize: 24, fontWeight: '800', color: '#383432' },
  doneSub: { fontSize: 15, color: '#B07868' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F5EDE8' },
  headerTitle: { fontSize: 14, fontWeight: '600', color: '#383432' },
  selAll: { fontSize: 13, color: '#8B5CF6', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: '#F5EDE8' },
  rowSelected: { borderColor: '#8B5CF6', backgroundColor: '#F5F3FF' },
  check: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#8B5CF6', alignItems: 'center', justifyContent: 'center' },
  checkSelected: { backgroundColor: '#8B5CF6' },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600', color: '#383432' },
  rowSub: { fontSize: 12, color: '#B07868', marginTop: 2 },
  bar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#F5EDE8', paddingBottom: 32 },
});
