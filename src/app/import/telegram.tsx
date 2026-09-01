import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CheckCircle2 } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, type, spacing, radius, control, tabular } from '../../theme';
import { Button } from '../../components/ui';

type Phase = 'phone' | 'code' | 'loading' | 'done';

const TELEGRAM_BLUE = '#2AABEE'; // brand color: Telegram

export default function TelegramImportScreen() {
  const router = useRouter();
  const token = useUserStore((s) => s.token);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
        <ActivityIndicator size="large" color={TELEGRAM_BLUE} />
      </View>
    );
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <CheckCircle2 size={52} color={TELEGRAM_BLUE} strokeWidth={2} />
        <Text style={[styles.doneTitle, tabular]}>Импортировано {imported} контактов</Text>
        <Button
          title="Перейти к контактам"
          onPress={() => router.push('/(tabs)/contacts' as never)}
          style={{ backgroundColor: TELEGRAM_BLUE }}
        />
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
            placeholderTextColor={colors.placeholder}
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
            placeholderTextColor={colors.placeholder}
            keyboardType="number-pad"
            maxLength={8}
            autoFocus
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Button
          title={phase === 'phone' ? 'Получить код' : 'Импортировать'}
          onPress={phase === 'phone' ? () => void sendCode() : () => void verify()}
          style={{ backgroundColor: TELEGRAM_BLUE, marginBottom: spacing.md }}
        />

        {phase === 'code' && (
          <TouchableOpacity
            style={styles.back}
            onPress={() => { setPhase('phone'); setCode(''); setError(''); }}
            activeOpacity={0.7}
          >
            <Text style={styles.backText}>← Изменить номер</Text>
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { flex: 1, padding: spacing.xl, justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, gap: spacing.lg },
  title: { ...type.display, color: c.text1, marginBottom: spacing.xs },
  sub: { ...type.body, color: c.amber, marginBottom: spacing.xl },
  input: {
    height: control.md, borderWidth: 1, borderColor: c.inputBorder, borderRadius: radius.lg,
    backgroundColor: c.surface, paddingHorizontal: spacing.lg, fontSize: 16, color: c.text1, marginBottom: spacing.md,
  },
  codeInput: { ...type.display, textAlign: 'center', letterSpacing: 10 },
  back: { alignItems: 'center', paddingVertical: spacing.sm },
  backText: { color: c.amber, fontSize: 14 },
  error: { color: c.danger, fontSize: 13, marginBottom: spacing.sm, textAlign: 'center' },
  doneTitle: { ...type.title, color: c.text1 },
});
