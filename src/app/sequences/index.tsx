// Email sequences — the list. Owner/admin only (the server enforces it too).
//
// Backend: GET /api/v1/sequences?status=
// i18n:    sequences.*
//
// A row answers the two questions an operator has on a phone: is this sequence running,
// and how many people are currently inside it. The count comes from each sequence's detail
// (see useSequenceSummaries) because the list endpoint does not carry it — the same cache
// entry the detail screen reads, so opening a row is instant.
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Mail, Plus } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import {
  useSequenceList,
  useSequenceSummaries,
  type Sequence,
  type SequenceStatus,
} from '../../hooks/useSequences';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

const STATUS_FILTERS: (SequenceStatus | 'all')[] = ['all', 'active', 'draft', 'paused', 'archived'];

const STATUS_LABEL_KEYS: Record<SequenceStatus, string> = {
  draft: 'sequences.statusDraft',
  active: 'sequences.statusActive',
  paused: 'sequences.statusPaused',
  archived: 'sequences.statusArchived',
};

/** Only a running sequence gets the accent colour — everything else reads as parked. */
function statusColor(status: SequenceStatus, c: ThemeColors): string {
  if (status === 'active') return c.orange;
  if (status === 'paused') return c.amber;
  if (status === 'draft') return c.textMuted;
  return c.textFaint;
}

export default function SequencesScreen(): JSX.Element {
  const { t } = useTranslation();
  const role = useUserStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canManage = role === 'owner' || role === 'admin';

  const [filter, setFilter] = useState<SequenceStatus | 'all'>('all');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const listQuery = useSequenceList(filter, canManage);
  const items: Sequence[] = listQuery.data?.data ?? [];
  const summaries = useSequenceSummaries(items.map((item) => item.id));

  const onRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void queryClient
      .invalidateQueries({ queryKey: ['sequences'] })
      .finally(() => setIsRefreshing(false));
  }, [queryClient]);

  if (!canManage) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('sequences.title') }} />
        <ScrollView contentContainerStyle={styles.gate}>
          <Text style={styles.pageTitle}>{t('sequences.title')}</Text>
          <Text style={styles.pageSubtitle}>{t('sequences.subtitle')}</Text>
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{t('sequences.adminOnly')}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t('sequences.title') }} />

      <View style={styles.intro}>
        <Text style={styles.pageSubtitle}>{t('sequences.subtitle')}</Text>
        <Text style={styles.legalNote}>{t('sequences.consentNote')}</Text>
        <TouchableOpacity
          style={styles.linkRow}
          onPress={() => router.push('/templates' as never)}
          accessibilityRole="button"
        >
          <Text style={styles.linkText}>{t('sequences.openTemplates')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.filters}
      >
        {STATUS_FILTERS.map((value) => {
          const active = filter === value;
          return (
            <TouchableOpacity
              key={value}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setFilter(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {value === 'all' ? t('sequences.filterAll') : t(STATUS_LABEL_KEYS[value])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {listQuery.isPending ? (
        <ActivityIndicator style={styles.loader} color={colors.orange} />
      ) : listQuery.isError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{t('sequences.failedToLoad')}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void listQuery.refetch(); }}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>{t('sequences.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          extraData={summaries}
          contentContainerStyle={items.length === 0 ? styles.emptyList : styles.list}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor={colors.orange}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Mail size={28} color={colors.orange} strokeWidth={2} />
              <Text style={styles.emptyTitle}>{t('sequences.empty')}</Text>
              <Text style={styles.emptyHint}>{t('sequences.emptyHint')}</Text>
              <Text style={styles.emptyHint}>{t('sequences.editHint')}</Text>
              <TouchableOpacity
                style={styles.emptyButton}
                onPress={() => router.push('/sequences/new' as never)}
                accessibilityRole="button"
              >
                <Text style={styles.emptyButtonText}>{t('sequences.createFirst')}</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }) => {
            const summary = summaries[item.id];
            const color = statusColor(item.status, colors);
            return (
              <TouchableOpacity
                style={styles.card}
                onPress={() => router.push(`/sequences/${item.id}` as never)}
                accessibilityRole="button"
                activeOpacity={0.7}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{item.name}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: color + '22' }]}>
                    <Text style={[styles.statusBadgeText, { color }]}>
                      {t(STATUS_LABEL_KEYS[item.status])}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
                </View>

                {item.description ? (
                  <Text style={styles.cardDescription} numberOfLines={2}>{item.description}</Text>
                ) : null}

                <Text style={styles.cardMeta}>
                  {summary
                    ? `${t('sequences.stepCount', { count: summary.steps.length })} · ${t('sequences.activeEnrollments', { count: summary.active_enrollments })}`
                    : t('sequences.countsLoading')}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity
        style={styles.createButton}
        onPress={() => router.push('/sequences/new' as never)}
        accessibilityRole="button"
      >
        <Plus size={18} color="#FFFFFF" strokeWidth={2.5} />
        <Text style={styles.createButtonText}>{t('sequences.create')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  gate: { padding: 20, gap: 10 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: c.text1 },
  pageSubtitle: { fontSize: 14, color: c.amber, lineHeight: 20 },
  legalNote: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  intro: { paddingHorizontal: 16, paddingTop: 14, gap: 6 },
  linkRow: { alignSelf: 'flex-start', paddingVertical: 6 },
  linkText: { color: c.orange, fontSize: 14, fontWeight: '700' },
  notice: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
    padding: 14,
  },
  noticeText: { color: c.amber, fontSize: 14, lineHeight: 20 },
  // flexGrow:0 is load-bearing. This ScrollView is a direct child of `screen`
  // (flex:1) and sits above the list, so without it the horizontal ScrollView
  // claims the leftover vertical space and stretches every chip to ~400px tall.
  // nearby.tsx does not need this only because its chip row is wrapped in a
  // content-sized View. alignItems keeps the chips their natural height.
  filterBar: { flexGrow: 0, flexShrink: 0 },
  filters: { paddingHorizontal: 16, paddingVertical: 12, gap: 8, alignItems: 'center' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
  },
  chipActive: { backgroundColor: c.orange, borderColor: c.orange },
  chipText: { color: c.amber, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#FFFFFF' },
  loader: { marginTop: 32 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyList: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  empty: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: c.text1 },
  emptyHint: { fontSize: 13, color: c.amber, textAlign: 'center', lineHeight: 19 },
  emptyButton: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.orange,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  emptyButtonText: { color: c.orange, fontSize: 14, fontWeight: '700' },
  card: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: c.text1 },
  cardDescription: { marginTop: 6, fontSize: 13, color: c.amber, lineHeight: 18 },
  cardMeta: { marginTop: 8, fontSize: 12, color: c.textMuted },
  statusBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeText: { fontSize: 12, fontWeight: '700' },
  errorBox: { padding: 24, alignItems: 'center', gap: 12 },
  errorText: { color: c.red, fontSize: 14, textAlign: 'center' },
  retryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: { color: c.text1, fontSize: 14, fontWeight: '600' },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    margin: 16,
    backgroundColor: c.orange,
    borderRadius: 12,
    paddingVertical: 14,
  },
  createButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});
