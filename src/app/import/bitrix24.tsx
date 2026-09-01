import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, StyleSheet,
  ActivityIndicator, ScrollView, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CheckCircle2 } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, type, spacing, radius, control, tabular } from '../../theme';
import { Card, Button } from '../../components/ui';

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
        <CheckCircle2 size={52} color={colors.danger} strokeWidth={2} />
        <Text style={[styles.doneTitle, tabular]}>{result.contacts_imported} контактов</Text>
        {result.deals_imported > 0 && <Text style={[styles.doneSub, tabular]}>{result.deals_imported} сделок</Text>}
        <Button
          title="Перейти к контактам"
          onPress={() => router.push('/(tabs)/contacts' as never)}
          variant="danger"
        />
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

      <Card style={styles.switchRow} padded={false}>
        <Text style={styles.switchLabel}>Импортировать сделки</Text>
        <Switch
          value={includeDeals}
          onValueChange={setIncludeDeals}
          thumbColor={colors.onAccent}
          trackColor={{ true: colors.danger, false: colors.border }}
        />
      </Card>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Button title="Начать импорт" onPress={() => void run()} variant="danger" block />
    </ScrollView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { padding: spacing.xl, paddingTop: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, gap: spacing.md },
  title: { ...type.display, color: c.text1, marginBottom: spacing.xs },
  sub: { ...type.label, color: c.amber, marginBottom: spacing.xl },
  input: {
    height: control.md, borderWidth: 1, borderColor: c.inputBorder, borderRadius: radius.lg,
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, fontSize: 14, color: c.text1, marginBottom: spacing.lg,
  },
  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: spacing.lg, marginBottom: spacing.xl,
  },
  switchLabel: { ...type.body, color: c.text1 },
  error: { color: c.danger, fontSize: 13, marginBottom: spacing.md, textAlign: 'center' },
  loadingText: { ...type.body, color: c.text1 },
  doneTitle: { ...type.title, color: c.text1 },
  doneSub: { ...type.body, color: c.amber },
});
