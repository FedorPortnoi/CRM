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
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronRight, FileText, Plus } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { formatMarketDate } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, tabular } from '../../theme';
import { useEmailTemplates, type EmailTemplate } from '../../hooks/useEmailTemplates';
import { Card, Button, EmptyState, SkeletonText } from '../../components/ui';

const SEARCH_DEBOUNCE_MS = 300;

function ListSkeleton({ styles }: { styles: ReturnType<typeof makeStyles> }): JSX.Element {
  return (
    <View style={styles.list}>
      {Array.from({ length: 6 }, (_, i) => (
        <Card key={i} style={styles.card}>
          <SkeletonText lines={3} lastLineWidth="40%" />
        </Card>
      ))}
    </View>
  );
}

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
        <ListSkeleton styles={styles} />
      ) : templatesQuery.isError ? (
        <EmptyState
          icon={<AlertCircle size={32} color={colors.danger} />}
          title={t('templates.failedToLoad')}
          actionLabel={t('templates.retry')}
          onAction={() => { void templatesQuery.refetch(); }}
        />
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
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            templates.length > 0 ? (
              <Text style={styles.count}>{t('templates.count', { count: total })}</Text>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon={<FileText size={32} color={colors.textMuted} />}
              title={isSearching ? t('templates.noMatches') : t('templates.empty')}
              description={
                isSearching
                  ? t('templates.noMatchesHint')
                  : canManage
                    ? `${t('templates.emptyHint')}\n${t('templates.editHint')}`
                    : t('templates.emptyHint')
              }
            />
          }
          renderItem={({ item }) => (
            <Card
              style={styles.card}
              onPress={() => openTemplate(item.id)}
              accessibilityLabel={item.name}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
                <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
              </View>
              <Text style={styles.cardSubject} numberOfLines={2}>{item.subject}</Text>
              <Text style={styles.cardMeta}>
                {t('templates.updatedAt', { date: formatMarketDate(item.updated_at) })}
                {item.creator ? ` · ${t('templates.createdBy')}: ${item.creator.name}` : ''}
              </Text>
            </Card>
          )}
        />
      )}

      {canManage ? (
        <Button
          title={t('templates.create')}
          icon={<Plus size={18} color={colors.onAccent} strokeWidth={2.5} />}
          onPress={() => openTemplate('new')}
          block
          style={styles.createButton}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  intro: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
  subtitle: { ...type.body, color: c.textMuted },
  mutedNote: { ...type.caption, color: c.textMuted },
  search: {
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    backgroundColor: c.inputBg,
    color: c.text1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...type.body,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  count: { ...type.caption, color: c.textMuted, marginBottom: spacing.sm, ...tabular },
  card: { marginBottom: spacing.sm },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { flex: 1, ...type.heading, color: c.text1 },
  cardSubject: { marginTop: spacing.xs, ...type.label, color: c.text1 },
  cardMeta: { marginTop: spacing.xs, ...type.caption, color: c.textMuted, ...tabular },
  createButton: { margin: spacing.lg },
});
