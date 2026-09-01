import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

type Phase = 'input' | 'loading' | 'done';

interface ImportResult {
  contacts_imported: number;
  deals_imported: number;
}

export default function Bitrix24ImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [includeDeals, setIncludeDeals] = useState(true);
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async () => {
    const url = webhookUrl.trim();
    if (!url) { setError('Вставьте ссылку вебхука'); return; }
    setError(''); setPhase('loading');
    try {
      const res = await fetch(`${API_URL}/import/bitrix24`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
        body: JSON.stringify({ webhook_url: url, include_deals: includeDeals }),
      });
      const json = await res.json() as { data?: ImportResult; error?: { message: string } };
      if (!res.ok) { setError(json.error?.message ?? 'Ошибка'); setPhase('input'); return; }
      setResult(json.data!);
      setPhase('done');
    } catch { setError('Нет соединения'); setPhase('input'); }
  };

  if (phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.danger} />
        <Text style={styles.loadingText}>Импортируем из Битрикс24...</Text>
      </View>
    );
  }

  if (phase === 'done' && result) {
    return (
      <View style={styles.center}>
        <Text style={[styles.doneEmoji, { color: colors.danger }]}>✓</Text>
        <Text style={styles.doneTitle}>{result.contacts_imported} контактов</Text>
        {result.deals_imported > 0 && <Text style={styles.doneSub}>{result.deals_imported} сделок</Text>}
        <TouchableOpacity style={[styles.btn, { backgroundColor: colors.danger }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Вебхук Битрикс24</Text>
      <Text style={styles.sub}>Битрикс24 → Приложения → Вебхуки → Входящий вебхук → скопируйте ссылку</Text>

      <TextInput
        style={styles.input}
        value={webhookUrl}
        onChangeText={setWebhookUrl}
        placeholder="https://домен.bitrix24.ru/rest/1/ключ/"
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Импортировать сделки</Text>
        <Switch
          value={includeDeals}
          onValueChange={setIncludeDeals}
          thumbColor={colors.onAccent}
          trackColor={{ true: colors.danger, false: colors.border }}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={[styles.btn, { backgroundColor: colors.danger }]} onPress={() => void run()}>
        <Text style={styles.btnText}>Начать импорт</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { padding: 24, paddingTop: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, gap: 12 },
  title: { fontSize: 24, fontWeight: '800', color: c.text1, marginBottom: 6 },
  sub: { fontSize: 13, color: c.amber, marginBottom: 24, lineHeight: 18 },
  input: {
    height: 54, borderWidth: 1, borderColor: c.inputBorder, borderRadius: 12,
    backgroundColor: c.surface, paddingHorizontal: 16, fontSize: 14, color: c.text1, marginBottom: 16,
  },
  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 20,
    borderWidth: 1, borderColor: c.borderStrong,
  },
  switchLabel: { fontSize: 15, color: c.text1, fontWeight: '500' },
  btn: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: c.onAccent, fontSize: 16, fontWeight: '700' },
  error: { color: c.danger, fontSize: 13, marginBottom: 12, textAlign: 'center' },
  loadingText: { fontSize: 15, color: c.text1, fontWeight: '600' },
  doneEmoji: { fontSize: 52, fontWeight: '700' },
  doneTitle: { fontSize: 22, fontWeight: '800', color: c.text1 },
  doneSub: { fontSize: 15, color: c.amber },
});
