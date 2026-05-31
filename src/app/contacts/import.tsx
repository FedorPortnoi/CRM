import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { sendOrQueueMutation } from '../../utils/offlineMutation';

type CsvRow = {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  notes?: string;
};

type Step = 'pick' | 'preview' | 'result';

type ImportResult = {
  imported_count: number;
  skipped: number;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).flatMap((line): CsvRow[] => {
    const vals = parseCsvLine(line);
    const rec = headers.reduce<Record<string, string>>((acc, h, i) => {
      acc[h] = vals[i] ?? '';
      return acc;
    }, {});
    const firstName = (rec.first_name ?? rec.firstname ?? rec.name ?? '').trim();
    if (!firstName) return [];
    return [{
      first_name: firstName,
      last_name: rec.last_name || rec.lastname || undefined,
      company: rec.company || undefined,
      email: rec.email || undefined,
      phone: rec.phone || rec.mobile || undefined,
      notes: rec.notes || undefined,
    }];
  });
}

export default function ContactsImportScreen(): JSX.Element {
  const { t } = useTranslation();
  const token = useUserStore((s) => s.token);
  const [step, setStep] = useState<Step>('pick');
  const [fileName, setFileName] = useState<string>('');
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePickFile = async (): Promise<void> => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', '*/*'] });
    if (res.canceled) return;
    const asset = res.assets[0];
    if (!asset) return;
    try {
      const content = await FileSystem.readAsStringAsync(asset.uri);
      const parsed = parseCsv(content);
      if (parsed.length === 0) {
        setError(t('contacts.importNoRows'));
        return;
      }
      setFileName(asset.name ?? 'import.csv');
      setRows(parsed);
      setStep('preview');
    } catch {
      setError(t('contacts.importReadError'));
    }
  };

  const handleImport = async (): Promise<void> => {
    if (!token || rows.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await sendOrQueueMutation({
        url: `${API_URL}/contacts/import-csv`,
        method: 'POST',
        token,
        body: rows,
      });
      if (res.queued) {
        Alert.alert(t('contacts.importQueued'), t('contacts.importQueuedDesc'), [
          { text: t('common.done'), onPress: () => router.back() },
        ]);
        return;
      }
      if (!res.response.ok) {
        const body = (await res.response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `Status ${res.response.status}`);
      }
      const body = (await res.response.json()) as { data: ImportResult };
      setResult(body.data);
      setStep('result');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('errors.serverError'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" style={styles.backBtn}>
          <Text style={styles.backText}>{'‹ ' + t('common.back')}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('contacts.importCsv')}</Text>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {step === 'pick' && (
          <View style={styles.section}>
            <Text style={styles.hint}>{t('contacts.importHint')}</Text>
            <Text style={styles.columns}>first_name, last_name, company, email, phone, notes</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <TouchableOpacity style={styles.primaryBtn} onPress={() => { void handlePickFile(); }} accessibilityRole="button">
              <Text style={styles.primaryBtnText}>{t('contacts.importPickFile')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'preview' && (
          <View style={styles.section}>
            <Text style={styles.hint}>{fileName}</Text>
            <Text style={styles.previewCount}>{t('contacts.importRowCount', { count: rows.length })}</Text>
            <View style={styles.table}>
              <View style={styles.tableHeaderRow}>
                {['first_name', 'last_name', 'company', 'email'].map((col) => (
                  <Text key={col} style={styles.tableHeader} numberOfLines={1}>{col}</Text>
                ))}
              </View>
              {rows.slice(0, 5).map((row, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={styles.tableCell} numberOfLines={1}>{row.first_name}</Text>
                  <Text style={styles.tableCell} numberOfLines={1}>{row.last_name ?? ''}</Text>
                  <Text style={styles.tableCell} numberOfLines={1}>{row.company ?? ''}</Text>
                  <Text style={styles.tableCell} numberOfLines={1}>{row.email ?? ''}</Text>
                </View>
              ))}
              {rows.length > 5 ? (
                <Text style={styles.moreRows}>{t('contacts.importMoreRows', { count: rows.length - 5 })}</Text>
              ) : null}
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.rowActions}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStep('pick')} accessibilityRole="button">
                <Text style={styles.secondaryBtnText}>{t('common.back')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, styles.flex1, importing && styles.btnDisabled]}
                onPress={() => { void handleImport(); }}
                disabled={importing}
                accessibilityRole="button"
              >
                {importing
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={styles.primaryBtnText}>{t('contacts.importStart')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {step === 'result' && result && (
          <View style={styles.section}>
            <View style={styles.resultCard}>
              <Text style={styles.resultTitle}>{t('contacts.importDone')}</Text>
              <Text style={styles.resultRow}>{t('contacts.importCreated', { count: result.imported_count })}</Text>
              {result.skipped > 0
                ? <Text style={styles.resultRow}>{t('contacts.importSkipped', { count: result.skipped })}</Text>
                : null}
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()} accessibilityRole="button">
              <Text style={styles.primaryBtnText}>{t('common.done')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FEF0E8' },
  header: {
    backgroundColor: '#FFF',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  backBtn: { marginBottom: 4 },
  backText: { fontSize: 14, color: '#C4704F', fontWeight: '500' },
  title: { fontSize: 20, fontWeight: '700', color: '#111' },
  body: { flex: 1 },
  bodyContent: { padding: 16 },
  section: { gap: 12 },
  hint: { fontSize: 14, color: '#555', lineHeight: 20 },
  columns: {
    fontSize: 12,
    color: '#888',
    fontFamily: 'monospace',
    backgroundColor: '#F0F0F0',
    padding: 10,
    borderRadius: 6,
  },
  error: { fontSize: 13, color: '#ef4444' },
  primaryBtn: {
    backgroundColor: '#C4704F',
    borderRadius: 12,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { color: '#FFF', fontWeight: '700', fontSize: 15 },
  secondaryBtn: {
    borderRadius: 12,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: '#DDD',
    backgroundColor: '#FFF',
  },
  secondaryBtnText: { color: '#444', fontWeight: '600', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },
  flex1: { flex: 1 },
  rowActions: { flexDirection: 'row', gap: 10 },
  previewCount: { fontSize: 13, color: '#555', fontWeight: '500' },
  table: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E8DDD6',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#F8F8F8',
    borderBottomWidth: 1,
    borderBottomColor: '#E8DDD6',
  },
  tableHeader: { flex: 1, fontSize: 11, fontWeight: '700', color: '#666', padding: 8 },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  tableCell: { flex: 1, fontSize: 12, color: '#111', padding: 8 },
  moreRows: { fontSize: 12, color: '#888', padding: 8, textAlign: 'center' },
  resultCard: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E8DDD6',
    gap: 8,
  },
  resultTitle: { fontSize: 18, fontWeight: '700', color: '#111' },
  resultRow: { fontSize: 14, color: '#555' },
});
