import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Link, CheckCircle } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type Phase = 'input' | 'loading' | 'done';

interface ImportResult {
  contacts_imported: number;
  contacts_failed: number;
  deals_imported: number;
  deals_failed: number;
  total_contacts: number;
}

export default function Bitrix24ImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [includeDeals, setIncludeDeals] = useState(true);
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async () => {
    const url = webhookUrl.trim();
    if (!url) { setError('Вставьте ссылку вебхука'); return; }
    if (!url.includes('bitrix24')) { setError('Ссылка должна содержать bitrix24.ru'); return; }
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
        <ActivityIndicator size="large" color="#FF5752" />
        <Text style={styles.loadingTitle}>Импортируем из Битрикс24</Text>
        <Text style={styles.loadingSub}>Это может занять минуту — не закрывайте экран</Text>
      </View>
    );
  }

  if (phase === 'done' && result) {
    return (
      <View style={styles.center}>
        <View style={styles.successIcon}>
          <CheckCircle size={44} color="#FF5752" strokeWidth={1.5} />
        </View>
        <Text style={styles.doneTitle}>Импорт завершён!</Text>
        <View style={styles.statsBox}>
          <Stat label="Контактов импортировано" value={result.contacts_imported} />
          {result.contacts_failed > 0 && <Stat label="Ошибок контактов" value={result.contacts_failed} warn />}
          {includeDeals && <Stat label="Сделок импортировано" value={result.deals_imported} />}
          {includeDeals && result.deals_failed > 0 && <Stat label="Ошибок сделок" value={result.deals_failed} warn />}
        </View>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#FF5752' }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.iconHeader}>
        <View style={[styles.iconCircle, { backgroundColor: '#FF5752' }]}>
          <Link size={28} color="#fff" strokeWidth={2} />
        </View>
        <Text style={styles.title}>Импорт из Битрикс24</Text>
        <Text style={styles.sub}>
          Откройте Битрикс24 → Настройки → Интеграция → Входящий вебхук → скопируйте ссылку
        </Text>
      </View>

      <Text style={styles.label}>Ссылка вебхука</Text>
      <TextInput
        style={styles.input}
        value={webhookUrl}
        onChangeText={setWebhookUrl}
        placeholder="https://ваш-домен.bitrix24.ru/rest/1/ключ/"
        placeholderTextColor="#CFADA3"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.switchRow}>
        <View>
          <Text style={styles.switchLabel}>Импортировать сделки</Text>
          <Text style={styles.switchSub}>Сделки попадут в воронку по умолчанию</Text>
        </View>
        <Switch value={includeDeals} onValueChange={setIncludeDeals} thumbColor="#fff" trackColor={{ true: '#FF5752', false: '#E8DDD6' }} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={[styles.btn, { backgroundColor: '#FF5752' }]} onPress={() => void run()}>
        <Text style={styles.btnText}>Начать импорт</Text>
      </TouchableOpacity>

      <View style={styles.hint}>
        <Text style={styles.hintText}>
          Как найти вебхук: Битрикс24 → Приложения → Вебхуки → Добавить входящий вебхук → выберите права на CRM → скопируйте ссылку
        </Text>
      </View>
    </ScrollView>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, warn && styles.statWarn]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  content: { padding: 24, paddingTop: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#FAF6F3' },
  iconHeader: { alignItems: 'center', marginBottom: 28 },
  iconCircle: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '800', color: '#383432', marginBottom: 8, textAlign: 'center' },
  sub: { fontSize: 13, color: '#B07868', textAlign: 'center', lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '600', color: '#6B5B55', marginBottom: 6 },
  input: {
    height: 52, borderWidth: 1, borderColor: '#E8DDD6', borderRadius: 12,
    backgroundColor: '#fff', paddingHorizontal: 16, fontSize: 14, color: '#383432', marginBottom: 16,
  },
  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 20,
    borderWidth: 1, borderColor: '#F5EDE8',
  },
  switchLabel: { fontSize: 15, fontWeight: '600', color: '#383432', marginBottom: 2 },
  switchSub: { fontSize: 12, color: '#B07868' },
  btn: {
    height: 52, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  hint: { backgroundColor: '#FFF8F5', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: '#F5EDE8' },
  hintText: { fontSize: 12, color: '#B07868', lineHeight: 18 },
  successIcon: { width: 88, height: 88, borderRadius: 22, backgroundColor: '#FFF1F0', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  doneTitle: { fontSize: 24, fontWeight: '800', color: '#383432', marginBottom: 20 },
  statsBox: { width: '100%', backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 28, borderWidth: 1, borderColor: '#F5EDE8' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#FAF6F3' },
  statLabel: { fontSize: 14, color: '#6B5B55' },
  statValue: { fontSize: 15, fontWeight: '700', color: '#383432' },
  statWarn: { color: '#ef4444' },
  loadingTitle: { marginTop: 20, fontSize: 17, fontWeight: '700', color: '#383432' },
  loadingSub: { marginTop: 8, fontSize: 13, color: '#B07868', textAlign: 'center' },
});
