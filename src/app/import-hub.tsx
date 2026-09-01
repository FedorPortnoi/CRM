import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Phone, FileText, Upload, MessageSquare, ChevronRight, Zap } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../theme';

interface Source {
  id: string;
  label: string;
  sub: string;
  icon: React.ReactElement;
  color: string;
  route: string;
  badge?: string;
}

export default function ImportHubScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const SOURCES: Source[] = [
    {
      id: 'telegram',
      label: 'Telegram',
      sub: 'Контакты из Telegram одним нажатием',
      icon: <Zap size={22} color="#fff" strokeWidth={2} />,
      color: '#2AABEE', // brand color
      route: '/import/telegram',
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      sub: 'Импорт из экспорта чата (.txt)',
      icon: <MessageSquare size={22} color="#fff" strokeWidth={2} />,
      color: '#25D366', // brand color
      route: '/import/whatsapp',
    },
    {
      id: 'bitrix24',
      label: 'Битрикс24',
      sub: 'Контакты и сделки через вебхук',
      icon: <Zap size={22} color={colors.onAccent} strokeWidth={2} />,
      color: colors.danger,
      route: '/import/bitrix24',
    },
    {
      id: 'vcard',
      label: 'vCard / Файл контактов',
      sub: 'Файл .vcf из любого приложения',
      icon: <Upload size={22} color="#fff" strokeWidth={2} />,
      color: '#8B5CF6',
      route: '/import/vcard',
    },
    {
      id: 'phone',
      label: 'Телефонная книга',
      sub: 'WhatsApp, Telegram, MAX — синхронизированы с контактами',
      icon: <Phone size={22} color={colors.onAccent} strokeWidth={2} />,
      color: colors.accent,
      route: '/contact/import-phone',
    },
    {
      id: 'csv',
      label: 'Excel / CSV',
      sub: 'Таблица с контактами в формате CSV',
      icon: <FileText size={22} color="#fff" strokeWidth={2} />,
      color: '#16A34A',
      route: '/contact/import-csv',
    },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.heading}>Откуда импортируем?</Text>
      <Text style={styles.sub}>Выберите источник — данные автоматически попадут в контакты</Text>

      {SOURCES.map((s) => (
        <TouchableOpacity
          key={s.id}
          style={styles.card}
          onPress={() => router.push(s.route as never)}
          activeOpacity={0.78}
        >
          <View style={[styles.iconWrap, { backgroundColor: s.color }]}>{s.icon}</View>
          <View style={styles.cardText}>
            <Text style={styles.cardLabel}>{s.label}</Text>
            <Text style={styles.cardSub}>{s.sub}</Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { padding: 20, paddingBottom: 48 },
  heading: { fontSize: 22, fontWeight: '800', color: c.text1, marginBottom: 6 },
  sub: { fontSize: type.body.fontSize, color: c.amber, marginBottom: spacing.xl, lineHeight: 20 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: c.surface, borderRadius: 14, padding: spacing.lg,
    marginBottom: spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
    borderWidth: 1, borderColor: '#F5EDE8', // pre-existing: near-white border on a dark card, likely a bug (not in the given color mapping — left as-is, see report)
  },
  iconWrap: {
    width: 46, height: 46, borderRadius: radius.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  cardText: { flex: 1 },
  cardLabel: { fontSize: 15, fontWeight: '700', color: c.text1, marginBottom: 2 },
  cardSub: { fontSize: type.caption.fontSize, color: c.amber, lineHeight: 16 },
});
