import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type Phase = 'phone' | 'code' | 'loading' | 'done';

export default function TelegramImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [error, setError] = useState('');
  const [imported, setImported] = useState(0);

  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` };

  const sendCode = async () => {
    if (!phone.trim()) { setError('Введите номер телефона'); return; }
    setError('');
    setPhase('loading');
    try {
      const res = await fetch(`${API_URL}/import/telegram/send-code`, {
        method: 'POST', headers: h, body: JSON.stringify({ phone: phone.trim() }),
      });
      const json = await res.json() as { data?: { phoneCodeHash: string }; error?: { message: string } };
      if (!res.ok) { setError(json.error?.message ?? 'Ошибка'); setPhase('phone'); return; }
      setPhoneCodeHash(json.data!.phoneCodeHash);
      setPhase('code');
    } catch { setError('Нет соединения'); setPhase('phone'); }
  };

  const verify = async () => {
    if (!code.trim()) { setError('Введите код'); return; }
    setError('');
    setPhase('loading');
    try {
      const res = await fetch(`${API_URL}/import/telegram/verify`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ phone: phone.trim(), code: code.trim(), phoneCodeHash }),
      });
      const json = await res.json() as { data?: { imported: number }; error?: { message: string } };
      if (!res.ok) { setError(json.error?.message ?? 'Неверный код'); setPhase('code'); return; }
      setImported(json.data!.imported);
      setPhase('done');
    } catch { setError('Нет соединения'); setPhase('code'); }
  };

  if (phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2AABEE" />
      </View>
    );
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={styles.doneEmoji}>✓</Text>
        <Text style={styles.doneTitle}>Импортировано {imported} контактов</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: '#2AABEE' }]} onPress={() => router.push('/(tabs)/contacts' as never)}>
          <Text style={styles.btnText}>Перейти к контактам</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.content}>
        <Text style={styles.title}>
          {phase === 'phone' ? 'Ваш номер Telegram' : 'Код из Telegram'}
        </Text>
        <Text style={styles.sub}>
          {phase === 'phone'
            ? 'Код придёт в приложение Telegram'
            : `Код отправлен на ${phone}`}
        </Text>

        {phase === 'phone' && (
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="+7 999 000 00 00"
            placeholderTextColor="#CFADA3"
            keyboardType="phone-pad"
            autoFocus
          />
        )}

        {phase === 'code' && (
          <TextInput
            style={[styles.input, styles.codeInput]}
            value={code}
            onChangeText={setCode}
            placeholder="·····"
            placeholderTextColor="#CFADA3"
            keyboardType="number-pad"
            maxLength={8}
            autoFocus
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: '#2AABEE' }]}
          onPress={phase === 'phone' ? () => void sendCode() : () => void verify()}
        >
          <Text style={styles.btnText}>
            {phase === 'phone' ? 'Получить код' : 'Импортировать'}
          </Text>
        </TouchableOpacity>

        {phase === 'code' && (
          <TouchableOpacity style={styles.back} onPress={() => { setPhase('phone'); setCode(''); setError(''); }}>
            <Text style={styles.backText}>← Изменить номер</Text>
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  content: { flex: 1, padding: 24, justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FAF6F3', gap: 16 },
  title: { fontSize: 24, fontWeight: '800', color: '#383432', marginBottom: 6 },
  sub: { fontSize: 14, color: '#B07868', marginBottom: 28, lineHeight: 20 },
  input: {
    height: 54, borderWidth: 1, borderColor: '#E8DDD6', borderRadius: 12,
    backgroundColor: '#fff', paddingHorizontal: 16, fontSize: 17, color: '#383432', marginBottom: 12,
  },
  codeInput: { fontSize: 30, fontWeight: '700', textAlign: 'center', letterSpacing: 10 },
  btn: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  back: { alignItems: 'center', paddingVertical: 10 },
  backText: { color: '#B07868', fontSize: 14 },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 10, textAlign: 'center' },
  doneEmoji: { fontSize: 52, color: '#2AABEE', fontWeight: '700' },
  doneTitle: { fontSize: 18, fontWeight: '700', color: '#383432' },
});
