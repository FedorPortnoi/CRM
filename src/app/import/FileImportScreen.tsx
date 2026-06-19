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

// ─── Config contract ─────────────────────────────────────────────────────────

export interface FileImportConfig<T> {
  // MIME types passed to DocumentPicker (e.g. ['text/vcard', '*\/*'])
  mimeTypes: string[];
  /** Accent color used for buttons, checkboxes, and the done state */
  accentColor: string;
  /** Parse the raw file string into an array of items */
  parse: (content: string) => T[];
  /** API path segment after API_URL (e.g. '/import/vcard') */
  endpoint: string;
  /**
   * Derive a stable string key from an item and its index.
   * Used for the selection Set and as the FlatList keyExtractor.
   */
  getKey: (item: T, index: number) => string;
  /**
   * Render the inner content of a row (everything right of the checkbox).
   * The surrounding TouchableOpacity + checkbox shell is handled by the component.
   */
  renderItem: (item: T, selected: boolean) => React.ReactNode;
  /** Title shown on the pick phase (e.g. "Файл контактов") */
  pickTitle: string;
  /** Subtitle shown on the pick phase */
  pickInstructions?: string;
  /** Button label on the pick phase (e.g. "Выбрать .vcf файл") */
  pickButtonLabel?: string;
  /** Error message when parse() returns an empty array */
  emptyError?: string;
  /** Label in the preview bar: "{count} {barUnit}" */
  barUnit?: string;
}

// ─── Phase type ──────────────────────────────────────────────────────────────

type Phase = 'pick' | 'preview' | 'loading' | 'done';

// ─── Component ───────────────────────────────────────────────────────────────

export default function FileImportScreen<T>({
  mimeTypes,
  accentColor,
  parse,
  endpoint,
  getKey,
  renderItem,
  pickTitle,
  pickInstructions,
  pickButtonLabel = 'Выбрать файл',
  emptyError = 'Контакты не найдены — проверьте файл',
  barUnit = 'контактов',
}: FileImportConfig<T>) {
  const router = useRouter();
  const token = useUserStore((s) => s.token);

  const [phase, setPhase] = useState<Phase>('pick');
  const [items, setItems] = useState<T[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState(0);
  const [error, setError] = useState('');

  // ── File pick ───────────────────────────────────────────────────────────────

  const pickFile = async () => {
    setError('');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: mimeTypes,
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const parsed = parse(content);
      if (!parsed.length) { setError(emptyError); return; }
      setItems(parsed);
      setSelected(new Set(parsed.map((item, i) => getKey(item, i))));
      setPhase('preview');
    } catch {
      setError('Не удалось прочитать файл');
    }
  };

  // ── Selection ───────────────────────────────────────────────────────────────

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleAll = () =>
    setSelected(
      selected.size === items.length
        ? new Set()
        : new Set(items.map((item, i) => getKey(item, i))),
    );

  // ── Import ──────────────────────────────────────────────────────────────────

  const doImport = async () => {
    const toImport = items.filter((item, i) => selected.has(getKey(item, i)));
    if (!toImport.length) return;
    setPhase('loading');
    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token ?? ''}`,
        },
        body: JSON.stringify({ contacts: toImport }),
      });
      const json = await res.json() as { data?: { imported: number }; error?: { message: string } };
      if (!res.ok) {
        setError(json.error?.message ?? 'Ошибка');
        setPhase('preview');
        return;
      }
      setImported(json.data!.imported);
      setPhase('done');
    } catch {
      setError('Нет соединения');
      setPhase('preview');
    }
  };

  // ── Loading ─────────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={accentColor} />
      </View>
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────────

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={[styles.doneEmoji, { color: accentColor }]}>✓</Text>
        <Text style={styles.doneTitle}>{imported} контактов добавлено</Text>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: accentColor }]}
          onPress={() => router.push('/(tabs)/contacts' as never)}
        >
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Pick ────────────────────────────────────────────────────────────────────

  if (phase === 'pick') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{pickTitle}</Text>
        {pickInstructions ? (
          <Text style={styles.sub}>{pickInstructions}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: accentColor, flexDirection: 'row', gap: 8 }]}
          onPress={() => void pickFile()}
        >
          <Upload size={18} color="#fff" strokeWidth={2.5} />
          <Text style={styles.btnText}>{pickButtonLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Preview ─────────────────────────────────────────────────────────────────

  const selCount = selected.size;

  return (
    <View style={styles.container}>
      {/* Bar */}
      <View style={styles.bar}>
        <Text style={styles.barTitle}>{items.length} {barUnit}</Text>
        <TouchableOpacity onPress={toggleAll}>
          <Text style={[styles.selAll, { color: accentColor }]}>
            {selCount === items.length ? 'Снять всё' : 'Выбрать всё'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* List */}
      <FlatList
        data={items}
        keyExtractor={(item, index) => getKey(item, index)}
        renderItem={({ item, index }: ListRenderItemInfo<T>) => {
          const key = getKey(item, index);
          const on = selected.has(key);
          return (
            <TouchableOpacity
              style={[styles.row, on && { borderColor: accentColor }]}
              onPress={() => toggle(key)}
            >
              <View
                style={[
                  styles.check,
                  { borderColor: accentColor },
                  on && { backgroundColor: accentColor },
                ]}
              >
                {on && <Text style={styles.checkMark}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                {renderItem(item, on)}
              </View>
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
      />

      {/* Preview-phase error (shown below list, above footer — mirrors whatsapp.tsx) */}
      {error ? (
        <Text style={[styles.error, { textAlign: 'center', padding: 8 }]}>{error}</Text>
      ) : null}

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: accentColor, flex: 1 },
            !selCount && styles.btnOff,
          ]}
          onPress={() => void doImport()}
          disabled={!selCount}
        >
          <Text style={styles.btnText}>Импортировать ({selCount})</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#FAF6F3' },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#FAF6F3', gap: 14 },
  title:      { fontSize: 26, fontWeight: '800', color: '#383432' },
  sub:        { fontSize: 14, color: '#B07868', lineHeight: 21, textAlign: 'center' },
  btn:        { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  btnOff:     { opacity: 0.45 },
  btnText:    { color: '#fff', fontSize: 16, fontWeight: '700' },
  error:      { color: '#ef4444', fontSize: 13 },
  doneEmoji:  { fontSize: 52, fontWeight: '700' },
  doneTitle:  { fontSize: 20, fontWeight: '800', color: '#383432' },
  bar:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F5EDE8' },
  barTitle:   { fontSize: 14, fontWeight: '600', color: '#383432' },
  selAll:     { fontSize: 13, fontWeight: '600' },
  row:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: '#F5EDE8' },
  check:      { width: 22, height: 22, borderRadius: 4, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkMark:  { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowName:    { fontSize: 15, fontWeight: '600', color: '#383432' },
  rowSub:     { fontSize: 12, color: '#B07868', marginTop: 2 },
  footer:     { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: 32, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#F5EDE8' },
});

// ─── Re-export row text styles so callers can match the design system ─────────
//     Usage: import { rowStyles } from './FileImportScreen';
export const rowStyles = {
  rowName: styles.rowName,
  rowSub:  styles.rowSub,
};
