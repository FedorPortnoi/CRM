import { useState } from 'react';
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

interface VContact { first_name: string; last_name?: string; phone?: string; email?: string; company?: string }
type Phase = 'pick' | 'preview' | 'loading' | 'done';

function parseVCards(text: string): VContact[] {
  return text.split(/BEGIN:VCARD/i).slice(1).map((block) => {
    const get = (f: string) => block.match(new RegExp(`^${f}[^:]*:(.+)$`, 'im'))?.[1]?.trim();
    const fn = get('FN'); const n = get('N');
    let first = '', last = '';
    if (fn) { const p = fn.split(' '); first = p[0]; last = p.slice(1).join(' '); }
    else if (n) { const p = n.split(';'); last = p[0]?.trim(); first = p[1]?.trim(); }
    return { first_name: first || 'Контакт', last_name: last || undefined, phone: get('TEL')?.replace(/\s/g, ''), email: get('EMAIL'), company: get('ORG') };
  }).filter((c) => c.first_name !== 'Контакт' || c.phone);
}

export default function VCardImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [phase, setPhase] = useState<Phase>('pick');
  const [contacts, setContacts] = useState<VContact[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [imported, setImported] = useState(0);
  const [error, setError] = useState('');

  const pickFile = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/vcard', 'text/x-vcard', '*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const parsed = parseVCards(content);
      if (!parsed.length) { setError('Контакты не найдены — нужен файл .vcf'); return; }
      setContacts(parsed);
      setSelected(new Set(parsed.map((_, i) => i)));
      setPhase('preview');
    } catch { setError('Не удалось прочитать файл'); }
  };

  const toggle = (i: number) => setSelected((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const doImport = async () => {
    const toImport = contacts.filter((_, i) => selected.has(i));
    if (!toImport.length) return;
    setPhase('loading');
    try {
      const res = await fetch(`${API_URL}/import/vcard`, {
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
    return <View style={styles.center}><ActivityIndicator size="large" color="#8B5CF6" /></View>;
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={[styles.doneEmoji, { color: '#8B5CF6' }]}>✓</Text>
        <Text style={styles.doneTitle}>{imported} контактов добавлено</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#8B5CF6' }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'pick') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Файл контактов</Text>
        <Text style={styles.sub}>Файл .vcf из iPhone, Google, Outlook или любого другого приложения</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#8B5CF6', flexDirection: 'row', gap: 8 }]} onPress={() => void pickFile()}>
          <Upload size={18} color="#fff" strokeWidth={2.5} />
          <Text style={styles.btnText}>Выбрать .vcf файл</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const selCount = selected.size;
  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        <Text style={styles.barTitle}>{contacts.length} контактов</Text>
        <TouchableOpacity onPress={() => setSelected(selCount === contacts.length ? new Set() : new Set(contacts.map((_, i) => i)))}>
          <Text style={[styles.selAll, { color: '#8B5CF6' }]}>{selCount === contacts.length ? 'Снять всё' : 'Выбрать всё'}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item, index }: ListRenderItemInfo<VContact>) => {
          const on = selected.has(index);
          const name = [item.first_name, item.last_name].filter(Boolean).join(' ');
          return (
            <TouchableOpacity style={[styles.row, on && styles.rowOn]} onPress={() => toggle(index)}>
              <View style={[styles.check, on && { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' }]}>
                {on && <Text style={styles.checkMark}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{name}</Text>
                <Text style={styles.rowSub}>{[item.phone, item.email, item.company].filter(Boolean).join(' · ')}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      />

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#8B5CF6', flex: 1 }, !selCount && styles.btnOff]}
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
  sub: { fontSize: 14, color: '#B07868', lineHeight: 20, textAlign: 'center' },
  btn: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  btnOff: { opacity: 0.45 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#ef4444', fontSize: 13 },
  doneEmoji: { fontSize: 52, fontWeight: '700' },
  doneTitle: { fontSize: 20, fontWeight: '800', color: '#383432' },
  bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F5EDE8' },
  barTitle: { fontSize: 14, fontWeight: '600', color: '#383432' },
  selAll: { fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: '#F5EDE8' },
  rowOn: { borderColor: '#8B5CF6' },
  check: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#8B5CF6', alignItems: 'center', justifyContent: 'center' },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowName: { fontSize: 15, fontWeight: '600', color: '#383432' },
  rowSub: { fontSize: 12, color: '#B07868', marginTop: 2 },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: 32, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#F5EDE8' },
});
