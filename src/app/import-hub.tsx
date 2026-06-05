import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Phone, FileText, Upload, MessageSquare, ChevronRight, Zap } from 'lucide-react-native';

interface Source {
  id: string;
  label: string;
  sub: string;
  icon: React.ReactElement;
  color: string;
  route: string;
  badge?: string;
}

const SOURCES: Source[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    sub: 'Контакты из Telegram одним нажатием',
    icon: <Zap size={22} color="#fff" strokeWidth={2} />,
    color: '#2AABEE',
    route: '/import/telegram',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    sub: 'Импорт из экспорта чата (.txt)',
    icon: <MessageSquare size={22} color="#fff" strokeWidth={2} />,
    color: '#25D366',
    route: '/import/whatsapp',
  },
  {
    id: 'bitrix24',
    label: 'Битрикс24',
    sub: 'Контакты и сделки через вебхук',
    icon: <Zap size={22} color="#fff" strokeWidth={2} />,
    color: '#FF5752',
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
    icon: <Phone size={22} color="#fff" strokeWidth={2} />,
    color: '#C45A10',
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

export default function ImportHubScreen() {
  const router = useRouter();

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
          <ChevronRight size={18} color="#CFADA3" strokeWidth={2} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAF6F3' },
  content: { padding: 20, paddingBottom: 48 },
  heading: { fontSize: 22, fontWeight: '800', color: '#383432', marginBottom: 6 },
  sub: { fontSize: 14, color: '#B07868', marginBottom: 24, lineHeight: 20 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: '#fff', borderRadius: 14, padding: 16,
    marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
    borderWidth: 1, borderColor: '#F5EDE8',
  },
  iconWrap: {
    width: 46, height: 46, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  cardText: { flex: 1 },
  cardLabel: { fontSize: 15, fontWeight: '700', color: '#383432', marginBottom: 2 },
  cardSub: { fontSize: 12, color: '#B07868', lineHeight: 16 },
});
