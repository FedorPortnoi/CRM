import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Phone, FileText, Upload, MessageSquare, ChevronRight, Zap } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { ThemeColors, spacing, radius, type } from '../theme';
import { Card, Screen } from '../components/ui';

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
      icon: <Zap size={22} color={colors.onAccent} strokeWidth={2} />,
      color: '#2AABEE', // brand color
      route: '/import/telegram',
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      sub: 'Импорт из экспорта чата (.txt)',
      icon: <MessageSquare size={22} color={colors.onAccent} strokeWidth={2} />,
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
      icon: <Upload size={22} color={colors.onAccent} strokeWidth={2} />,
      color: colors.accent,
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
      icon: <FileText size={22} color={colors.onAccent} strokeWidth={2} />,
      color: colors.success,
      route: '/contact/import-csv',
    },
  ];

  return (
    <Screen contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Откуда импортируем?</Text>
      <Text style={styles.sub}>Выберите источник — данные автоматически попадут в контакты</Text>

      {SOURCES.map((s) => (
        <Card
          key={s.id}
          onPress={() => router.push(s.route as never)}
          style={styles.card}
          accessibilityLabel={s.label}
        >
          <View style={[styles.iconWrap, { backgroundColor: s.color }]}>{s.icon}</View>
          <View style={styles.cardText}>
            <Text style={styles.cardLabel}>{s.label}</Text>
            <Text style={styles.cardSub}>{s.sub}</Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
        </Card>
      ))}
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  content: { padding: spacing.lg },
  heading: { ...type.title, color: c.text1, marginBottom: spacing.xs },
  sub: { ...type.body, color: c.amber, marginBottom: spacing.xl },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    marginBottom: spacing.md,
  },
  iconWrap: {
    width: 46, height: 46, borderRadius: radius.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  cardText: { flex: 1 },
  cardLabel: { ...type.heading, color: c.text1, marginBottom: 2 },
  cardSub: { ...type.caption, color: c.amber },
});
