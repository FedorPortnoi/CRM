import { useMemo } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import FileImportScreen, { makeRowStyles } from './FileImportScreen';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

interface WaContact { name: string; phone?: string; message_count: number }

function parseWhatsApp(text: string): WaContact[] {
  const map = new Map<string, WaContact>();
  const re = /(?:\[\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s[\d:]+\s?(?:AM|PM)?\]|\d{1,2}[./]\d{1,2}[./]\d{2,4},\s[\d:]+)\s[-–]\s(.+?):\s(.+)/;

  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    const phoneMatch = name.match(/\+[\d\s\-()]{7,20}/);
    const phone = phoneMatch?.[0].replace(/\s/g, '');
    const existing = map.get(name);
    if (existing) { existing.message_count++; }
    else { map.set(name, { name, phone, message_count: 1 }); }
  }

  return Array.from(map.values()).sort((a, b) => b.message_count - a.message_count);
}

export default function WhatsAppImportScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const rowStyles = useMemo(() => makeRowStyles(colors), [colors]);

  return (
    <FileImportScreen<WaContact>
      mimeTypes={['text/plain', '*/*']}
      accentColor="#25D366" // brand color: WhatsApp
      parse={parseWhatsApp}
      endpoint="/import/whatsapp"
      getKey={(item) => item.name}
      pickTitle="WhatsApp"
      pickInstructions={'Чат → ⋮ → Ещё → Экспорт чата → Без медиа\nСохраните .txt и выберите его ниже'}
      pickButtonLabel="Выбрать файл"
      emptyError="Собеседники не найдены — проверьте файл"
      barUnit="собеседников"
      renderItem={(item) => (
        <View style={styles.row}>
          <View style={styles.textBlock}>
            <Text style={rowStyles.rowName}>{item.name}</Text>
            {item.phone ? <Text style={rowStyles.rowSub}>{item.phone}</Text> : null}
          </View>
          <Text style={styles.count}>{item.message_count} сообщ.</Text>
        </View>
      )}
    />
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  row:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textBlock: { flex: 1 },
  count:     { fontSize: 11, color: c.textMuted },
});
