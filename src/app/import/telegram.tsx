import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Phone, Shield } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type Phase = 'phone' | 'code' | 'importing' | 'done';

export default function TelegramImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ imported: number; total: number } | null>(null);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` };

  const sendCode = async () => {
    if (!phone.trim()) { setError('Введите номер телефона'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/import/telegram/send-code`, {
        method: 'POST', headers, body: JSON.stringify({ phone: phone.trim() }),
      });
      const json = await res.json() as { data?: { phoneCodeHash: string }; error?: { message: string } };
      if (!res.ok) { setError(json.error?.message ?? 'Ошибка'); return; }
      setPhoneCodeHash(json.data!.phoneCodeHash);
      setPhase('code');
    } catch { setError('Нет соединения'); } finally { setLoading(false); }
  };

  const verify = async () => {
    if (!code.trim()) { setError('Введите код'); return; }
    setLoading(true); setError(''); setPhase('importing');
    try {
      const res = await fetch(`${API_URL}/import/telegram/verify`, {
        method: 'POST', headers,
        body: JSON.stringify({ phone: phone.trim(), code: code.trim(), phoneCodeHash }),
      });
      const json = await res.json() as { data?: { imported: number; total: number }; error?: { message: string } };
      if (!res.ok) {
        setError(json.error?.message ?? 'Неверный код');
        setPhase('code');
        return;
      }
      setResult(json.data!);
      setPhase('done');
    } catch { setError('Нет соединения'); setPhase('code'); } finally { setLoading(false); }
  };

  if (phase === 'importing') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2AABEE" />
        <Text style={styles.loadingText}>Импортируем контакты из Telegram...</Text>
      </View>
    );
  }

  if (phase === 'done' && result) {
    return (
      <View style={styles.center}>
        <View style={styles.successIcon}>
          <Shield size={40} color="#2AABEE" strokeWidth={1.5} />
        </View>
        <Text style={styles.doneTitle}>Готово!</Text>
        <Text style={styles.doneSub}>
          Импортировано {result.imported} из {result.total} контактов
        </Text>
        <TouchableOpacity style={styles.btn} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.iconHeader}>
          <View style={[styles.iconCircle, { backgroundColor: '#2AABEE' }]}>
            <Phone size={28} color="#fff" strokeWidth={2} />
          </View>
          <Text style={styles.title}>Импорт из Telegram</Text>
          <Text style={styles.sub}>
            {phase === 'phone'
              ? 'Введите номер телефона, привязанный к Telegram. Вы получите код подтверждения.'
              : `Код отправлен на ${phone}. Проверьте Telegram или SMS.`}
          </Text>
        </View>

        {phase === 'phone' && (
          <>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="+7 999 123 45 67"
              placeholderTextColor="#CFADA3"
              keyboardType="phone-pad"
              autoFocus
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <TouchableOpacity style={styles.btn} onPress={() => void sendCode()} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Получить код</Text>}
            </TouchableOpacity>
          </>
        )}

        {phase === 'code' && (
          <>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              placeholder="12345"
              placeholderTextColor="#CFADA3"
              keyboardType="number-pad"
              maxLength={8}
              autoFocus
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <TouchableOpacity style={styles.btn} onPress={() => void verify()} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Импортировать контакты</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkBtn} onPress={() => { setPhase('phone'); setCode(''); setError(''); }}>
              <Text style={styles.linkBtnText}>← Изменить номер</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={styles.notice}>
          <Shield size={14} color="#CFADA3" />
          <Text style={styles.noticeText}>
            Мы используем официальный Telegram API. Пароль и переписка не передаются.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  content: { padding: 24, paddingTop: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#FAF6F3' },
  iconHeader: { alignItems: 'center', marginBottom: 32 },
  iconCircle: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '800', color: '#383432', marginBottom: 8, textAlign: 'center' },
  sub: { fontSize: 14, color: '#B07868', textAlign: 'center', lineHeight: 20 },
  input: {
    height: 52, borderWidth: 1, borderColor: '#E8DDD6', borderRadius: 12,
    backgroundColor: '#fff', paddingHorizontal: 16, fontSize: 16, color: '#383432', marginBottom: 12,
  },
  codeInput: { fontSize: 28, fontWeight: '700', textAlign: 'center', letterSpacing: 8 },
  btn: {
    height: 52, backgroundColor: '#2AABEE', borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  linkBtn: { alignItems: 'center', paddingVertical: 12 },
  linkBtnText: { color: '#B07868', fontSize: 14 },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 8, textAlign: 'center' },
  notice: { flexDirection: 'row', gap: 8, marginTop: 24, alignItems: 'flex-start' },
  noticeText: { flex: 1, fontSize: 12, color: '#CFADA3', lineHeight: 16 },
  loadingText: { marginTop: 16, fontSize: 16, color: '#383432', fontWeight: '600' },
  successIcon: { width: 80, height: 80, borderRadius: 20, backgroundColor: '#EBF8FF', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  doneTitle: { fontSize: 24, fontWeight: '800', color: '#383432', marginBottom: 8 },
  doneSub: { fontSize: 15, color: '#B07868', marginBottom: 32, textAlign: 'center' },
});
