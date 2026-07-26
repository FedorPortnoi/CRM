// Email templates — the list. Create/edit/delete live in templates/[id].tsx.
//
// Backend: GET /api/v1/email-templates?per_page=&q=
// i18n:    templates.*
//
// Reading is open to every role (the preview route is explicitly viewer-safe); creating and
// editing are owner/admin on the server, so the create button is hidden for everyone else
// rather than shown and then rejected with a 403.
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { formatMarketDate } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { useEmailTemplates, type EmailTemplate } from '../../hooks/useEmailTemplates';

const SEARCH_DEBOUNCE_MS = 300;

export default function TemplatesScreen(): JSX.Element {
  const { t } = useTranslation();
  const role = useUserStore((s) => s.user?.role);
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const templatesQuery = useEmailTemplates(debouncedSearch);
  const templates: EmailTemplate[] = templatesQuery.data?.data ?? [];
  const total = templatesQuery.data?.meta.total ?? 0;
  const isSearching = debouncedSearch.trim().length > 0;

  const openTemplate = (id: string): void => {
    router.push({ pathname: '/templates/[id]', params: { id } } as never);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('templates.title') }} />

      <View style={styles.intro}>
        <Text style={styles.subtitle}>{t('templates.subtitle')}</Text>
        {!canManage ? <Text style={styles.mutedNote}>{t('templates.adminOnly')}</Text> : null}
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder={t('templates.search')}
          placeholderTextColor={colors.placeholder}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel={t('templates.search')}
        />
      </View>

      {templatesQuery.isPending ? (
        <ActivityIndicator style={styles.loader} color={colors.orange} />
      ) : templatesQuery.isError ? (
        <View style={styles.stateBlock}>
          <Text style={styles.errorText}>{t('templates.failedToLoad')}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void templatesQuery.refetch(); }}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>{t('templates.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={templates}
          keyExtractor={(item) => item.id}
          contentContainerStyle={templates.length === 0 ? styles.emptyList : styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={templatesQuery.isRefetching}
              onRefresh={() => { void templatesQuery.refetch(); }}
              tintColor={colors.orange}
            />
          }
          ListHeaderComponent={
            templates.length > 0 ? (
              <Text style={styles.count}>{t('templates.count', { count: total })}</Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <FileText size={28} color={colors.orange} strokeWidth={2} />
              <Text style={styles.emptyTitle}>
                {isSearching ? t('templates.noMatches') : t('templates.empty')}
              </Text>
              <Text style={styles.emptyHint}>
                {isSearching ? t('templates.noMatchesHint') : t('templates.emptyHint')}
              </Text>
              {!isSearching && canManage ? (
                <Text style={styles.emptyHint}>{t('templates.editHint')}</Text>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => openTemplate(item.id)}
              accessibilityRole="button"
              activeOpacity={0.7}
            >
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.cardSubject} numberOfLines={2}>{item.subject}</Text>
                <Text style={styles.cardMeta}>
                  {t('templates.updatedAt', { date: formatMarketDate(item.updated_at) })}
                  {item.creator ? ` · ${t('templates.createdBy')}: ${item.creator.name}` : ''}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
            </TouchableOpacity>
          )}
        />
      )}

      {canManage ? (
        <TouchableOpacity
          style={styles.createButton}
          onPress={() => openTemplate('new')}
          accessibilityRole="button"
          activeOpacity={0.8}
        >
          <Text style={styles.createButtonText}>+ {t('templates.create')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  intro: { paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  subtitle: { fontSize: 14, color: c.amber, lineHeight: 20 },
  mutedNote: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  search: {
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 12,
    backgroundColor: c.inputBg,
    color: c.text1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 15,
    marginBottom: 6,
  },
  loader: { marginTop: 32 },
  stateBlock: { paddingHorizontal: 16, paddingTop: 24, alignItems: 'flex-start', gap: 10 },
  list: { paddingHorizontal: 16, paddingBottom: 96 },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingBottom: 96 },
  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: c.text1 },
  emptyHint: { fontSize: 13, color: c.amber, textAlign: 'center', lineHeight: 19 },
  count: { fontSize: 13, color: c.amber, marginBottom: 10 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    marginBottom: 10,
  },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: c.text1 },
  cardSubject: { fontSize: 13, color: c.text1, marginTop: 4, lineHeight: 18 },
  cardMeta: { fontSize: 12, color: c.amber, marginTop: 6 },
  errorText: { color: c.red, fontSize: 14 },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.orange,
    borderRadius: 6,
  },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  createButton: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: c.orange,
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
});
